import { describe, expect, it } from 'vitest';
import {
  toMonthlyPence, fromMonthlyPence, sumPence, distributePence,
  formatPence, parsePounds, MoneyError,
} from '@solvenda/core';

describe('frequency normalisation', () => {
  it('converts each frequency to its monthly equivalent', () => {
    // £100 weekly is £433.33 monthly, not £400: 52 payments a year, not 48.
    expect(toMonthlyPence(10_000, 'weekly')).toBe(43_333);
    expect(toMonthlyPence(10_000, 'fortnightly')).toBe(21_667);
    expect(toMonthlyPence(10_000, 'four-weekly')).toBe(10_833);
    expect(toMonthlyPence(10_000, 'monthly')).toBe(10_000);
    expect(toMonthlyPence(120_000, 'annually')).toBe(10_000);
    expect(toMonthlyPence(30_000, 'quarterly')).toBe(10_000);
  });

  it('treats a one-off amount as contributing nothing to a monthly budget', () => {
    expect(toMonthlyPence(50_000, 'one-off')).toBe(0);
  });

  it('round-trips a monthly figure back to its entered frequency', () => {
    expect(fromMonthlyPence(43_333, 'weekly')).toBe(10_000);
    expect(fromMonthlyPence(10_000, 'monthly')).toBe(10_000);
  });

  it('refuses non-integer amounts rather than silently rounding', () => {
    expect(() => toMonthlyPence(100.5, 'monthly')).toThrow(MoneyError);
  });
});

describe('distribution', () => {
  it('never loses or invents a penny', () => {
    const shares = distributePence(10_000, [1, 1, 1]);
    expect(sumPence(shares)).toBe(10_000);
    expect(shares).toEqual([3_334, 3_333, 3_333]);
  });

  it('distributes pro rata by creditor balance', () => {
    // A £100 monthly payment across three creditors owed £1,000, £500 and £250.
    const shares = distributePence(10_000, [100_000, 50_000, 25_000]);
    expect(sumPence(shares)).toBe(10_000);
    // Exact shares are 5714.29, 2857.14 and 1428.57. The spare penny goes to
    // the third creditor, which lost the most in rounding.
    expect(shares).toEqual([5_714, 2_857, 1_429]);
  });

  it('handles an awkward remainder without drift over many rounds', () => {
    let total = 0;
    for (let i = 0; i < 120; i++) {
      const shares = distributePence(3_333, [1, 1, 1, 1, 1, 1, 1]);
      expect(sumPence(shares)).toBe(3_333);
      total += sumPence(shares);
    }
    expect(total).toBe(3_333 * 120);
  });

  it('rejects weights that cannot form a distribution', () => {
    expect(() => distributePence(1_000, [0, 0])).toThrow(MoneyError);
    expect(distributePence(1_000, [])).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats to two decimal places with thousands separators', () => {
    expect(formatPence(123_456)).toBe('£1,234.56');
    expect(formatPence(0)).toBe('£0.00');
    expect(formatPence(-5_000)).toBe('-£50.00');
    expect(formatPence(5_000, { showSign: true })).toBe('+£50.00');
  });

  it('parses the forms a person actually types', () => {
    expect(parsePounds('1234.56')).toBe(123_456);
    expect(parsePounds('£1,234.56')).toBe(123_456);
    expect(parsePounds('  £45 ')).toBe(4_500);
    expect(parsePounds('0.5')).toBe(50);
  });

  it('refuses input it cannot read exactly', () => {
    expect(() => parsePounds('about fifty')).toThrow(MoneyError);
    expect(() => parsePounds('12.345')).toThrow(MoneyError);
  });
});
