import { sumPence, toMonthlyPence, type Frequency, type Pence } from '../money.js';

/**
 * The Standard Financial Statement engine.
 *
 * Two properties matter more than the arithmetic.
 *
 * First, a statement is a snapshot. Correcting a figure supersedes the
 * statement rather than editing it, so "what did the file look like when that
 * advice was given?" always has an answer - which is the question an FOS
 * complaint or an FCA file review actually asks.
 *
 * Second, what the client said and what the bank data shows are kept in
 * separate fields. Declared figures are never overwritten by observed ones.
 * That separation is what makes discrepancy detection possible at all, and it
 * keeps the client's own account of their finances intact on the file.
 */

export interface StatementLineInput {
  section: 'income' | 'expenditure' | 'asset';
  category: string;
  subcategory?: string | null;
  label?: string | null;
  enteredAmountPence: Pence;
  enteredFrequency: Frequency;
  source?: 'declared' | 'observed' | 'document-extracted' | 'adviser-adjusted' | 'migrated';
  observedAmountPence?: Pence | null;
  observedConfidence?: number | null;
  explanation?: string | null;
}

export interface StatementLine extends StatementLineInput {
  /** Always the monthly equivalent, whatever frequency was entered. */
  amountPence: Pence;
  triggerFigurePence: Pence | null;
  exceedsTrigger: boolean;
}

export interface HouseholdComposition {
  adults: number;
  children: number;
  /** Ages matter for some trigger figure sets. */
  childAges?: number[];
  vehicles?: number;
}

export interface TriggerFigureSet {
  version: string;
  source: 'placeholder' | 'firm-supplied';
  /**
   * Monthly trigger figures in pence, keyed by SFS expenditure category, then
   * by household size band ("1", "2", "3", "4+"). Real values are licensed
   * content a firm supplies under its own SFS membership.
   */
  categories: Record<string, Record<string, Pence>>;
}

export interface StatementTotals {
  totalIncomePence: Pence;
  totalExpenditurePence: Pence;
  surplusPence: Pence;
  totalAssetsPence: Pence;
}

export interface TriggerExceedance {
  category: string;
  amountPence: Pence;
  triggerPence: Pence;
  overByPence: Pence;
  explanation: string | null;
  /** The SFS expects an explanation where a category exceeds its guideline. */
  explanationRequired: true;
  explanationProvided: boolean;
}

export interface BuiltStatement {
  lines: StatementLine[];
  totals: StatementTotals;
  exceedances: TriggerExceedance[];
  household: HouseholdComposition;
  rulesetVersion: string | null;
}

export function householdBand(household: HouseholdComposition): string {
  const size = Math.max(1, household.adults + household.children);
  return size >= 4 ? '4+' : String(size);
}

export function triggerFigureFor(
  triggers: TriggerFigureSet | null,
  category: string,
  household: HouseholdComposition,
): Pence | null {
  if (!triggers) return null;
  const band = triggers.categories[category];
  if (!band) return null;
  return band[householdBand(household)] ?? band['4+'] ?? null;
}

/**
 * Normalises every line to a monthly amount, totals the sections, and compares
 * expenditure against the trigger figures in force.
 *
 * Exceeding a trigger figure is not an error and never blocks: households
 * legitimately spend more than a guideline. What the SFS expects is an
 * explanation, so an exceedance is reported with whether one has been given.
 */
export function buildStatement(input: {
  lines: readonly StatementLineInput[];
  household: HouseholdComposition;
  triggers?: TriggerFigureSet | null;
}): BuiltStatement {
  const triggers = input.triggers ?? null;

  const lines: StatementLine[] = input.lines.map((line) => {
    const amountPence = toMonthlyPence(line.enteredAmountPence, line.enteredFrequency);
    const triggerFigurePence =
      line.section === 'expenditure'
        ? triggerFigureFor(triggers, line.category, input.household)
        : null;
    return {
      ...line,
      amountPence,
      triggerFigurePence,
      exceedsTrigger: triggerFigurePence !== null && amountPence > triggerFigurePence,
    };
  });

  // Trigger figures apply to a category as a whole, so lines are grouped before
  // comparison. Two £40 lines under one £60 guideline is an exceedance.
  const byCategory = new Map<string, StatementLine[]>();
  for (const line of lines) {
    if (line.section !== 'expenditure') continue;
    const existing = byCategory.get(line.category);
    if (existing) existing.push(line);
    else byCategory.set(line.category, [line]);
  }

  const exceedances: TriggerExceedance[] = [];
  for (const [category, categoryLines] of byCategory) {
    const trigger = triggerFigureFor(triggers, category, input.household);
    if (trigger === null) continue;
    const total = sumPence(categoryLines.map((l) => l.amountPence));
    if (total <= trigger) continue;

    const explanation = categoryLines.map((l) => l.explanation).find((e) => e && e.trim()) ?? null;
    exceedances.push({
      category,
      amountPence: total,
      triggerPence: trigger,
      overByPence: total - trigger,
      explanation,
      explanationRequired: true,
      explanationProvided: Boolean(explanation),
    });
  }

  const totalIncomePence = sumPence(lines.filter((l) => l.section === 'income').map((l) => l.amountPence));
  const totalExpenditurePence = sumPence(lines.filter((l) => l.section === 'expenditure').map((l) => l.amountPence));
  const totalAssetsPence = sumPence(lines.filter((l) => l.section === 'asset').map((l) => l.amountPence));

  return {
    lines,
    totals: {
      totalIncomePence,
      totalExpenditurePence,
      surplusPence: totalIncomePence - totalExpenditurePence,
      totalAssetsPence,
    },
    exceedances,
    household: input.household,
    rulesetVersion: triggers?.version ?? null,
  };
}

