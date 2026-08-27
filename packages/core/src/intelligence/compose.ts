import type { CaseSnapshot } from '../advice/facts.js';
import type { CaseTypeDefinition } from '../case-types/schema.js';
import type { Discrepancy } from '../sfs/statement.js';
import { evaluateEligibility, type EligibilityResult } from '../advice/eligibility.js';
import { formatPence, type Pence } from '../money.js';
import { assessHealth, signal, type HealthAssessment, type Signal } from './signals.js';

/**
 * Case Intelligence.
 *
 * The problem this solves is mundane and expensive: an adviser opening a file
 * spends the first several minutes reconstructing it from a dozen screens, and
 * the things that most need attention - a surplus that has quietly halved, a
 * review three weeks overdue, a vulnerability recorded by a colleague last
 * month - are exactly the things easiest to miss.
 *
 * Everything below is computed from the case record. The AI narrative is added
 * separately and clearly labelled; if the model is unavailable, every signal,
 * every deadline and the health score are still there. The intelligence does
 * not depend on the model - the model summarises the intelligence.
 */

export interface IntelligenceInput {
  snapshot: CaseSnapshot;
  caseType: CaseTypeDefinition;
  caseTypes: readonly CaseTypeDefinition[];
  thresholdConfig?: Readonly<Record<string, number>>;
  discrepancies?: readonly Discrepancy[];
  /** The previous statement, for change detection. */
  previousStatement?: {
    surplusPence: Pence;
    totalIncomePence: Pence;
    totalExpenditurePence: Pence;
    completedAt: string;
  } | null;
  tasks?: readonly {
    id: string; title: string; dueAt: string | null;
    status: string; priority: string; assignedTo: string | null;
  }[];
  complianceFailures?: readonly {
    id: string; ruleKey: string; severity: string; detail: string | null;
  }[];
  pendingProposals?: readonly {
    id: string; proposalType: string; touchesRegulatedField: boolean;
    confidence: number | null; reasoning: string;
  }[];
  engagement?: {
    lastClientContactAt: string | null;
    lastClientResponseAt: string | null;
    unansweredOutboundCount: number;
    portalLastSeenAt: string | null;
  };
  payments?: {
    expectedMonthlyPence: Pence;
    lastPaymentPence: Pence | null;
    lastPaymentAt: string | null;
    missedCount: number;
    arrearsPence: Pence;
  } | null;
  now?: Date;
}

export interface NextAction {
  key: string;
  title: string;
  reason: string;
  urgency: 'now' | 'this-week' | 'when-convenient';
  relatedSignals: string[];
}

export interface CaseIntelligence {
  caseId: string;
  generatedAt: string;
  health: HealthAssessment;
  adviceReadiness: {
    ready: boolean;
    blocking: { item: string; why: string }[];
    stage: string;
    isAdvicePoint: boolean;
  };
  signals: Signal[];
  nextActions: NextAction[];
  eligibility: EligibilityResult;
  openTaskCount: number;
  overdueTaskCount: number;
  pendingProposalCount: number;
  regulatedProposalCount: number;
  /** Present only when a narrative has been generated and accepted. */
  narrative: {
    text: string;
    invocationId: string;
    simulated: boolean;
    generatedAt: string;
  } | null;
}

const DAY_MS = 86_400_000;

export function composeCaseIntelligence(input: IntelligenceInput): CaseIntelligence {
  const now = input.now ?? new Date();
  const signals: Signal[] = [];

  signals.push(...affordabilitySignals(input, now));
  signals.push(...discrepancySignals(input));
  signals.push(...evidenceSignals(input));
  signals.push(...vulnerabilitySignals(input));
  signals.push(...deadlineSignals(input, now));
  signals.push(...complianceSignals(input));
  signals.push(...engagementSignals(input, now));
  signals.push(...paymentSignals(input));
  signals.push(...proposalSignals(input));

  const eligibility = evaluateEligibility({
    snapshot: input.snapshot,
    caseTypes: input.caseTypes,
    thresholdConfig: input.thresholdConfig ?? {},
  });

  const stage = input.caseType.stages.find((s) => s.key === input.snapshot.stage);
  const readiness = assessReadiness(input, signals);

  const tasks = input.tasks ?? [];
  const openTasks = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
  const overdue = openTasks.filter((t) => t.dueAt !== null && new Date(t.dueAt) < now);
  const proposals = input.pendingProposals ?? [];

  return {
    caseId: input.snapshot.caseId,
    generatedAt: now.toISOString(),
    health: assessHealth(signals),
    adviceReadiness: {
      ...readiness,
      stage: input.snapshot.stage,
      isAdvicePoint: stage?.isAdvicePoint ?? false,
    },
    signals: [...signals].sort(bySeverityThenWeight),
    nextActions: deriveNextActions(signals, readiness, input),
    eligibility,
    openTaskCount: openTasks.length,
    overdueTaskCount: overdue.length,
    pendingProposalCount: proposals.length,
    regulatedProposalCount: proposals.filter((p) => p.touchesRegulatedField).length,
    narrative: null,
  };
}

