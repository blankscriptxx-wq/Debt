import { describe, expect, it } from 'vitest';
import {
  ageAt, ageOf, compositionFrom, equityOf, monthlyIncomeOf,
  totalAttributableEquity, totalsFor, type Asset, type HouseholdMember,
} from '@solvenda/core';

/**
 * The case file's computed properties.
 *
 * These are the parts where a wrong answer changes advice rather than a
 * display: household banding decides the trigger figures, equity decides
 * whether a DRO is available, and the debt split decides what can go into a
 * solution at all.
 */

const member = (over: Partial<HouseholdMember>): HouseholdMember => ({
  id: 'x', clientId: 'c', relationship: 'child',
  isDependant: true, contributesToHousehold: false, contributionPence: 0,
  ...over,
});

describe('household composition', () => {
  const asOf = new Date('2026-08-28T00:00:00Z');

  it('counts the client as an adult even with nobody else recorded', () => {
    expect(compositionFrom([], asOf)).toEqual({ adults: 1, children: 0, childAges: [] });
  });

  it('bands by age, not by whether someone is called a dependant', () => {
    // An 18-year-old still living at home is a dependant to a parent and an
    // adult to the SFS. The trigger figures follow the age.
    const composition = compositionFrom([
      member({ relationship: 'child', dateOfBirth: '2008-01-01', isDependant: true }),
      member({ relationship: 'child', dateOfBirth: '2015-06-01' }),
    ], asOf);
    expect(composition).toEqual({ adults: 2, children: 1, childAges: [11] });
  });

  it('treats a partner as an adult', () => {
    const composition = compositionFrom([
      member({ relationship: 'partner', ageYears: 34, isDependant: false }),
    ], asOf);
    expect(composition.adults).toBe(2);
    expect(composition.children).toBe(0);
  });

  it('uses a stated age when no date of birth is known', () => {
    expect(ageOf({ ageYears: 7 }, asOf)).toBe(7);
    expect(ageOf({ dateOfBirth: '2000-08-29' }, asOf)).toBe(25);
    expect(ageOf({ dateOfBirth: '2000-08-28' }, asOf)).toBe(26);
    expect(ageOf({}, asOf)).toBeNull();
  });
});

describe('client age', () => {
  it('does not tick over until the birthday has passed', () => {
    const asOf = new Date('2026-08-28T00:00:00Z');
    expect(ageAt('1999-06-24', asOf)).toBe(27);
    expect(ageAt('1999-08-29', asOf)).toBe(26);
    expect(ageAt(null, asOf)).toBeNull();
  });
});

describe('employment income', () => {
  it('normalises the pay frequency the client actually gave', () => {
    // Four-weekly is not monthly, and treating it as such overstates annual
    // income by a month's pay - roughly 8%, which is the difference between a
    // plan that holds and one that does not.
    expect(monthlyIncomeOf({ netPayPence: 100_000, payFrequency: 'four-weekly' } as never))
      .toBe(108_333);
    expect(monthlyIncomeOf({ netPayPence: 100_000, payFrequency: 'monthly' } as never))
      .toBe(100_000);
    expect(monthlyIncomeOf({ netPayPence: 50_000, payFrequency: 'weekly' } as never))
      .toBe(216_667);
  });

  it('contributes nothing when there is no pay', () => {
    expect(monthlyIncomeOf({ netPayPence: null, payFrequency: 'monthly' } as never)).toBe(0);
  });
});

describe('asset equity', () => {
  it('never reports negative equity as an asset', () => {
    expect(equityOf({ estimatedValuePence: 15_000_00, securedDebtPence: 18_000_00 }))
      .toEqual({ equityPence: 0, attributableEquityPence: 0 });
  });

  it('attributes only the client share of a jointly owned asset', () => {
    expect(equityOf({
      estimatedValuePence: 200_000_00,
      securedDebtPence: 150_000_00,
      ownershipShareBps: 5_000,
    })).toEqual({ equityPence: 50_000_00, attributableEquityPence: 25_000_00 });
  });

  it('leaves an exempt asset out of the total eligibility tests', () => {
    const assets = [
      { exemptionClaimed: null, attributableEquityPence: 1_000_00 },
      { exemptionClaimed: 'vehicle-needed-for-work', attributableEquityPence: 4_000_00 },
    ] as Asset[];
    expect(totalAttributableEquity(assets)).toBe(1_000_00);
  });
});

describe('debt totals', () => {
  const debts = [
    { debtType: 'unsecured', balancePence: 294_00, contractualPaymentPence: 0 },
    { debtType: 'unsecured', balancePence: 1_240_03, contractualPaymentPence: 49_00 },
    { debtType: 'secured', balancePence: 120_000_00, contractualPaymentPence: 640_00 },
    { debtType: 'court-fine', balancePence: 400_00, isPriority: true },
    { debtType: 'unsecured', balancePence: 9_999_00, status: 'removed' },
  ];

  it('separates secured from unsecured rather than summing everything', () => {
    const totals = totalsFor(debts);
    expect(totals.unsecuredCount).toBe(3);
    expect(totals.securedCount).toBe(1);
    expect(totals.unsecuredPence).toBe(294_00 + 1_240_03 + 400_00);
    expect(totals.securedPence).toBe(120_000_00);
  });

  it('excludes a removed debt from every total', () => {
    // Withdrawn debts stay on the file for the audit trail, so a total that
    // counted them would be wrong on exactly the cases someone is reviewing.
    expect(totalsFor(debts).unsecuredPence).not.toContain(9_999_00);
    expect(totalsFor(debts).unsecuredCount).toBe(3);
  });

  it('counts priority debts separately, since they cross the secured line', () => {
    const totals = totalsFor(debts);
    expect(totals.priorityCount).toBe(1);
    expect(totals.priorityPence).toBe(400_00);
  });

  it('sums the monthly commitments each side of the line', () => {
    const totals = totalsFor(debts);
    expect(totals.unsecuredMonthlyPence).toBe(49_00);
    expect(totals.securedMonthlyPence).toBe(640_00);
  });
});
