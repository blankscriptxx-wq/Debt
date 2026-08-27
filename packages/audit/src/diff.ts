/**
 * Field-level difference between two snapshots, used to populate
 * `audit_events.changed_fields` so a reviewer can see what moved without
 * reading two JSON blobs side by side.
 */
export function changedFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before && !after) return [];
  if (!before) return Object.keys(after ?? {}).sort();
  if (!after) return Object.keys(before).sort();

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (!deepEqual(before[key], after[key])) changed.push(key);
  }
  return changed.sort();
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

/**
 * Values that must never be written into an audit payload even though they
 * legitimately live on the records being audited.
 */
const REDACTED_KEYS = new Set([
  'password', 'password_hash', 'passwordHash',
  'mfa_secret', 'mfaSecret', 'token', 'token_hash', 'tokenHash',
  'access_token', 'refresh_token', 'client_secret', 'api_key', 'apiKey',
  'secret', 'private_key', 'signature_key',
]);

/** Recursively removes credential material from a snapshot before it is stored. */
export function redact<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? '[redacted]' : redact(v);
  }
  return out as T;
}
