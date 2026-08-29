import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';

/**
 * The proposal gate.
 *
 * AI output that would change anything on a case becomes a proposal. A proposal
 * is a record of what the model suggested and why; it changes nothing on its
 * own. Someone decides.
 *
 * For a proposal touching regulated information the someone must be a person:
 * `ai:accept_proposal` is a regulated permission, and the authorisation engine
 * refuses it to API keys, workflows and AI principals regardless of how they
 * are configured. This is the mechanism that keeps a system which analyses bank
 * data, drafts rationales and flags vulnerability signals on the correct side of
 * the line between assisting an adviser and giving advice.
 */

export interface ProposalInput {
  invocationId: string;
  caseId?: string | null;
  /**
   * Who the proposal is about, when that is not answered by the case.
   *
   * A client with no open case, or with two, still has one set of support
   * needs. Without this the proposal is reachable only through `case_id`, and a
   * signal raised at either of those moments would be invisible forever in a
   * table that forbids deletes.
   */
  clientId?: string | null;
  proposalType: string;
  targetTable: string;
  targetId?: string | null;
  targetField?: string | null;
  currentValue?: unknown;
  proposedValue: unknown;
  reasoning: string;
  confidence?: number | null;
  touchesRegulatedField: boolean;
  expiresInHours?: number;
}

export interface Proposal {
  id: string;
  proposalType: string;
  targetTable: string;
  targetField: string | null;
  currentValue: unknown;
  proposedValue: unknown;
  reasoning: string;
  confidence: number | null;
  touchesRegulatedField: boolean;
  status: string;
}

export class ProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProposalError';
  }
}

export async function createProposals(
  db: Database,
  ctx: TenantContext,
  proposals: readonly ProposalInput[],
): Promise<string[]> {
  const ids: string[] = [];

  for (const proposal of proposals) {
    if (!proposal.reasoning || proposal.reasoning.trim().length < 10) {
      throw new ProposalError('A proposal must carry reasoning an adviser can weigh');
    }

    const res = await db.execute<{ id: string }>(sql`
      INSERT INTO ai_proposals (
        invocation_id, case_id, client_id, proposal_type, target_table, target_id, target_field,
        current_value, proposed_value, reasoning, confidence, touches_regulated_field,
        expires_at
      ) VALUES (
        ${proposal.invocationId}, ${proposal.caseId ?? null}, ${proposal.clientId ?? null},
        ${proposal.proposalType},
        ${proposal.targetTable}, ${proposal.targetId ?? null}, ${proposal.targetField ?? null},
        ${proposal.currentValue === undefined ? null : JSON.stringify(proposal.currentValue)}::jsonb,
        ${JSON.stringify(proposal.proposedValue)}::jsonb,
        ${proposal.reasoning}, ${proposal.confidence ?? null}, ${proposal.touchesRegulatedField},
        ${proposal.expiresInHours
          ? sql`now() + (${String(proposal.expiresInHours)} || ' hours')::interval`
          : sql`NULL`}
      ) RETURNING id`);

    const id = res.rows[0]!.id;
    ids.push(id);

    await recordAudit(db, ctx, {
      action: 'ai.proposal.created',
      resourceType: 'ai_proposal',
      resourceId: id,
      caseId: proposal.caseId ?? null,
      source: `ai:proposal`,
      aiInvocationId: proposal.invocationId,
      after: {
        proposalType: proposal.proposalType,
        target: `${proposal.targetTable}.${proposal.targetField ?? '(record)'}`,
        touchesRegulatedField: proposal.touchesRegulatedField,
        confidence: proposal.confidence ?? null,
      },
    });
  }

  return ids;
}

export type ProposalDecision = 'accepted' | 'modified' | 'rejected';

export interface DecideProposalInput {
  proposalId: string;
  decision: ProposalDecision;
  /** Required when modifying: what the person is actually applying. */
  appliedValue?: unknown;
  note?: string;
}

export interface DecidedProposal {
  proposalId: string;
  decision: ProposalDecision;
  /** The value to apply, if any. Applying it is the caller's job. */
  valueToApply: unknown;
  touchesRegulatedField: boolean;
}

/**
 * Records a person's decision on a proposal.
 *
 * Deliberately does not apply the change itself. The caller owns its own
 * domain, and coupling the gate to every possible write would make the gate the
 * thing that changes whenever a table does. What this guarantees is that no
 * value leaves here without a named person having decided, and that the
 * decision is on the audit ledger before the caller acts on it.
 */
