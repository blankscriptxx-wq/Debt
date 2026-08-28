import { requireOperator } from '@/lib/session';
import { listTenants } from '@/lib/data';
import { ControlShell } from '@/components/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function TenantsPage() {
  const session = await requireOperator();
  const tenants = await listTenants(session.operatorId);

  return (
    <ControlShell session={session} current="tenants">
      <PageHeader eyebrow="Firms" title="Every firm on this deployment"
                  meta={<span>{tenants.length} firms</span>} />
      <div className="ct-warning">
        Counts and configuration are visible here. A firm&rsquo;s client data is not: reading
        that requires a time-boxed grant recorded under Support access.
      </div>
      <Card padded={false}>
        <DataTable
          rows={tenants} getKey={(t) => t.id}
          empty={<EmptyState title="No firms provisioned." />}
          columns={[
            { key: 'name', header: 'Firm', render: (t) => (
              <span>
                <strong>{t.tradingName ?? t.legalName}</strong><br />
                <code style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-subtle)' }}>
                  {t.slug}
                </code>
              </span>
            )},
            { key: 'status', header: 'Status', render: (t) => (
              <Badge tone={t.status === 'active' ? 'positive'
                          : t.status === 'trial' ? 'accent'
                          : t.status === 'suspended' ? 'critical' : 'neutral'}>
                {t.status}
              </Badge>
            )},
            { key: 'plan', header: 'Plan',
              render: (t) => t.planKey ?? <span style={{ color: 'var(--ink-subtle)' }}>None</span> },
            { key: 'jurisdictions', header: 'Jurisdictions', render: (t) => (
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {t.jurisdictions.map((j) => <Badge key={j}>{j}</Badge>)}
              </span>
            )},
            { key: 'region', header: 'Region', render: (t) => t.dataRegion },
            { key: 'users', header: 'Users', numeric: true, render: (t) => t.users },
            { key: 'cases', header: 'Cases', numeric: true,
              render: (t) => `${t.openCases} / ${t.cases}` },
            { key: 'activity', header: 'Last activity', render: (t) => t.lastActivityAt
              ? new Date(t.lastActivityAt).toLocaleDateString('en-GB')
              : <span style={{ color: 'var(--ink-subtle)' }}>Never</span> },
          ]}
        />
      </Card>
    </ControlShell>
  );
}
