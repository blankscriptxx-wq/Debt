import type { CaseTypeDefinition, EvidenceRequirement } from '../case-types/schema.js';

/**
 * What is actually known about a case, and how well it is known.
 *
 * The distinction this module exists to preserve is between *declared* and
 * *verified*. A client saying they earn £1,800 a month and a payslip showing
 * they earn £1,800 a month produce the same number and are not the same fact,
 * and a product whose selling point is that compliance evidence is a by-product
 * of the work cannot afford to conflate them.
 *
 * Resolution is driven by the case type's own evidence declarations rather than
 * by a table of known keys, so a firm adding a case type gets correct evidence
 * state without anyone writing code for it. The mechanism is
 * `verification_items.requirement_key`, which is unique per case and keyed to
 * exactly these requirements; where no verification item exists, a few kinds
 * can be answered from the underlying records instead.
 */

export type EvidenceState =
  /** Supported by a document, an electronic check or a data feed. */
  | 'verified'
  /** Recorded from what the client said, with nothing behind it yet. */
  | 'declared'
  /** Someone decided evidence was not needed. A decision, and audited as one. */
  | 'waived'
  /** Verified once, but the evidence has passed its expiry date. */
  | 'expired'
  /** Nothing recorded. */
  | 'missing'
  /** This case type does not ask for it at all. */
  | 'not-required';

/** Whether the case needs this now, later, or never. */
export type EvidenceTiming = 'now' | 'later' | 'never';

export interface ResolvedEvidence {
  key: string;
  label: string;
  kind: EvidenceRequirement['kind'];
  /** Blocking items stop the case leaving the stage that requires them. */
  blocking: boolean;
  state: EvidenceState;
  timing: EvidenceTiming;
  /** How the state was arrived at, in words an adviser can act on. */
  because: string;
  /** The record that decided it, so the interface can link to the source. */
  source: { type: string; id: string | null } | null;
}

/** The records evidence state is resolved from. */
export interface EvidenceRecords {
  verificationItems: readonly {
    id: string;
    requirementKey: string;
    status: 'outstanding' | 'received' | 'verified' | 'rejected' | 'waived' | 'not-applicable';
    method: string | null;
    expiresOn: string | null;
  }[];
  consents: readonly {
    id: string;
    purpose: string;
    granted: boolean;
    withdrawnAt: string | null;
  }[];
  vulnerability: {
    /** Includes an explicitly recorded "no indicators identified". */
    assessed: boolean;
    recordId: string | null;
  };
  statement: {
    id: string;
    completedAt: string | null;
    lineCount: number;
    /** Lines carrying a document, open-banking or credit-file backing. */
    evidencedLineCount: number;
  } | null;
}

/** Methods that mean someone checked something, rather than was told it. */
const VERIFYING_METHODS = new Set(['document', 'open-banking', 'credit-file', 'electronic-check']);

/**
 * Kinds where recording the thing *is* the evidence, so how it was captured
 * does not downgrade it.
 *
 * A consent is established by having been given, and a vulnerability assessment
 * by having been carried out — there is no external document either could be
 * checked against, and marking them "declared" because the method was a
 * conversation would be telling an adviser to go and verify something that
 * cannot be verified. Everything else, a debt list included, can in principle
 * be evidenced, so for those the method is the whole question.
 */
const SELF_EVIDENCING_KINDS = new Set(['consent', 'vulnerability-assessment']);

function timingFor(caseType: CaseTypeDefinition, currentStage: string, key: string): EvidenceTiming {
  const current = caseType.stages.find((s) => s.key === currentStage);
  const requiring = caseType.stages.filter((s) => s.requiredEvidence.includes(key));
  if (requiring.length === 0) return 'never';
  if (!current) return 'later';
  // Required now if any stage at or before the current one asks for it: an item
  // owed two stages ago is more overdue than one owed at this stage, not less.
  return requiring.some((s) => s.order <= current.order) ? 'now' : 'later';
}

/**
 * Resolves a single requirement, preferring an explicit verification item and
 * falling back to the records for the kinds that can be answered from them.
 */
