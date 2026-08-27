import { describe, expect, it } from 'vitest';
import {
  buildStatement, findDiscrepancies, triggerFigureFor, householdBand,
  type StatementLineInput, type TriggerFigureSet,
} from '@solvenda/core';

/**
 * Placeholder trigger figures. Real values are licensed content a firm supplies
 * under its own SFS membership; the shape is what matters here.
 */
const TRIGGERS: TriggerFigureSet = {
  version: 'placeholder-2026',
  source: 'placeholder',
  categories: {
    'food-and-housekeeping': { '1': 30_000, '2': 45_000, '3': 55_000, '4+': 65_000 },
    'communications-and-leisure': { '1': 8_000, '2': 11_000, '3': 13_000, '4+': 15_000 },
    'personal-costs': { '1': 4_000, '2': 6_500, '3': 8_000, '4+': 9_500 },
  },
};

const household = { adults: 2, children: 1 };

function lines(): StatementLineInput[] {
  return [
    { section: 'income', category: 'earnings', enteredAmountPence: 45_000, enteredFrequency: 'weekly' },
    { section: 'income', category: 'benefits', enteredAmountPence: 32_000, enteredFrequency: 'monthly' },
    { section: 'expenditure', category: 'rent', enteredAmountPence: 85_000, enteredFrequency: 'monthly' },
    { section: 'expenditure', category: 'food-and-housekeeping', enteredAmountPence: 12_000, enteredFrequency: 'weekly' },
    { section: 'expenditure', category: 'communications-and-leisure', enteredAmountPence: 9_000, enteredFrequency: 'monthly' },
    { section: 'asset', category: 'vehicle', enteredAmountPence: 150_000, enteredFrequency: 'one-off' },
  ];
}

describe('statement building', () => {
  it('normalises every line to a monthly amount', () => {
    const built = buildStatement({ lines: lines(), household, triggers: TRIGGERS });
    const earnings = built.lines.find((l) => l.category === 'earnings')!;
    // £450 a week is £1,950 a month: 52 payments a year, not 48.
    expect(earnings.amountPence).toBe(195_000);
    expect(earnings.enteredAmountPence).toBe(45_000);
    // The frequency the client actually gave is preserved alongside it.
    expect(earnings.enteredFrequency).toBe('weekly');
  });

  it('totals income, expenditure and surplus', () => {
    const built = buildStatement({ lines: lines(), household, triggers: TRIGGERS });
    expect(built.totals.totalIncomePence).toBe(227_000);
    // 85,000 rent + 52,000 food (£120/wk) + 9,000 comms
    expect(built.totals.totalExpenditurePence).toBe(146_000);
    expect(built.totals.surplusPence).toBe(81_000);
  });

  it('excludes assets from the income and expenditure totals', () => {
    const built = buildStatement({ lines: lines(), household, triggers: TRIGGERS });
    expect(built.totals.totalAssetsPence).toBe(0); // a one-off asset is not monthly income
  });

  it('selects the trigger figure for the household size', () => {
    expect(householdBand({ adults: 1, children: 0 })).toBe('1');
    expect(householdBand({ adults: 2, children: 1 })).toBe('3');
    expect(householdBand({ adults: 2, children: 4 })).toBe('4+');
    expect(triggerFigureFor(TRIGGERS, 'food-and-housekeeping', { adults: 2, children: 1 })).toBe(55_000);
    expect(triggerFigureFor(TRIGGERS, 'no-such-category', household)).toBeNull();
    expect(triggerFigureFor(null, 'food-and-housekeeping', household)).toBeNull();
  });

  it('reports an exceedance without blocking, and notes whether it was explained', () => {
    // Households legitimately spend more than a guideline. The SFS asks for an
    // explanation, not a refusal.
    const built = buildStatement({ lines: lines(), household, triggers: TRIGGERS });
    expect(built.exceedances).toHaveLength(0);

    const over = buildStatement({
      lines: [...lines(), { section: 'expenditure', category: 'food-and-housekeeping',
        enteredAmountPence: 20_000, enteredFrequency: 'monthly' }],
      household, triggers: TRIGGERS,
    });
    expect(over.exceedances).toHaveLength(1);
    expect(over.exceedances[0]).toMatchObject({
      category: 'food-and-housekeeping',
      amountPence: 72_000,
      triggerPence: 55_000,
      overByPence: 17_000,
      explanationRequired: true,
      explanationProvided: false,
    });
  });

  it('compares a category as a whole rather than line by line', () => {
    // Two modest lines can exceed one guideline between them.
    const built = buildStatement({
      lines: [
        { section: 'expenditure', category: 'personal-costs', enteredAmountPence: 5_000, enteredFrequency: 'monthly' },
        { section: 'expenditure', category: 'personal-costs', enteredAmountPence: 4_500, enteredFrequency: 'monthly' },
      ],
      household, triggers: TRIGGERS,
    });
    expect(built.exceedances).toHaveLength(1);
    expect(built.exceedances[0]!.amountPence).toBe(9_500);
  });

  it('records the explanation an adviser gave', () => {
    const built = buildStatement({
      lines: [{ section: 'expenditure', category: 'personal-costs',
        enteredAmountPence: 12_000, enteredFrequency: 'monthly',
        explanation: 'Ongoing medication costs not covered by a prepayment certificate.' }],
      household, triggers: TRIGGERS,
    });
    expect(built.exceedances[0]!.explanationProvided).toBe(true);
    expect(built.exceedances[0]!.explanation).toMatch(/medication/);
  });

  it('records which ruleset produced the statement', () => {
    const built = buildStatement({ lines: lines(), household, triggers: TRIGGERS });
    expect(built.rulesetVersion).toBe('placeholder-2026');
    expect(buildStatement({ lines: lines(), household }).rulesetVersion).toBeNull();
  });
});

