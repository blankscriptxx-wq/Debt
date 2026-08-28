import type { EvidenceState, ResolvedEvidence } from '@solvenda/core';

/**
 * How the case file is grouped.
 *
 * Not by table, and not by the order the data happens to be entered. An adviser
 * picking up a file asks a small number of questions — do I know who this person
 * is, do I know what they have and what they owe, can I advise yet, and what has
 * been said to them — and the file is organised to answer those.
 *
 * The grouping is ours; the names are the trade's. "I&E", "SFS", "living
 * arrangements" and "verification" are what UK debt advisers call these things,
 * and inventing house synonyms for them would cost recognition and buy nothing.
 * What was worth not copying is the shape of the interface, not the vocabulary
 * of the profession it serves.
 *
 * Each section names the evidence requirements that bear on it, so a section's
 * state is derived from the same resolution the rest of the platform uses rather
 * than from a second opinion. Requirements a case type does not declare are
 * simply absent, which is how a DRO gets an approved-intermediary row and a DMP
 * does not, with no code either way.
 */

export interface SectionDefinition {
  slug: string;
  label: string;
  group: string;
  /** Evidence keys whose state this section is answerable for. */
  evidenceKeys: readonly string[];
  /** Which tab count, if any, belongs on the row. */
  countKey?: string;
}

export const CASE_SECTIONS: readonly SectionDefinition[] = [
  { slug: 'client', label: 'Client details', group: 'The client',
    evidenceKeys: ['identity.verified', 'consent.processing'] },
  { slug: 'living', label: 'Living arrangements', group: 'The client',
    evidenceKeys: [], countKey: 'household' },
  { slug: 'verification', label: 'Verification', group: 'The client',
    evidenceKeys: ['vulnerability.assessed'], countKey: 'verification' },

  { slug: 'employment', label: 'Employment', group: 'The money',
    evidenceKeys: [], countKey: 'employment' },
  { slug: 'finances', label: 'Income & expenditure (SFS)', group: 'The money',
    evidenceKeys: ['sfs.complete'] },
  { slug: 'debts', label: 'Debts & creditors', group: 'The money',
    evidenceKeys: ['debts.captured'], countKey: 'debts' },
  { slug: 'assets', label: 'Assets', group: 'The money',
    evidenceKeys: [], countKey: 'assets' },

  { slug: 'advice', label: 'Advice', group: 'The advice',
    evidenceKeys: [] },
  { slug: 'checklist', label: 'Checklist', group: 'The advice',
    // Everything left over — signatures, mandates, appointments and whatever a
    // case type declares that no other section claims — surfaces here, so a
    // requirement can never be declared and then displayed nowhere.
    evidenceKeys: [] },

  { slug: 'messenger', label: 'Messenger', group: 'The contact',
    evidenceKeys: [], countKey: 'messages' },
  { slug: 'appointments', label: 'Appointments', group: 'The contact',
    evidenceKeys: [], countKey: 'appointments' },
];

/** Requirements no section claims, which the readiness section shows. */
export function unclaimedEvidence(evidence: readonly ResolvedEvidence[]): ResolvedEvidence[] {
  const claimed = new Set(CASE_SECTIONS.flatMap((s) => s.evidenceKeys));
  return evidence.filter((e) => !claimed.has(e.key));
}

/**
 * The state of a section: the worst of the evidence it answers for.
 *
 * Worst rather than an average, because a file is not three-quarters ready. If
 * one required item is missing, the honest thing for the row to say is missing.
 */
export function sectionState(
  section: SectionDefinition,
  evidence: readonly ResolvedEvidence[],
): { state: EvidenceState; because: string } | null {
  const keys = section.slug === 'checklist'
    ? unclaimedEvidence(evidence).map((e) => e.key)
    : section.evidenceKeys;

  const relevant = evidence.filter(
    (e) => keys.includes(e.key) && e.timing !== 'never' && e.state !== 'not-required');
  if (relevant.length === 0) return null;

  const rank: Record<EvidenceState, number> = {
    missing: 0, expired: 1, declared: 2, waived: 3, verified: 4, 'not-required': 5,
  };
  const worst = relevant.reduce((a, b) => (rank[a.state] <= rank[b.state] ? a : b));

  // One requirement, or one item worse than the rest: its own reason is the
  // sentence worth showing, because it names the thing to go and do. Several
  // sharing the worst state: count them, so the row is not silently speaking
  // for items it has not mentioned. All of them settled: say so and stop —
  // "2 of 2 items verified, including consent" is a sentence nobody needs.
  const sharing = relevant.filter((e) => e.state === worst.state).length;
  const settled = worst.state === 'verified' || worst.state === 'waived';
  const because = settled
    ? (relevant.length === 1 ? `${worst.label}: ${worst.because}` : 'Everything here is in order.')
    : (relevant.length === 1 || sharing === 1
        ? `${worst.label}: ${worst.because}`
        : `${sharing} of ${relevant.length} items ${worst.state}, including `
          + `${worst.label.toLowerCase()}.`);

  return { state: worst.state, because };
}
