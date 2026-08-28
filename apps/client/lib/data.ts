import { sql, type Database } from '@solvenda/db';
import { CASE_TYPE_TEMPLATES, parseCaseTypeDefinition } from '@solvenda/core';

export interface ClientCaseView {
  caseId: string;
  reference: string;
  caseTypeName: string;
  /** Plain-English description of the solution, written for the client. */
  caseTypeExplanation: string;
  stageName: string;
  steps: { key: string; name: string; description: string;
           state: 'done' | 'current' | 'todo' }[];
  outstanding: { key: string; label: string; description: string }[];
  adviserName: string | null;
  totalDebtPence: number;
  monthlyPaymentPence: number | null;
  nextReviewDue: string | null;
  /**
   * The client's other open cases.
   *
   * A client having two at once is ordinary — a Breathing Space moratorium
   * running alongside a DMP referral, say. This view shows one in detail, and
   * naming the rest is the difference between choosing what to show first and
   * hiding something from the person it belongs to.
   */
  otherOpenCases: { caseId: string; reference: string; caseTypeName: string;
                    stageName: string }[];
}

const PLAIN_ENGLISH: Record<string, string> = {
  dmp: 'An arrangement where you make one affordable payment each month, which we share out between the people you owe. It is not legally binding, so you can change or stop it.',
  iva: 'A formal agreement with the people you owe, run by a licensed insolvency practitioner. Once it is agreed it is legally binding on everyone, including creditors who voted against it.',
  dro: 'A court-backed order that freezes what you owe for twelve months, and writes it off at the end if your circumstances have not improved. There are limits on debt, savings and what you own.',
  bankruptcy: 'A formal way of dealing with debts you cannot pay. Most debts are written off, but you may lose things you own and there is a fee to apply.',
  'breathing-space': 'A period where most interest, fees and enforcement action stop, giving you time to get advice without pressure.',
  'trust-deed': 'A formal agreement in Scotland where what you can afford is paid to a trustee for a set period, after which remaining debts are usually written off.',
  sequestration: 'Scottish bankruptcy. Most debts are written off, and there are different routes depending on your circumstances.',
  'das-dpp': 'A Scottish scheme where you repay what you owe over a longer period, with interest and charges frozen while you keep to it.',
};

export async function loadClientCase(
  db: Database,
  clientId: string,
): Promise<ClientCaseView | null> {
  const res = await db.execute<{
    id: string; reference: string; case_type_key: string; stage: string;
    adviser: string | null; next_review_due: string | null; total_debt: string;
    payment: string | null; definition: unknown;
  }>(sql`
    SELECT k.id, k.reference, k.case_type_key, k.stage,
           u.full_name AS adviser, k.next_review_due::text,
           coalesce((SELECT sum(balance_pence) FROM debts d
                      WHERE d.case_id = k.id AND d.status = 'active'), 0)::text AS total_debt,
           (SELECT sustainable_payment_pence FROM affordability_assessments a
             WHERE a.case_id = k.id ORDER BY assessed_at DESC LIMIT 1)::text AS payment,
           (SELECT definition FROM case_type_definitions ctd
             WHERE ctd.key = k.case_type_key AND ctd.status = 'active'
             ORDER BY version DESC LIMIT 1) AS definition
      FROM cases k
      LEFT JOIN users u ON u.id = k.owner_user_id
     WHERE k.client_id = ${clientId} AND k.status = 'open'
     ORDER BY k.opened_at DESC LIMIT 1`);

  const row = res.rows[0];
  if (!row) return null;

  const caseType = row.definition
    ? parseCaseTypeDefinition(row.definition)
    : CASE_TYPE_TEMPLATES.find((t) => t.key === row.case_type_key) ?? CASE_TYPE_TEMPLATES[0]!;

  const ordered = [...caseType.stages].sort((a, b) => a.order - b.order);
  const currentIndex = ordered.findIndex((s) => s.key === row.stage);

  const evidence = await db.execute<{ purpose: string }>(sql`
    SELECT DISTINCT purpose FROM consents
     WHERE client_id = ${clientId} AND granted AND withdrawn_at IS NULL`);
  const held = new Set(evidence.rows.map((r) => r.purpose));

  const currentStage = ordered[currentIndex];
  const outstanding = (currentStage?.requiredEvidence ?? [])
    .filter((key) => !held.has(key))
    .map((key) => {
      const requirement = caseType.evidence.find((e) => e.key === key);
      return {
        key,
        label: requirement?.label ?? key,
        description: requirement?.description ?? '',
      };
    });

  return {
    caseId: row.id,
    reference: row.reference,
    caseTypeName: caseType.name,
    caseTypeExplanation: PLAIN_ENGLISH[row.case_type_key] ?? caseType.description,
    stageName: currentStage?.name ?? row.stage,
    steps: ordered
      // Terminal stages and exception branches are noise on a progress view.
      .filter((s) => !s.isTerminal && !['arrears', 'variation'].includes(s.key))
      .map((stage, index) => ({
        key: stage.key,
        name: stage.name,
        description: stage.description,
        state: currentIndex === -1 ? 'todo'
          : index < currentIndex ? 'done'
          : index === currentIndex ? 'current' : 'todo',
      })),
    outstanding,
    adviserName: row.adviser,
    totalDebtPence: Number(row.total_debt),
    monthlyPaymentPence: row.payment === null ? null : Number(row.payment),
    nextReviewDue: row.next_review_due,
    otherOpenCases: await loadOtherOpenCases(db, clientId, row.id),
  };
}

