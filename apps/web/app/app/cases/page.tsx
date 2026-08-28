import { requireSession, query } from '@/lib/console/session';
import { listCases, loadDashboard } from '@/lib/console/data';
import { AppShell } from '@/components/console/app-shell';
import { Badge, Card, DataTable, Money, PageHeader } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function CasesPage({
  searchParams,
}: { searchParams: Promise<{ q?: string; mine?: string }> }) {
  const session = await requireSession();
  const { q, mine } = await searchParams;

  const [cases, dashboard] = await Promise.all([
    query(session, (db) => listCases(db, {
      search: q, ownerId: mine === '1' ? session.user.id : null, limit: 100,
    })),
    query(session, (db) => loadDashboard(db, session.user.id)),
  ]);

  return (
    <AppShell
      firmName={session.tenant.name}
      userName={session.user.fullName}
      counts={{ cases: dashboard.openCases, tasks: dashboard.openTasks,
                approvals: dashboard.pendingApprovals }}
      current="cases"
    >
      <PageHeader
        eyebrow="Cases"
        title={mine === '1' ? 'My cases' : 'All open cases'}
        meta={<span>{cases.length} shown{q ? ` matching “${q}”` : ''}</span>}
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <form method="get" style={{ display: 'flex', gap: 8 }}>
              <input className="sv-input" name="q" defaultValue={q ?? ''}
                     placeholder="Reference, name or postcode"
                     style={{ width: 260 }} aria-label="Filter cases" />
              <button className="sv-btn sv-btn--secondary sv-btn--md" type="submit">Filter</button>
            </form>
            <a className="sv-btn sv-btn--primary sv-btn--md" href="/app/cases/new">Open a case</a>
          </div>
        }
      />

      <Card padded={false}>
        <DataTable
          rows={cases}
          getKey={(row) => row.id}
          onRowHref={(row) => `/app/cases/${row.id}`}
          columns={[
            { key: 'reference', header: 'Reference', render: (r) => r.reference, width: '130px' },
            { key: 'client', header: 'Client', render: (r) => r.clientName },
            { key: 'type', header: 'Type',
              render: (r) => <Badge>{r.caseTypeKey.toUpperCase()}</Badge>, width: '90px' },
            { key: 'stage', header: 'Stage', render: (r) => r.stage },
            { key: 'owner', header: 'Adviser',
              render: (r) => r.ownerName ?? <span style={{ color: 'var(--ink-subtle)' }}>Unassigned</span> },
            { key: 'debt', header: 'Debt', numeric: true,
              render: (r) => <Money pence={r.totalDebtPence} /> },
            { key: 'surplus', header: 'Surplus', numeric: true,
              render: (r) => r.surplusPence === null
                ? <span style={{ color: 'var(--ink-subtle)' }}>—</span>
                : <Money pence={r.surplusPence} /> },
            { key: 'review', header: 'Review due',
              render: (r) => r.nextReviewDue ?? <span style={{ color: 'var(--ink-subtle)' }}>—</span> },
            { key: 'flags', header: '', render: (r) => (
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {r.vulnerabilityCount > 0 && <Badge tone="regulated">Support needs</Badge>}
                {r.openTasks > 0 && <Badge>{r.openTasks}</Badge>}
              </span>
            )},
          ]}
        />
      </Card>
    </AppShell>
  );
}
