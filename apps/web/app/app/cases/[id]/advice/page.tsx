import { redirect } from 'next/navigation';
import { sql } from '@solvenda/db';
import { requireSession, query } from '@/lib/console/session';
import { caseContext } from '@/lib/console/case-context';
import {
  recordAdviceDecision, supersedeAdviceDecision, saveEligibilityEvaluation,
  AdviceValidationError,
} from '@solvenda/core';
import {
  Badge, Card, DataTable, EmptyState, Field, Form, RegulatedMark, Stack,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const RESPONSES = ['accepted', 'declined', 'deferred', 'considering', 'no-response'];

/**
 * Advice given, and giving it.
 *
 * The decision goes through `recordAdviceDecision`, which refuses the
 * permission to every non-human principal, requires a current statement and a
 * recorded eligibility evaluation, and demands each alternative with the reason
 * it was rejected. A database trigger then refuses any later edit to its
 * substance: superseding creates a second record and the original wording
 * survives verbatim.
 *
 * The form exists to feed that function, not to work around it. Nothing posted
 * from the browser decides anything: the eligibility the decision is judged
 * against is recomputed on the server at submit, written down, and the decision
 * recorded against that row in the same transaction — so what the adviser was
 * shown and what the file says they were shown cannot come apart. Every refusal
 * the module raises is shown verbatim rather than summarised, because the
 * wording is what tells the adviser what to do about it.
 */
export default async function AdviceTab({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { saved, error } = await searchParams;

  const context = await caseContext(id);
  if (!context) redirect('/app/cases');
  const { header, detail } = context;
  const eligibility = detail.intelligence.eligibility;

  async function record(form: FormData) {
    'use server';
    const active = await requireSession();
    try {
      const recommended = String(form.get('recommended') ?? '');
      if (!recommended) throw new AdviceValidationError(['Choose the solution being recommended']);
      const supersedes = String(form.get('supersedes') ?? '');

      // Which options were on the table, and why each other one was not chosen.
      const considered = eligibility.assessments
        .map((a) => a.caseTypeKey)
        .filter((key) => key === recommended || form.get(`considered:${key}`) === 'on');
      const rejectedOptions = considered
        .filter((key) => key !== recommended)
        .map((key) => ({
          caseTypeKey: key,
          reason: String(form.get(`why-not:${key}`) ?? '').trim(),
        }));

      await query(active, async (db) => {
        // Recomputed and written down here rather than carried through the
        // form: a posted evaluation is something the browser could have
        // changed, and this row is the basis the decision will be judged on.
        const evaluationId = await saveEligibilityEvaluation(db, active.context, {
          caseId: id,
          statementId: detail.statementId,
          result: eligibility,
        });

        const decision = {
          caseId: id,
          clientId: header.clientId,
          recommendedCaseType: recommended,
          rationale: String(form.get('rationale') ?? ''),
          optionsConsidered: considered,
          rejectedOptions,
          risksExplained: String(form.get('risks') ?? '')
            .split('\n').map((r) => r.trim()).filter(Boolean),
          statementId: detail.statementId,
          eligibilityEvaluationId: evaluationId,
          clientResponse: (String(form.get('clientResponse') ?? 'no-response')
            || 'no-response') as 'accepted',
          overrideReason: String(form.get('overrideReason') ?? '') || undefined,
        };

        // Correcting advice is superseding it. The original wording survives
        // and the replacement says what changed, which is the only way the
        // file can show what the client was told and when.
        if (supersedes) {
          await supersedeAdviceDecision(db, active.context, active.principal, {
            previousDecisionId: supersedes,
            reason: String(form.get('supersedeReason') ?? ''),
            replacement: decision,
          }, eligibility);
        } else {
          await recordAdviceDecision(db, active.context, active.principal,
                                     decision, eligibility);
        }
      });
    } catch (cause) {
      console.error('advice decision failed', cause);
      // The module returns every problem at once, and each one names what to
      // do. Collapsing them to "invalid" would make the adviser guess.
      const message = cause instanceof AdviceValidationError
        ? cause.issues.join(' · ')
        : 'The decision could not be recorded. Nothing was changed.';
      redirect(`/app/cases/${id}/advice?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/advice?saved=1`);
  }

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

  const ruledOut = eligibility.assessments.filter((a) => !a.available).map((a) => a.caseTypeKey);
  // At most one decision stands at a time. While one does, this form replaces
  // it rather than adding a second, because two live recommendations on one
  // case is not a state anyone could act on.
  const active = decisions.find((d) => d['status'] === 'active');

  return (
    <Stack gap={5}>
      <Form action={record} submitLabel={active ? "Supersede with this advice" : "Record this advice"}
            result={saved
              ? { ok: true, message: active
                  ? 'Advice superseded. The previous decision is kept exactly as it was written.'
                  : 'Advice recorded. It cannot be edited — a correction supersedes it.' }
              : error ? { ok: false, message: error } : null}>
        <Card title={active ? 'Replace the advice on this case' : 'Record advice'}
              subtitle="A person makes this decision, holding the competency, and it is immutable once made.">
          <p className="sv-muted" style={{ marginTop: 0 }}>
            Choose what is being recommended, tick every other solution that was genuinely
            on the table, and say why each was not chosen. A file review reads the reasons,
            not the recommendation.
          </p>

          {active && (
            <>
              <input type="hidden" name="supersedes" value={active['id']!} />
              <p className="sv-form__result" role="status">
                <strong>{active['recommended_case_type']?.toUpperCase()}</strong> was recorded
                on this case{active['decided_at']
                  ? ` on ${new Date(active['decided_at']).toLocaleDateString('en-GB')}` : ''}.
                Recording new advice supersedes it. The original wording is kept exactly as
                it was written.
              </p>
              <Field label="What changed"
                     hint="At least 20 characters. This is what a file review reads first.">
                <textarea className="sv-input" name="supersedeReason" rows={2}
                          placeholder="What changed since the previous advice was given." />
              </Field>
            </>
          )}

          <table className="sv-table">
            <thead>
              <tr>
                <th>Recommend</th><th>Considered</th><th>Solution</th>
                <th>Eligibility</th><th>Why not this one</th>
              </tr>
            </thead>
            <tbody>
              {eligibility.assessments.map((a) => (
                <tr key={a.caseTypeKey}>
                  <td><input type="radio" name="recommended" value={a.caseTypeKey}
                             aria-label={`Recommend ${a.caseTypeKey}`} /></td>
                  <td><input type="checkbox" name={`considered:${a.caseTypeKey}`}
                             aria-label={`Considered ${a.caseTypeKey}`} /></td>
                  <td><strong>{a.caseTypeKey.toUpperCase()}</strong></td>
                  <td>
                    {a.available
                      ? <Badge tone="positive">Available</Badge>
                      : <Badge tone="attention">Ruled out</Badge>}
                  </td>
                  <td>
                    <input className="sv-input sv-input--sm" name={`why-not:${a.caseTypeKey}`}
                           placeholder="Why not"
                           aria-label={`Why not ${a.caseTypeKey}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <Field label="Rationale"
                 hint="At least 40 characters, explaining why this solution suits this client.">
            <textarea className="sv-input" name="rationale" rows={4}
                      placeholder="Why this solution, for this person, on these figures." />
          </Field>

          <Field label="Risks explained to the client" hint="One per line.">
            <textarea className="sv-input" name="risks" rows={3}
                      placeholder={'Interest may not be frozen by every creditor\nThe plan is informal'} />
          </Field>

          <Field label="Client response">
            <select className="sv-input" name="clientResponse" defaultValue="no-response">
              {RESPONSES.map((r) => <option key={r} value={r}>{r.replace('-', ' ')}</option>)}
            </select>
          </Field>

          <Field label="Override reason"
                 hint={ruledOut.length
                   ? `Required if you recommend one the engine ruled out: ${ruledOut.join(', ').toUpperCase()}. At least 20 characters.`
                   : 'Only needed when advising a solution the engine ruled out.'}>
            <textarea className="sv-input" name="overrideReason" rows={2}
                      placeholder="Why this is right for this client despite the rule it fails." />
          </Field>

          {!detail.statementId && (
            <p className="sv-form__result sv-form__result--error" role="alert">
              There is no current financial statement on this case, so advice cannot be
              recorded yet. Complete the income and expenditure first.
            </p>
          )}
        </Card>
      </Form>

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
