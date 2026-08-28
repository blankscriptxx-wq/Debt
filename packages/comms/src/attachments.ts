import { createHash } from 'node:crypto';
import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';

/**
 * Getting what a client sent into their case file.
 *
 * Two ideas, and they are separate on purpose.
 *
 * **Ingesting** is fetching the bytes and holding them safely. It happens as
 * soon as the message arrives, without anybody asking, because a WhatsApp media
 * id in a webhook stops working after about seven days and its download URL
 * lasts about five minutes. A design that fetches when the adviser clicks
 * "save" is a design that loses a client's bank statement a week later, and
 * asking a client in difficulty to send it again is the sort of small failure
 * that ends a case.
 *
 * **Filing** is a person deciding what the thing is and where it belongs. It
 * happens later, it is reversible, and it is audited — because filing a
 * document is what makes a case evidenced, and evidence is the thing this
 * platform exists to produce honestly.
 *
 * Between the two the document exists, is scanned, and belongs to nobody's case
 * yet. `quarantined` means we hold it and have not cleared it; `unfiled` means
 * it is clean and waiting for a person.
 */

export class AttachmentError extends Error {}

/** What a provider hands back when asked for the bytes. */
export interface FetchedMedia {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export type MediaFetcher = (providerMediaId: string) => Promise<FetchedMedia>;

/**
 * A malware verdict. Kept as a contract rather than an implementation because
 * the scanner is deployment configuration, and because a scanner that is not
 * present must fail closed rather than wave everything through.
 */
export type MalwareScanner = (bytes: Buffer, filename: string) => Promise<{
  clean: boolean;
  detail?: string;
}>;

export interface StoredObject {
  storageKey: string;
  storageProvider: string;
}
export type ObjectStore = (input: {
  tenantId: string; sha256: string; filename: string; bytes: Buffer;
}) => Promise<StoredObject>;

/**
 * Fetches, scans and stores one attachment.
 *
 * Idempotent on the attachment row, so the job queue retrying a partial failure
 * does not produce two documents for one message.
 */
export async function ingestAttachment(
  db: Database, ctx: TenantContext,
  attachmentId: string,
  deps: { fetch: MediaFetcher; scan: MalwareScanner; store: ObjectStore },
): Promise<{ status: string; documentId: string | null }> {
  const rows = await db.execute<{
    id: string; communication_id: string; conversation_id: string | null;
    provider_media_id: string | null; provider_expires_at: string | null;
    provider_sha256: string | null; filename: string | null; media_kind: string | null;
    ingest_status: string; document_id: string | null;
    client_id: string | null; case_id: string | null;
  }>(sql`
    SELECT a.id, a.communication_id, a.conversation_id, a.provider_media_id,
           a.provider_expires_at::text, a.provider_sha256, a.filename, a.media_kind,
           a.ingest_status, a.document_id, c.client_id, c.case_id
      FROM message_attachments a
      JOIN communications c ON c.id = a.communication_id
     WHERE a.id = ${attachmentId}`);
  const row = rows.rows[0];
  if (!row) throw new AttachmentError('No such attachment.');
  if (row.ingest_status === 'stored' && row.document_id) {
    return { status: 'stored', documentId: row.document_id };
  }
  if (!row.provider_media_id) {
    await fail(db, attachmentId, 'skipped', 'No media to fetch.');
    return { status: 'skipped', documentId: null };
  }
  if (row.provider_expires_at && new Date(row.provider_expires_at) < new Date()) {
    await fail(db, attachmentId, 'expired',
      'The provider no longer holds this file. Ask the client to send it again.');
    return { status: 'expired', documentId: null };
  }

  let media: FetchedMedia;
  try {
    media = await deps.fetch(row.provider_media_id);
  } catch (cause) {
    await fail(db, attachmentId, 'failed', String((cause as Error).message ?? cause));
    return { status: 'failed', documentId: null };
  }

  const sha256 = createHash('sha256').update(media.bytes).digest('hex');
  // The provider tells us what it sent. If our copy hashes differently, the
  // file changed in transit and is not the client's document.
  if (row.provider_sha256 && row.provider_sha256 !== sha256) {
    await fail(db, attachmentId, 'failed',
      'The file does not match the checksum the provider gave for it.');
    return { status: 'failed', documentId: null };
  }

  const verdict = await deps.scan(media.bytes, media.filename);
  if (!verdict.clean) {
    await fail(db, attachmentId, 'infected', verdict.detail ?? 'Malware detected.');
    await recordAudit(db, ctx, {
      action: 'comms.attachment.quarantined',
      resourceType: 'message_attachment', resourceId: attachmentId,
      caseId: row.case_id,
      reason: verdict.detail ?? 'Attachment failed a malware scan and was not stored.',
      source: 'integration',
      after: { filename: media.filename, sha256 },
    });
    return { status: 'infected', documentId: null };
  }

  const stored = await deps.store({
    tenantId: ctx.tenantId, sha256, filename: media.filename, bytes: media.bytes,
  });

  // Unfiled, not active: it is held against the client but is not part of a
  // case file until a person says what it is.
  const document = await db.execute<{ id: string }>(sql`
    INSERT INTO documents
      (client_id, case_id, filename, content_type, byte_size, checksum_sha256,
       storage_key, storage_provider, direction, uploaded_via, status,
       source_communication_id, source_channel, retention_class)
    VALUES (${row.client_id}, NULL, ${media.filename}, ${media.contentType},
            ${media.bytes.length}, ${sha256}, ${stored.storageKey},
            ${stored.storageProvider}, 'inbound', 'conversation', 'unfiled',
            ${row.communication_id},
            (SELECT channel FROM communications WHERE id = ${row.communication_id}),
            'case-file')
    RETURNING id`);
  const documentId = document.rows[0]!.id;

  await db.execute(sql`
    UPDATE message_attachments
       SET ingest_status = 'stored', ingested_at = now(), ingest_error = NULL,
           document_id = ${documentId}, content_type = ${media.contentType},
           byte_size = ${media.bytes.length}, filename = ${media.filename}
     WHERE id = ${attachmentId}`);

  return { status: 'stored', documentId };
}

async function fail(
  db: Database, attachmentId: string, status: string, error: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE message_attachments
       SET ingest_status = ${status}, ingest_error = ${error}, ingested_at = now()
     WHERE id = ${attachmentId}`);
}

/**
 * Files an ingested attachment onto a case.
 *
 * This is the moment a conversation becomes evidence. It records what the
 * document is, which case it belongs to, that it came from a message, and
 * whether a person chose the classification or accepted a suggested one —
 * because "the software guessed and nobody looked" and "an adviser read it and
 * agreed" are different facts, and only one of them is worth anything at a file
 * review.
 */
export async function fileAttachment(
  db: Database, ctx: TenantContext, principal: Principal,
  input: {
    attachmentId: string;
    caseId: string;
    documentType: string;
    /** Set when the adviser accepted a suggestion rather than choosing. */
    acceptedSuggestion?: boolean;
    /** A verification requirement this document satisfies, if any. */
    satisfiesRequirement?: string | null;
  },
): Promise<{ documentId: string; requirementSatisfied: string | null }> {
  requirePermission(principal, 'document:write', { tenantId: ctx.tenantId });

  const rows = await db.execute<{
    document_id: string | null; ingest_status: string;
    communication_id: string; client_id: string | null;
  }>(sql`
    SELECT a.document_id, a.ingest_status, a.communication_id, c.client_id
      FROM message_attachments a
      JOIN communications c ON c.id = a.communication_id
     WHERE a.id = ${input.attachmentId}`);
  const row = rows.rows[0];
  if (!row) throw new AttachmentError('No such attachment.');
  if (!row.document_id || row.ingest_status !== 'stored') {
    throw new AttachmentError(
      row.ingest_status === 'infected'
        ? 'That file failed a malware scan and cannot be filed.'
        : 'That file has not finished being received yet.');
  }

  const kase = await db.execute<{ id: string; client_id: string }>(sql`
    SELECT id, client_id FROM cases WHERE id = ${input.caseId}`);
  if (!kase.rows[0]) throw new AttachmentError('No such case.');

  // The document is held against the client the conversation is linked to.
  // Filing it onto a case belonging to somebody else is the exact mistake this
  // whole design is built to prevent, so it is refused rather than warned about.
  if (row.client_id && kase.rows[0].client_id !== row.client_id) {
    throw new AttachmentError(
      'That case belongs to a different client from the one who sent this file.');
  }

  await db.execute(sql`
    UPDATE documents
       SET case_id = ${input.caseId},
           client_id = ${kase.rows[0].client_id},
           document_type = ${input.documentType},
           status = 'active',
           classified_by = ${input.acceptedSuggestion ? 'ai' : 'user'},
           classification_accepted_by = ${ctx.userId ?? null},
           classification_accepted_at = now()
     WHERE id = ${row.document_id}`);

  // Filing evidence should move the case, not just add a file to it. Where the
  // document answers a requirement, the verification item moves with it, which
  // is what makes the spine change in front of the adviser.
  //
  // Upserted rather than updated. The verification row for a requirement is
  // created lazily when somebody opens the checks list, so a case where nobody
  // has been there yet would have nothing to update — and an adviser filing a
  // bank statement would watch it change nothing, which is worse than not
  // offering the option.
  //
  // Marking it verified is the adviser's assertion, not the software's
  // inference: they have the document in front of them and are saying it
  // answers the requirement. It is recorded as theirs, with the document
  // attached, which is what a file review needs to see.
  let requirementSatisfied: string | null = null;
  if (input.satisfiesRequirement) {
    const upserted = await db.execute<{ requirement_key: string }>(sql`
      INSERT INTO verification_items
        (case_id, client_id, requirement_key, category, status, method,
         document_id, verified_by, verified_at)
      VALUES (${input.caseId}, ${kase.rows[0].client_id}, ${input.satisfiesRequirement},
              'other', 'verified', 'document', ${row.document_id},
              ${ctx.userId ?? null}, now())
      ON CONFLICT (case_id, requirement_key) DO UPDATE
        SET status = 'verified', method = 'document',
            document_id = EXCLUDED.document_id,
            verified_by = EXCLUDED.verified_by, verified_at = now()
      RETURNING requirement_key`);
    requirementSatisfied = upserted.rows[0]?.requirement_key ?? null;
  }

  await recordAudit(db, ctx, {
    action: 'comms.attachment.filed',
    resourceType: 'document', resourceId: row.document_id,
    caseId: input.caseId,
    reason: `Filed from a conversation as ${input.documentType}`,
    source: 'console',
    after: {
      documentType: input.documentType,
      fromCommunication: row.communication_id,
      classificationAccepted: Boolean(input.acceptedSuggestion),
      requirementSatisfied,
    },
  });

  return { documentId: row.document_id, requirementSatisfied };
}

/** Marks an attachment as not worth filing, with the reason kept. */
export async function rejectAttachment(
  db: Database, ctx: TenantContext, principal: Principal,
  input: { attachmentId: string; reason: string },
): Promise<void> {
  requirePermission(principal, 'document:write', { tenantId: ctx.tenantId });
  if (!input.reason?.trim()) {
    throw new AttachmentError('Say why this is not being filed.');
  }

  const rows = await db.execute<{ document_id: string | null }>(sql`
    SELECT document_id FROM message_attachments WHERE id = ${input.attachmentId}`);
  if (!rows.rows[0]) throw new AttachmentError('No such attachment.');

  await db.execute(sql`
    UPDATE message_attachments SET ingest_status = 'skipped', ingest_error = ${input.reason}
     WHERE id = ${input.attachmentId}`);

  await recordAudit(db, ctx, {
    action: 'comms.attachment.rejected',
    resourceType: 'message_attachment', resourceId: input.attachmentId,
    reason: input.reason,
    source: 'console',
  });
}
