import { sql } from '@solvenda/db';
import { query } from '@/lib/session';
import { withShell } from '@/lib/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader, Stack } from '@solvenda/ui';
import { parseWorkflowDefinition } from '@solvenda/workflow';
import { isRegulatedPermission } from '@solvenda/auth';

export const dynamic = 'force-dynamic';

export default async function WorkflowsPage() {
  return withShell('workflows', async (session) => {
    const rows = await query(session, async (db) => {
      const res = await db.execute<{
        id: string; key: string; name: string; description: string; status: string;
        trigger_event: string; version: number; definition: unknown;
        runs: string; failed: string;
      }>(sql`
        SELECT w.id, w.key, w.name, w.description, w.status, w.trigger_event, w.version,
               w.definition,
               (SELECT count(*) FROM workflow_runs r WHERE r.definition_id = w.id)::text AS runs,
               (SELECT count(*) FROM workflow_runs r
                 WHERE r.definition_id = w.id AND r.status = 'failed')::text AS failed
          FROM workflow_definitions w ORDER BY w.name`);
      return res.rows;
    });

    const workflows = rows.map((r) => {
      let stepCount = 0;
      let approvals: string[] = [];
      try {
        const definition = parseWorkflowDefinition(r.definition);
        stepCount = definition.steps.length;
        approvals = definition.steps
          .filter((s) => s.type === 'approval')
          .map((s) => (s as { requiredPermission: string }).requiredPermission);
      } catch { /* an invalid stored definition is shown as such below */ }
      return { ...r, stepCount, approvals, runs: Number(r.runs), failed: Number(r.failed) };
    });

    return (
      <>
        <PageHeader
          eyebrow="Workflows"
          title="Automation"
          meta={<span>Configured as data. Changing one needs no release.</span>}
        />

        <Stack gap={4}>
          <Card padded={false}>
            <DataTable
              rows={workflows}
              getKey={(w) => w.id}
              empty={<EmptyState title="No workflows configured." />}
              columns={[
                { key: 'name', header: 'Workflow', render: (w) => (
                  <span>
                    <strong>{w.name}</strong>
                    <br />
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                      {w.description}
                    </span>
                  </span>
                )},
                { key: 'trigger', header: 'Trigger',
                  render: (w) => <code style={{ fontSize: 'var(--text-sm)' }}>{w.trigger_event}</code> },
                { key: 'steps', header: 'Steps', numeric: true, render: (w) => w.stepCount },
                { key: 'gates', header: 'Human gates', render: (w) =>
                  w.approvals.length === 0
                    ? <span style={{ color: 'var(--ink-subtle)' }}>None</span>
                    : <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {w.approvals.map((p) => (
                          <Badge key={p} tone={isRegulatedPermission(p) ? 'regulated' : 'neutral'}>
                            {p}
                          </Badge>
                        ))}
                      </span>
                },
                { key: 'runs', header: 'Runs', numeric: true, render: (w) => w.runs },
                { key: 'failed', header: 'Failed', numeric: true, render: (w) =>
                  w.failed > 0 ? <span style={{ color: 'var(--critical)' }}>{w.failed}</span> : 0 },
                { key: 'status', header: 'Status', render: (w) => (
                  <Badge tone={w.status === 'active' ? 'positive' : 'neutral'}>{w.status}</Badge>
                )},
              ]}
            />
          </Card>

          <Card title="How the engine treats regulated information">
            <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
              A workflow step configured to change regulated information does not change it. The
              engine raises a proposal or an approval instead, and only a person holding the
              relevant competency can resolve it. That is enforced in the engine rather than left
              to whoever configures the workflow, so a step written in good faith cannot
              accidentally issue advice.
            </p>
          </Card>
        </Stack>
      </>
    );
  });
}