// ---------------------------------------------------------------------------
// Declared versus observed
// ---------------------------------------------------------------------------

export interface Discrepancy {
  category: string;
  subcategory: string | null;
  declaredPence: Pence;
  observedPence: Pence;
  differencePence: Pence;
  /** Positive means the client declared more than the bank data shows. */
  direction: 'declared-higher' | 'observed-higher';
  percentageDifference: number;
  materiality: 'minor' | 'notable' | 'material';
  confidence: number | null;
  /**
   * Written for an adviser to raise with the client, not for a machine to act
   * on. A divergence is a question, not a finding: irregular income, cash
   * spending, a second account and a genuine error all look the same here.
   */
  suggestedQuestion: string;
}

export interface DiscrepancyThresholds {
  /** Ignore differences below this absolute amount. */
  minimumPence: Pence;
  notablePercentage: number;
  materialPercentage: number;
}

export const DEFAULT_DISCREPANCY_THRESHOLDS: DiscrepancyThresholds = {
  minimumPence: 2_000,
  notablePercentage: 15,
  materialPercentage: 30,
};

/**
 * Compares what the client declared against what was observed in bank data.
 *
 * Nothing here changes a regulated figure. The output is a list of questions
 * for an adviser, and the platform's authorisation layer prevents any
 * automated principal from acting on them.
 */
export function findDiscrepancies(
  lines: readonly StatementLine[],
  thresholds: DiscrepancyThresholds = DEFAULT_DISCREPANCY_THRESHOLDS,
): Discrepancy[] {
  const out: Discrepancy[] = [];

  for (const line of lines) {
    if (line.observedAmountPence === null || line.observedAmountPence === undefined) continue;
    const declared = line.amountPence;
    const observed = line.observedAmountPence;
    const difference = Math.abs(declared - observed);
    if (difference < thresholds.minimumPence) continue;

    const base = Math.max(declared, observed);
    if (base === 0) continue;
    const percentage = (difference / base) * 100;
    if (percentage < thresholds.notablePercentage) continue;

    const direction = declared > observed ? 'declared-higher' : 'observed-higher';
    const materiality = percentage >= thresholds.materialPercentage ? 'material' : 'notable';

    out.push({
      category: line.category,
      subcategory: line.subcategory ?? null,
      declaredPence: declared,
      observedPence: observed,
      differencePence: difference,
      direction,
      percentageDifference: Math.round(percentage * 10) / 10,
      materiality,
      confidence: line.observedConfidence ?? null,
      suggestedQuestion: suggestQuestion(line.section, line.category, direction),
    });
  }

  return out.sort((a, b) => b.differencePence - a.differencePence);
}

function suggestQuestion(
  section: 'income' | 'expenditure' | 'asset',
  category: string,
  direction: 'declared-higher' | 'observed-higher',
): string {
  const name = category.replace(/[-_]/g, ' ');
  if (section === 'income') {
    return direction === 'declared-higher'
      ? `Declared ${name} is higher than the amount seen in the bank data. Is income irregular, paid partly in cash, or received into another account?`
      : `The bank data shows more ${name} than was declared. Is there additional or recently changed income to record?`;
  }
  return direction === 'declared-higher'
    ? `Declared ${name} is higher than the spending seen in the bank data. Is some of this paid in cash, from another account, or an amount expected rather than currently paid?`
    : `The bank data shows more spending on ${name} than was declared. Is the budgeted figure realistic, or has something been missed?`;
}
