/**
 * Suggesting what a document is, and where it belongs.
 *
 * A classifier that only reads the file can tell an adviser "this is a payslip".
 * That is mildly useful. What makes it worth acting on is knowing that *this
 * case is missing income evidence*, so the suggestion becomes "this is a payslip,
 * and it answers the thing this case is waiting for" — which is a sentence an
 * adviser can accept with one click instead of a fact they then have to act on.
 *
 * That connection is only available because the platform already resolves what
 * each case needs (`packages/core/src/evidence/state.ts`). It is the reason this
 * is a feature rather than a file picker.
 *
 * The signals here are deliberately shallow — filename, media kind, content type
 * and a few words. A real model goes behind the same interface and returns the
 * same shape. What must not change is that the output is a *suggestion*: it is
 * proposed to a person, and the record distinguishes a suggestion accepted from
 * a classification chosen.
 */

/**
 * The part of a resolved evidence requirement this needs.
 *
 * Structural rather than imported: `ResolvedEvidence` from the core package
 * satisfies it, and declaring the three fields here keeps communications from
 * depending on the domain package for a type.
 */
export interface OutstandingRequirement {
  key: string;
  label: string;
  state: string;
}

export interface DocumentSuggestion {
  documentType: string;
  label: string;
  /** 0–1. Shown, because an adviser should know how much to trust it. */
  confidence: number;
  /** The verification requirement it would answer, when there is one. */
  satisfiesRequirement: string | null;
  /** Why this was suggested, in words the adviser reads. */
  because: string;
}

interface Signal {
  documentType: string;
  label: string;
  patterns: RegExp[];
  /** Evidence keys this kind of document typically answers. */
  answers: string[];
}

const SIGNALS: Signal[] = [
  { documentType: 'bank-statement', label: 'Bank statement',
    patterns: [/bank\s*statement/i, /\bstatement\b/i, /\b(barclays|natwest|lloyds|halifax|monzo|santander|hsbc|nationwide|starling)\b/i],
    answers: ['income.bank-statements', 'sfs.complete'] },
  { documentType: 'payslip', label: 'Payslip',
    patterns: [/pay\s*slip/i, /payslip/i, /wage\s*slip/i, /\bpay\s*advice\b/i],
    answers: ['income.payslip-or-benefit-award', 'sfs.complete'] },
  { documentType: 'benefit-award', label: 'Benefit award letter',
    patterns: [/universal\s*credit/i, /benefit/i, /\bpip\b/i, /\bdwp\b/i, /award\s*letter/i],
    answers: ['income.payslip-or-benefit-award', 'sfs.complete'] },
  { documentType: 'identity', label: 'Proof of identity',
    patterns: [/passport/i, /driving\s*licen[cs]e/i, /\bid\b/i, /birth\s*certificate/i],
    answers: ['identity.verified'] },
  { documentType: 'proof-of-address', label: 'Proof of address',
    patterns: [/council\s*tax/i, /utility/i, /tenancy/i, /proof\s*of\s*address/i],
    answers: ['address.proof'] },
  { documentType: 'creditor-letter', label: 'Creditor letter',
    patterns: [/default\s*notice/i, /arrears/i, /creditor/i, /final\s*demand/i, /\bccj\b/i],
    answers: ['debts.captured'] },
  { documentType: 'utility-bill', label: 'Utility bill',
    patterns: [/\b(gas|electric|electricity|water|energy)\b/i, /\bbill\b/i],
    answers: ['address.proof'] },
];

export function suggestClassification(input: {
  filename: string | null;
  contentType: string | null;
  mediaKind: string | null;
  /** Anything the client said in the same message, which is often the best clue. */
  messageText?: string | null;
  /** What this case still needs, so the suggestion can be about this case. */
  outstanding?: readonly OutstandingRequirement[];
}): DocumentSuggestion {
  const haystack = `${input.filename ?? ''} ${input.messageText ?? ''}`;

  // A voice note is not a document to be filed under payslips. Saying so is
  // more useful than guessing, and a client explaining their circumstances in
  // speech is still evidence — of a different kind.
  if (input.mediaKind === 'voice' || input.mediaKind === 'audio') {
    return {
      documentType: 'voice-note', label: 'Voice note', confidence: 0.9,
      satisfiesRequirement: null,
      because: 'A voice note. Worth listening to and noting, rather than filing as a document.',
    };
  }

  const outstandingKeys = new Set(
    (input.outstanding ?? [])
      .filter((e) => e.state === 'missing' || e.state === 'declared' || e.state === 'expired')
      .map((e) => e.key));

  let best: { signal: Signal; hits: number } | null = null;
  for (const signal of SIGNALS) {
    const hits = signal.patterns.filter((p) => p.test(haystack)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { signal, hits };
  }

  if (!best) {
    return {
      documentType: 'other', label: 'Something else', confidence: 0.2,
      satisfiesRequirement: null,
      because: 'Not recognised from the file name. Choose what it is.',
    };
  }

  // The requirement it answers, preferring one this case is actually waiting on.
  const wanted = best.signal.answers.find((k) => outstandingKeys.has(k)) ?? null;
  const outstandingLabel = wanted
    ? (input.outstanding ?? []).find((e) => e.key === wanted)?.label ?? wanted
    : null;

  // Matching something the case needs is corroboration, not just a keyword hit,
  // so it is worth more confidence than the file name alone.
  const confidence = Math.min(0.95, 0.45 + best.hits * 0.15 + (wanted ? 0.2 : 0));

  return {
    documentType: best.signal.documentType,
    label: best.signal.label,
    confidence: Number(confidence.toFixed(2)),
    satisfiesRequirement: wanted,
    because: outstandingLabel
      ? `Looks like a ${best.signal.label.toLowerCase()}, and this case is waiting on `
        + `${outstandingLabel.toLowerCase()}.`
      : `Looks like a ${best.signal.label.toLowerCase()} from the file name.`,
  };
}
