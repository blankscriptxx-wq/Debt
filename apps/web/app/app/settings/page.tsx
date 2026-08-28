import { sql } from '@solvenda/db';
import { query } from '@/lib/console/session';
import { withShell } from '@/lib/console/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader, Stack } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  return withShell('settings', async (session) => {
    const { caseTypes, capabilities, roles } = await query(session, async (db) => {
      const caseTypesRes = await db.execute<{
        key: string; name: string; category: string; jurisdictions: string[];
        status: string; version: number;
      }>(sql`
        SELECT key, name, category, jurisdictions, status, version
          FROM case_type_definitions ORDER BY name`);
      const capabilitiesRes = await db.execute<{
        capability_key: string; enabled: boolean; model: string | null;
        name: string; touches_regulated_fields: boolean;
      }>(sql`
        SELECT c.capability_key, c.enabled, c.model, k.name, k.touches_regulated_fields
          FROM ai_capabilities c
          JOIN ai_capability_catalogue k ON k.key = c.capability_key
         ORDER BY k.name`);
      const rolesRes = await db.execute<{ key: string; name: string; permissions: string }>(sql`
        SELECT r.key, r.name, count(rp.permission_key)::text AS permissions
          FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
         GROUP BY r.key, r.name ORDER BY r.name`);
      return {
        caseTypes: caseTypesRes.rows,
        capabilities: capabilitiesRes.rows,
        roles: rolesRes.rows,
      };
    });

    return (
      <>
        <PageHeader
          eyebrow="Settings"
          title={session.tenant.name}
          meta={<span>Case types, AI capabilities and roles are configuration, not code</span>}
        />

        <Stack gap={5}>
          <Card title="Case types"
                subtitle="Each carries its own stages, evidence, eligibility rules and review cadence"
                padded={false}>
            <DataTable
              rows={caseTypes} getKey={(c) => c.key}
              empty={<EmptyState title="No case types configured." />}
              columns={[
                { key: 'name', header: 'Case type', render: (c) => c.name },
                { key: 'category', header: 'Category',
                  render: (c) => c.category.replace(/-/g, ' ') },
                { key: 'jurisdictions', header: 'Jurisdictions', render: (c) => (
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {c.jurisdictions.map((j) => <Badge key={j}>{j}</Badge>)}
                  </span>
                )},
                { key: 'version', header: 'Version', numeric: true, render: (c) => c.version },
                { key: 'status', header: 'Status', render: (c) => (
                  <Badge tone={c.status === 'active' ? 'positive' : 'neutral'}>{c.status}</Badge>
                )},
              ]}
            />
          </Card>

          <Card title="AI capabilities"
                subtitle="Off by default where the capability touches regulated information"
                padded={false}>
            <DataTable
              rows={capabilities} getKey={(c) => c.capability_key}
              empty={<EmptyState title="No capabilities configured." />}
              columns={[
                { key: 'name', header: 'Capability', render: (c) => c.name },
                { key: 'regulated', header: '', render: (c) =>
                  c.touches_regulated_fields
                    ? <Badge tone="regulated">Regulated</Badge> : null },
                { key: 'enabled', header: 'State', render: (c) => (
                  <Badge tone={c.enabled ? 'positive' : 'neutral'}>
                    {c.enabled ? 'Enabled' : 'Off'}
                  </Badge>
                )},
                { key: 'model', header: 'Model', render: (c) =>
                  c.model ?? <span style={{ color: 'var(--ink-subtle)' }}>Firm default</span> },
              ]}
            />
          </Card>

          <Card title="Roles" padded={false}>
            <DataTable
              rows={roles} getKey={(r) => r.key}
              empty={<EmptyState title="No roles configured." />}
              columns={[
                { key: 'name', header: 'Role', render: (r) => r.name },
                { key: 'permissions', header: 'Permissions', numeric: true,
                  render: (r) => r.permissions },
              ]}
            />
          </Card>
        </Stack>
      </>
    );
  });
}
