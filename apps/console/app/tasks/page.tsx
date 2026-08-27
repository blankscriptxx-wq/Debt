import { query } from '@/lib/session';
import { withShell } from '@/lib/shell';
import { listTasks } from '@/lib/pages';
import { Badge, Card, DataTable, EmptyState, PageHeader } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function TasksPage() {
  return withShell('tasks', async (session) => {
    const tasks = await query(session, (db) => listTasks(db));
    const overdue = tasks.filter((t) => t.overdue).length;

    return (
      <>
        <PageHeader
          eyebrow="Tasks"
          title="Work outstanding"
          meta={
            <>
              <span>{tasks.length} open</span>
              {overdue > 0 && <Badge tone="critical">{overdue} overdue</Badge>}
            </>
          }
        />
        <Card padded={false}>
          <DataTable
            rows={tasks}
            getKey={(t) => t.id}
            onRowHref={(t) => (t.caseId ? `/cases/${t.caseId}` : '#')}
            empty={<EmptyState title="Nothing outstanding."
                               detail="Tasks raised by advisers and by workflows appear here." />}
            columns={[
              { key: 'title', header: 'Task', render: (t) => t.title },
              { key: 'case', header: 'Case',
                render: (t) => t.caseReference ?? '—' },
              { key: 'client', header: 'Client', render: (t) => t.clientName ?? '—' },
              { key: 'priority', header: 'Priority', render: (t) => (
                <Badge tone={t.priority === 'urgent' ? 'critical'
                            : t.priority === 'high' ? 'attention' : 'neutral'}>
                  {t.priority}
                </Badge>
              )},
              { key: 'source', header: 'Raised by', render: (t) => (
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                  {t.createdVia === 'workflow' ? 'Workflow'
                   : t.createdVia === 'ai' ? 'AI observation' : 'Adviser'}
                </span>
              )},
              { key: 'due', header: 'Due', render: (t) => t.dueAt
                ? <span style={{ color: t.overdue ? 'var(--critical)' : undefined }}>
                    {new Date(t.dueAt).toLocaleDateString('en-GB')}
                  </span>
                : '—' },
            ]}
          />
        </Card>
      </>
    );
  });
}
