import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';

/**
 * Argon2id parameters.
 *
 * Chosen to land around 250ms on the target runtime, following OWASP's
 * guidance (64 MiB memory, 3 iterations, parallelism 1 - the memory cost is
 * what makes GPU cracking expensive, so it is not the knob to lower first).
 * A pure-WASM implementation keeps the deployment target free of native builds.
 */
export const ARGON2_PARAMS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 65536, // KiB
  hashLength: 32,
} as const;

export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return argon2id({
    password,
    salt: randomBytes(16),
    ...ARGON2_PARAMS,
    outputType: 'encoded',
  });
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded) {
    // Spend comparable time even when the account has no password set, so the
    // response time does not reveal whether the account exists.
    await argon2id({ password, salt: randomBytes(16), ...ARGON2_PARAMS, outputType: 'encoded' });
    return false;
  }
  try {
    return await argon2Verify({ password, hash: encoded });
  } catch {
    return false;
  }
}

export class WeakPasswordError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`Password rejected: ${reasons.join('; ')}`);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Length-led policy rather than composition rules, matching NCSC and NIST
 * guidance. Composition rules push people towards predictable substitutions
 * without materially raising the cost of an attack.
 */
export function assertPasswordAcceptable(password: string): void {
  const reasons: string[] = [];
  if (password.length < 12) reasons.push('must be at least 12 characters');
  if (password.length > 256) reasons.push('must be at most 256 characters');
  if (/^(.)\1+$/.test(password)) reasons.push('must not be a single repeated character');
  if (COMMON_PASSWORDS.has(password.toLowerCase())) reasons.push('is among the most commonly used passwords');
  if (reasons.length) throw new WeakPasswordError(reasons);
}

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd123', '123456789012',
  'qwertyuiop12', 'letmein12345', 'welcome12345', 'administrator',
  'iloveyou1234', 'monkey123456', 'abc123456789', 'football1234',
]);

/** Constant-time comparison for opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