function resolveOne(
  requirement: EvidenceRequirement,
  records: EvidenceRecords,
  timing: EvidenceTiming,
  today: string,
): ResolvedEvidence {
  const base = {
    key: requirement.key,
    label: requirement.label,
    kind: requirement.kind,
    blocking: requirement.blocking,
    timing,
  };

  const item = records.verificationItems.find((v) => v.requirementKey === requirement.key);

  // A verification item that has been acted on is the answer. One that is still
  // outstanding is only a note that somebody should look, so it must not
  // override a consent or a statement that already answers the question —
  // otherwise opening a case, which creates the outstanding rows, would appear
  // to erase evidence the case already had.
  const acted = item && item.status !== 'outstanding' && item.status !== 'rejected';

  if (item && acted) {
    const source = { type: 'verification_item', id: item.id };
    switch (item.status) {
      case 'waived':
        return { ...base, state: 'waived', source,
                 because: 'Evidence was waived, with a recorded reason.' };
      case 'not-applicable':
        return { ...base, state: 'not-required', source,
                 because: 'Marked not applicable to this case.' };
      case 'verified': {
        if (item.expiresOn && item.expiresOn < today) {
          return { ...base, state: 'expired', source,
                   because: `Verified, but the evidence expired on ${item.expiresOn}.` };
        }
        // Verbal confirmation is a record of what someone was told. It belongs
        // on the file and it is not verification.
        if (item.method && !VERIFYING_METHODS.has(item.method)
            && !SELF_EVIDENCING_KINDS.has(requirement.kind)) {
          return { ...base, state: 'declared', source,
                   because: `Confirmed ${item.method}, which is not independent evidence.` };
        }
        // Naming the method only says something where a method is what settles
        // it. "Verified by other" is noise on an assessment that is settled by
        // having been carried out.
        return { ...base, state: 'verified', source,
                 because: item.method && !SELF_EVIDENCING_KINDS.has(requirement.kind)
                   ? `Verified by ${item.method}.`
                   : 'Recorded.' };
      }
      case 'received':
        return { ...base, state: 'declared', source,
                 because: 'Evidence received but not yet checked.' };
      default:
        return { ...base, state: 'verified', source, because: 'Verified.' };
    }
  }

  const pending = item
    ? { type: 'verification_item', id: item.id }
    : null;
  const pendingBecause = item?.status === 'rejected'
    ? 'The evidence provided was rejected.'
    : 'Requested, not yet provided.';

  // Nothing has been done to the item, so the case's own records answer it.
  switch (requirement.kind) {
    case 'consent': {
      const consent = records.consents.find(
        (c) => c.purpose === requirement.key && c.granted && c.withdrawnAt === null,
      );
      return consent
        ? { ...base, state: 'verified', source: { type: 'consent', id: consent.id },
            because: 'Consent recorded with its lawful basis and wording.' }
        : { ...base, state: 'missing', source: pending, because: 'No consent recorded.' };
    }

    case 'vulnerability-assessment':
      return records.vulnerability.assessed
        ? { ...base, state: 'verified',
            source: { type: 'vulnerability_record', id: records.vulnerability.recordId },
            because: 'Assessment recorded against the FG21/1 drivers.' }
        : { ...base, state: 'missing', source: pending,
            because: 'No assessment recorded, not even a "no indicators identified".' };

    case 'financial-statement': {
      const s = records.statement;
      if (!s || s.lineCount === 0) {
        return { ...base, state: 'missing', source: pending,
                 because: 'No financial statement on the file.' };
      }
      const source = { type: 'financial_statement', id: s.id };
      if (!s.completedAt) {
        return { ...base, state: 'declared', source, because: 'Statement started but not completed.' };
      }
      // A statement is only as good as what backs its lines. Every line
      // evidenced is a verified statement; anything less is the client's word.
      return s.evidencedLineCount >= s.lineCount
        ? { ...base, state: 'verified', source,
            because: 'Complete, with every line evidenced.' }
        : { ...base, state: 'declared', source,
            because: `Complete, but ${s.lineCount - s.evidencedLineCount} of ${s.lineCount} `
                   + 'lines rest on what the client said.' };
    }

    default:
      // Documents, signatures, mandates, identity checks and declarations all
      // need someone to record that they happened. The software cannot infer
      // that a client disclosed every debt, or that a mandate was signed.
      return { ...base, state: 'missing', source: pending,
               because: item ? pendingBecause : 'Not yet recorded.' };
  }
}

/**
 * Resolves every evidence requirement the case type declares.
 *
 * `today` is injected rather than read from the clock so expiry is testable.
 */
export function resolveEvidenceState(
  caseType: CaseTypeDefinition,
  currentStage: string,
  records: EvidenceRecords,
  today: string = new Date().toISOString().slice(0, 10),
): ResolvedEvidence[] {
  return caseType.evidence.map((requirement) =>
    resolveOne(requirement, records, timingFor(caseType, currentStage, requirement.key), today));
}

/**
 * The boolean map the eligibility and intelligence layers consume.
 *
 * Waived counts as satisfied — a waiver is a decision that the item is not
 * needed, and second-guessing it here would mean the same case reads as ready
 * in one surface and not in another. Expired does not: evidence that has run
 * out is the case of most interest to a file reviewer.
 */
export function evidenceMap(resolved: readonly ResolvedEvidence[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const item of resolved) {
    map[item.key] = item.state === 'verified' || item.state === 'waived';
  }
  return map;
}

/** Requirements owed now and not satisfied, worst first for display. */
export function outstandingEvidence(
  resolved: readonly ResolvedEvidence[],
): ResolvedEvidence[] {
  const rank: Record<EvidenceState, number> = {
    missing: 0, expired: 1, declared: 2, verified: 3, waived: 3, 'not-required': 4,
  };
  return resolved
    .filter((r) => r.timing === 'now' && rank[r.state] <= 2)
    .sort((a, b) =>
      Number(b.blocking) - Number(a.blocking) || rank[a.state] - rank[b.state]);
}
