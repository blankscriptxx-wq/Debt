import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import type { HouseholdComposition } from '../sfs/statement.js';

/**
 * Who else lives in the household.
 *
 * This is not administrative detail. The Standard Financial Statement bands its
 * trigger figures by household size, so adding a child changes what the client
 * is allowed to spend on food before an explanation is required — and therefore
 * changes their surplus, which changes which solutions are open to them. The
 * composition is derived from these records rather than typed twice, so the two
 * cannot disagree.
 */

export interface HouseholdMemberInput {
  clientId: string;
  fullName?: string | null;
  relationship: 'partner' | 'child' | 'parent' | 'sibling' | 'other-relative'
              | 'friend' | 'lodger' | 'carer' | 'other';
  dateOfBirth?: string | null;
  ageYears?: number | null;
  isDependant?: boolean;
  contributesToHousehold?: boolean;
  contributionPence?: number;
  notes?: string | null;
}

export interface HouseholdMember extends HouseholdMemberInput {
  id: string;
  isDependant: boolean;
  contributesToHousehold: boolean;
  contributionPence: number;
}

export class HouseholdValidationError extends Error {}

/** A member is a person: without a date of birth or an age they cannot be banded. */
function validate(input: HouseholdMemberInput): void {
  if (input.dateOfBirth == null && input.ageYears == null) {
    throw new HouseholdValidationError(
      'A household member needs a date of birth or an age: the SFS trigger figures '
      + 'are banded by household composition and cannot be applied without one.',
    );
  }
  if ((input.contributionPence ?? 0) > 0 && !input.contributesToHousehold) {
    throw new HouseholdValidationError(
      'A contribution was given for someone not marked as contributing to the household.',
    );
  }
}

export function ageOf(member: { dateOfBirth?: string | null; ageYears?: number | null },
                     asOf = new Date()): number | null {
  if (member.ageYears != null) return member.ageYears;
  if (!member.dateOfBirth) return null;
  const dob = new Date(member.dateOfBirth);
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const month = asOf.getUTCMonth() - dob.getUTCMonth();
  if (month < 0 || (month === 0 && asOf.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

/**
 * The composition the SFS engine consumes.
 *
 * The client is always one adult. Anyone 18 or over is another adult; anyone
 * under 18 is a child, and their ages are carried through because some trigger
 * figure sets band by them.
 */
export function compositionFrom(
  members: readonly HouseholdMember[],
  asOf = new Date(),
): HouseholdComposition {
  let adults = 1;
  const childAges: number[] = [];
  for (const member of members) {
    const age = ageOf(member, asOf);
    if (age != null && age < 18) childAges.push(age);
    else adults += 1;
  }
  return { adults, children: childAges.length, childAges };
}

export async function listHouseholdMembers(
  db: Database, clientId: string,
): Promise<HouseholdMember[]> {
  const res = await db.execute<Record<string, string | null> & {
    is_dependant: boolean; contributes_to_household: boolean;
  }>(sql`
    SELECT id, full_name, relationship, date_of_birth::text, age_years::text,
           is_dependant, contributes_to_household, contribution_pence::text, notes
      FROM household_members WHERE client_id = ${clientId}
     ORDER BY is_dependant DESC, date_of_birth NULLS LAST, created_at`);
  return res.rows.map((r) => ({
    id: r['id']!, clientId,
    fullName: r['full_name'] ?? null,
    relationship: r['relationship'] as HouseholdMember['relationship'],
    dateOfBirth: r['date_of_birth'] ?? null,
    ageYears: r['age_years'] == null ? null : Number(r['age_years']),
    isDependant: r.is_dependant,
    contributesToHousehold: r.contributes_to_household,
    contributionPence: Number(r['contribution_pence']),
    notes: r['notes'] ?? null,
  }));
}

export async function recordHouseholdMember(
  db: Database, ctx: TenantContext, principal: Principal, input: HouseholdMemberInput,
): Promise<string> {
  requirePermission(principal, 'client:write');
  validate(input);

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO household_members
      (client_id, full_name, relationship, date_of_birth, age_years,
       is_dependant, contributes_to_household, contribution_pence, notes)
    VALUES (${input.clientId}, ${input.fullName ?? null}, ${input.relationship},
            ${input.dateOfBirth ?? null}, ${input.ageYears ?? null},
            ${input.isDependant ?? false}, ${input.contributesToHousehold ?? false},
            ${input.contributionPence ?? 0}, ${input.notes ?? null})
    RETURNING id`);
  const id = res.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'household.member.recorded',
    resourceType: 'household_member',
    resourceId: id,
    reason: `${input.relationship} added to the household`,
    source: 'console',
    after: { ...input } as Record<string, unknown>,
  });
  return id;
}

export async function removeHouseholdMember(
  db: Database, ctx: TenantContext, principal: Principal,
  memberId: string, reason: string,
): Promise<void> {
  requirePermission(principal, 'client:write');
  if (!reason.trim()) {
    throw new HouseholdValidationError(
      'Removing a household member changes the trigger figures, so it needs a reason.',
    );
  }
  const before = await db.execute(sql`
    SELECT * FROM household_members WHERE id = ${memberId}`);
  await db.execute(sql`DELETE FROM household_members WHERE id = ${memberId}`);
  await recordAudit(db, ctx, {
    action: 'household.member.removed',
    resourceType: 'household_member',
    resourceId: memberId,
    reason,
    source: 'console',
    before: (before.rows[0] ?? null) as Record<string, unknown> | null,
  });
}
