-- =============================================================================
-- 0016  Platform administration.
--
-- The operating principle: anything that can safely be configuration should be
-- configuration, so running the business does not mean going back to the
-- codebase. Plans, features, announcements, retention policy and support access
-- all live here rather than in a deploy.
-- =============================================================================

CREATE TABLE plans (
  key            text PRIMARY KEY,
  name           text NOT NULL,
  description    text NOT NULL DEFAULT '',
  -- Pence per month. Integer, like every other monetary value.
  platform_fee_pence bigint NOT NULL DEFAULT 0,
  per_seat_pence bigint NOT NULL DEFAULT 0,
  included_seats int NOT NULL DEFAULT 0,
  included_cases_per_month int,
  -- Feature keys this plan turns on by default.
  features       text[] NOT NULL DEFAULT '{}',
  -- Usage allowances and overage rates, keyed by meter.
  usage_terms    jsonb NOT NULL DEFAULT '{}'::jsonb,
  minimum_term_months int NOT NULL DEFAULT 12,
  support_tier   text NOT NULL DEFAULT 'standard'
                 CHECK (support_tier IN ('standard','priority','enterprise')),
  status         text NOT NULL DEFAULT 'available'
                 CHECK (status IN ('available','legacy','withdrawn')),
  sort_order     int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- What a firm is actually on, which may differ from the published plan.
CREATE TABLE tenant_subscriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  plan_key       text NOT NULL REFERENCES plans(key),
  seats          int NOT NULL DEFAULT 1,
  -- Negotiated variations from the plan, recorded rather than remembered.
  overrides      jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_on     date NOT NULL DEFAULT current_date,
  ends_on        date,
  status         text NOT NULL DEFAULT 'active'
                 CHECK (status IN ('trial','active','past-due','suspended','ended')),
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_subscriptions_tenant ON tenant_subscriptions (tenant_id, status);

-- Metered usage, recorded as it happens so an invoice can be reconstructed.
CREATE TABLE usage_records (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  meter          text NOT NULL,
  quantity       bigint NOT NULL,
  unit           text NOT NULL,
  cost_pence     bigint NOT NULL DEFAULT 0,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, meter, period_start)
);

CREATE TABLE announcements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL,
  body           text NOT NULL,
  severity       text NOT NULL DEFAULT 'info'
                 CHECK (severity IN ('info','change','maintenance','incident')),
  -- Empty means every firm.
  tenant_ids     uuid[] NOT NULL DEFAULT '{}',
  audiences      text[] NOT NULL DEFAULT ARRAY['staff'],
  publish_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  created_by     uuid REFERENCES platform_operators(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_releases (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        text NOT NULL UNIQUE,
  released_at    timestamptz NOT NULL DEFAULT now(),
  summary        text NOT NULL,
  changes        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Migrations included, so an operator can tie a schema change to a release.
  migrations     text[] NOT NULL DEFAULT '{}',
  created_by     uuid REFERENCES platform_operators(id)
);

-- Retention policy is configuration, per firm and per data class, because
-- statutory retention periods differ by solution and firms take different views
-- within them.
CREATE TABLE retention_policies (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL DEFAULT app.current_tenant_id() REFERENCES tenants(id),
  data_class     text NOT NULL,
  retain_months  int NOT NULL,
  -- What starts the clock: case closure, last contact, or record creation.
  anchor         text NOT NULL DEFAULT 'case-closed'
                 CHECK (anchor IN ('case-closed','last-contact','record-created')),
  action         text NOT NULL DEFAULT 'delete'
                 CHECK (action IN ('delete','anonymise','archive')),
  legal_basis    text,
  approved_by    uuid REFERENCES users(id),
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, data_class)
);

SELECT app.apply_global_rls('plans');
SELECT app.apply_platform_rls('tenant_subscriptions');
SELECT app.apply_platform_rls('usage_records');
SELECT app.apply_platform_rls('announcements');
SELECT app.apply_platform_rls('platform_releases');
SELECT app.apply_tenant_rls('retention_policies');
SELECT app.apply_touch_updated_at('plans');
SELECT app.apply_touch_updated_at('tenant_subscriptions');
SELECT app.apply_touch_updated_at('retention_policies');

-- A firm needs to see the announcements addressed to it, and nothing else.
DROP POLICY IF EXISTS announcements_self_read ON announcements;
CREATE POLICY announcements_self_read ON announcements
  FOR SELECT USING (
    publish_at <= now()
    AND (expires_at IS NULL OR expires_at > now())
    AND (cardinality(tenant_ids) = 0 OR app.current_tenant_id() = ANY(tenant_ids))
  );
GRANT SELECT ON announcements TO solvenda_app;
UPDATE app.table_registry SET self_readable = true WHERE table_name = 'announcements';
