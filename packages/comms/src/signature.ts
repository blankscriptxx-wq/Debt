import { sql, type Database } from '@solvenda/db';
import type { Principal } from '@solvenda/auth';

/**
 * Who a message is from.
 *
 * A client in difficulty receiving a WhatsApp from a number they half recognise
 * needs to know which person is writing to them. So every message a person
 * sends carries that person's name — and the whole value of it rests on the
 * name being true.
 *
 * **It is read from the users table by the authenticated user id, never taken
 * from the caller.** There is no parameter for it. That is the difference
 * between a signature and a typed sign-off: an adviser cannot sign as a
 * colleague, a compromised session cannot sign as somebody senior, and an
 * integration cannot sign as a person at all.
 *
 * Two shapes, because WhatsApp forces the distinction:
 *
 *   Free text  — the signature is appended. There is no approved form to match.
 *   A template — the signature is a *variable* the platform fills. An approved
 *                template's body is fixed by Meta; appending to it produces a
 *                message that no longer matches what was approved, so a
 *                template that cannot be signed is a template that cannot be
 *                used for client-facing work.
 */

/** The variable a client-facing template must declare so it can be signed. */
export const SIGNATURE_VARIABLE = 'adviser';

export class SignatureError extends Error {}

export interface Signature {
  /** What appears on the message. */
  text: string;
  /** Null for anything not sent by a person. */
  userId: string | null;
  /** True when a person is signing, false for automated messages. */
  human: boolean;
}

/**
 * Resolves the signature for whoever is actually sending.
 *
 * A workflow or an AI capability is signed as the firm and marked automated. It
 * is never given a person's name — a client acting on what they think an
 * adviser told them, when no adviser said it, is the same failure the
 * regulated-permission rule exists to prevent, arriving by a different route.
 */
export async function resolveSignature(
  db: Database, principal: Principal,
): Promise<Signature> {
  const firm = await db.execute<{ legal_name: string }>(sql`
    SELECT legal_name FROM tenants WHERE id = app.current_tenant_id()`);
  const firmName = firm.rows[0]?.legal_name ?? 'your adviser';

  if (principal.kind !== 'user') {
    return { text: `${firmName} (automated message)`, userId: null, human: false };
  }

  const user = await db.execute<{ full_name: string; job_title: string | null }>(sql`
    SELECT full_name, job_title FROM users
     WHERE id = ${principal.userId} AND status = 'active'`);
  const row = user.rows[0];
  if (!row?.full_name?.trim()) {
    // Refused rather than defaulted. An unsigned message is one a client cannot
    // attribute, and inventing a name would be worse than not sending.
    throw new SignatureError(
      'No name is recorded on this account, so a message cannot be signed. '
      + 'Ask an administrator to set your full name before sending to clients.');
  }

  // The firm as well as the person: a name alone does not tell somebody who has
  // been passed between agencies which organisation is writing to them.
  return { text: `${row.full_name.trim()}, ${firmName}`, userId: principal.userId, human: true };
}

/**
 * Appends the signature to free text.
 *
 * Deliberately not clever about a sign-off the adviser typed themselves. "Ruth"
 * at the end of a message does not tell somebody who has been passed between
 * three agencies which Ruth, at which organisation, is writing to them — so a
 * hand-typed first name is left in place and the full attribution is added
 * anyway. The only thing skipped is a body that already ends in this exact
 * signature, which is a message being re-sent rather than a message being
 * signed twice.
 */
export function applySignature(body: string, signature: Signature): string {
  const trimmed = body.trimEnd();
  if (trimmed.toLowerCase().endsWith(signature.text.toLowerCase())) return trimmed;
  return `${trimmed}\n\n— ${signature.text}`;
}

/**
 * Whether a template can be used for a client-facing message.
 *
 * A template that does not declare the signature variable cannot be signed —
 * and since an approved WhatsApp template cannot be appended to, it cannot be
 * made signable at send time either. So the check belongs here, when a firm
 * activates a template, rather than at the moment somebody tries to answer a
 * client with it.
 */
export function templateCanBeSigned(body: string): boolean {
  return new RegExp(`\\{\\{\\s*${SIGNATURE_VARIABLE}\\s*\\}\\}`).test(body);
}

/**
 * Fills a template's variables, including the signature, which the caller
 * cannot override.
 *
 * Every unresolved placeholder is named rather than the first one, because a
 * template with three gaps should take one correction rather than three.
 */
export function renderTemplate(
  body: string,
  variables: Readonly<Record<string, string>>,
  signature: Signature,
): string {
  const values: Record<string, string> = {
    ...variables,
    // Last, deliberately: a caller passing `adviser` does not get to choose who
    // the message is from.
    [SIGNATURE_VARIABLE]: signature.text,
  };

  const rendered = body.replace(/\{\{\s*([\w.]+)\s*\}\}/g,
    (whole, key: string) => values[key] ?? whole);

  const unresolved = [...new Set(
    (rendered.match(/\{\{\s*([\w.]+)\s*\}\}/g) ?? [])
      .map((p) => p.replace(/[{}\s]/g, '')))];

  if (unresolved.length > 0) {
    throw new SignatureError(
      `This template still needs ${unresolved.join(', ')}. `
      + 'A message with a visible gap in it should not reach a client.');
  }

  return rendered;
}
