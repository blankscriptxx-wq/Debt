import { notFound } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, loadTabCounts } from '@/lib/console/case-file';
import { AppShell } from '@/components/console/app-shell';
import { loadDashboard } from '@/lib/console/data';
import { PageHeader } from '@solvenda/ui';
import { CaseTabs } from '@/components/console/case-tabs';

export const dynamic = 'force-dynamic';

/**
 * The case file.
 *
 * Eleven tabs over one case, sharing this header and strip so an adviser never
 * loses their place. The counts are on the strip because the commonest question
 * when picking a file back up is "what is left", and answering it should not
 * require opening every tab.
 */
export default async function CaseLayout({
  children, params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const header = await query(session, (db) => loadCaseFileHeader(db, id));
  if (!header) notFound();

  const [counts, dashboard] = await Promise.all([
    query(session, (db) => loadTabCounts(db, id, header.clientId)),
    query(session, (db) => loadDashboard(db, session.user.id)),
  ]);

  const base = `/app/cases/${id}`;
  const tabs = [
    { slug: '', label: 'Overview' },
    { slug: 'client', label: 'Client details' },
    { slug: 'living', label: 'Living arrangements', count: counts['household'] },
    { slug: 'employment', label: 'Employment', count: counts['employment'] },
    { slug: 'assets', label: 'Assets', count: counts['assets'] },
    { slug: 'debts', label: 'Debts', count: counts['debts'] },
    { slug: 'finances', label: 'I&E (SFS)' },
    { slug: 'advice', label: 'Advice' },
    { slug: 'verification', label: 'Verification', count: counts['verification'] },
    { slug: 'appointments', label: 'Appointments', count: counts['appointments'] },
    { slug: 'checklist', label: 'Checklist' },
    { slug: 'messenger', label: 'Messenger', count: counts['messages'] },
  ];

  return (
    <AppShell
      firmName={session.tenant.name}
      userName={session.user.fullName}
      counts={{ cases: dashboard.openCases, tasks: dashboard.openTasks,
                approvals: dashboard.pendingApprovals }}
      current="cases"
    >
      <PageHeader
        eyebrow={header.caseTypeKey.toUpperCase()}
        title={`${header.clientName}, ${header.reference}`}
        meta={
          <>
            <span>Stage: <strong>{header.stage}</strong></span>
            <span>Adviser: {header.ownerName ?? 'Unassigned'}</span>
            <span>{header.status}</span>
          </>
        }
      />
      <CaseTabs tabs={tabs} base={base} />
      {children}
    </AppShell>
  );
}
