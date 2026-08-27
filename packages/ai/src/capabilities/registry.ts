import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * The AI capability registry.
 *
 * A capability declares three things that together make up the safety model:
 *
 *   permittedFields  the case information it may see. Data minimisation is a
 *                    property of the capability, not of the prompt - the
 *                    context builder assembles from this allowlist and nothing
 *                    reaches the model that is not on it.
 *
 *   outputSchema     what a valid answer looks like. Enforced by strict tool
 *                    use at the provider and validated again on the way back,
 *                    so a malformed answer is a failed invocation rather than
 *                    something an adviser has to notice.
 *
 *   proposals        whether the capability may suggest changes, and whether
 *                    any of those touch regulated information. A proposal
 *                    touching a regulated field can only be resolved by a
 *                    person.
 */

export interface CapabilityDefinition<T = unknown> {
  key: string;
  name: string;
  description: string;
  category: 'comprehension' | 'analysis' | 'drafting' | 'oversight' | 'extraction';
  permittedFields: readonly string[];
  producesProposals: boolean;
  touchesRegulatedFields: boolean;
  defaultEnabled: boolean;
  promptVersion: number;
  systemPrompt: string;
  /** Receives the assembled, minimised context and returns the user message. */
  buildUserPrompt: (context: Record<string, unknown>) => string;
  outputSchema: z.ZodType<T>;
}

/** Instruction every capability inherits. */
const HOUSE_RULES = `
You assist qualified debt advisers working at an FCA-regulated firm in the United Kingdom.

You never give advice to a consumer and you never decide anything. Your output is
read by a qualified person who is accountable for every decision on the case.

Rules that apply to every answer:
- Use only the case information provided. If something is not there, say it is not
  known. Never infer a fact, a figure or a circumstance that is not present.
- Where you are uncertain, say so plainly and say what would resolve it.
- Never state or imply which debt solution the client should take. You may set out
  what the information shows; the adviser decides.
- Never write anything intended to be read directly by the client unless the
  capability explicitly asks for a draft, and label drafts as drafts.
- Write in plain British English. No jargon the adviser would not use with a client.
- A divergence, an indicator or a pattern is a question to ask, not a finding.
`.trim();

function schemaFor(schema: z.ZodType): unknown {
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
  // Strict tool use requires the schema to close the object.
  return { ...json, additionalProperties: false };
}

export function jsonSchemaOf(capability: CapabilityDefinition): unknown {
  return schemaFor(capability.outputSchema);
}

export function systemPromptOf(capability: CapabilityDefinition): string {
  return `${HOUSE_RULES}\n\n---\n\n${capability.systemPrompt}`;
}

// ---------------------------------------------------------------------------
// Shared field groups
// ---------------------------------------------------------------------------

const CASE_BASICS = [
  'case.reference', 'case.type', 'case.stage', 'case.jurisdiction',
  'case.openedAt', 'case.owner', 'case.nextReviewDue',
] as const;

const CLIENT_BASICS = [
  'client.householdAdults', 'client.householdChildren', 'client.employmentStatus',
  'client.jurisdiction',
] as const;

const FINANCIAL = [
  'sfs.totalIncomePence', 'sfs.totalExpenditurePence', 'sfs.surplusPence',
  'sfs.lines', 'sfs.exceedances', 'sfs.completedAt',
  'debt.total', 'debt.count', 'debt.creditorCount', 'debt.list',
] as const;

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export const CASE_SUMMARY = {
  key: 'case-summary',
  name: 'Case summary',
  description:
    'A short narrative of where the case stands, so an adviser opening a file does not ' +
    'have to reconstruct it from a dozen screens.',
  category: 'comprehension',
  permittedFields: [...CASE_BASICS, ...CLIENT_BASICS, ...FINANCIAL,
    'timeline.recentEvents', 'vulnerability.summary', 'tasks.open', 'comms.recent'],
  producesProposals: false,
  touchesRegulatedFields: false,
  defaultEnabled: true,
  promptVersion: 1,
  systemPrompt: `
Summarise the case for an adviser who is about to speak to this client.

Lead with what matters now, not with chronology. Six sentences at most. Mention
money in pounds. If a vulnerability is recorded, note that support needs apply
without repeating clinical detail unnecessarily.

Do not suggest a solution.`.trim(),
  buildUserPrompt: (context) =>
    `Case information:\n\n${JSON.stringify(context, null, 2)}\n\nSummarise this case.`,
  outputSchema: z.object({
    summary: z.string().describe('Six sentences at most.'),
    situationInOneLine: z.string(),
    mostRecentDevelopment: z.string(),
    informationGaps: z.array(z.string()),
  }),
} satisfies CapabilityDefinition;