describe('declared versus observed', () => {
  it('flags a material divergence with a question for the adviser', () => {
    const built = buildStatement({
      lines: [{ section: 'expenditure', category: 'food-and-housekeeping',
        enteredAmountPence: 40_000, enteredFrequency: 'monthly',
        observedAmountPence: 62_000, observedConfidence: 0.86 }],
      household, triggers: TRIGGERS,
    });
    const [discrepancy] = findDiscrepancies(built.lines);
    expect(discrepancy).toMatchObject({
      category: 'food-and-housekeeping',
      declaredPence: 40_000,
      observedPence: 62_000,
      differencePence: 22_000,
      direction: 'observed-higher',
      materiality: 'material',
      confidence: 0.86,
    });
    expect(discrepancy!.suggestedQuestion).toMatch(/more spending on food and housekeeping than was declared/);
  });

  it('never alters the declared figure', () => {
    const built = buildStatement({
      lines: [{ section: 'income', category: 'earnings', enteredAmountPence: 200_000,
        enteredFrequency: 'monthly', observedAmountPence: 140_000 }],
      household, triggers: TRIGGERS,
    });
    findDiscrepancies(built.lines);
    // The client's own account of their finances stays on the file untouched.
    expect(built.lines[0]!.amountPence).toBe(200_000);
    expect(built.totals.totalIncomePence).toBe(200_000);
  });

  it('ignores small differences that would only create noise', () => {
    const built = buildStatement({
      lines: [{ section: 'expenditure', category: 'personal-costs', enteredAmountPence: 5_000,
        enteredFrequency: 'monthly', observedAmountPence: 5_400 }],
      household, triggers: TRIGGERS,
    });
    expect(findDiscrepancies(built.lines)).toEqual([]);
  });

  it('ignores lines with no observed data at all', () => {
    const built = buildStatement({ lines: lines(), household, triggers: TRIGGERS });
    expect(findDiscrepancies(built.lines)).toEqual([]);
  });

  it('orders discrepancies by the size of the difference', () => {
    const built = buildStatement({
      lines: [
        { section: 'expenditure', category: 'personal-costs', enteredAmountPence: 10_000,
          enteredFrequency: 'monthly', observedAmountPence: 16_000 },
        { section: 'expenditure', category: 'food-and-housekeeping', enteredAmountPence: 40_000,
          enteredFrequency: 'monthly', observedAmountPence: 70_000 },
      ],
      household, triggers: TRIGGERS,
    });
    const found = findDiscrepancies(built.lines);
    expect(found.map((d) => d.category)).toEqual(['food-and-housekeeping', 'personal-costs']);
  });
});
