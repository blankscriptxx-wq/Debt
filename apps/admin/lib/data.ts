import { sql, withPlatform } from '@solvenda/db';

/** Everything the operator console reads runs through platform context. */
async function platform<T>(
  operatorId: string, reason: string, fn: Parameters<typeof withPlatform<T>>[1],
): Promise<T> {
  return withPlatform({ operatorId, reason }, fn);
}

export interface TenantRow {
  id: string; slug: string; legalName: string; tradingName: string | null;
  status: string; dataRegion: string; planKey: string | null;
  jurisdictions: string[]; createdAt: string;
  users: number; cases: number; openCases: number;
  lastActivityAt: string | null;
}

export async function listTenants(operatorId: string): Promise<TenantRow[]> {
  return platform(operatorId, 'list firms in the operator console', async (db) => {
    const res = await db.execute<Record<string, string | null> & { jurisdictions: string[] }>(sql`
      SELECT t.id, t.slug, t.legal_name, t.trading_name, t.status, t.data_region,
             t.plan_key, t.jurisdictions, t.created_at::text,
             (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)::text AS users,
             (SELECT count(*) FROM cases c WHERE c.tenant_id = t.id)::text AS cases,
             (SELECT count(*) FROM cases c
               WHERE c.tenant_id = t.id AND c.status = 'open')::text AS open_cases,
             (SELECT max(occurred_at)::text FROM audit_events a
               WHERE a.tenant_id = t.id) AS last_activity
        FROM tenants t ORDER BY t.created_at DESC`);
    return res.rows.map((r) => ({
      id: r['id']!, slug: r['slug']!, legalName: r['legal_name']!,
      tradingName: r['trading_name'] ?? null, status: r['status']!,
      dataRegion: r['data_region']!, planKey: r['plan_key'] ?? null,
      jurisdictions: r.jurisdictions, createdAt: r['created_at']!,
      users: Number(r['users']), cases: Number(r['cases']),
      openCases: Number(r['open_cases']),
      lastActivityAt: r['last_activity'] ?? null,
    }));
  });
}

export interface PlatformHealth {
  tenants: number; activeTenants: number; users: number; cases: number;
  auditEntries: number; chainOk: boolean; chainDetail: string | null;
  failedJobs: number; deadJobs: number; failedWorkflows: number;
  failingWebhooks: number; aiInvocations: number; aiFailures: number;
  migrationsApplied: number; latestMigration: string | null;
  pendingRegulatedProposals: number;
}

export async function loadHealth(operatorId: string): Promise<PlatformHealth> {
  return platform(operatorId, 'platform health check', async (db) => {
    const counts = await db.execute<Record<string, string>>(sql`
      SELECT (SELECT count(*) FROM tenants)::text AS tenants,
             (SELECT count(*) FROM tenants WHERE status IN ('trial','active'))::text AS active_tenants,
             (SELECT count(*) FROM users)::text AS users,
             (SELECT count(*) FROM cases)::text AS cases,
             (SELECT count(*) FROM audit_events)::text AS audit_entries,
             (SELECT count(*) FROM job_queue WHERE status = 'failed')::text AS failed_jobs,
             (SELECT count(*) FROM job_queue WHERE status = 'dead')::text AS dead_jobs,
             (SELECT count(*) FROM workflow_runs WHERE status = 'failed')::text AS failed_workflows,
             (SELECT count(*) FROM webhook_endpoints
               WHERE status IN ('failing','disabled'))::text AS failing_webhooks,
             (SELECT count(*) FROM ai_invocations)::text AS ai_invocations,
             (SELECT count(*) FROM ai_invocations WHERE status = 'failed')::text AS ai_failures,
             (SELECT count(*) FROM app.schema_migrations)::text AS migrations,
             (SELECT count(*) FROM ai_proposals
               WHERE status = 'pending' AND touches_regulated_field)::text AS pending_regulated`);

    const latest = await db.execute<{ filename: string }>(sql`
      SELECT filename FROM app.schema_migrations ORDER BY filename DESC LIMIT 1`);

    // Verification across every firm: an operator should learn about a broken
    // ledger from this page, not from a customer.
    const chain = await db.execute<{ ok: boolean; detail: string | null; tenant_id: string }>(sql`
      SELECT ok, detail, tenant_id FROM app.verify_audit_chain(NULL) WHERE NOT ok LIMIT 1`);

    const c = counts.rows[0]!;
    return {
      tenants: Number(c['tenants']), activeTenants: Number(c['active_tenants']),
      users: Number(c['users']), cases: Number(c['cases']),
      auditEntries: Number(c['audit_entries']),
      chainOk: chain.rows.length === 0,
      chainDetail: chain.rows[0]
        ? `${chain.rows[0].detail} (firm ${chain.rows[0].tenant_id})` : null,
      failedJobs: Number(c['failed_jobs']), deadJobs: Number(c['dead_jobs']),
      failedWorkflows: Number(c['failed_workflows']),
      failingWebhooks: Number(c['failing_webhooks']),
      aiInvocations: Number(c['ai_invocations']), aiFailures: Number(c['ai_failures']),
      migrationsApplied: Number(c['migrations']),
      latestMigration: latest.rows[0]?.filename ?? null,
      pendingRegulatedProposals: Number(c['pending_regulated']),
    };
  });
}