export const IE_DISCREPANCY = {
  key: 'ie-discrepancy',
  name: 'Declared versus observed expenditure',
  description:
    'Compares the client\'s declared income and expenditure against categorised bank data ' +
    'and raises the differences worth asking about.',
  category: 'analysis',
  permittedFields: ['sfs.lines', 'sfs.totalIncomePence', 'sfs.totalExpenditurePence',
    'bank.categorisedTotals', 'bank.periodMonths', 'client.householdAdults',
    'client.householdChildren'],
  producesProposals: true,
  touchesRegulatedFields: true,
  defaultEnabled: true,
  promptVersion: 1,
  systemPrompt: `
Compare declared figures against what the bank data shows.

A difference is not evidence of anything. Irregular income, cash spending, a
second account, a recent change in circumstances and a simple mistake all look
identical here. For each difference worth raising, write the question the adviser
should actually ask.

Never propose changing a declared figure to the observed one. Propose that the
adviser checks it.

Ignore differences under £20 a month or under 15 per cent - they are noise.`.trim(),
  buildUserPrompt: (context) =>
    `Declared and observed figures:\n\n${JSON.stringify(context, null, 2)}\n\n` +
    `Identify the differences worth raising with the client.`,
  outputSchema: z.object({
    differences: z.array(z.object({
      category: z.string(),
      declaredMonthlyPence: z.number().int(),
      observedMonthlyPence: z.number().int(),
      materiality: z.enum(['minor', 'notable', 'material']),
      possibleExplanations: z.array(z.string()),
      questionForAdviser: z.string(),
    })),
    overallAssessment: z.string(),
    confidence: z.number().min(0).max(1),
  }),
} satisfies CapabilityDefinition;

export const ADVICE_READINESS = {
  key: 'advice-readiness',
  name: 'Advice readiness',
  description:
    'Identifies what is still missing before regulated advice could safely be given on this case.',
  category: 'analysis',
  permittedFields: [...CASE_BASICS, ...FINANCIAL, 'evidence.status',
    'consent.status', 'vulnerability.summary', 'caseType.requiredEvidence'],
  producesProposals: false,
  touchesRegulatedFields: false,
  defaultEnabled: true,
  promptVersion: 1,
  systemPrompt: `
List what is still missing before this case is ready for advice.

Work from the case type's required evidence and from what a competent adviser
would want in front of them. Separate what blocks advice from what merely would
help. Be specific: "no evidence of the client's rent" is useful, "incomplete
information" is not.

Do not assess which solution fits.`.trim(),
  buildUserPrompt: (context) =>
    `Case information:\n\n${JSON.stringify(context, null, 2)}\n\n` +
    `What is missing before advice can be given?`,
  outputSchema: z.object({
    readyForAdvice: z.boolean(),
    blocking: z.array(z.object({
      item: z.string(),
      why: z.string(),
      howToResolve: z.string(),
    })),
    helpful: z.array(z.object({ item: z.string(), why: z.string() })),
  }),
} satisfies CapabilityDefinition;

