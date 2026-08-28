import { describe, expect, it } from 'vitest';
import { PLANS, poundsFromPence } from '@solvenda/db/plans';

/**
 * The published price and the seeded price are the same object, so they cannot
 * disagree. What can still go wrong is the units: a fee written in pounds where
 * pence were meant is off by a hundred and looks entirely plausible. These
 * assertions are on the rendered figure for that reason.
 */
describe('the plan catalogue', () => {
  it('renders the intended headline prices', () => {
    const rendered = Object.fromEntries(
      PLANS.map((p) => [p.key, poundsFromPence(p.platformFeePence)]),
    );
    expect(rendered).toEqual({
      practice: '£950',
      firm: '£2,850',
      enterprise: '£7,500',
    });
  });

  it('renders the intended seat prices', () => {
    const rendered = PLANS.map((p) => poundsFromPence(p.perSeatPence));
    expect(rendered).toEqual(['£95', '£85', '£70']);
  });

  it('gets cheaper per seat as it gets bigger, and never free', () => {
    for (const plan of PLANS) {
      expect(plan.platformFeePence).toBeGreaterThan(0);
      expect(plan.perSeatPence).toBeGreaterThan(0);
      expect(plan.includedSeats).toBeGreaterThan(0);
    }
    const seats = PLANS.map((p) => p.perSeatPence);
    expect([...seats].sort((a, b) => b - a)).toEqual(seats);
    const fees = PLANS.map((p) => p.platformFeePence);
    expect([...fees].sort((a, b) => a - b)).toEqual(fees);
  });

  it('meters only the four things whose cost is genuinely variable', () => {
    for (const plan of PLANS) {
      expect(Object.keys(plan.usageTerms).sort()).toEqual([
        'ai.tokens',
        'comms.messages',
        'open-banking.calls',
        'storage.gb',
      ]);
    }
  });
});