export interface AccessGrantRow {
  id: string; operatorName: string; tenantSlug: string; reason: string;
  scope: string; grantedAt: string; expiresAt: string; revokedAt: string | null;
  active: boolean;
}

export async function listAccessGrants(operatorId: string): Promise<AccessGrantRow[]> {
  return platform(operatorId, 'review support access grants', async (db) => {
    const res = await db.execute<Record<string, string | null> & { active: boolean }>(sql`
      SELECT g.id, o.full_name AS operator_name, t.slug AS tenant_slug, g.reason,
             g.scope, g.granted_at::text, g.expires_at::text, g.revoked_at::text,
             (g.revoked_at IS NULL AND g.expires_at > now()) AS active
        FROM platform_access_grants g
        JOIN platform_operators o ON o.id = g.operator_id
        JOIN tenants t ON t.id = g.tenant_id
       ORDER BY g.granted_at DESC LIMIT 100`);
    return res.rows.map((r) => ({
      id: r['id']!, operatorName: r['operator_name']!, tenantSlug: r['tenant_slug']!,
      reason: r['reason']!, scope: r['scope']!, grantedAt: r['granted_at']!,
      expiresAt: r['expires_at']!, revokedAt: r['revoked_at'] ?? null, active: r.active,
    }));
  });
}

export interface ActivityRow {
  id: string; tenantSlug: string; action: string; actor: string;
  severity: string; reason: string | null; occurredAt: string;
}

export async function listSecurityActivity(operatorId: string): Promise<ActivityRow[]> {
  return platform(operatorId, 'review security activity across firms', async (db) => {
    // Deliberately security and regulated events only. An operator has no
    // business browsing ordinary case activity without a support grant.
    const res = await db.execute<Record<string, string | null>>(sql`
      SELECT a.id, t.slug, a.action, a.actor_label, a.severity, a.reason, a.occurred_at::text
        FROM audit_events a JOIN tenants t ON t.id = a.tenant_id
       WHERE a.severity IN ('security','regulated')
       ORDER BY a.occurred_at DESC LIMIT 100`);
    return res.rows.map((r) => ({
      id: r['id']!, tenantSlug: r['slug']!, action: r['action']!,
      actor: r['actor_label']!, severity: r['severity']!,
      reason: r['reason'] ?? null, occurredAt: r['occurred_at']!,
    }));
  });
}

export interface PlanRow {
  key: string; name: string; description: string;
  platformFeePence: number; perSeatPence: number; includedSeats: number;
  features: string[]; supportTier: string; minimumTermMonths: number;
  status: string; subscribers: number;
}

export async function listPlans(operatorId: string): Promise<PlanRow[]> {
  return platform(operatorId, 'review commercial plans', async (db) => {
    const res = await db.execute<Record<string, string | null> & { features: string[] }>(sql`
      SELECT p.key, p.name, p.description, p.platform_fee_pence::text, p.per_seat_pence::text,
             p.included_seats::text, p.features, p.support_tier,
             p.minimum_term_months::text, p.status,
             (SELECT count(*) FROM tenant_subscriptions s
               WHERE s.plan_key = p.key AND s.status = 'active')::text AS subscribers
        FROM plans p ORDER BY p.sort_order, p.name`);
    return res.rows.map((r) => ({
      key: r['key']!, name: r['name']!, description: r['description']!,
      platformFeePence: Number(r['platform_fee_pence']),
      perSeatPence: Number(r['per_seat_pence']),
      includedSeats: Number(r['included_seats']),
      features: r.features, supportTier: r['support_tier']!,
      minimumTermMonths: Number(r['minimum_term_months']),
      status: r['status']!, subscribers: Number(r['subscribers']),
    }));
  });
}