export const VULNERABILITY_INDICATORS = {
  key: 'vulnerability-indicators',
  name: 'Vulnerability indicators',
  description:
    'Surfaces signals that may indicate vulnerability under the four FG21/1 drivers, for ' +
    'adviser consideration.',
  category: 'analysis',
  permittedFields: ['comms.recent', 'timeline.recentEvents', 'client.employmentStatus',
    'sfs.surplusPence', 'debt.total', 'case.stage', 'vulnerability.summary'],
  producesProposals: true,
  touchesRegulatedFields: true,
  defaultEnabled: false,
  promptVersion: 1,
  systemPrompt: `
Identify signals that may indicate vulnerability, framed by the four FCA FG21/1
drivers: health, life events, resilience, capability.

You are not diagnosing anything and you are not concluding that the client is
vulnerable. You are pointing at something in the record that an adviser should
consider and, where appropriate, ask about sensitively.

Quote the specific wording or fact that prompted each signal, so the adviser can
judge it themselves. Where a signal is weak, say so. Suggest nothing that would
require the adviser to raise a sensitive topic without cause.

Recording vulnerability is a regulated act performed by a person, and health
information needs the client's explicit consent before it is written down.`.trim(),
  buildUserPrompt: (context) =>
    `Case record:\n\n${JSON.stringify(context, null, 2)}\n\n` +
    `Identify any vulnerability signals for the adviser to consider.`,
  outputSchema: z.object({
    signals: z.array(z.object({
      driver: z.enum(['health', 'life-event', 'resilience', 'capability']),
      signal: z.string(),
      evidenceQuote: z.string(),
      strength: z.enum(['weak', 'moderate', 'strong']),
      suggestedApproach: z.string(),
      requiresConsentBeforeRecording: z.boolean(),
    })),
    noSignalsFound: z.boolean(),
  }),
} satisfies CapabilityDefinition;

export const DUPLICATE_DEBT = {
  key: 'duplicate-debt',
  name: 'Duplicate and matched debts',
  description:
    'Identifies debts likely to be the same account recorded twice, or sold on to a new owner.',
  category: 'analysis',
  permittedFields: ['debt.list'],
  producesProposals: true,
  touchesRegulatedFields: false,
  defaultEnabled: true,
  promptVersion: 1,
  systemPrompt: `
Find debts that are probably the same underlying account.

The common causes are a debt sold to a purchaser (the original creditor and the
new owner both appear), a trading name recorded alongside a legal name, and the
same account entered twice from two sources.

Give each pairing a confidence and say what makes you think so. Balances rarely
match exactly after a sale - interest, charges and part payments intervene - so
do not require them to.

Never merge anything. An adviser confirms.`.trim(),
  buildUserPrompt: (context) =>
    `Debts on this case:\n\n${JSON.stringify(context, null, 2)}\n\n` +
    `Which of these are likely to be the same account?`,
  outputSchema: z.object({
    pairs: z.array(z.object({
      debtIdA: z.string(),
      debtIdB: z.string(),
      relationship: z.enum(['duplicate-entry', 'sold-on', 'same-creditor-group', 'uncertain']),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
      recommendedAction: z.string(),
    })),
  }),
} satisfies CapabilityDefinition;

export const ADVICE_RATIONALE_DRAFT = {
  key: 'advice-rationale-draft',
  name: 'Advice rationale draft',
  description:
    'Drafts the wording of an advice rationale for the adviser to edit, from a decision the ' +
    'adviser has already reached.',
  category: 'drafting',
  permittedFields: [...CASE_BASICS, ...CLIENT_BASICS, ...FINANCIAL,
    'eligibility.assessments', 'affordability.summary', 'adviser.chosenSolution',
    'adviser.reasoning', 'vulnerability.summary'],
  producesProposals: false,
  touchesRegulatedFields: true,
  defaultEnabled: false,
  promptVersion: 1,
  systemPrompt: `
The adviser has already decided which solution they are recommending and why.
Draft the written rationale for their file.

You are writing up their reasoning, not forming your own. Use the solution they
chose and the reasons they gave. Set out why it suits this client's circumstances,
which alternatives were considered, and why each was not chosen, drawing on the
eligibility assessment provided.

This is a draft. The adviser is accountable for what is finally recorded, and
will edit it. Do not add a reason they did not give.`.trim(),
  buildUserPrompt: (context) =>
    `Case and the adviser's decision:\n\n${JSON.stringify(context, null, 2)}\n\n` +
    `Draft the advice rationale.`,
  outputSchema: z.object({
    rationaleDraft: z.string(),
    alternativesConsidered: z.array(z.object({
      solution: z.string(),
      whyNotChosen: z.string(),
    })),
    risksToExplain: z.array(z.string()),
    pointsAdviserShouldVerify: z.array(z.string()),
  }),
} satisfies CapabilityDefinition;

