/**
 * A small declarative rule language.
 *
 * Eligibility for a DRO, an IVA or a Trust Deed changes by regulation, differs
 * by jurisdiction, and firms hold legitimate policy views of their own on top
 * of the statutory position. Encoding that in TypeScript means a deployment
 * every time a limit moves, so rules are data: JSON that an administrator can
 * edit, that the platform can version, and that an evaluation can store
 * verbatim so a decision remains explicable years later.
 *
 * The language is deliberately not Turing complete and evaluates no code. The
 * worst a malformed rule can do is fail to evaluate, which is reported rather
 * than swallowed.
 */

export type Expression =
  | { const: number | string | boolean | null }
  | { fact: string }
  | { and: Expression[] }
  | { or: Expression[] }
  | { not: Expression }
  | { eq: [Expression, Expression] }
  | { neq: [Expression, Expression] }
  | { gt: [Expression, Expression] }
  | { gte: [Expression, Expression] }
  | { lt: [Expression, Expression] }
  | { lte: [Expression, Expression] }
  | { between: [Expression, Expression, Expression] }
  | { in: [Expression, Expression[]] }
  | { includes: [Expression, Expression] }
  | { isNull: Expression }
  | { add: Expression[] }
  | { subtract: [Expression, Expression] }
  | { multiply: Expression[] };

export type FactValue = number | string | boolean | null | readonly (string | number)[];
export type Facts = Readonly<Record<string, FactValue>>;

export class RuleEvaluationError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${message} (at ${path})`);
    this.name = 'RuleEvaluationError';
  }
}

const MAX_DEPTH = 24;

export function evaluate(expression: Expression, facts: Facts, path = '$', depth = 0): FactValue {
  if (depth > MAX_DEPTH) {
    throw new RuleEvaluationError('Expression nested too deeply', path);
  }
  const next = (e: Expression, seg: string) => evaluate(e, facts, `${path}.${seg}`, depth + 1);

  if ('const' in expression) return expression.const;

  if ('fact' in expression) {
    // A missing fact is null rather than an error: rules routinely reference
    // information that has not been gathered yet, and "not yet known" is a
    // meaningful state in a debt advice case.
    return Object.prototype.hasOwnProperty.call(facts, expression.fact)
      ? facts[expression.fact]!
      : null;
  }

  if ('and' in expression) return expression.and.every((e, i) => truthy(next(e, `and[${i}]`)));
  if ('or' in expression) return expression.or.some((e, i) => truthy(next(e, `or[${i}]`)));
  if ('not' in expression) return !truthy(next(expression.not, 'not'));

  if ('eq' in expression) return same(next(expression.eq[0], 'eq[0]'), next(expression.eq[1], 'eq[1]'));
  if ('neq' in expression) return !same(next(expression.neq[0], 'neq[0]'), next(expression.neq[1], 'neq[1]'));

  if ('gt' in expression) return compare(expression.gt, next, path, (a, b) => a > b);
  if ('gte' in expression) return compare(expression.gte, next, path, (a, b) => a >= b);
  if ('lt' in expression) return compare(expression.lt, next, path, (a, b) => a < b);
  if ('lte' in expression) return compare(expression.lte, next, path, (a, b) => a <= b);

  if ('between' in expression) {
    const [v, lo, hi] = expression.between;
    const value = numeric(next(v, 'between[0]'), path);
    if (value === null) return false;
    const low = numeric(next(lo, 'between[1]'), path);
    const high = numeric(next(hi, 'between[2]'), path);
    if (low === null || high === null) return false;
    return value >= low && value <= high;
  }

  if ('in' in expression) {
    const value = next(expression.in[0], 'in[0]');
    return expression.in[1].some((e, i) => same(value, next(e, `in[1][${i}]`)));
  }

  if ('includes' in expression) {
    const haystack = next(expression.includes[0], 'includes[0]');
    const needle = next(expression.includes[1], 'includes[1]');
    if (!Array.isArray(haystack)) return false;
    return haystack.some((v) => same(v, needle));
  }

  if ('isNull' in expression) return next(expression.isNull, 'isNull') === null;

  if ('add' in expression) {
    return expression.add.reduce<number>(
      (acc, e, i) => acc + (numeric(next(e, `add[${i}]`), path) ?? 0), 0);
  }
  if ('subtract' in expression) {
    const a = numeric(next(expression.subtract[0], 'subtract[0]'), path) ?? 0;
    const b = numeric(next(expression.subtract[1], 'subtract[1]'), path) ?? 0;
    return a - b;
  }
  if ('multiply' in expression) {
    return expression.multiply.reduce<number>(
      (acc, e, i) => acc * (numeric(next(e, `multiply[${i}]`), path) ?? 0), 1);
  }

  throw new RuleEvaluationError(
    `Unrecognised expression: ${Object.keys(expression as object).join(', ')}`, path);
}

function compare(
  operands: [Expression, Expression],
  next: (e: Expression, seg: string) => FactValue,
  path: string,
  op: (a: number, b: number) => boolean,
): boolean {
  const a = numeric(next(operands[0], 'lhs'), path);
  const b = numeric(next(operands[1], 'rhs'), path);
  // A comparison against unknown information is false, never an error. An
  // eligibility rule that cannot yet be satisfied is exactly what "missing
  // information" looks like on a case.
  if (a === null || b === null) return false;
  return op(a, b);
}

function numeric(value: FactValue, path: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RuleEvaluationError('Non-finite number', path);
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function truthy(value: FactValue): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function same(a: FactValue, b: FactValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface Rule {
  key: string;
  description: string;
  /** Human-readable statement of what must be true, shown in the console. */
  requirement: string;
  when: Expression;
  /** Shown when the rule is not satisfied. Written for an adviser to read aloud. */
  failMessage: string;
  severity?: 'blocking' | 'warning' | 'advisory';
  /** Cited source, e.g. "IVA Protocol 2025 s.5" or "firm policy". */
  authority?: string;
}

export interface RuleOutcome {
  key: string;
  requirement: string;
  satisfied: boolean;
  severity: 'blocking' | 'warning' | 'advisory';
  message: string | null;
  authority: string | null;
  /** Present when the rule could not be evaluated at all. */
  error: string | null;
}

export interface RuleSetOutcome {
  satisfied: boolean;
  blockedBy: string[];
  warnings: string[];
  outcomes: RuleOutcome[];
}

export function evaluateRules(rules: readonly Rule[], facts: Facts): RuleSetOutcome {
  const outcomes: RuleOutcome[] = rules.map((rule) => {
    const severity = rule.severity ?? 'blocking';
    try {
      const satisfied = truthy(evaluate(rule.when, facts));
      return {
        key: rule.key,
        requirement: rule.requirement,
        satisfied,
        severity,
        message: satisfied ? null : rule.failMessage,
        authority: rule.authority ?? null,
        error: null,
      };
    } catch (error) {
      // A broken rule is never treated as satisfied. It blocks and says why,
      // so a configuration mistake surfaces as an obstacle rather than as a
      // silently approved case.
      return {
        key: rule.key,
        requirement: rule.requirement,
        satisfied: false,
        severity: 'blocking',
        message: rule.failMessage,
        authority: rule.authority ?? null,
        error: (error as Error).message,
      };
    }
  });

  const blockedBy = outcomes.filter((o) => !o.satisfied && o.severity === 'blocking').map((o) => o.key);
  const warnings = outcomes.filter((o) => !o.satisfied && o.severity === 'warning').map((o) => o.key);

  return { satisfied: blockedBy.length === 0, blockedBy, warnings, outcomes };
}
