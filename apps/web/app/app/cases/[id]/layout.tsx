import { notFound } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { caseContext } from '@/lib/console/case-context';
import { CASE_SECTIONS, sectionState } from '@/lib/console/case-sections';
import { AppShell } from '@/components/console/app-shell';
import { loadDashboard } from '@/lib/console/data';
import { CaseSpine, type SpineRowData } from '@/components/console/case-spine';
import { Badge } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * The case file.
 *
 * The spine stands beside the work rather than above it, and carries evidence
 * state rather than a row of names: an adviser opening a file asks how well the
 * case is known, and a strip of equal tabs cannot answer that. Case Intelligence
 * sits at its head because it is the reason to use this product, and putting it
 * behind a tab made it something to remember to open.
 */
export default async function CaseLayout({
  children, params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;

  const context = await caseContext(id);
  if (!context) notFound();
  const { header, detail, counts } = context;
  const intel = detail.intelligence;

  const rows: SpineRowData[] = CASE_SECTIONS.map((section) => {
    const state = sectionState(section, detail.evidence);
    return {
      slug: section.slug,
      label: section.label,
      group: section.group,
      state: state?.state ?? null,
      detail: state?.because ?? null,
      count: section.countKey ? counts[section.countKey] : undefined,
    };
  });

  const dashboard = await query(session, (db) => loadDashboard(db, session.user.id));

  return (
    <AppShell
      firmName={session.tenant.name}
      userName={session.user.fullName}
      counts={{ cases: dashboard.openCases, tasks: dashboard.openTasks,
                approvals: dashboard.pendingApprovals }}
      current="cases"
    >
      <header className="sv-casehead">
        <div className="sv-casehead__who">
          <h1 className="sv-casehead__name">{header.clientName}</h1>
          <p className="sv-casehead__meta">
            <span className="sv-casehead__ref">{header.reference}</span>
            <span>{detail.caseTypeName}</span>
            <span>{header.ownerName ?? 'Unassigned'}</span>
          </p>
        </div>
        <div className="sv-casehead__state">
          <Badge tone={header.status === 'open' ? 'positive' : 'neutral'}>{header.status}</Badge>
          <Badge tone="accent">{header.stage}</Badge>
        </div>
      </header>

      <div className="sv-case">
        <CaseSpine
          rows={rows}
          base={`/app/cases/${id}`}
          standing={{
            score: intel.health.score,
            band: intel.health.band,
            summary: intel.health.summary,
            ready: intel.adviceReadiness.ready,
            blockingCount: intel.adviceReadiness.blocking.length,
          }}
        />
        <div className="sv-case__work">{children}</div>
      </div>
    </AppShell>
  );
}