// ---------------------------------------------------------------------------

function affordabilitySignals(input: IntelligenceInput, _now: Date): Signal[] {
  const out: Signal[] = [];
  const statement = input.snapshot.statement;
  if (!statement) return out;

  if (statement.surplusPence < 0) {
    out.push(signal({
      key: 'deficit-budget',
      category: 'affordability',
      severity: 'urgent',
      title: 'Budget is in deficit',
      detail:
        `Expenditure exceeds income by ${formatPence(Math.abs(statement.surplusPence))} a month. ` +
        `The client cannot sustain any payment arrangement at these figures.`,
      sources: [{ type: 'financial_statement', id: null, label: 'Current financial statement' }],
      suggestedAction: 'Review the budget for missed income, and check entitlement to benefits.',
    }));
  }

  const previous = input.previousStatement;
  if (previous && statement.surplusPence !== previous.surplusPence) {
    const delta = statement.surplusPence - previous.surplusPence;
    const proportion = previous.surplusPence !== 0
      ? Math.abs(delta) / Math.abs(previous.surplusPence)
      : 1;

    if (proportion >= 0.2 && Math.abs(delta) >= 2_000) {
      const worse = delta < 0;
      out.push(signal({
        key: 'affordability-changed',
        category: 'affordability',
        severity: worse ? 'urgent' : 'attention',
        title: worse ? 'Affordability has fallen materially' : 'Affordability has improved materially',
        detail:
          `Monthly surplus has moved from ${formatPence(previous.surplusPence)} to ` +
          `${formatPence(statement.surplusPence)}, a change of ${formatPence(Math.abs(delta))} ` +
          `(${Math.round(proportion * 100)}%).`,
        sources: [
          { type: 'financial_statement', id: null, label: 'Current financial statement' },
          { type: 'financial_statement', id: null, label: `Previous statement, ${previous.completedAt}` },
        ],
        suggestedAction: worse
          ? 'Reassess whether the current arrangement remains sustainable.'
          : 'Consider whether the arrangement should be revised upward at the next review.',
      }));
    }
  }

  return out;
}

function discrepancySignals(input: IntelligenceInput): Signal[] {
  const material = (input.discrepancies ?? []).filter((d) => d.materiality === 'material');
  if (material.length === 0) return [];

  const total = material.reduce((sum, d) => sum + d.differencePence, 0);
  return [signal({
    key: 'declared-observed-divergence',
    category: 'discrepancy',
    severity: material.length >= 3 ? 'urgent' : 'attention',
    title: `${material.length} material difference${material.length === 1 ? '' : 's'} between declared and observed figures`,
    detail:
      `Categories differing materially: ${material.map((d) => d.category).join(', ')}. ` +
      `Total divergence ${formatPence(total)} a month. These are questions to raise, not corrections to make - ` +
      `irregular income, cash spending and a second account all look like this.`,
    sources: material.map((d) => ({
      type: 'financial_statement_line', id: null, label: `${d.category} declared vs observed`,
    })),
    suggestedAction: 'Work through the differences with the client before finalising the statement.',
  })];
}

function evidenceSignals(input: IntelligenceInput): Signal[] {
  const stage = input.caseType.stages.find((s) => s.key === input.snapshot.stage);
  if (!stage) return [];

  const missing = stage.requiredEvidence.filter((key) => input.snapshot.evidence[key] !== true);
  if (missing.length === 0) return [];

  const labels = missing.map(
    (key) => input.caseType.evidence.find((e) => e.key === key)?.label ?? key,
  );

  return [signal({
    key: 'evidence-outstanding',
    category: 'compliance',
    severity: 'attention',
    title: `${missing.length} required item${missing.length === 1 ? '' : 's'} outstanding at this stage`,
    detail: `Still needed before the case can leave ${stage.name}: ${labels.join(', ')}.`,
    sources: [{ type: 'case_type_definition', id: null, label: `${input.caseType.name} stage requirements` }],
    suggestedAction: 'Request the outstanding items from the client.',
  })];
}

