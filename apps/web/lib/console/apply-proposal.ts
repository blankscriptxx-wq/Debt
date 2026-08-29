import { sql } from '@solvenda/db';
import {
  decideProposal, type ProposalDecision as Decision,
} from '@solvenda/ai';
import {
  recordVulnerability, consentPermittingSpecialCategory, severityFromStrength,
  ConsentRequiredError,
  type VulnerabilityDriver, type VulnerabilitySeverity,
} from '@solvenda/core';
import { query, type ConsoleSession } from '@/lib/console/session';

/**
 * Deciding a suggestion, and carrying the decision out.
 *
 * `decideProposal` records what a person decided and deliberately does not
 * apply it — applying a value is domain work and belongs with whoever owns the
 * domain. This is where the two meet for a vulnerability signal.
 *
 * **The order is the whole design: check, then decide, then write.** A decision
 * is immutable once made — the database guard refuses any further status change
 * — so deciding first and then discovering that health information cannot
 * lawfully be recorded would leave an accepted proposal that can never be
 * applied and never be decided again. A transaction is not a way out either:
 * the audit ledger is hash-chained, and unwinding an appended chain is exactly
 * the thing that must not happen.
 *
 * So a proposal is accepted only once the acceptance is known to be something
 * we can actually do.
 */

export type ApplyOutcome =
  | { applied: true; recordId: string }
  /** Refused before anything was decided. The proposal is untouched and still pending. */
  | { applied: false; needs: 'consent'; clientId: string; driver: string; because: string }
  /** Decided, with nothing to write — a rejection, or a type with no writer. */
  | { applied: false; needs: 'nothing' };

export interface VulnerabilitySignal {
  driver?: string;
  signal?: string;
  evidenceQuote?: string;
  strength?: string;
  suggestedApproach?: string;
  requiresConsentBeforeRecording?: boolean;
}

export interface ApplyInput {
  decision: Decision;
  appliedValue?: unknown;
  note?: string;
  /** The consent an adviser has chosen to record health information under. */
  consentId?: string | null;
  /** An adviser's own judgement, which overrides what the model inferred. */
  severity?: VulnerabilitySeverity;
  detail?: string | null;
  supportNeeds?: string[];
}

const DRIVERS = new Set(['health', 'life-event', 'resilience', 'capability']);

/**
 * Whether recording this signal would mean holding special-category data.
 *
 * The driver decides it, not the model's own flag — a model that returns
 * `requiresConsentBeforeRecording: false` on a health signal must not thereby
 * switch the gate off. The flag can only ever add caution.
 */
function needsArticle9(signal: VulnerabilitySignal): boolean {
  return signal.driver === 'health' || signal.requiresConsentBeforeRecording === true;
}

export async function decideAndApply(
  session: ConsoleSession,
  proposalId: string,
  input: ApplyInput,
): Promise<ApplyOutcome> {
  const proposal = await query(session, async (db) => {
    const r = await db.execute<{
      proposal_type: string; proposed_value: unknown; invocation_id: string;
      case_id: string | null; client_id: string | null; status: string;
    }>(sql`
      SELECT proposal_type, proposed_value, invocation_id, case_id, client_id, status
        FROM ai_proposals WHERE id = ${proposalId}`);
    return r.rows[0] ?? null;
  });

  if (!proposal || proposal.proposal_type !== 'vulnerability-consideration'
      || input.decision === 'rejected') {
    await query(session, (db) => decideProposal(db, session.context, session.principal, {
      proposalId, decision: input.decision,
      appliedValue: input.appliedValue, note: input.note,
    }));
    return { applied: false, needs: 'nothing' };
  }

  const signal = {
    ...(proposal.proposed_value as VulnerabilitySignal),
    ...(input.appliedValue as VulnerabilitySignal | undefined ?? {}),
  };
  const driver = DRIVERS.has(signal.driver ?? '') ? signal.driver as VulnerabilityDriver : null;
  const clientId = proposal.client_id;

  if (!driver || !clientId) {
    // Nothing to write, so nothing is claimed. The decision is still the
    // adviser's to record.
    await query(session, (db) => decideProposal(db, session.context, session.principal, {
      proposalId, decision: input.decision,
      appliedValue: input.appliedValue, note: input.note,
    }));
    return { applied: false, needs: 'nothing' };
  }

  // Check before deciding. Nothing above this line has changed anything.
  if (needsArticle9(signal)) {
    const consent = await query(session, (db) =>
      consentPermittingSpecialCategory(db, clientId, input.consentId));
    if (!consent) {
      return {
        applied: false, needs: 'consent', clientId, driver,
        because: 'This is health information. It can be recorded once the client’s explicit '
          + 'consent to hold it is on file. Nothing has been written down.',
      };
    }
  }

  const decided = await query(session, (db) =>
    decideProposal(db, session.context, session.principal, {
      proposalId, decision: input.decision,
      appliedValue: input.appliedValue, note: input.note,
    }));

  const sourceCommunicationId = await sourceCommunicationOf(session, proposal.invocation_id);

  try {
    const recordId = await query(session, (db) => recordVulnerability(
      db, session.context, session.principal, {
        clientId,
        caseId: proposal.case_id,
        driver,
        severity: input.severity ?? severityFromStrength(signal.strength ?? ''),
        indicators: signal.signal ? [signal.signal] : [],
        consentId: input.consentId ?? null,
        detail: input.detail ?? null,
        supportNeeds: input.supportNeeds ?? [],
        identifiedVia: 'ai-indicator',
        aiInvocationId: proposal.invocation_id,
        sourceCommunicationId,
      }));

    // Which suggestion became which record. `target_id` exists for exactly this
    // and the guard does not freeze it, so no column was needed.
    await query(session, (db) => db.execute(sql`
      UPDATE ai_proposals SET target_id = ${recordId} WHERE id = ${proposalId}`));

    return { applied: true, recordId };
  } catch (cause) {
    // Only reachable if the consent was taken back between the check above and
    // here. Rare, and better surfaced than swallowed: the decision stands on the
    // ledger and the adviser is told the record was not written.
    if (cause instanceof ConsentRequiredError) {
      console.error('consent disappeared between checking and recording', decided.proposalId);
      return {
        applied: false, needs: 'consent', clientId, driver,
        because: `${cause.message} Your decision was recorded, but the vulnerability was not. `
          + 'Record it from the Vulnerability section once consent is back on file.',
      };
    }
    throw cause;
  }
}

/**
 * The message a signal came out of.
 *
 * Recovered from the invocation's own source rather than carried through the
 * proposal, because the invocation already records where it was reading.
 */
async function sourceCommunicationOf(
  session: ConsoleSession, invocationId: string,
): Promise<string | null> {
  const source = await query(session, async (db) => {
    const r = await db.execute<{ source: string | null }>(sql`
      SELECT source FROM ai_invocations WHERE id = ${invocationId}`);
    return r.rows[0]?.source ?? null;
  });
  const match = source?.match(/^comms:inbound:([0-9a-f-]{36})$/);
  return match ? match[1]! : null;
}
