import { query } from '@/lib/session';
import { withShell } from '@/lib/shell';
import { loadAnalytics } from '@/lib/pages';
import {
  Card, DataTable, EmptyState, Grid, Money, PageHeader, Stack, StatTile,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage() {
  return withShell('analytics', async (session) => {
    const data = await query(session, (db) => loadAnalytics(db));
    const aiCost = data.aiUsage.reduce((sum, a) => sum + a.costPence, 0);
    const aiCalls = data.aiUsage.reduce((sum, a) => sum + a.invocations, 0);

    return (
      <>
        <PageHeader eyebrow="Analytics" title="How the book is performing" />

        <Stack gap={5}>
          <Grid min="200px">
            <StatTile label="Debt under management"
                      value={<Money pence={data.totalDebtPence} />} />
            <StatTile label="Median surplus"
                      value={data.medianSurplusPence === null
                        ? '—' : <Money pence={data.medianSurplusPence} />}
                      footnote="Across current financial statements" />
            <StatTile label="AI invocations" value={aiCalls}
                      footnote={`${aiCost === 0 ? 'No model cost recorded' : `£${(aiCost / 100).toFixed(2)} to date`}`} />
          </Grid>

          <Grid min="320px">
            <Card title="Cases by stage" padded={false}>
              <DataTable rows={data.casesByStage} getKey={(r) => r.stage}
                empty={<EmptyState title="No open cases." />}
                columns={[
                  { key: 'stage', header: 'Stage', render: (r) => r.stage },
                  { key: 'n', header: 'Cases', numeric: true, render: (r) => r.count },
                ]} />
            </Card>

            <Card title="Solution mix"
                  subtitle="What was actually advised"
                  padded={false}>
              <DataTable rows={data.solutionOutcomes} getKey={(r) => r.solution}
                empty={<EmptyState title="No advice decisions recorded yet."
                                   detail="Solution distribution appears once advice is being given." />}
                columns={[
                  { key: 'solution', header: 'Solution',
                    render: (r) => r.solution.toUpperCase() },
                  { key: 'n', header: 'Cases', numeric: true, render: (r) => r.count },
                ]} />
            </Card>

            <Card title="Case types" padded={false}>
              <DataTable rows={data.casesByType} getKey={(r) => r.caseType}
                empty={<EmptyState title="No cases." />}
                columns={[
                  { key: 'type', header: 'Type', render: (r) => r.caseType.toUpperCase() },
                  { key: 'n', header: 'Cases', numeric: true, render: (r) => r.count },
                ]} />
            </Card>

            <Card title="Communications" padded={false}>
              <DataTable rows={data.commsByChannel} getKey={(r) => r.channel}
                empty={<EmptyState title="Nothing sent or received yet." />}
                columns={[
                  { key: 'channel', header: 'Channel', render: (r) => r.channel },
                  { key: 'out', header: 'Sent', numeric: true, render: (r) => r.outbound },
                  { key: 'in', header: 'Received', numeric: true, render: (r) => r.inbound },
                ]} />
            </Card>

            <Card title="Automation" subtitle="Workflow runs by outcome" padded={false}>
              <DataTable rows={data.workflowRuns} getKey={(r) => r.workflow}
                empty={<EmptyState title="No workflow runs yet." />}
                columns={[
                  { key: 'workflow', header: 'Workflow', render: (r) => r.workflow },
                  { key: 'completed', header: 'Completed', numeric: true, render: (r) => r.completed },
                  { key: 'waiting', header: 'In flight', numeric: true, render: (r) => r.waiting },
                  { key: 'failed', header: 'Failed', numeric: true, render: (r) => r.failed },
                ]} />
            </Card>

            <Card title="AI usage"
                  subtitle="What was suggested, and what advisers did with it"
                  padded={false}>
              <DataTable rows={data.aiUsage} getKey={(r) => r.capability}
                empty={<EmptyState title="No AI capabilities have run yet." />}
                columns={[
                  { key: 'capability', header: 'Capability',
                    render: (r) => r.capability.replace(/-/g, ' ') },
                  { key: 'n', header: 'Runs', numeric: true, render: (r) => r.invocations },
                  { key: 'cost', header: 'Cost', numeric: true,
                    render: (r) => <Money pence={r.costPence} /> },
                ]} />
            </Card>
          </Grid>
        </Stack>
      </>
    );
  });
}
