import { redirect } from 'next/navigation';
import { sql } from '@solvenda/db';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseDetail } from '@/lib/console/data';
import { loadCaseFileHeader } from '@/lib/console/case-file';
import { Badge, Card, EmptyState, Stack, SummaryBar } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * What the case type requires, and what is missing.
 *
 * Derived rather than stored. The requirements live in the case type
 * definition, so a firm that changes its process changes this list without a
 * release, and a case cannot drift out of step with the rules it is being run
 * under. Advice readiness on the Overview tab is computed from the same source.
 */
export default async function ChecklistTab({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  const header = await query(session, (db) => loadCaseFileHeader(db, id));
  if (!header) redirect('/app/cases');
  const detail = await query(session, (db) => loadCaseDetail(db, id));
  if (!detail) redirect('/app/cases');

  const readiness = detail.intelligence.adviceReadiness;
  const stages = await query(session, async (db) => {
    const res = await db.execute<Record<string, string>>(sql`
      SELECT from_stage, to_stage, entered_at::text, duration_seconds::text, reason
        FROM case_stage_history WHERE case_id = ${id} ORDER BY entered_at`);
    return res.rows;
  });

  // Readiness reports what is blocking and why. Each blocker carries its own
  // reason, which is more use than a tick list: "identity not verified" and
  // "identity document expired" need different actions.
  const blocking = readiness.blocking ?? [];

  return (
    <Stack gap={5}>
      <Card
        title="Advice readiness"
        subtitle="What this case type requires before advice can safely be given. Computed from the definition, not a list someone maintains by hand."
      >
        {blocking.length === 0 ? (
          <EmptyState
            title="Nothing is blocking advice on this case."
            detail="Every requirement this case type sets has been met."
          />
        ) : (
          <ul className="sv-checklist">
            {blocking.map((item) => (
              <li key={item.item} className="sv-checklist__item sv-checklist__item--todo">
                <span aria-hidden="true">○</span>
                <span>
                  <strong>{item.item}</strong><br />
                  <span className="sv-muted">{item.why}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Stage history" subtitle="Every transition, in order.">
        {stages.length === 0 ? (
          <EmptyState title="No stage changes recorded." />
        ) : (
          <ul className="sv-checklist">
            {stages.map((s) => (
              <li key={`${s['to_stage']}-${s['entered_at']}`} className="sv-checklist__item">
                <span>
                  <strong>{s['to_stage']}</strong>
                  {s['from_stage'] && (
                    <span className="sv-muted"> from {s['from_stage']}</span>
                  )}
                  <br />
                  <span className="sv-muted">
                    {new Date(s['entered_at']!).toLocaleDateString('en-GB')}
                    {s['duration_seconds']
                      ? ` · ${Math.round(Number(s['duration_seconds']) / 86400)} days`
                      : ''}
                    {s['reason'] ? ` · ${s['reason']}` : ''}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SummaryBar figures={[
        { label: 'Ready to advise', value: readiness.ready ? 'Yes' : 'No',
          tone: readiness.ready ? 'positive' : 'critical' },
        { label: 'Blocking', value: blocking.length,
          tone: blocking.length ? 'critical' : 'positive',
          detail: blocking.length ? 'Each names what would clear it' : 'Nothing outstanding' },
        {
          label: 'Advice point',
          value: <Badge tone={readiness.isAdvicePoint ? 'regulated' : 'neutral'}>
            {readiness.isAdvicePoint ? 'Reached' : 'Not yet'}
          </Badge>,
          detail: readiness.stage,
        },
      ]} />
    </Stack>
  );
}
