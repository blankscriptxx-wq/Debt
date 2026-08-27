import type { Pence } from '../money.js';

/**
 * A signal is one observation about a case, with the records that produced it.
 *
 * The traceability is the point. An adviser who is told "affordability has
 * fallen" and cannot see why will not trust the next thing the platform tells
 * them, so every signal names its sources and a reviewer can follow it back.
 * Nothing here is inferred by a model; these are computed from the case.
 */

export type SignalCategory =
  | 'affordability'
  | 'discrepancy'
  | 'vulnerability'
  | 'compliance'
  | 'engagement'
  | 'deadline'
  | 'creditor'
  | 'payment'
  | 'data-quality'
  | 'progression';

export type SignalSeverity = 'informational' | 'attention' | 'urgent' | 'critical';

export interface SourceReference {
  type: string;
  id: string | null;
  label: string;
}

export interface Signal {
  key: string;
  category: SignalCategory;
  severity: SignalSeverity;
  title: string;
  detail: string;
  sources: SourceReference[];
  /** What the adviser would do about it, if there is an obvious next step. */
  suggestedAction: string | null;
  /** Contributes this many points of concern to the case health score. */
  weight: number;
}

export const SEVERITY_WEIGHT: Record<SignalSeverity, number> = {
  informational: 0,
  attention: 8,
  urgent: 20,
  critical: 40,
};

export interface HealthAssessment {
  score: number;
  band: 'healthy' | 'monitor' | 'attention' | 'at-risk';
  drivers: Signal[];
  summary: string;
}

/**
 * Case health starts at 100 and loses points for each concerning signal.
 *
 * A composite score is only useful if it can be taken apart, so the drivers
 * travel with it. An adviser never has to accept "62" on faith.
 */
export function assessHealth(signals: readonly Signal[]): HealthAssessment {
  const concerning = signals.filter((s) => s.severity !== 'informational');
  const deduction = concerning.reduce((total, s) => total + s.weight, 0);
  const score = Math.max(0, Math.min(100, 100 - deduction));

  const band =
    score >= 85 ? 'healthy'
    : score >= 65 ? 'monitor'
    : score >= 40 ? 'attention'
    : 'at-risk';

  const drivers = [...concerning].sort((a, b) => b.weight - a.weight).slice(0, 5);

  const summary = buildSummary(concerning, drivers);

  return { score, band, drivers, summary };
}

function buildSummary(concerning: readonly Signal[], drivers: readonly Signal[]): string {
  if (drivers.length === 0) return 'No concerns identified on this case.';

  // Titles are written as sentences, so lower-casing them mid-list reads badly
  // and upper-casing an acronym-led title reads worse. Join them as they are
  // and only fix the first character.
  const listed = drivers.slice(0, 3).map((d) => d.title).join('; ');
  const prefix = drivers.length === concerning.length
    ? '' : `${concerning.length} concerns, led by: `;
  const body = prefix ? `${prefix}${listed}` : listed;
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}.`;
}

export function signal(input: Omit<Signal, 'weight'> & { weight?: number }): Signal {
  return { ...input, weight: input.weight ?? SEVERITY_WEIGHT[input.severity] };
}

export function formatChange(from: Pence, to: Pence): string {
  const delta = to - from;
  const direction = delta > 0 ? 'up' : 'down';
  const pounds = (Math.abs(delta) / 100).toFixed(2);
  return `${direction} £${pounds}`;
}