function vulnerabilitySignals(input: IntelligenceInput): Signal[] {
  const v = input.snapshot.vulnerability;
  if (v.activeRecordCount === 0) return [];

  const severe = v.highestSeverity === 'significant';
  return [signal({
    key: 'vulnerability-recorded',
    category: 'vulnerability',
    severity: severe ? 'urgent' : 'attention',
    title: severe ? 'Significant vulnerability recorded' : 'Vulnerability recorded',
    detail:
      `${v.activeRecordCount} active record${v.activeRecordCount === 1 ? '' : 's'} against ` +
      `${v.drivers.join(', ')}. Agreed adjustments apply to how this client is contacted and supported.`,
    sources: [{ type: 'vulnerability_record', id: null, label: 'Vulnerability records' }],
    suggestedAction: 'Check the recorded support needs before contacting the client.',
    // Vulnerability never reduces the health score. A vulnerable client is not
    // an unhealthy case; treating them as one would rank people by their
    // difficulties.
    weight: 0,
  })];
}

function deadlineSignals(input: IntelligenceInput, now: Date): Signal[] {
  const out: Signal[] = [];
  const months = input.snapshot.monthsSinceLastReview;
  const cadence = input.caseType.reviewCadence.everyMonths;

  if (cadence !== null && months !== null && months > cadence) {
    const overdueBy = months - cadence;
    out.push(signal({
      key: 'review-overdue',
      category: 'deadline',
      severity: overdueBy >= 2 ? 'urgent' : 'attention',
      title: `Review overdue by ${overdueBy} month${overdueBy === 1 ? '' : 's'}`,
      detail:
        `The ${input.caseType.name} requires a review every ${cadence} months. ` +
        `The last was ${months} months ago.`,
      sources: [{ type: 'case', id: input.snapshot.caseId, label: 'Case review history' }],
      suggestedAction: 'Book the review and request an updated financial statement.',
    }));
  }

  const stage = input.caseType.stages.find((s) => s.key === input.snapshot.stage);
  if (stage?.slaHours) {
    // Stage entry time is carried on the snapshot's attributes where available.
    const enteredAt = input.snapshot.attributes['stageEnteredAt'];
    if (typeof enteredAt === 'string') {
      const hours = (now.getTime() - new Date(enteredAt).getTime()) / 3_600_000;
      if (hours > stage.slaHours) {
        out.push(signal({
          key: 'stage-sla-breached',
          category: 'progression',
          severity: hours > stage.slaHours * 2 ? 'urgent' : 'attention',
          title: `Case has been in ${stage.name} beyond its target`,
          detail:
            `${Math.round(hours)} hours in this stage against a ${stage.slaHours} hour target.`,
          sources: [{ type: 'case', id: input.snapshot.caseId, label: 'Stage history' }],
          suggestedAction: 'Identify what is holding the case at this stage.',
        }));
      }
    }
  }

  return out;
}

function complianceSignals(input: IntelligenceInput): Signal[] {
  const failures = input.complianceFailures ?? [];
  const blocking = failures.filter((f) => f.severity === 'blocking');
  if (failures.length === 0) return [];

  return [signal({
    key: 'compliance-failures',
    category: 'compliance',
    severity: blocking.length > 0 ? 'critical' : 'attention',
    title: blocking.length > 0
      ? `${blocking.length} blocking compliance check${blocking.length === 1 ? '' : 's'} failing`
      : `${failures.length} compliance observation${failures.length === 1 ? '' : 's'}`,
    detail: failures.map((f) => f.detail ?? f.ruleKey).join('; '),
    sources: failures.map((f) => ({ type: 'compliance_check', id: f.id, label: f.ruleKey })),
    suggestedAction: blocking.length > 0
      ? 'Resolve the blocking checks before progressing the case.'
      : 'Review the observations.',
  })];
}

function engagementSignals(input: IntelligenceInput, now: Date): Signal[] {
  const e = input.engagement;
  if (!e) return [];
  const out: Signal[] = [];

  if (e.lastClientResponseAt) {
    const days = Math.floor((now.getTime() - new Date(e.lastClientResponseAt).getTime()) / DAY_MS);
    if (days >= 21) {
      out.push(signal({
        key: 'client-disengaged',
        category: 'engagement',
        severity: days >= 42 ? 'urgent' : 'attention',
        title: `No response from the client for ${days} days`,
        detail:
          `${e.unansweredOutboundCount} outbound message${e.unansweredOutboundCount === 1 ? '' : 's'} ` +
          `unanswered. Disengagement often precedes a plan breaking down, and can itself be a ` +
          `sign of difficulty rather than disinterest.`,
        sources: [{ type: 'communications', id: null, label: 'Communication history' }],
        suggestedAction: 'Try a different channel, and consider whether support needs have changed.',
      }));
    }
  }

  return out;
}

