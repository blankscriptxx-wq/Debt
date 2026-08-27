/**
 * Money is integer pence throughout. Floating point is never used for a
 * monetary value: a penny of drift in a surplus is a wrong DMP payment, and in
 * an IVA it is a wrong dividend to every creditor.
 */
export type Pence = number;

export const FREQUENCIES = [
  'weekly', 'fortnightly', 'four-weekly', 'monthly', 'quarterly', 'annually', 'one-off',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/**
 * Payments per year for each frequency. Weekly is 52 rather than 52.1775,
 * matching how the sector states figures; the monthly conversion below uses the
 * annualised value so a weekly amount does not quietly lose a payment.
 */
const PER_YEAR: Record<Frequency, number> = {
  weekly: 52,
  fortnightly: 26,
  'four-weekly': 13,
  monthly: 12,
  quarterly: 4,
  annually: 1,
  'one-off': 0,
};

export class MoneyError extends Error {}

/**
 * Converts an amount at any frequency to its monthly equivalent, rounding half
 * away from zero to the penny. A one-off amount contributes nothing to a
 * monthly budget and returns zero.
 */
export function toMonthlyPence(amount: Pence, frequency: Frequency): Pence {
  assertPence(amount);
  const perYear = PER_YEAR[frequency];
  if (perYear === undefined) throw new MoneyError(`Unknown frequency: ${frequency}`);
  if (perYear === 0) return 0;
  return roundHalfAwayFromZero((amount * perYear) / 12);
}

export function fromMonthlyPence(monthly: Pence, frequency: Frequency): Pence {
  assertPence(monthly);
  const perYear = PER_YEAR[frequency];
  if (!perYear) return 0;
  return roundHalfAwayFromZero((monthly * 12) / perYear);
}

export function sumPence(values: readonly Pence[]): Pence {
  let total = 0;
  for (const v of values) {
    assertPence(v);
    total += v;
  }
  return total;
}

/**
 * Distributes an amount across weights without losing or inventing a penny.
 * Used for pro-rata creditor distributions, where the remainder must go
 * somewhere explicit rather than disappearing into rounding.
 */
export function distributePence(total: Pence, weights: readonly number[]): Pence[] {
  assertPence(total);
  if (weights.length === 0) return [];
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  if (weightTotal <= 0) throw new MoneyError('Distribution weights must sum to more than zero');

  const exact = weights.map((w) => (total * w) / weightTotal);
  const floors = exact.map((v) => Math.floor(v));
  let remainder = total - floors.reduce((a, b) => a + b, 0);

  // Largest-remainder method: the pennies go to the entries that lost the most
  // in rounding, which is both fair and reproducible.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    out[i] = out[i]! + 1;
    remainder -= 1;
  }
  return out;
}

export function formatPence(amount: Pence, options: { showSign?: boolean } = {}): string {
  const negative = amount < 0;
  const abs = Math.abs(amount);
  const body = `£${(abs / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  if (negative) return `-${body}`;
  return options.showSign ? `+${body}` : body;
}

export function parsePounds(input: string): Pence {
  const cleaned = input.replace(/[£,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new MoneyError(`Cannot read "${input}" as an amount`);
  }
  return roundHalfAwayFromZero(Number(cleaned) * 100);
}

function assertPence(value: number): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`Monetary values must be integer pence, received ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Monetary value ${value} is outside the safe integer range`);
  }
}

function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}
