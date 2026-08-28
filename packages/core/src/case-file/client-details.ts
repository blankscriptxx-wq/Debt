import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { hashPassword, requirePermission, type Principal } from '@solvenda/auth';

/**
 * The client record an adviser maintains.
 *
 * Two things here are less obvious than they look.
 *
 * The security answer is a shared secret used to authenticate someone on the
 * telephone, so it is hashed with the same Argon2id parameters as a password
 * and never returned. The question is stored plainly, because the adviser has
 * to read it out.
 *
 * Service and marketing contact permissions are held separately, per channel,
 * because they are separate legal bases. Consent to be marketed to can be
 * withdrawn without touching a firm's ability to service the case, and a system
 * that stores one flag for both cannot honour that distinction.
 */

export const CONTACT_CHANNELS = ['home-phone', 'mobile', 'work-phone', 'email', 'sms', 'post'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

export interface ContactPermissions {
  service: ContactChannel[];
  marketing: ContactChannel[];
  bestTimeToCall?: string | null;
  preferredMethod?: ContactChannel | null;
}

export interface ClientDetailsInput {
  title?: string | null;
  firstName: string;
  middleNames?: string | null;
  lastName: string;
  previousNames?: string[];
  dateOfBirth?: string | null;
  placeOfBirth?: string | null;
  maritalStatus?: string | null;
  gender?: string | null;
  nationalInsuranceNumber?: string | null;
  email?: string | null;
  phoneMobile?: string | null;
  phoneOther?: string | null;
  addressLine1?: string | null;
  addressCity?: string | null;
  addressPostcode?: string | null;
  occupancyStatus?: string | null;
  employmentStatus?: string | null;
  securityQuestion?: string | null;
  /** Plain text in, hash out. Never stored or returned as given. */
  securityAnswer?: string | null;
  contactPermissions?: ContactPermissions;
}

export class ClientValidationError extends Error {}

/** Age at a date, which is what every eligibility rule actually asks for. */
export function ageAt(dateOfBirth: string | null | undefined, asOf = new Date()): number | null {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  let age = asOf.getUTCFullYear() - dob.getUTCFullYear();
  const month = asOf.getUTCMonth() - dob.getUTCMonth();
  if (month < 0 || (month === 0 && asOf.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

function validate(input: ClientDetailsInput): void {
  if (!input.firstName.trim() || !input.lastName.trim()) {
    throw new ClientValidationError('A client needs a first and last name.');
  }
  const age = ageAt(input.dateOfBirth);
  if (age != null && (age < 16 || age > 120)) {
    throw new ClientValidationError(
      `That date of birth gives an age of ${age}. Check it before saving.`,
    );
  }
  const permissions = input.contactPermissions;
  if (permissions?.preferredMethod
      && !permissions.service.includes(permissions.preferredMethod)) {
    throw new ClientValidationError(
      'The preferred contact method is not among the channels the client has '
      + 'permitted for service contact.',
    );
  }
}

export async function updateClientDetails(
  db: Database, ctx: TenantContext, principal: Principal,
  clientId: string, input: ClientDetailsInput,
): Promise<void> {
  requirePermission(principal, 'client:write');
  validate(input);

  const before = await db.execute(sql`
    SELECT id, title, first_name, middle_names, last_name, date_of_birth::text,
           place_of_birth, marital_status, gender, email, phone_mobile,
           occupancy_status, employment_status, contact_preferences
      FROM clients WHERE id = ${clientId}`);
  if (!before.rows[0]) throw new ClientValidationError('No such client.');

  const answerHash = input.securityAnswer?.trim()
    ? await hashPassword(input.securityAnswer.trim().toLowerCase())
    : null;

  await db.execute(sql`
    UPDATE clients
       SET title = ${input.title ?? null}, first_name = ${input.firstName},
           middle_names = ${input.middleNames ?? null}, last_name = ${input.lastName},
           previous_names = ARRAY(SELECT jsonb_array_elements_text(
             ${JSON.stringify(input.previousNames ?? [])}::jsonb)),
           date_of_birth = ${input.dateOfBirth ?? null},
           place_of_birth = ${input.placeOfBirth ?? null},
           marital_status = ${input.maritalStatus ?? null},
           gender = ${input.gender ?? null},
           national_insurance_number = ${input.nationalInsuranceNumber ?? null},
           email = ${input.email ?? null}, phone_mobile = ${input.phoneMobile ?? null},
           phone_other = ${input.phoneOther ?? null},
           address_line1 = ${input.addressLine1 ?? null},
           address_city = ${input.addressCity ?? null},
           address_postcode = ${input.addressPostcode ?? null},
           occupancy_status = ${input.occupancyStatus ?? null},
           employment_status = ${input.employmentStatus ?? null},
           security_question = ${input.securityQuestion ?? null},
           -- Only replaced when a new answer was actually given, so saving the
           -- rest of the form does not wipe it.
           security_answer_hash = coalesce(${answerHash}, security_answer_hash),
           contact_preferences = ${JSON.stringify(input.contactPermissions ?? {})}::jsonb
     WHERE id = ${clientId}`);

  const after = await db.execute(sql`
    SELECT id, title, first_name, middle_names, last_name, date_of_birth::text,
           place_of_birth, marital_status, gender, email, phone_mobile,
           occupancy_status, employment_status, contact_preferences
      FROM clients WHERE id = ${clientId}`);

  await recordAudit(db, ctx, {
    action: 'client.updated',
    resourceType: 'client',
    resourceId: clientId,
    source: 'console',
    before: before.rows[0] as Record<string, unknown>,
    after: after.rows[0] as Record<string, unknown>,
  });
}
