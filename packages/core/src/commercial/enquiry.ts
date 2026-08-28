/**
 * Public enquiries from the marketing site.
 *
 * The only unauthenticated write in the platform, so the validation is done
 * here rather than in the page: a form is a client-side convenience and the
 * server has to assume it was never used. Everything below is enforced again
 * by CHECK constraints on `platform_enquiries`, because a validator you can
 * skip is not a constraint.
 */
import { z } from 'zod';
import { sql, withPublic } from '@solvenda/db';

export const ENQUIRY_TYPES = [
  'general',
  'demo',
  'pricing',
  'migration',
  'security',
  'partnership',
  'press',
] as const;

export const enquirySchema = z.object({
  name: z.string().trim().min(1, 'Tell us who you are').max(200),
  organisation: z.string().trim().max(200).default(''),
  // Not a full RFC 5322 parse - that rejects addresses that work. A shape
  // check plus a length bound, and the reply either arrives or it does not.
  email: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .regex(/^[^@\s]+@[^@\s.]+\.[^@\s]+$/, 'That does not look like an email address'),
  message: z.string().trim().min(1, 'Tell us what you need').max(5000),
  enquiryType: z.enum(ENQUIRY_TYPES).default('general'),
  sourcePath: z.string().trim().max(200).default('/contact'),
});

export type EnquiryInput = z.infer<typeof enquirySchema>;

/**
 * Records an enquiry.
 *
 * No id is returned, and that is not an oversight: the public role holds INSERT
 * and no SELECT, so `RETURNING` would be refused by Postgres. The submitter
 * gets an acknowledgement, not a handle on a row.
 */
export async function recordEnquiry(input: EnquiryInput): Promise<void> {
  const e = enquirySchema.parse(input);
  await withPublic(async (db) => {
    await db.execute(sql`
      INSERT INTO platform_enquiries
        (name, organisation, email, message, enquiry_type, source_path)
      VALUES (${e.name}, ${e.organisation}, ${e.email}, ${e.message},
              ${e.enquiryType}, ${e.sourcePath})`);
  });
}

/**
 * A crude in-process throttle.
 *
 * Honest about what it is: one process's memory, so it does not survive a
 * restart and does not coordinate across instances. It stops a bored person
 * with a browser tab, not a determined one, and the production-readiness notes
 * say so - a public site needs an edge rate limit in front of this.
 */
const attempts = new Map<string, number[]>();

export function throttle(key: string, limit = 5, windowMs = 60 * 60 * 1000, now = Date.now()): boolean {
  const recent = (attempts.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    attempts.set(key, recent);
    return false;
  }
  recent.push(now);
  attempts.set(key, recent);
  return true;
}

/** Test hook: the throttle is module state, so tests have to be able to clear it. */
export function resetThrottle(): void {
  attempts.clear();
}
