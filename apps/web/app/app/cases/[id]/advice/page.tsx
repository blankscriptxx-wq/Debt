import { redirect } from 'next/navigation';
import { sql } from '@solvenda/db';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader } from '@/lib/console/case-file';
import {
  Badge, Card, DataTable, EmptyState, RegulatedMark, Stack,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * Advice given.
 *
 * Read-only by design. A decision is recorded through the advice module, which
 * refuses the permission to every non-human principal, requires a current
 * statement and an eligibility evaluation, and demands the alternatives with
 * the reason each was rejected. A database trigger then refuses any later edit
 * to its substance: superseding creates a second record and the original
 * wording survives verbatim.
 *
 * That is why there is no edit form on this page. Making one would mean
 * building a path around the guard rather than through it.
 */
export default async function AdviceTab({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  const header = await query(session, (db) => loadCaseFileHeader(db, id));
  if (!header) redirect('/app/cases');

  const decisions = await query(session, async (db) => {
    const res = await db.execute<Record<string, string | null>>(sql`
      SELECT d.id, d.recommended_case_type, d.rationale, d.client_response,
             d.decided_at::text, d.status, d.supersede_reason,
             d.decided_by_competencies, d.rejected_options,
             u.full_name AS adviser
        FROM advice_decisions d
        LEFT JOIN users u ON u.id = d.decided_by
       WHERE d.case_id = ${id}
       ORDER BY d.decided_at DESC`);
    return res.rows;
  });

  return (
    <Stack gap={5}>
      <Card
        title="Advice decisions"
        subtitle="Recorded by a named person holding the competency, with the alternatives considered. Immutable once made."
      >
        <DataTable
          rows={decisions}
          getKey={(d) => d['id']!}
          empty={
            <EmptyState
              title="No advice recorded on this case."
              detail="A decision needs a current financial statement and an eligibility evaluation before it can be made."
            />
          }
          columns={[
            {
              key: 'solution', header: 'Recommended',
              render: (d) => (
                <span>
                  <RegulatedMark>{d['recommended_case_type']?.toUpperCase()}</RegulatedMark>
                  {d['status'] === 'superseded' && <> <Badge>Superseded</Badge></>}
                </span>
              ),
            },
            { key: 'adviser', header: 'Adviser', render: (d) => d['adviser'] ?? '—' },
            {
              key: 'when', header: 'Decided',
              render: (d) => (d['decided_at']
                ? new Date(d['decided_at']).toLocaleDateString('en-GB') : '—'),
            },
            {
              key: 'response', header: 'Client response',
              render: (d) => <Badge>{d['client_response'] ?? 'no response'}</Badge>,
            },
            {
              key: 'rationale', header: 'Rationale',
              render: (d) => (
                <span className="sv-muted">
                  {(d['rationale'] ?? '').slice(0, 180)}
                  {(d['rationale'] ?? '').length > 180 ? '…' : ''}
                </span>
              ),
            },
            {
              key: 'alternatives', header: 'Alternatives',
              render: (d) => {
                // Recorded as JSON: each rejected option carries its reason,
                // which is the part a file review actually reads.
                const rejected = (d['rejected_options'] ?? '[]') as unknown;
                const list = Array.isArray(rejected) ? rejected : [];
                return <span className="sv-muted">
                  {list.length ? `${list.length} considered and rejected` : '—'}
                </span>;
              },
            },
          ]}
        />
      </Card>

      <Card title="How a decision gets made"
            subtitle="Not a workflow note — these are enforced, and the enforcement is tested.">
        <ul className="sv-list">
          <li>A person makes it. The permission is refused to every API key, workflow
              step and AI capability, whatever it has been granted.</li>
          <li>They hold the competency the firm signed them off for, and have completed a
              second factor in this session.</li>
          <li>A current financial statement and an eligibility evaluation exist. Advice
              without a picture of the finances is not advice.</li>
          <li>The alternatives are recorded, each with why it was rejected.</li>
          <li>Advising against the engine is allowed, and requires a stated override
              reason. The departure is recorded rather than smoothed over.</li>
        </ul>
      </Card>
    </Stack>
  );
}