async function loadOtherOpenCases(
  db: Database,
  clientId: string,
  primaryCaseId: string,
): Promise<ClientCaseView['otherOpenCases']> {
  const res = await db.execute<{ id: string; reference: string;
                                 case_type_key: string; stage: string }>(sql`
    SELECT id, reference, case_type_key, stage
      FROM cases
     WHERE client_id = ${clientId} AND status = 'open' AND id <> ${primaryCaseId}
     ORDER BY opened_at DESC`);

  return res.rows.map((row) => {
    const template = CASE_TYPE_TEMPLATES.find((t) => t.key === row.case_type_key);
    return {
      caseId: row.id,
      reference: row.reference,
      caseTypeName: template?.name ?? row.case_type_key,
      stageName: template?.stages.find((s) => s.key === row.stage)?.name ?? row.stage,
    };
  });
}

export interface ClientMessage {
  id: string; direction: string; channel: string; subject: string | null;
  body: string; occurredAt: string; from: string | null;
}

export async function loadClientMessages(
  db: Database,
  clientId: string,
): Promise<ClientMessage[]> {
  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT c.id, c.direction, c.channel, c.subject, c.body, c.occurred_at::text,
           u.full_name AS sender
      FROM communications c
      LEFT JOIN users u ON u.id = c.sent_by
     WHERE c.client_id = ${clientId}
       -- Internal notes are for the firm, never the client.
       AND c.channel <> 'internal-note' AND c.direction <> 'internal'
     ORDER BY c.occurred_at DESC LIMIT 50`);

  return res.rows.map((r) => ({
    id: r['id']!, direction: r['direction']!, channel: r['channel']!,
    subject: r['subject'] ?? null, body: r['body'] ?? '', occurredAt: r['occurred_at']!,
    from: r['sender'] ?? null,
  }));
}

export interface ClientDocument {
  id: string; filename: string; documentType: string | null;
  uploadedAt: string; direction: string; signatureStatus: string | null;
}

export async function loadClientDocuments(
  db: Database,
  clientId: string,
): Promise<ClientDocument[]> {
  const res = await db.execute<Record<string, string | null>>(sql`
    SELECT id, filename, document_type, created_at::text, direction, signature_status
      FROM documents WHERE client_id = ${clientId} AND status = 'active'
     ORDER BY created_at DESC LIMIT 50`);
  return res.rows.map((r) => ({
    id: r['id']!, filename: r['filename']!, documentType: r['document_type'] ?? null,
    uploadedAt: r['created_at']!, direction: r['direction']!,
    signatureStatus: r['signature_status'] ?? null,
  }));
}
