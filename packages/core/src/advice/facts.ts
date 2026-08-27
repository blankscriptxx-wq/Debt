import type { Facts, FactValue } from '../rules/engine.js';
import type { Pence } from '../money.js';
import { sumPence } from '../money.js';

/**
 * The fact set eligibility rules are evaluated against.
 *
 * Rules reference facts by name, so this is effectively the contract between
 * configuration and code. Adding a fact is additive; removing or renaming one
 * breaks existing rules, so the names here are treated as a published
 * interface. A missing fact evaluates to null rather than throwing, because
 * "not yet gathered" is a normal and meaningful state on a live case.
 */

export interface DebtSnapshot {
  id: string;
  balancePence: Pence;
  arrearsPence: Pence;
  debtType: string;
  isPriority: boolean;
  isJoint: boolean;
  inDispute: boolean;
  isStatuteBarred: boolean;
  includedInSolution: boolean;
  creditorId: string | null;
  creditorName: string;
  status: string;
}

export interface CaseSnapshot {
  caseId: string;
  caseTypeKey: string;
  stage: string;
  jurisdiction: 'england-wales' | 'scotland' | 'northern-ireland';
  monthsSinceLastReview: number | null;
  client: {
    id: string;
    jurisdiction: 'england-wales' | 'scotland' | 'northern-ireland';
    householdAdults: number;
    householdChildren: number;
    employmentStatus: string | null;
    dateOfBirth: string | null;
  };
  debts: readonly DebtSnapshot[];
  statement: {
    totalIncomePence: Pence;
    totalExpenditurePence: Pence;
    surplusPence: Pence;
    completedAt: string | null;
  } | null;
  affordability: {
    sustainablePaymentPence: Pence;
    contingencyPence: Pence;
  } | null;
  assets: {
    totalPence: Pence;
    realisablePence: Pence;
    vehicleValuePence: Pence;
    vehicleAdaptedForDisability: boolean;
    hasProperty: boolean;
    propertyEquityPence: Pence;
  };
  history: {
    hasActiveInsolvency: boolean;
    hasPriorInsolvency: boolean;
    priorInsolvencyDisclosed: boolean;
    monthsSinceBreathingSpace: number | null;
    monthsSinceDmp: number | null;
  };
  vulnerability: {
    activeRecordCount: number;
    drivers: readonly string[];
    highestSeverity: string | null;
  };
  evidence: Readonly<Record<string, boolean>>;
  /** Case-specific answers captured during the fact find. */
  attributes: Readonly<Record<string, FactValue>>;
}

/**
 * Non-priority, non-statute-barred, undisputed debt included in the solution.
 * This is the figure statutory thresholds actually bite on, and it is not the
 * same as "everything the client owes".
 */
export function qualifyingDebtPence(debts: readonly DebtSnapshot[]): Pence {
  return sumPence(
    debts
      .filter(
        (d) =>
          d.status === 'active' &&
          d.includedInSolution &&
          !d.isPriority &&
          !d.isStatuteBarred &&
          !d.inDispute,
      )
      .map((d) => d.balancePence),
  );
}

export function buildFacts(
  snapshot: CaseSnapshot,
  thresholdConfig: Readonly<Record<string, number>> = {},
): Facts {
  const active = snapshot.debts.filter((d) => d.status === 'active');
  const nonPriority = active.filter((d) => !d.isPriority);
  const priority = active.filter((d) => d.isPriority);
  const creditorIds = new Set(active.map((d) => d.creditorId ?? d.creditorName.toLowerCase().trim()));

  const facts: Record<string, FactValue> = {
    'case.id': snapshot.caseId,
    'case.type': snapshot.caseTypeKey,
    'case.stage': snapshot.stage,
    'case.jurisdiction': snapshot.jurisdiction,
    'case.monthsSinceLastReview': snapshot.monthsSinceLastReview,

    'client.jurisdiction': snapshot.client.jurisdiction,
    'client.householdAdults': snapshot.client.householdAdults,
    'client.householdChildren': snapshot.client.householdChildren,
    'client.householdSize': snapshot.client.householdAdults + snapshot.client.householdChildren,
    'client.employmentStatus': snapshot.client.employmentStatus,

    'debt.count': active.length,
    'debt.nonPriorityCount': nonPriority.length,
    'debt.priorityCount': priority.length,
    'debt.creditorCount': creditorIds.size,
    'debt.totalPence': sumPence(active.map((d) => d.balancePence)),
    'debt.qualifyingPence': qualifyingDebtPence(snapshot.debts),
    'debt.priorityPence': sumPence(priority.map((d) => d.balancePence)),
    'debt.priorityArrearsPence': sumPence(priority.map((d) => d.arrearsPence)),
    'debt.jointCount': active.filter((d) => d.isJoint).length,
    'debt.disputedCount': active.filter((d) => d.inDispute).length,

    'sfs.present': snapshot.statement !== null,
    'sfs.totalIncomePence': snapshot.statement?.totalIncomePence ?? null,
    'sfs.totalExpenditurePence': snapshot.statement?.totalExpenditurePence ?? null,
    'sfs.surplusPence': snapshot.statement?.surplusPence ?? null,

    'affordability.present': snapshot.affordability !== null,
    'affordability.sustainablePaymentPence': snapshot.affordability?.sustainablePaymentPence ?? null,

    'assets.totalPence': snapshot.assets.totalPence,
    'assets.realisablePence': snapshot.assets.realisablePence,
    'assets.vehicleValuePence': snapshot.assets.vehicleValuePence,
    'assets.vehicleAdaptedForDisability': snapshot.assets.vehicleAdaptedForDisability,
    'assets.hasProperty': snapshot.assets.hasProperty,
    'assets.propertyEquityPence': snapshot.assets.propertyEquityPence,

    'history.hasActiveInsolvency': snapshot.history.hasActiveInsolvency,
    'history.hasPriorInsolvency': snapshot.history.hasPriorInsolvency,
    'history.priorInsolvencyDisclosed': snapshot.history.priorInsolvencyDisclosed,
    'history.monthsSinceBreathingSpace': snapshot.history.monthsSinceBreathingSpace,
    'history.monthsSinceDmp': snapshot.history.monthsSinceDmp,

    'vulnerability.recordCount': snapshot.vulnerability.activeRecordCount,
    'vulnerability.drivers': snapshot.vulnerability.drivers as readonly string[],
    'vulnerability.highestSeverity': snapshot.vulnerability.highestSeverity,
  };

  for (const [key, present] of Object.entries(snapshot.evidence)) {
    facts[`evidence.${key}`] = present;
  }
  for (const [key, value] of Object.entries(snapshot.attributes)) {
    facts[`case.${key}`] = value;
  }
  for (const [key, value] of Object.entries(thresholdConfig)) {
    facts[key] = value;
  }

  return facts;
}
