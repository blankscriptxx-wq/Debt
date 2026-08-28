import { requireOperator } from '@/lib/session';
import { listCapabilities } from '@/lib/data';
import { ControlShell } from '@/components/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader, RegulatedMark, Stack } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * AI capability oversight.
 *
 * The acceptance rate matters more than the invocation count. A capability
 * whose suggestions are consistently rejected is producing noise, and that is
 * something the platform operator should see across firms rather than each firm
 * discovering separately.
 */
export default async function CapabilitiesPage() {
  const session = await requireOperator();
  const capabilities = await listCapabilities(session.operatorId);

  return (
    <ControlShell session={session} current="capabilities">
      <PageHeader eyebrow="AI" title="Capabilities"
                  meta={<span>What is enabled, what it costs, and what advisers do with it</span>} />
      <Stack gap={4}>
        <Card padded={false}>
          <DataTable
            rows={capabilities} getKey={(c) => c.key}
            empty={<EmptyState title="Catalogue not published." />}
            columns={[
              { key: 'name', header: 'Capability', render: (c) => (
                <span><strong>{c.name}</strong><br />
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                    {c.description}
                  </span>
                </span>
              )},
              { key: 'regulated', header: '', render: (c) =>
                c.touchesRegulated ? <RegulatedMark /> : null },
              { key: 'default', header: 'Default', render: (c) => (
                <Badge tone={c.defaultEnabled ? 'positive' : 'neutral'}>
                  {c.defaultEnabled ? 'On' : 'Off'}
                </Badge>
              )},
              { key: 'firms', header: 'Firms using', numeric: true,
                render: (c) => c.enabledTenants },
              { key: 'runs', header: 'Runs', numeric: true, render: (c) => c.invocations },
              { key: 'failures', header: 'Failures', numeric: true, render: (c) =>
                c.failures > 0
                  ? <span style={{ color: 'var(--critical)' }}>{c.failures}</span> : 0 },
              { key: 'outcome', header: 'Accepted / rejected', render: (c) => {
                const total = c.acceptedProposals + c.rejectedProposals;
                if (total === 0) return <span style={{ color: 'var(--ink-subtle)' }}>—</span>;
                const rate = Math.round((c.acceptedProposals / total) * 100);
                return (
                  <span>
                    {c.acceptedProposals} / {c.rejectedProposals}{' '}
                    <Badge tone={rate >= 60 ? 'positive' : rate >= 30 ? 'attention' : 'critical'}>
                      {rate}% accepted
                    </Badge>
                  </span>
                );
              }},
            ]}
          />
        </Card>
        <Card title="Why acceptance rate is the number that matters">
          <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
            Invocation counts say how much a capability is used. Acceptance rate says whether it
            is any good. A capability whose suggestions advisers consistently reject is
            producing work rather than saving it, and the platform should see that across firms
            rather than each firm discovering it separately and quietly turning it off.
          </p>
        </Card>
      </Stack>
    </ControlShell>
  );
}