export const COMMUNICATION_DRAFT = {
  key: 'communication-draft',
  name: 'Communication draft',
  description: 'Drafts a message to a client or creditor for the adviser to review and send.',
  category: 'drafting',
  permittedFields: [...CASE_BASICS, 'client.firstName', 'comms.recent',
    'comms.purpose', 'client.communicationAdjustments', 'vulnerability.summary'],
  producesProposals: false,
  touchesRegulatedFields: false,
  defaultEnabled: true,
  promptVersion: 1,
  systemPrompt: `
Draft a message for the adviser to review before sending.

Write plainly, at a reading age of around 12. Short sentences. No jargon, no
legal phrasing, no threats of consequence. Say what has happened, what it means
for the person, and what if anything they need to do. If there are recorded
communication adjustments, follow them.

Never state or imply advice. Never promise an outcome. If the message would need
to convey something the adviser has not told you, leave a clearly marked
placeholder rather than inventing it.`.trim(),
  buildUserPrompt: (context) =>
    `Context:\n\n${JSON.stringify(context, null, 2)}\n\nDraft the message.`,
  outputSchema: z.object({
    subject: z.string(),
    body: z.string(),
    readingAgeEstimate: z.number(),
    placeholders: z.array(z.string()),
    toneNotes: z.string(),
  }),
} satisfies CapabilityDefinition;

export const QA_REVIEW = {
  key: 'qa-review',
  name: 'Quality assurance review',
  description:
    'Assesses a case file against the firm\'s QA framework, for a reviewer to confirm or reject.',
  category: 'oversight',
  permittedFields: [...CASE_BASICS, ...FINANCIAL, 'advice.decision', 'advice.rationale',
    'evidence.status', 'consent.status', 'vulnerability.summary', 'comms.recent',
    'qa.framework'],
  producesProposals: false,
  touchesRegulatedFields: false,
  defaultEnabled: false,
  promptVersion: 1,
  systemPrompt: `
Assess this case file against the QA framework provided.

For each criterion, say whether it is met, partially met or not met, and quote
the part of the file that supports your view. Where a criterion is not met, say
what is missing rather than what you assume happened.

You are producing a first pass for a human reviewer, who confirms or overrides
every finding. Do not soften a genuine gap, and do not manufacture one. If the
file looks sound, say so.`.trim(),
  buildUserPrompt: (context) =>
    `Case file and framework:\n\n${JSON.stringify(context, null, 2)}\n\n` +
    `Assess this file.`,
  outputSchema: z.object({
    criteria: z.array(z.object({
      criterion: z.string(),
      outcome: z.enum(['met', 'partially-met', 'not-met', 'not-applicable']),
      evidence: z.string(),
      gap: z.string(),
    })),
    overallOutcome: z.enum(['pass', 'pass-with-observations', 'refer', 'fail']),
    summary: z.string(),
    pointsForReviewer: z.array(z.string()),
  }),
} satisfies CapabilityDefinition;

export const CAPABILITIES: readonly CapabilityDefinition[] = [
  CASE_SUMMARY, IE_DISCREPANCY, ADVICE_READINESS, VULNERABILITY_INDICATORS,
  DUPLICATE_DEBT, ADVICE_RATIONALE_DRAFT, COMMUNICATION_DRAFT, QA_REVIEW,
];

const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));

export function capability(key: string): CapabilityDefinition | undefined {
  return BY_KEY.get(key);
}
