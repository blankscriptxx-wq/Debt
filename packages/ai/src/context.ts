import { createHash } from 'node:crypto';

/**
 * Context assembly.
 *
 * The model only ever sees fields a capability declares. This is the practical
 * expression of data minimisation: rather than assembling a case and trusting
 * the prompt to ignore the parts it should not use, the platform builds the
 * payload from an allowlist and everything else is simply absent.
 *
 * Free-text fields are additionally scrubbed of the identifiers that tend to
 * appear inside them - National Insurance numbers, card numbers, sort codes -
 * because a note written by a person will contain things no field-level
 * allowlist can anticipate.
 */

export interface AssembledContext {
  payload: Record<string, unknown>;
  /** Field paths that were requested but not present on the case. */
  missing: string[];
  /** Field paths that were available but not permitted, for the audit record. */
  withheld: string[];
  redactionsApplied: string[];
  fingerprint: string;
}

const PATTERNS: { name: string; pattern: RegExp; replacement: string }[] = [
  // Deliberately looser than the official prefix rules. A scrubber should
  // over-match: removing something that merely looks like an NI number costs
  // nothing, while missing a real one sends it to a third party.
  { name: 'national-insurance',
    pattern: /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]?\b/gi,
    replacement: '[NI number removed]' },
  { name: 'card-number', pattern: /\b(?:\d[ -]?){13,19}\b/g, replacement: '[card number removed]' },
  { name: 'sort-code', pattern: /\b\d{2}-\d{2}-\d{2}\b/g, replacement: '[sort code removed]' },
  { name: 'account-number', pattern: /\baccount(?:\s+number)?[:\s]+\d{8}\b/gi,
    replacement: 'account number [removed]' },
  { name: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, replacement: '[email removed]' },
  { name: 'uk-phone', pattern: /\b(?:0|\+44)\s?\d{4}\s?\d{6}\b/g, replacement: '[phone removed]' },
];

export function scrub(value: string): { text: string; applied: string[] } {
  let text = value;
  const applied: string[] = [];
  for (const { name, pattern, replacement } of PATTERNS) {
    if (pattern.test(text)) {
      applied.push(name);
      text = text.replace(new RegExp(pattern.source, pattern.flags), replacement);
    }
    pattern.lastIndex = 0;
  }
  return { text, applied };
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[segment];
  }, source);
}

function writePath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i]!;
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

function scrubDeep(value: unknown, applied: Set<string>): unknown {
  if (typeof value === 'string') {
    const result = scrub(value);
    result.applied.forEach((a) => applied.add(a));
    return result.text;
  }
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, applied));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubDeep(v, applied);
    }
    return out;
  }
  return value;
}

export function assembleContext(
  available: Record<string, unknown>,
  permittedFields: readonly string[],
): AssembledContext {
  const payload: Record<string, unknown> = {};
  const missing: string[] = [];
  const applied = new Set<string>();

  for (const field of permittedFields) {
    const value = readPath(available, field);
    if (value === undefined) {
      missing.push(field);
      continue;
    }
    writePath(payload, field, scrubDeep(value, applied));
  }

  const permitted = new Set(permittedFields);
  const withheld = enumeratePaths(available).filter((p) => !isPermitted(p, permitted));

  return {
    payload,
    missing,
    withheld,
    redactionsApplied: [...applied].sort(),
    fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32),
  };
}

/** A path is permitted if it, or one of its ancestors, is on the allowlist. */
function isPermitted(path: string, permitted: ReadonlySet<string>): boolean {
  const segments = path.split('.');
  for (let i = segments.length; i > 0; i--) {
    if (permitted.has(segments.slice(0, i).join('.'))) return true;
  }
  return false;
}

function enumeratePaths(source: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...enumeratePaths(value as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
}