function paymentSignals(input: IntelligenceInput): Signal[] {
  const p = input.payments;
  if (!p) return [];
  const out: Signal[] = [];

  if (p.missedCount > 0) {
    out.push(signal({
      key: 'payments-missed',
      category: 'payment',
      severity: p.missedCount >= 3 ? 'critical' : p.missedCount >= 2 ? 'urgent' : 'attention',
      title: `${p.missedCount} payment${p.missedCount === 1 ? '' : 's'} missed`,
      detail:
        `Arrears of ${formatPence(p.arrearsPence)} against an expected ` +
        `${formatPence(p.expectedMonthlyPence)} a month.`,
      sources: [{ type: 'payments', id: null, label: 'Payment history' }],
      suggestedAction: 'Contact the client to understand the change and consider forbearance.',
    }));
  }

  return out;
}

function proposalSignals(input: IntelligenceInput): Signal[] {
  const proposals = input.pendingProposals ?? [];
  if (proposals.length === 0) return [];

  const regulated = proposals.filter((p) => p.touchesRegulatedField);
  return [signal({
    key: 'proposals-awaiting-decision',
    category: 'data-quality',
    severity: 'informational',
    title: `${proposals.length} suggestion${proposals.length === 1 ? '' : 's'} awaiting your decision`,
    detail:
      regulated.length > 0
        ? `${regulated.length} affect${regulated.length === 1 ? 's' : ''} regulated information and can only be actioned by you.`
        : 'None affect regulated information.',
    sources: proposals.map((p) => ({ type: 'ai_proposal', id: p.id, label: p.proposalType })),
    suggestedAction: 'Review the suggestions when working the case.',
  })];
}

function assessReadiness(
  input: IntelligenceInput,
  signals: readonly Signal[],
): { ready: boolean; blocking: { item: string; why: string }[] } {
  const blocking: { item: string; why: string }[] = [];

  if (!input.snapshot.statement) {
    blocking.push({
      item: 'Financial statement',
      why: 'Advice cannot be given without a current picture of income and expenditure.',
    });
  }
  if (!input.snapshot.affordability) {
    blocking.push({
      item: 'Affordability assessment',
      why: 'What the client can sustainably pay has not been assessed.',
    });
  }
  if (input.snapshot.debts.filter((d) => d.status === 'active').length === 0) {
    blocking.push({ item: 'Debts', why: 'No debts have been recorded on the case.' });
  }

  const evidenceSignal = signals.find((s) => s.key === 'evidence-outstanding');
  if (evidenceSignal) {
    blocking.push({ item: 'Required evidence', why: evidenceSignal.detail });
  }

  const complianceSignal = signals.find(
    (s) => s.key === 'compliance-failures' && s.severity === 'critical');
  if (complianceSignal) {
    blocking.push({ item: 'Compliance checks', why: complianceSignal.detail });
  }

  return { ready: blocking.length === 0, blocking };
}

function deriveNextActions(
  signals: readonly Signal[],
  readiness: { ready: boolean; blocking: { item: string; why: string }[] },
  input: IntelligenceInput,
): NextAction[] {
  const actions: NextAction[] = [];

  for (const s of [...signals].sort(bySeverityThenWeight)) {
    if (!s.suggestedAction) continue;
    if (s.severity === 'informational' && actions.length >= 3) continue;
    actions.push({
      key: s.key,
      title: s.suggestedAction,
      reason: s.title,
      urgency:
        s.severity === 'critical' || s.severity === 'urgent' ? 'now'
        : s.severity === 'attention' ? 'this-week'
        : 'when-convenient',
      relatedSignals: [s.key],
    });
    if (actions.length >= 6) break;
  }

  const stage = input.caseType.stages.find((s) => s.key === input.snapshot.stage);
  if (readiness.ready && stage?.isAdvicePoint) {
    actions.unshift({
      key: 'ready-for-advice',
      title: 'Record the advice decision',
      reason: 'The evidence needed to advise is complete.',
      urgency: 'this-week',
      relatedSignals: [],
    });
  }

  return actions;
}

const SEVERITY_ORDER = { critical: 0, urgent: 1, attention: 2, informational: 3 } as const;

function bySeverityThenWeight(a: Signal, b: Signal): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.weight - a.weight;
}
