import { requireSession, query, type ConsoleSession } from '@/lib/console/session';
import { loadDashboard } from '@/lib/console/data';
import { AppShell } from '@/components/console/app-shell';

/** Every page needs the same shell with the same live counts. */
export async function withShell(
  current: string,
  render: (session: ConsoleSession) => Promise<React.ReactNode>,
): Promise<React.ReactElement> {
  const session = await requireSession();
  const [dashboard, content] = await Promise.all([
    query(session, (db) => loadDashboard(db, session.user.id)),
    render(session),
  ]);
  return (
    <AppShell
      firmName={session.tenant.name}
      userName={session.user.fullName}
      counts={{ cases: dashboard.openCases, tasks: dashboard.openTasks,
                approvals: dashboard.pendingApprovals }}
      current={current}
    >
      {content}
    </AppShell>
  );
}
