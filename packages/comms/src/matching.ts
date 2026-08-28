import { sql, type Database } from '@solvenda/db';

/**
 * Deciding whose conversation this is.
 *
 * The consequence of getting this wrong is specific and serious: one client's
 * bank statement filed on another client's case. That is a data breach, and it
 * is the kind that happens quietly, because nobody notices a document on the
 * wrong file until somebody reads it.
 *
 * So the rule is deliberately conservative. A person having confirmed that this
 * number belongs to this client is a match. Everything else — including the
 * number appearing on exactly one client record — is a *candidate*, offered to
 * an adviser to confirm. The cost of that choice is a moment's work on a first
 * message. The cost of the other choice is disclosing one client's finances to
 * another, and mobile numbers are shared within households and recycled between
 * strangers often enough that it would happen.
 *
 * The tenant is never decided here. It comes from the channel account that
 * received the message, which is tenant-scoped, so two firms holding the same
 * client's number is not a collision — the message belongs to whichever firm's
 * number it arrived on, and row-level security does the rest.
 */

export type MatchConfidence = 'verified' | 'candidate' | 'none';

export interface MatchResult {
  confidence: MatchConfidence;
  /** Set only when confidence is 'verified'. */
  clientId: string | null;
  /** Everyone the identifier could plausibly belong to, worst case included. */
  candidates: { clientId: string; reference: string; name: string; why: string }[];
  /** What to tell the adviser about why this was not decided automatically. */
  reason: string;
}

/**
 * Normalises an identifier so the same person is the same string.
 *
 * "07700 900123", "+44 7700 900123" and "447700900123" are one number, and
 * matching on the raw text makes them three people. UK numbers are assumed
 * where a bare national number appears, which is the jurisdiction this platform
 * serves; anything already in international form is left alone.
 */
export function normaliseIdentifier(channel: string, raw: string): string {
  const value = raw.trim();
  if (channel === 'email') return value.toLowerCase();

  const digits = value.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) return `+44${digits.slice(1)}`;
  if (digits.startsWith('44')) return `+${digits}`;
  return digits ? `+${digits}` : value;
}

/** How a number reads to a person, once it is normalised. */
export function displayIdentifier(channel: string, identifier: string): string {
  if (channel === 'email' || !identifier.startsWith('+44')) return identifier;
  const national = `0${identifier.slice(3)}`;
  return national.length === 11
    ? `${national.slice(0, 5)} ${national.slice(5)}`
    : national;
}

export async function matchIdentifier(
  db: Database, channel: string, rawIdentifier: string,
): Promise<MatchResult> {
  const identifier = normaliseIdentifier(channel, rawIdentifier);

  // 1. Somebody has confirmed this identifier belongs to this client.
  const verified = await db.execute<{ client_id: string; opted_out: string | null }>(sql`
    SELECT client_id, opted_out_at::text AS opted_out
      FROM channel_identities
     WHERE channel = ${channel} AND identifier = ${identifier}
       AND verified_at IS NOT NULL
     ORDER BY verified_at DESC`);

  if (verified.rows.length === 1) {
    return {
      confidence: 'verified',
      clientId: verified.rows[0]!.client_id,
      candidates: [],
      reason: verified.rows[0]!.opted_out
        ? 'Confirmed identity, but this client has opted out of this channel.'
        : 'A confirmed identity for this client.',
    };
  }

  // Two confirmed owners is a household sharing a phone, and it is exactly the
  // case where guessing does damage. It goes to a person.
  if (verified.rows.length > 1) {
    const candidates = await describe(db, verified.rows.map((r) => r.client_id),
      'Confirmed for more than one client on this number');
    return {
      confidence: 'candidate', clientId: null, candidates,
      reason: `${verified.rows.length} clients have confirmed this number. `
            + 'Choose who this message is from.',
    };
  }

  // 2. The identifier appears on a client record. Evidence, not proof.
  // Compared on the last ten digits, because a client record says
  // "07700 900123" and the message arrives as "+447700900123" — the same number
  // with a different prefix. Comparing all the digits misses every one of them.
  // A loose comparison is right here: this only ever produces candidates for a
  // person to confirm, so offering too many costs a glance and missing one
  // costs an adviser the connection entirely.
  const onRecord = channel === 'email'
    ? await db.execute<{ id: string }>(sql`
        SELECT id FROM clients WHERE lower(email) = ${identifier} LIMIT 5`)
    : await db.execute<{ id: string }>(sql`
        SELECT id FROM clients
         WHERE right(regexp_replace(coalesce(phone_mobile, ''), '[^0-9]', '', 'g'), 10)
                 = right(regexp_replace(${identifier}, '[^0-9]', '', 'g'), 10)
            OR right(regexp_replace(coalesce(phone_other, ''), '[^0-9]', '', 'g'), 10)
                 = right(regexp_replace(${identifier}, '[^0-9]', '', 'g'), 10)
         LIMIT 5`);

  if (onRecord.rows.length > 0) {
    return {
      confidence: 'candidate',
      clientId: null,
      candidates: await describe(db, onRecord.rows.map((r) => r.id),
        'This number is on their client record'),
      reason: onRecord.rows.length === 1
        ? 'The number is on one client record, which is not the same as knowing '
          + 'it is them. Confirm before linking.'
        : `The number is on ${onRecord.rows.length} client records.`,
    };
  }

  return {
    confidence: 'none', clientId: null, candidates: [],
    reason: 'Nobody on file uses this number. Link it to a client, or leave it '
          + 'unmatched if it is not a client.',
  };
}

async function describe(
  db: Database, ids: readonly string[], why: string,
): Promise<MatchResult['candidates']> {
  if (ids.length === 0) return [];
  const rows = await db.execute<{ id: string; reference: string; name: string }>(sql`
    SELECT id, reference, first_name || ' ' || last_name AS name
      FROM clients WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
  return rows.rows.map((r) => ({
    clientId: r.id, reference: r.reference, name: r.name, why,
  }));
}
