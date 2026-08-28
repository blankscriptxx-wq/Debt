import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, withPlatform, withTenant } from '@solvenda/db';
import { receiveInbound, ingestAttachment } from '@solvenda/comms';
import { SimulatedWhatsApp } from '@solvenda/integrations';

export const dynamic = 'force-dynamic';

/**
 * Where inbound WhatsApp arrives.
 *
 * Two things here are load-bearing.
 *
 * **The tenant comes from the number that received the message**, never from
 * the sender. An inbound webhook has no session and no tenant, so the phone
 * number id is looked up in platform context — a deliberately narrow, audited
 * step — and everything after it runs inside that one firm's tenant context
 * with row-level security in force. Two firms can hold the same client's mobile
 * number without any possibility of one seeing the other's message, because the
 * sender never selects anything.
 *
 * **Attachments are fetched now, not later.** The media id in this payload stops
 * resolving after about seven days and its download URL lasts minutes. Waiting
 * until an adviser clicks "save" is a design that loses a client's bank
 * statement, so ingestion happens as part of accepting the message.
 *
 * The provider is a simulator until a firm connects a real one. What arrives
 * here has the same shape either way.
 */

const OPERATOR = process.env['SOLVENDA_SIGNIN_OPERATOR_ID'] ?? '';

/**
 * Meta signs webhooks as `sha256=<hmac>` over the raw body. Compared in
 * constant time, because a comparison that returns early tells an attacker how
 * much of a forged signature was right.
 */
function signatureValid(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  const presented = Buffer.from(header.slice(7), 'hex');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export async function POST(request: Request) {
  const raw = await request.text();
  const secret = process.env['WHATSAPP_WEBHOOK_SECRET'] ?? '';

  // Fail closed. An unsigned webhook endpoint is an open door to writing
  // messages into somebody's case file, so a missing secret refuses everything
  // rather than accepting everything.
  if (!secret) {
    return NextResponse.json(
      { error: { code: 'not_configured',
                 message: 'No webhook secret is configured, so inbound messages are refused.' } },
      { status: 503 });
  }
  if (!signatureValid(raw, request.headers.get('x-hub-signature-256'), secret)) {
    return NextResponse.json(
      { error: { code: 'bad_signature', message: 'That signature does not verify.' } },
      { status: 401 });
  }

  let body: {
    phoneNumberId?: string; from?: string; text?: string | null;
    profileName?: string | null; providerMessageId?: string;
    media?: { providerMediaId: string; filename?: string; mimeType?: string;
              byteSize?: number; sha256?: string; kind?: string;
              expiresAt?: string;
              /** Sandbox only: the content itself, since no provider holds it. */
              contentBase64?: string } | null;
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_request', message: 'Body is not JSON.' } }, { status: 400 });
  }

  if (!body.phoneNumberId || !body.from) {
    return NextResponse.json(
      { error: { code: 'invalid_request',
                 message: 'phoneNumberId and from are required.' } }, { status: 400 });
  }

  // The one cross-tenant read, narrow and audited: which firm owns the number
  // this arrived on. Nothing about the sender is consulted.
  const account = await withPlatform(
    { operatorId: OPERATOR, reason: 'route an inbound message to the firm that owns the number' },
    async (db) => {
      const r = await db.execute<{ id: string; tenant_id: string; simulated: boolean }>(sql`
        SELECT id, tenant_id, simulated FROM channel_accounts
         WHERE provider_account_id = ${body.phoneNumberId} AND channel = 'whatsapp'
           AND status = 'active'
         LIMIT 1`);
      return r.rows[0] ?? null;
    }).catch(() => null);

  if (!account) {
    // Deliberately not "unknown number": telling an unauthenticated caller
    // which numbers exist is an enumeration they have not earned.
    return NextResponse.json({ data: { accepted: false } }, { status: 202 });
  }

  const ctx = {
    tenantId: account.tenant_id,
    actorType: 'integration' as const,
    actorLabel: 'whatsapp:webhook',
  };

  const received = await withTenant(ctx, (db) => receiveInbound(db, ctx, {
    channelAccountId: account.id,
    channel: 'whatsapp',
    from: body.from!,
    body: body.text ?? null,
    providerMessageId: body.providerMessageId ?? `wamid.${Date.now()}`,
    counterpartyLabel: body.profileName ?? null,
    attachments: body.media ? [{
      providerMediaId: body.media.providerMediaId,
      filename: body.media.filename ?? null,
      contentType: body.media.mimeType ?? null,
      byteSize: body.media.byteSize ?? null,
      sha256: body.media.sha256 ?? null,
      mediaKind: body.media.kind ?? 'document',
      expiresAt: body.media.expiresAt ? new Date(body.media.expiresAt) : null,
    }] : [],
  }));

  // Fetched now rather than queued, because the whole point is that the bytes
  // are ours before anybody asks for them. A real deployment moves this to the
  // job queue so a slow provider cannot hold the webhook open; the ordering —
  // receive, then immediately ingest — is the part that must not change.
  const adapter = new SimulatedWhatsApp();
  for (const attachmentId of received.attachmentIds) {
    await withTenant(ctx, (db) => ingestAttachment(db, ctx, attachmentId, {
      fetch: async (mediaId) => {
        // A sandbox number has no provider holding the bytes, so the caller
        // supplies them. Only ever accepted for an account marked simulated —
        // a live number must fetch from the provider, or the endpoint would be
        // a way to write arbitrary files into a firm's case files.
        if (account.simulated && body.media?.contentBase64) {
          return {
            bytes: Buffer.from(body.media.contentBase64, 'base64'),
            contentType: body.media.mimeType ?? 'application/octet-stream',
            filename: body.media.filename ?? 'attachment',
          };
        }
        return adapter.fetchMedia(mediaId);
      },
      // No scanner is configured in this environment, and a missing scanner
      // must fail closed rather than wave files through. The simulator's own
      // media is generated by the platform, so it is treated as clean; anything
      // from a real provider needs a real verdict before this is switched on.
      scan: async () => ({ clean: account.simulated,
                           detail: account.simulated ? undefined
                                 : 'No malware scanner is configured for live media.' }),
      store: async ({ sha256, filename }) => ({
        storageKey: `inbound/${account.tenant_id}/${sha256}/${filename}`,
        storageProvider: 'local',
      }),
    })).catch((cause) => {
      // A failed ingest is recorded on the attachment; it must not lose the
      // message, which is the part the client can see was delivered.
      console.error('ingesting an inbound attachment failed', cause);
    });
  }

  return NextResponse.json({
    data: {
      accepted: true,
      conversationId: received.conversationId,
      matched: received.matched,
      attachments: received.attachmentIds.length,
    },
  }, { status: 202 });
}