export async function decideProposal(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: DecideProposalInput,
): Promise<DecidedProposal> {
  const found = await db.execute<{
    id: string; status: string; touches_regulated_field: boolean;
    proposal_type: string; target_table: string; target_field: string | null;
    proposed_value: unknown; current_value: unknown; case_id: string | null;
    invocation_id: string;
  }>(sql`SELECT * FROM ai_proposals WHERE id = ${input.proposalId}`);

  const proposal = found.rows[0];
  if (!proposal) throw new ProposalError('No such proposal');
  if (proposal.status !== 'pending') {
    throw new ProposalError(`This proposal was already ${proposal.status}`);
  }

  // A proposal touching regulated information can only be resolved by a person.
  // For anything else, the ordinary invoke permission is enough.
  requirePermission(
    principal,
    proposal.touches_regulated_field ? 'ai:accept_proposal' : 'ai:invoke',
    { tenantId: ctx.tenantId },
  );

  if (input.decision === 'modified' && input.appliedValue === undefined) {
    throw new ProposalError('Modifying a proposal requires the value actually being applied');
  }
  if (input.decision === 'rejected' && !input.note?.trim()) {
    throw new ProposalError('Rejecting a proposal requires a note, so the pattern can be reviewed');
  }

  const appliedValue =
    input.decision === 'accepted' ? proposal.proposed_value
    : input.decision === 'modified' ? input.appliedValue
    : null;

  await db.execute(sql`
    UPDATE ai_proposals
       SET status = ${input.decision},
           decided_by = ${principal.kind === 'user' ? principal.userId : null},
           decided_at = now(),
           decision_note = ${input.note ?? null},
           applied_value = ${appliedValue === null ? null : JSON.stringify(appliedValue)}::jsonb
     WHERE id = ${input.proposalId}`);

  await recordAudit(db, ctx, {
    action:
      input.decision === 'accepted' ? 'ai.proposal.accepted'
      : input.decision === 'modified' ? 'ai.proposal.modified'
      : 'ai.proposal.rejected',
    resourceType: 'ai_proposal',
    resourceId: input.proposalId,
    caseId: proposal.case_id,
    source: 'console',
    aiInvocationId: proposal.invocation_id,
    severity: proposal.touches_regulated_field ? 'regulated' : 'notable',
    reason:
      input.note ??
      (proposal.touches_regulated_field
        ? `Adviser ${input.decision} an AI proposal affecting ${proposal.target_table}.${proposal.target_field ?? 'record'}`
        : null),
    before: { value: proposal.current_value, status: 'pending' },
    after: { value: appliedValue, status: input.decision, decidedBy: principal.kind === 'user' ? principal.userId : null },
  });

  return {
    proposalId: input.proposalId,
    decision: input.decision,
    valueToApply: appliedValue,
    touchesRegulatedField: proposal.touches_regulated_field,
  };
}

export async function pendingProposals(
  db: Database,
  caseId: string,
): Promise<Proposal[]> {
  const res = await db.execute<{
    id: string; proposal_type: string; target_table: string; target_field: string | null;
    current_value: unknown; proposed_value: unknown; reasoning: string;
    confidence: string | null; touches_regulated_field: boolean; status: string;
  }>(sql`
    SELECT id, proposal_type, target_table, target_field, current_value, proposed_value,
           reasoning, confidence, touches_regulated_field, status
      FROM ai_proposals
     WHERE case_id = ${caseId} AND status = 'pending'
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY touches_regulated_field DESC, confidence DESC NULLS LAST, created_at`);

  return res.rows.map((r) => ({
    id: r.id,
    proposalType: r.proposal_type,
    targetTable: r.target_table,
    targetField: r.target_field,
    currentValue: r.current_value,
    proposedValue: r.proposed_value,
    reasoning: r.reasoning,
    confidence: r.confidence === null ? null : Number(r.confidence),
    touchesRegulatedField: r.touches_regulated_field,
    status: r.status,
  }));
}

/**
 * Turns a capability's output into proposals.
 *
 * Lives here rather than in the workflow engine because a capability's output
 * becomes a proposal the same way wherever it was invoked from — a workflow
 * step, an inbound message, or an adviser asking. Two copies of "which parts of
 * this output are worth a person's attention" is how the answer starts
 * depending on who called.
 *
 * A capability with no branch here produces nothing. That is deliberate: a
 * capability whose output nobody has decided how to act on should say nothing
 * rather than raise something shapeless.
 */
