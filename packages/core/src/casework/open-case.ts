import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import type { CaseTypeDefinition } from '../case-types/schema.js';

/**
 * Starting work: a client, and a case for them.
 *
 * This lived inline in the two public API routes, which meant the console had
 * nowhere to call and would have grown a second copy — and two copies of "what
 * stage does a case start at" is how a firm ends up with cases that skip their
 * own onboarding. One implementation, both callers.
 */

export class CaseworkError extends Error {}

export interface NewClient {
  firstName: string;
  lastName: string;
  dateOfBirth?: string | null;
  email?: string | null;
  phoneMobile?: string | null;
  addressLine1?: string | null;
  addressCity?: string | null;
  addressPostcode?: string | null;
  jurisdiction?: 'england-wales' | 'scotland' | 'northern-ireland';
  householdAdults?: number;
  householdChildren?: number;
  employmentStatus?: string | null;
}

/**
 * Allocates the next reference for a prefix.
 *
 * Counting rows and adding one is wrong twice over: a withdrawn case frees a
 * number that is already printed on a letter, and two advisers creating a case
 * in the same second both read the same count. So this reads the highest number
 * actually used, and takes a transaction-scoped advisory lock on the prefix
 * first — which costs nothing and makes concurrent allocation wait rather than
 * collide with the unique constraint on the reference.
 */
async function nextReference(
  db: Database, table: 'cases' | 'clients', prefix: string,
): Promise<string> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${table}:${prefix}`}))`);

  const like = `${prefix}-%`;
  const res = table === 'cases'
    ? await db.execute<{ n: string }>(sql`
        SELECT coalesce(max(nullif(regexp_replace(reference, '^.*[^0-9]', ''), '')::bigint), 0)::text AS n
          FROM cases WHERE reference LIKE ${like}`)
    : await db.execute<{ n: string }>(sql`
        SELECT coalesce(max(nullif(regexp_replace(reference, '^.*[^0-9]', ''), '')::bigint), 0)::text AS n
          FROM clients WHERE reference LIKE ${like}`);

  return `${prefix}-${String(Number(res.rows[0]!.n) + 1).padStart(4, '0')}`;
}

/**
 * The prefix a case type's configured reference format asks for.
 *
 * The API used to take the first four characters of the case type key, so a
 * breathing space came out as BREA-0007 while its definition plainly said
 * `BSP-{SEQ}`. Configuration that the code ignores is worse than no
 * configuration, because it looks settled.
 */
export function referencePrefix(
  caseType: Pick<CaseTypeDefinition, 'key' | 'referenceFormat'>,
): string {
  const configured = caseType.referenceFormat.split('{')[0]?.replace(/[^A-Za-z0-9]+$/, '');
  return configured && configured.length > 0
    ? configured.toUpperCase()
    : caseType.key.toUpperCase().slice(0, 4);
}

export async function createClient(
  db: Database, ctx: TenantContext, principal: Principal, input: NewClient,
): Promise<{ id: string; reference: string }> {
  requirePermission(principal, 'client:write', { tenantId: ctx.tenantId });

  if (!input.firstName?.trim() || !input.lastName?.trim()) {
    throw new CaseworkError('A first and last name are needed to open a client record.');
  }

  const reference = await nextReference(db, 'clients', 'CL');
  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO clients (reference, first_name, last_name, date_of_birth, email, phone_mobile,
                         address_line1, address_city, address_postcode, jurisdiction,
                         household_adults, household_children, employment_status)
    VALUES (${reference}, ${input.firstName.trim()}, ${input.lastName.trim()},
            ${input.dateOfBirth || null}, ${input.email || null}, ${input.phoneMobile || null},
            ${input.addressLine1 || null}, ${input.addressCity || null},
            ${input.addressPostcode || null}, ${input.jurisdiction ?? 'england-wales'},
            ${input.householdAdults ?? 1}, ${input.householdChildren ?? 0},
            ${input.employmentStatus || null})
    RETURNING id`);
  const id = created.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'client.created', resourceType: 'client', resourceId: id,
    reason: 'Client record opened',
    source: ctx.actorType === 'api_key' ? 'api' : 'console',
    after: { reference, jurisdiction: input.jurisdiction ?? 'england-wales' },
  });

  return { id, reference };
}

export async function openCase(
  db: Database, ctx: TenantContext, principal: Principal,
  input: {
    clientId: string;
    caseType: CaseTypeDefinition;
    caseTypeVersion: number;
    source?: string;
    ownerUserId?: string | null;
  },
): Promise<{ id: string; reference: string; stage: string }> {
  requirePermission(principal, 'case:write', { tenantId: ctx.tenantId });

  const client = await db.execute<{ id: string; jurisdiction: string }>(sql`
    SELECT id, jurisdiction FROM clients WHERE id = ${input.clientId}`);
  if (!client.rows[0]) throw new CaseworkError('No client with that identifier.');
  const jurisdiction = client.rows[0].jurisdiction;

  // A Scottish remedy for a client in England is not a data-entry slip to be
  // corrected later; it is advice that could not lawfully be given, so the case
  // is refused rather than opened and flagged.
  if (!input.caseType.jurisdictions.includes(jurisdiction as 'england-wales')) {
    throw new CaseworkError(
      `${input.caseType.name} is not available in ${jurisdiction.replace(/-/g, ' ')}, `
      + 'which is where this client lives.',
    );
  }

  const stage = [...input.caseType.stages].sort((a, b) => a.order - b.order)[0]?.key;
  if (!stage) throw new CaseworkError(`${input.caseType.name} has no stages configured.`);

  const reference = await nextReference(db, 'cases', referencePrefix(input.caseType));

  const created = await db.execute<{ id: string }>(sql`
    INSERT INTO cases (reference, client_id, case_type_key, case_type_version, jurisdiction,
                       stage, status, source, owner_user_id, stage_entered_at)
    VALUES (${reference}, ${input.clientId}, ${input.caseType.key}, ${input.caseTypeVersion},
            ${jurisdiction}, ${stage}, 'open', ${input.source ?? 'direct'},
            ${input.ownerUserId ?? ctx.userId ?? null}, now())
    RETURNING id`);
  const id = created.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'case.created', resourceType: 'case', resourceId: id, caseId: id,
    reason: `${input.caseType.name} opened at ${stage}`,
    source: ctx.actorType === 'api_key' ? 'api' : 'console',
    after: { reference, caseType: input.caseType.key, stage, jurisdiction },
  });

  return { id, reference, stage };
}
