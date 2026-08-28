import { requireOperator } from '@/lib/session';
import { listSecurityActivity } from '@/lib/data';
import { ControlShell } from '@/components/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader, Stack } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  const session = await requireOperator();
  const activity = await listSecurityActivity(session.operatorId);

  return (
    <ControlShell session={session} current="activity">
      <PageHeader
        eyebrow="Activity"
        title="Security and regulated events"
        meta={<span>Across every firm, most recent first</span>}
      />
      <Stack gap={4}>
        <Card>
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            Deliberately limited to security and regulated events. An operator has no business
            browsing ordinary case activity, and the query that backs this page cannot return
            it.
          </p>
        </Card>
        <Card padded={false}>
          <DataTable
            rows={activity} getKey={(a) => a.id}
            empty={<EmptyState title="No security or regulated events recorded." />}
            columns={[
              { key: 'when', header: 'When',
                render: (a) => new Date(a.occurredAt).toLocaleString('en-GB',
                  { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
              { key: 'tenant', header: 'Firm', render: (a) => <code>{a.tenantSlug}</code> },
              { key: 'action', header: 'Action', render: (a) => a.action },
              { key: 'severity', header: 'Severity', render: (a) => (
                <Badge tone={a.severity === 'security' ? 'critical' : 'regulated'}>
                  {a.severity}
                </Badge>
              )},
              { key: 'actor', header: 'By', render: (a) => a.actor },
              { key: 'reason', header: 'Why', render: (a) => (
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                  {a.reason ?? '—'}
                </span>
              )},
            ]}
          />
        </Card>
      </Stack>
    </ControlShell>
  );
}