export function proposalsFromOutput(input: {
  invocationId: string;
  caseId: string | null;
  clientId?: string | null;
  capabilityKey: string;
  output: unknown;
}): ProposalInput[] {
  const result = (input.output ?? {}) as Record<string, unknown>;
  const base = {
    invocationId: input.invocationId,
    caseId: input.caseId,
    clientId: input.clientId ?? null,
  };

  if (input.capabilityKey === 'ie-discrepancy' && Array.isArray(result['differences'])) {
    return (result['differences'] as Record<string, unknown>[])
      .filter((d) => d['materiality'] === 'material' || d['materiality'] === 'notable')
      .map((d) => ({
        ...base,
        proposalType: 'expenditure-review',
        targetTable: 'financial_statement_lines',
        targetField: 'amount_pence',
        currentValue: d['declaredMonthlyPence'],
        proposedValue: d['observedMonthlyPence'],
        reasoning: String(d['questionForAdviser']
          ?? 'Declared and observed figures differ materially.'),
        confidence: typeof result['confidence'] === 'number' ? result['confidence'] : null,
        touchesRegulatedField: true,
      }));
  }

  if (input.capabilityKey === 'duplicate-debt' && Array.isArray(result['pairs'])) {
    return (result['pairs'] as Record<string, unknown>[]).map((p) => ({
      ...base,
      proposalType: 'duplicate-debt',
      targetTable: 'debts', targetField: 'status',
      currentValue: 'active', proposedValue: 'duplicate',
      reasoning: String(p['reasoning'] ?? 'These appear to be the same account.'),
      confidence: typeof p['confidence'] === 'number' ? p['confidence'] : null,
      touchesRegulatedField: false,
    }));
  }

  if (input.capabilityKey === 'vulnerability-indicators' && Array.isArray(result['signals'])) {
    // The model saying it found nothing is an answer, and used to be ignored.
    if (result['noSignalsFound'] === true) return [];

    return (result['signals'] as Record<string, unknown>[])
      // A weak textual hunch is not worth putting a named person through a
      // regulated decision, and a queue full of them is how the queue stops
      // being read at all.
      .filter((s) => s['strength'] !== 'weak')
      .map((s) => ({
        ...base,
        proposalType: 'vulnerability-consideration',
        targetTable: 'vulnerability_records', targetField: null,
        proposedValue: s,
        // Written to be read by an adviser rather than parsed. The client's own
        // words are the part that lets them judge it for themselves.
        reasoning: [
          String(s['signal'] ?? 'A possible vulnerability signal.'),
          s['evidenceQuote'] ? `The client wrote: “${String(s['evidenceQuote'])}”.` : '',
          String(s['suggestedApproach'] ?? ''),
        ].filter(Boolean).join(' '),
        confidence: null,
        touchesRegulatedField: true,
      }));
  }

  return [];
}

/**
 * Pending proposals about a person rather than a case.
 *
 * Vulnerability belongs to the client: they may have no open case, or two, and
 * either way they have one set of support needs. `pendingProposals` answers the
 * case-shaped question; this answers the client-shaped one.
 */
export async function pendingProposalsForClient(
  db: Database,
  clientId: string,
  proposalType?: string,
): Promise<Proposal[]> {
  const res = await db.execute<{
    id: string; proposal_type: string; target_table: string; target_field: string | null;
    current_value: unknown; proposed_value: unknown; reasoning: string;
    confidence: string | null; touches_regulated_field: boolean; status: string;
  }>(sql`
    SELECT id, proposal_type, target_table, target_field, current_value, proposed_value,
           reasoning, confidence, touches_regulated_field, status
      FROM ai_proposals
     WHERE client_id = ${clientId} AND status = 'pending'
       ${proposalType ? sql`AND proposal_type = ${proposalType}` : sql``}
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY touches_regulated_field DESC, confidence DESC NULLS LAST, created_at`);

  return res.rows.map((r) => ({
    id: r.id,
    proposalType: r.proposal_type,
    targetTable: r.target_table,
    targetField: r.target_field,
    currentValue: r.current_value,
    proposedValue: r.proposed_value,
    reasoning: r.reasoning,
    confidence: r.confidence === null ? null : Number(r.confidence),
    touchesRegulatedField: r.touches_regulated_field,
    status: r.status,
  }));
}
