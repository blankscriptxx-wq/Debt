import { requireOperator } from '@/lib/control/session';
import { loadHealth } from '@/lib/control/data';
import { ControlShell } from '@/components/control/shell';
import { Badge, Card, Grid, PageHeader, Stack, StatTile } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function HealthPage() {
  const session = await requireOperator();
  const health = await loadHealth(session.operatorId);

  const problems = [
    health.chainOk ? null : `Audit chain integrity failure: ${health.chainDetail}`,
    health.deadJobs > 0 ? `${health.deadJobs} jobs exhausted their retries` : null,
    health.failedWorkflows > 0 ? `${health.failedWorkflows} workflow runs failed` : null,
    health.failingWebhooks > 0 ? `${health.failingWebhooks} webhook endpoints failing or disabled` : null,
    health.aiFailures > 0 ? `${health.aiFailures} AI invocations failed` : null,
  ].filter(Boolean) as string[];

  return (
    <ControlShell session={session} current="health">
      <PageHeader
        eyebrow="Platform"
        title="Health"
        meta={<span>Across every firm on this deployment</span>}
      />

      <Stack gap={5}>
        {problems.length > 0 ? (
          <div className="ct-warning">
            <strong>{problems.length} thing{problems.length === 1 ? '' : 's'} needs attention</strong>
            <ul style={{ margin: 'var(--space-2) 0 0', paddingLeft: '1.2rem' }}>
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        ) : (
          <Card>
            <p style={{ margin: 0, color: 'var(--positive)' }}>
              Nothing needs attention. Audit chains verify across every firm, no jobs are dead,
              no workflows have failed and every webhook endpoint is healthy.
            </p>
          </Card>
        )}

        <Card title="Audit ledger"
              subtitle="Recomputed across every firm on every load - an operator should learn about a broken ledger here, not from a customer">
          <div style={{ display: 'flex', gap: 'var(--space-4)', alignItems: 'center' }}>
            <Badge tone={health.chainOk ? 'positive' : 'critical'}>
              {health.chainOk ? 'All chains verify' : 'Integrity failure'}
            </Badge>
            <span>{health.auditEntries.toLocaleString('en-GB')} entries</span>
          </div>
          {!health.chainOk && (
            <p style={{ color: 'var(--critical)', marginBottom: 0 }}>{health.chainDetail}</p>
          )}
        </Card>

        <Grid min="180px">
          <StatTile label="Firms" value={health.tenants}
                    footnote={`${health.activeTenants} active or in trial`} />
          <StatTile label="Users" value={health.users} />
          <StatTile label="Cases" value={health.cases} />
          <StatTile label="Audit entries" value={health.auditEntries} />
          <StatTile label="Dead jobs" value={health.deadJobs}
                    tone={health.deadJobs > 0 ? 'critical' : 'positive'}
                    footnote="Exhausted retries; visible rather than dropped" />
          <StatTile label="Failed workflows" value={health.failedWorkflows}
                    tone={health.failedWorkflows > 0 ? 'attention' : 'positive'} />
          <StatTile label="AI invocations" value={health.aiInvocations}
                    footnote={`${health.aiFailures} failed`} />
          <StatTile label="Regulated suggestions pending"
                    value={health.pendingRegulatedProposals}
                    footnote="Awaiting a person, across all firms" />
        </Grid>

        <Card title="Schema">
          <p style={{ margin: 0 }}>
            {health.migrationsApplied} migrations applied.
            {health.latestMigration && <> Latest: <code>{health.latestMigration}</code>.</>}
          </p>
          <p style={{ marginBottom: 0, color: 'var(--ink-muted)' }}>
            Migrations are immutable and checksummed: an applied migration that has since been
            edited fails the next run rather than being silently skipped.
          </p>
        </Card>
      </Stack>
    </ControlShell>
  );
}
