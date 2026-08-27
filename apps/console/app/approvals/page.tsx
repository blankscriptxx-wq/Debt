import { query } from '@/lib/session';
import { withShell } from '@/lib/shell';
import { listApprovals } from '@/lib/pages';
import { Card, EmptyState, PageHeader, RegulatedMark, Stack, Badge } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  return withShell('approvals', async (session) => {
    const approvals = await query(session, (db) => listApprovals(db));
    const regulated = approvals.filter((a) => a.regulated).length;

    return (
      <>
        <PageHeader
          eyebrow="Approvals"
          title="Waiting on a person"
          meta={
            <>
              <span>{approvals.length} pending</span>
              {regulated > 0 && (
                <Badge tone="regulated">{regulated} affecting regulated information</Badge>
              )}
            </>
          }
        />

        {approvals.length === 0 ? (
          <Card><EmptyState
            title="Nothing is waiting for a decision."
            detail="Workflows pause here whenever they reach a point that needs a person." />
          </Card>
        ) : (
          <Stack gap={3}>
            {approvals.map((approval) => (
              <Card key={approval.id}
                    title={approval.title}
                    subtitle={approval.workflowName
                      ? `Raised by "${approval.workflowName}"` : undefined}
                    actions={approval.regulated ? <RegulatedMark /> : undefined}>
                <p style={{ margin: 0, color: 'var(--ink-muted)' }}>{approval.detail}</p>
                <div style={{ display: 'flex', gap: 16, marginTop: 'var(--space-3)',
                              fontSize: 'var(--text-sm)', flexWrap: 'wrap' }}>
                  {approval.caseReference && (
                    <a href={`/cases/${approval.caseId}`}>{approval.caseReference}</a>
                  )}
                  {approval.clientName && <span>{approval.clientName}</span>}
                  <span style={{ color: 'var(--ink-subtle)' }}>
                    Requires <code>{approval.requiredPermission}</code>
                  </span>
                  {approval.dueAt && (
                    <span style={{ color: new Date(approval.dueAt) < new Date()
                      ? 'var(--critical)' : 'var(--ink-subtle)' }}>
                      Due {new Date(approval.dueAt).toLocaleDateString('en-GB')}
                    </span>
                  )}
                </div>
                {approval.regulated && (
                  <p style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-sm)',
                              color: 'var(--regulated)' }}>
                    This decision affects regulated information, so it can only be made by a
                    person holding the competency for it. Automation cannot resolve it.
                  </p>
                )}
              </Card>
            ))}
          </Stack>
        )}
      </>
    );
  });
}
