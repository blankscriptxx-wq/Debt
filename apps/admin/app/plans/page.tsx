import { requireOperator } from '@/lib/session';
import { listPlans } from '@/lib/data';
import { ControlShell } from '@/components/shell';
import { Badge, Card, DataTable, EmptyState, Money, PageHeader } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function PlansPage() {
  const session = await requireOperator();
  const plans = await listPlans(session.operatorId);

  return (
    <ControlShell session={session} current="plans">
      <PageHeader eyebrow="Commercial" title="Plans"
                  meta={<span>Pricing and entitlements are configuration, not code</span>} />
      <Card padded={false}>
        <DataTable
          rows={plans} getKey={(p) => p.key}
          empty={<EmptyState title="No plans configured."
                             detail="Plans define platform fee, seats, features and support tier." />}
          columns={[
            { key: 'name', header: 'Plan', render: (p) => (
              <span><strong>{p.name}</strong><br />
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                  {p.description}
                </span>
              </span>
            )},
            { key: 'platform', header: 'Platform fee', numeric: true,
              render: (p) => <span><Money pence={p.platformFeePence} />/mo</span> },
            { key: 'seat', header: 'Per seat', numeric: true,
              render: (p) => <span><Money pence={p.perSeatPence} />/mo</span> },
            { key: 'seats', header: 'Included seats', numeric: true, render: (p) => p.includedSeats },
            { key: 'term', header: 'Min term', numeric: true,
              render: (p) => `${p.minimumTermMonths}m` },
            { key: 'support', header: 'Support', render: (p) => <Badge>{p.supportTier}</Badge> },
            { key: 'subs', header: 'Firms', numeric: true, render: (p) => p.subscribers },
            { key: 'status', header: 'Status', render: (p) => (
              <Badge tone={p.status === 'available' ? 'positive' : 'neutral'}>{p.status}</Badge>
            )},
          ]}
        />
      </Card>
    </ControlShell>
  );
}