export interface ProviderRow {
  key: string; name: string; category: string; description: string;
  simulated: boolean; status: string; installs: number; calls: number;
}

export async function listProviders(operatorId: string): Promise<ProviderRow[]> {
  return platform(operatorId, 'review the integration catalogue', async (db) => {
    const res = await db.execute<Record<string, string | null> & { simulated: boolean }>(sql`
      SELECT p.key, p.name, p.category, p.description, p.simulated, p.status,
             (SELECT count(*) FROM integration_installs i
               WHERE i.provider_key = p.key)::text AS installs,
             (SELECT count(*) FROM integration_calls c
               WHERE c.provider_key = p.key)::text AS calls
        FROM integration_providers p ORDER BY p.category, p.name`);
    return res.rows.map((r) => ({
      key: r['key']!, name: r['name']!, category: r['category']!,
      description: r['description']!, simulated: r.simulated, status: r['status']!,
      installs: Number(r['installs']), calls: Number(r['calls']),
    }));
  });
}

export interface CapabilityRow {
  key: string; name: string; category: string; description: string;
  touchesRegulated: boolean; producesProposals: boolean; defaultEnabled: boolean;
  enabledTenants: number; invocations: number; failures: number;
  acceptedProposals: number; rejectedProposals: number;
}

export async function listCapabilities(operatorId: string): Promise<CapabilityRow[]> {
  return platform(operatorId, 'review AI capability usage', async (db) => {
    const res = await db.execute<Record<string, string | null> & {
      touches_regulated_fields: boolean; produces_proposals: boolean; default_enabled: boolean;
    }>(sql`
      SELECT k.key, k.name, k.category, k.description, k.touches_regulated_fields,
             k.produces_proposals, k.default_enabled,
             (SELECT count(*) FROM ai_capabilities c
               WHERE c.capability_key = k.key AND c.enabled)::text AS enabled_tenants,
             (SELECT count(*) FROM ai_invocations i
               WHERE i.capability_key = k.key)::text AS invocations,
             (SELECT count(*) FROM ai_invocations i
               WHERE i.capability_key = k.key AND i.status = 'failed')::text AS failures,
             (SELECT count(*) FROM ai_proposals p JOIN ai_invocations i ON i.id = p.invocation_id
               WHERE i.capability_key = k.key AND p.status IN ('accepted','modified'))::text AS accepted,
             (SELECT count(*) FROM ai_proposals p JOIN ai_invocations i ON i.id = p.invocation_id
               WHERE i.capability_key = k.key AND p.status = 'rejected')::text AS rejected
        FROM ai_capability_catalogue k ORDER BY k.name`);
    return res.rows.map((r) => ({
      key: r['key']!, name: r['name']!, category: r['category']!,
      description: r['description']!,
      touchesRegulated: r.touches_regulated_fields,
      producesProposals: r.produces_proposals,
      defaultEnabled: r.default_enabled,
      enabledTenants: Number(r['enabled_tenants']),
      invocations: Number(r['invocations']), failures: Number(r['failures']),
      acceptedProposals: Number(r['accepted']), rejectedProposals: Number(r['rejected']),
    }));
  });
}

export interface EnquiryRow {
  id: string; submittedAt: string; name: string; organisation: string;
  email: string; message: string; enquiryType: string; sourcePath: string;
  status: string;
}

/**
 * The marketing site's contact form writes through the unauthenticated database
 * path, which holds INSERT and no SELECT. This is the only way anything reads
 * those rows back: a platform operator, under a live access grant, audited like
 * every other operator action.
 */
export async function listEnquiries(operatorId: string): Promise<EnquiryRow[]> {
  return platform(operatorId, 'triage public enquiries', async (db) => {
    const res = await db.execute<Record<string, string>>(sql`
      SELECT id, submitted_at::text, name, organisation, email, message,
             enquiry_type, source_path, status
        FROM platform_enquiries
       ORDER BY submitted_at DESC
       LIMIT 200`);
    return res.rows.map((r) => ({
      id: r['id']!, submittedAt: r['submitted_at']!, name: r['name']!,
      organisation: r['organisation']!, email: r['email']!, message: r['message']!,
      enquiryType: r['enquiry_type']!, sourcePath: r['source_path']!, status: r['status']!,
    }));
  });
}
