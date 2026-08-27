import Link from 'next/link';
import { requireSession, query } from '@/lib/session';
import { loadDashboard } from '@/lib/data';
import { AppShell } from '@/components/app-shell';
import {
  Badge, Card, DataTable, Grid, Money, PageHeader, StatTile, Stack,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const session = await requireSession();
  const data = await query(session, (db) => loadDashboard(db, session.user.id));

  return (
    <AppShell
      firmName={session.tenant.name}
      userName={session.user.fullName}
      counts={{ cases: data.openCases, tasks: data.openTasks, approvals: data.pendingApprovals }}
      current="overview"
    >
      <PageHeader
        eyebrow="Overview"
        title={`Good to see you, ${session.user.fullName.split(' ')[0]}`}
        meta={<span>{session.tenant.name}</span>}
      />

      <Stack gap={5}>
        <Grid min="200px">
          <StatTile label="Open cases" value={data.openCases} />
          <StatTile label="Reviews overdue" value={data.overdueReviews}
                    tone={data.overdueReviews > 0 ? 'attention' : 'neutral'}
                    footnote="Against each case type's configured cadence" />
          <StatTile label="Tasks overdue" value={data.overdueTasks}
                    tone={data.overdueTasks > 0 ? 'critical' : 'neutral'}
                    change={`${data.openTasks} open in total`} />
          <StatTile label="Awaiting your decision" value={data.regulatedProposals}
                    tone={data.regulatedProposals > 0 ? 'attention' : 'neutral'}
                    footnote="Suggestions affecting regulated information" />
          <StatTile label="Approvals pending" value={data.pendingApprovals} />
          <StatTile label="Blocking compliance failures" value={data.casesNeedingAttention}
                    tone={data.casesNeedingAttention > 0 ? 'critical' : 'positive'} />
        </Grid>

        <Card
          title="Your cases"
          subtitle="Ordered by review date, soonest first"
          actions={<Link className="sv-btn sv-btn--secondary sv-btn--sm" href="/cases">All cases</Link>}
          padded={false}
        >
          <DataTable
            rows={data.recentCases}
            getKey={(row) => row.id}
            onRowHref={(row) => `/cases/${row.id}`}
            empty={<div style={{ padding: 32, textAlign: 'center', color: 'var(--ink-muted)' }}>
              No cases are assigned to you yet.
            </div>}
            columns={[
              { key: 'reference', header: 'Reference', render: (r) => r.reference },
              { key: 'client', header: 'Client', render: (r) => r.clientName },
              { key: 'type', header: 'Type',
                render: (r) => <Badge>{r.caseTypeKey.toUpperCase()}</Badge> },
              { key: 'stage', header: 'Stage', render: (r) => r.stage },
              { key: 'debt', header: 'Debt', numeric: true,
                render: (r) => <Money pence={r.totalDebtPence} /> },
              { key: 'surplus', header: 'Surplus', numeric: true,
                render: (r) => r.surplusPence === null
                  ? <span style={{ color: 'var(--ink-subtle)' }}>—</span>
                  : <Money pence={r.surplusPence} /> },
              { key: 'flags', header: '', render: (r) => (
                <span style={{ display: 'flex', gap: 4 }}>
                  {r.vulnerabilityCount > 0 && <Badge tone="regulated">Support needs</Badge>}
                  {r.openTasks > 0 && <Badge>{r.openTasks} task{r.openTasks === 1 ? '' : 's'}</Badge>}
                </span>
              )},
            ]}
          />
        </Card>
      </Stack>
    </AppShell>
  );
}
