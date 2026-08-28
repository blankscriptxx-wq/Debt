import { requireOperator } from '@/lib/control/session';
import { listAccessGrants } from '@/lib/control/data';
import { ControlShell } from '@/components/control/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader, Stack } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * Support access.
 *
 * Reading a firm's client data is a privileged act, so it is granted in advance
 * with a reason and an expiry rather than justified afterwards. This page is
 * the record, and it is the page a customer's compliance officer would want to
 * see during due diligence.
 */
export default async function AccessPage() {
  const session = await requireOperator();
  const grants = await listAccessGrants(session.operatorId);
  const active = grants.filter((g) => g.active).length;

  return (
    <ControlShell session={session} current="access">
      <PageHeader
        eyebrow="Support access"
        title="Who can see a firm's data, and why"
        meta={
          <>
            <span>{grants.length} grants recorded</span>
            {active > 0 && <Badge tone="attention">{active} active now</Badge>}
          </>
        }
      />
      <Stack gap={4}>
        <Card>
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            An operator holds no permissions inside a firm: the authorisation engine refuses
            every tenant permission to an operator principal, so support access is read access
            for diagnosis, never the ability to act on a case. Grants are time-boxed to a
            maximum of eight hours, require a specific reason, and write access additionally
            requires a second operator to approve.
          </p>
        </Card>
        <Card padded={false}>
          <DataTable
            rows={grants} getKey={(g) => g.id}
            empty={<EmptyState title="No support access has ever been granted."
                               detail="Every future grant will be recorded here." />}
            columns={[
              { key: 'operator', header: 'Operator', render: (g) => g.operatorName },
              { key: 'tenant', header: 'Firm', render: (g) => <code>{g.tenantSlug}</code> },
              { key: 'scope', header: 'Scope', render: (g) => (
                <Badge tone={g.scope === 'write' ? 'critical' : 'neutral'}>{g.scope}</Badge>
              )},
              { key: 'reason', header: 'Reason', render: (g) => (
                <span style={{ fontSize: 'var(--text-sm)' }}>{g.reason}</span>
              )},
              { key: 'granted', header: 'Granted',
                render: (g) => new Date(g.grantedAt).toLocaleString('en-GB',
                  { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
              { key: 'state', header: 'State', render: (g) => (
                <Badge tone={g.active ? 'attention' : 'neutral'}>
                  {g.revokedAt ? 'Revoked' : g.active ? 'Active' : 'Expired'}
                </Badge>
              )},
            ]}
          />
        </Card>
      </Stack>
    </ControlShell>
  );
}
