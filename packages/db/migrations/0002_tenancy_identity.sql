-- =============================================================================
-- 0002  Tenancy, identity, access control.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Platform-scoped: the tenant directory and the operators who administer it.
-- The application role cannot read these tables at all.
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           citext NOT NULL UNIQUE,
  legal_name     text NOT NULL,
  trading_name   text,
  status         text NOT NULL DEFAULT 'trial'
                 CHECK (status IN ('trial','active','suspended','offboarding','closed')),
  data_region    text NOT NULL DEFAULT 'eu-west',
  plan_key       text,
  -- Firms declare their own regulatory footprint; the platform stores it as
  -- fact supplied by the firm and never asserts it on their behalf.
  fca_firm_reference  text,
  regulated_activities text[] NOT NULL DEFAULT '{}',
  jurisdictions  text[] NOT NULL DEFAULT ARRAY['england-wales'],
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  branding       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  closed_at      timestamptz
);

CREATE TABLE platform_operators (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  full_name      text NOT NULL,
  password_hash  text NOT NULL,
  mfa_secret     text,
  mfa_enrolled_at timestamptz,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  operator_role  text NOT NULL DEFAULT 'support'
                 CHECK (operator_role IN ('support','engineering','compliance','admin')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Every cross-tenant look at customer data is itself a record. Support access
-- is time-boxed and reason-coded; expiry is enforced when the grant is used.
CREATE TABLE platform_access_grants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id    uuid NOT NULL REFERENCES platform_operators(id),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  reason         text NOT NULL,
  ticket_ref     text,
  scope          text NOT NULL DEFAULT 'read' CHECK (scope IN ('read','write')),
  approved_by    uuid REFERENCES platform_operators(id),
  granted_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  CHECK (expires_at > granted_at)
);
CREATE INDEX platform_access_grants_lookup
  ON platform_access_grants (operator_id, tenant_id, expires_at DESC);

-- ---------------------------------------------------------------------------
-- Global catalogues. Readable by every tenant, written only by the platform.
-- ---------------------------------------------------------------------------

CREATE TABLE permissions (
  key          text PRIMARY KEY,
  resource     text NOT NULL,
  action       text NOT NULL,
  description  text NOT NULL,
  -- Regulated permissions gate actions that carry advice or compliance weight.
  -- They can never be granted to a non-human principal (API key, workflow,
  -- AI action) - enforced in packages/auth and tested.
  is_regulated boolean NOT NULL DEFAULT false,
  UNIQUE (resource, action)
);

CREATE TABLE feature_definitions (
  key           text PRIMARY KEY,
  name          text NOT NULL,
  description   text NOT NULL,
  category      text NOT NULL,
  default_state boolean NOT NULL DEFAULT false,
  -- Features that require an explicit commercial entitlement rather than a
  -- simple on/off toggle.
  metered       boolean NOT NULL DEFAULT false
);

CREATE TABLE role_templates (
  key          text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}'
);

-- ---------------------------------------------------------------------------
-- Tenant-scoped identity.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  email         citext NOT NULL,
  full_name     text NOT NULL,
  -- staff work cases; client is the consumer portal; creditor and introducer
  -- are external counterparties with deliberately narrow permission sets.
  user_type     text NOT NULL DEFAULT 'staff'
                CHECK (user_type IN ('staff','client','creditor','introducer')),
  status        text NOT NULL DEFAULT 'invited'
                CHECK (status IN ('invited','active','suspended','closed')),
  password_hash text,
  mfa_secret    text,
  mfa_enrolled_at timestamptz,
  mfa_required  boolean NOT NULL DEFAULT false,
  -- Adviser competency: which regulated activities this person is signed off
  -- to perform. Advice decisions check this, not just the permission bit.
  competencies  text[] NOT NULL DEFAULT '{}',
  job_title     text,
  phone         text,
  last_login_at timestamptz,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX users_tenant_type ON users (tenant_id, user_type, status);

CREATE TABLE roles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  key          text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  template_key text REFERENCES role_templates(key),
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

CREATE TABLE role_permissions (
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permissions(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  tenant_id  uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the hash is stored; the bearer value never lands in the database.
  token_hash     text NOT NULL UNIQUE,
  mfa_satisfied  boolean NOT NULL DEFAULT false,
  ip             inet,
  user_agent     text,
  device_label   text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text
);
CREATE INDEX sessions_user ON sessions (tenant_id, user_id, revoked_at);

CREATE TABLE tenant_features (
  tenant_id   uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  feature_key text NOT NULL REFERENCES feature_definitions(key),
  enabled     boolean NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feature_key)
);

-- ---------------------------------------------------------------------------
-- Apply the conventions.
-- ---------------------------------------------------------------------------
SELECT app.apply_platform_rls('tenants');
SELECT app.apply_platform_rls('platform_operators');
SELECT app.apply_platform_rls('platform_access_grants');

SELECT app.apply_global_rls('permissions');
SELECT app.apply_global_rls('feature_definitions');
SELECT app.apply_global_rls('role_templates');

SELECT app.apply_tenant_rls('users');
SELECT app.apply_tenant_rls('roles');
SELECT app.apply_tenant_rls('role_permissions');
SELECT app.apply_tenant_rls('user_roles');
SELECT app.apply_tenant_rls('sessions');
SELECT app.apply_tenant_rls('tenant_features');

SELECT app.apply_touch_updated_at('tenants');
SELECT app.apply_touch_updated_at('platform_operators');
SELECT app.apply_touch_updated_at('users');
SELECT app.apply_touch_updated_at('roles');

-- The application needs to resolve its own tenant row (name, branding,
-- settings) without being able to see any other tenant. A security-definer
-- accessor returns exactly the current tenant and nothing else.
CREATE OR REPLACE FUNCTION app.current_tenant()
  RETURNS TABLE (id uuid, slug citext, legal_name text, trading_name text,
                 status text, data_region text, plan_key text,
                 jurisdictions text[], settings jsonb, branding jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app AS $$
  SELECT t.id, t.slug, t.legal_name, t.trading_name, t.status, t.data_region,
         t.plan_key, t.jurisdictions, t.settings, t.branding
    FROM tenants t
   WHERE t.id = app.current_tenant_id()
$$;
GRANT EXECUTE ON FUNCTION app.current_tenant() TO solvenda_app;
