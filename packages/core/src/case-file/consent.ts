import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';

/**
 * Consent, recorded as what the client was actually asked.
 *
 * Two things make this more than a checkbox with a timestamp.
 *
 * **The wording is stored, not referenced.** A consent captured against
 * "statement v3" is worthless the day v3 is edited, so the exact text the
 * client saw is copied onto the record. That is the whole reason the table has
 * `statement_text` alongside `statement_version`.
 *
 * **The Article 9 condition is separate from the Article 6 basis.** Handling
 * someone's case needs a lawful basis; holding information about their health
 * needs a second, independent condition on top of it. A consent that records
 * only the first does not permit the second, and
 * `@solvenda/core/case-file/vulnerability` refuses to write health detail
 * without one. This module is how a firm gets one on file.
 */

export type LawfulBasis =
  'consent' | 'contract' | 'legal-obligation' | 'vital-interests'
  | 'public-task' | 'legitimate-interests';

export type CapturedVia =
  'client-portal' | 'telephone' | 'in-person' | 'document' | 'e-signature' | 'api' | 'migrated';

export class ConsentError extends Error {}

export interface ConsentInput {
  clientId: string;
  caseId?: string | null;
  purpose: string;
  lawfulBasis: LawfulBasis;
  /** Names the Article 9 condition where special-category data is in scope. */
  specialCategoryCondition?: string | null;
  statementVersion: string;
  statementText: string;
  granted: boolean;
  capturedVia: CapturedVia;
  evidenceReference?: string | null;
  expiresAt?: Date | null;
}

export interface ConsentRecord {
  id: string;
  clientId: string;
  caseId: string | null;
  purpose: string;
  lawfulBasis: LawfulBasis;
  specialCategoryCondition: string | null;
  statementVersion: string;
  statementText: string;
  granted: boolean;
  grantedAt: string;
  capturedVia: CapturedVia;
  capturedByName: string | null;
  expiresAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  /** True when this consent still permits what it was captured for. */
  live: boolean;
}

/**
 * Records a consent, or a refusal.
 *
 * A refusal is worth capturing: "the client said no" and "nobody asked" are
 * different facts about a file, and only one of them is a gap.
 *
 * `consent:capture` is regulated, so the authorisation engine already restricts
 * this to a person with a satisfied second factor and refuses it to automation.
 */
export async function captureConsent(
  db: Database, ctx: TenantContext, principal: Principal, input: ConsentInput,
): Promise<string> {
  requirePermission(principal, 'consent:capture', { tenantId: ctx.tenantId });

  if (!input.statementText.trim()) {
    throw new ConsentError(
      'Record the words the client was actually given. A consent that points at a statement '
      + 'rather than carrying it stops meaning anything the day the statement is edited.');
  }
  if (!input.purpose.trim()) {
    throw new ConsentError('A consent has to say what it is for.');
  }

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO consents (
      client_id, case_id, purpose, lawful_basis, special_category_condition,
      statement_version, statement_text, granted, captured_via, captured_by,
      evidence_reference, expires_at
    ) VALUES (
      ${input.clientId}, ${input.caseId ?? null}, ${input.purpose.trim()},
      ${input.lawfulBasis}, ${input.specialCategoryCondition?.trim() || null},
      ${input.statementVersion}, ${input.statementText.trim()}, ${input.granted},
      ${input.capturedVia}, ${principal.kind === 'user' ? principal.userId : null},
      ${input.evidenceReference ?? null}, ${input.expiresAt ?? null}
    ) RETURNING id`);

  const id = res.rows[0]!.id;

  await recordAudit(db, ctx, {
    action: 'consent.captured',
    resourceType: 'consent', resourceId: id,
    caseId: input.caseId ?? null,
    reason: `${input.granted ? 'Consent given' : 'Consent refused'} for ${input.purpose.trim()}`,
    source: 'console',
    after: {
      purpose: input.purpose.trim(), lawfulBasis: input.lawfulBasis,
      specialCategoryCondition: input.specialCategoryCondition?.trim() || null,
      statementVersion: input.statementVersion, granted: input.granted,
      capturedVia: input.capturedVia,
    },
  });

  return id;
}

/**
 * Withdraws a consent.
 *
 * The row is not deleted and nothing recorded under it is retrospectively
 * removed — the client did consent, then withdrew, and both are true. What
 * changes is what may be done from now on: `consentPermittingSpecialCategory`
 * stops returning it, so no further health detail can be written under it.
 */
export async function withdrawConsent(
  db: Database, ctx: TenantContext, principal: Principal,
  consentId: string, reason: string,
): Promise<void> {
  requirePermission(principal, 'consent:capture', { tenantId: ctx.tenantId });
  if (!reason.trim()) {
    throw new ConsentError('Say why the consent is being withdrawn.');
  }

  const res = await db.execute<{ case_id: string | null; purpose: string;
                                 withdrawn_at: string | null }>(sql`
    SELECT case_id, purpose, withdrawn_at::text FROM consents WHERE id = ${consentId}`);
  const consent = res.rows[0];
  if (!consent) throw new ConsentError('No such consent.');
  if (consent.withdrawn_at) return;

  await db.execute(sql`
    UPDATE consents SET withdrawn_at = now(), withdrawn_reason = ${reason.trim()}
     WHERE id = ${consentId}`);

  await recordAudit(db, ctx, {
    action: 'consent.withdrawn',
    resourceType: 'consent', resourceId: consentId,
    caseId: consent.case_id,
    reason: reason.trim(),
    source: 'console',
    after: { purpose: consent.purpose, withdrawn: true },
  });
}

export async function listConsents(
  db: Database, clientId: string,
): Promise<ConsentRecord[]> {
  const res = await db.execute<Record<string, unknown>>(sql`
    SELECT c.id, c.client_id, c.case_id, c.purpose, c.lawful_basis,
           c.special_category_condition, c.statement_version, c.statement_text,
           c.granted, c.granted_at::text, c.captured_via, u.full_name AS captured_by_name,
           c.expires_at::text, c.withdrawn_at::text, c.withdrawn_reason,
           (c.granted AND c.withdrawn_at IS NULL
            AND (c.expires_at IS NULL OR c.expires_at > now())) AS live
      FROM consents c
      LEFT JOIN users u ON u.id = c.captured_by
     WHERE c.client_id = ${clientId}
     ORDER BY c.granted_at DESC`);

  return res.rows.map((r) => ({
    id: r['id'] as string,
    clientId: r['client_id'] as string,
    caseId: (r['case_id'] as string | null) ?? null,
    purpose: r['purpose'] as string,
    lawfulBasis: r['lawful_basis'] as LawfulBasis,
    specialCategoryCondition: (r['special_category_condition'] as string | null) ?? null,
    statementVersion: r['statement_version'] as string,
    statementText: r['statement_text'] as string,
    granted: r['granted'] as boolean,
    grantedAt: r['granted_at'] as string,
    capturedVia: r['captured_via'] as CapturedVia,
    capturedByName: (r['captured_by_name'] as string | null) ?? null,
    expiresAt: (r['expires_at'] as string | null) ?? null,
    withdrawnAt: (r['withdrawn_at'] as string | null) ?? null,
    withdrawnReason: (r['withdrawn_reason'] as string | null) ?? null,
    live: r['live'] as boolean,
  }));
}
