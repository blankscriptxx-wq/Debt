import { createHash, randomUUID } from 'node:crypto';

/**
 * The WhatsApp Business Platform, as a contract.
 *
 * Which provider carries the traffic — Meta's Cloud API directly, or a business
 * solution provider in front of it — changes the price, the onboarding and the
 * developer experience. It does not change what WhatsApp can do: templates,
 * message categories, rate limits, quality ratings and the service window are
 * Meta's rules and reach every provider identically. So the provider belongs
 * behind an adapter, and choosing one is configuration rather than a rewrite.
 *
 * Everything shipped here is a simulator. No live credentials exist, and the
 * platform says so rather than implying a message left the building.
 *
 * The three constraints below are the ones that shape the code above this file,
 * so they are stated here rather than discovered in production:
 *
 *  1. **Media ids expire.** A media id delivered in a webhook stops resolving
 *     after about seven days, and the download URL it yields lasts minutes. So
 *     attachments are fetched when the message arrives, never when an adviser
 *     asks for them.
 *  2. **The service window.** A business may send freely for 24 hours after the
 *     customer's last message. Outside it, only an approved template will go,
 *     and the platform treats that as a visible state rather than a failed send.
 *  3. **Approval is not ours.** A template can be perfectly good here and
 *     rejected by Meta. Our record of its status is a cache of theirs.
 */

export const WHATSAPP_LIMITS = {
  /** Bytes. Meta's published ceilings; a provider may be stricter. */
  document: 100 * 1024 * 1024,
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  /** How long the customer service window stays open, in hours. */
  serviceWindowHours: 24,
  /** Roughly how long a media id from a webhook keeps resolving, in days. */
  mediaIdDays: 7,
} as const;

export type WhatsAppMediaKind =
  'image' | 'document' | 'audio' | 'voice' | 'video' | 'sticker' | 'contact' | 'location';

export interface WhatsAppInbound {
  providerMessageId: string;
  /** The customer's number, in E.164 as the platform delivers it. */
  from: string;
  /** The business number it arrived on, which is what selects the tenant. */
  toPhoneNumberId: string;
  text: string | null;
  occurredAt: Date;
  profileName?: string | null;
  media?: {
    providerMediaId: string;
    kind: WhatsAppMediaKind;
    filename?: string | null;
    mimeType: string;
    byteSize: number;
    sha256: string;
    /** When the provider stops serving it. */
    expiresAt: Date;
  } | null;
}

export interface WhatsAppStatusUpdate {
  providerMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  occurredAt: Date;
  errorCode?: number | null;
  errorTitle?: string | null;
}

export interface WhatsAppSendResult {
  providerMessageId: string;
  status: 'queued' | 'sent' | 'failed';
  simulated: boolean;
  failureReason?: string;
  /** Set when the send was refused because the window had closed. */
  requiresTemplate?: boolean;
}

export interface WhatsAppAdapter {
  readonly category: 'whatsapp';
  readonly providerKey: string;
  readonly simulated: boolean;

  /** Free-form reply. Only valid inside the service window. */
  sendText(input: {
    phoneNumberId: string; to: string; body: string; windowOpenUntil: Date | null;
  }): Promise<WhatsAppSendResult>;

  /** An approved template, which is what reaches somebody outside the window. */
  sendTemplate(input: {
    phoneNumberId: string; to: string; templateName: string;
    languageCode: string; variables: readonly string[];
  }): Promise<WhatsAppSendResult>;

  /** Fetches the bytes behind a media id, while it still resolves. */
  fetchMedia(providerMediaId: string): Promise<{
    bytes: Buffer; contentType: string; filename: string;
  }>;

  /** What the provider says about a template, which overrides what we think. */
  templateStatus(input: { phoneNumberId: string; templateName: string }): Promise<{
    status: 'not-submitted' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';
    category: 'marketing' | 'utility' | 'authentication' | 'service' | null;
    rejectionReason: string | null;
  }>;
}

/** Whether the customer service window is still open, given the last inbound. */
export function serviceWindowOpenUntil(lastInboundAt: Date | null): Date | null {
  if (!lastInboundAt) return null;
  const until = new Date(lastInboundAt.getTime()
    + WHATSAPP_LIMITS.serviceWindowHours * 60 * 60 * 1000);
  return until > new Date() ? until : null;
}

/** The ceiling for a kind of media, so an oversized file fails before sending. */
export function sizeLimitFor(kind: WhatsAppMediaKind): number {
  switch (kind) {
    case 'image': case 'sticker': return WHATSAPP_LIMITS.image;
    case 'video': return WHATSAPP_LIMITS.video;
    case 'audio': case 'voice': return WHATSAPP_LIMITS.audio;
    default: return WHATSAPP_LIMITS.document;
  }
}

/**
 * A simulator that behaves like the real platform rather than like a stub.
 *
 * It refuses free text outside the service window, refuses an unapproved
 * template, expires media, and returns the same shapes as the live adapter — so
 * the code above it takes the real branches instead of always the happy one.
 */
export class SimulatedWhatsApp implements WhatsAppAdapter {
  readonly category = 'whatsapp' as const;
  readonly providerKey = 'sandbox-whatsapp';
  readonly simulated = true;

  /** Media the simulator is holding, keyed by the id it handed out. */
  private readonly media = new Map<string, {
    bytes: Buffer; contentType: string; filename: string; expiresAt: Date;
  }>();

  private readonly templates = new Map<string, {
    status: 'not-submitted' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';
    category: 'marketing' | 'utility' | 'authentication' | 'service' | null;
    rejectionReason: string | null;
  }>();

  /** Registers a template as the provider sees it. */
  setTemplate(
    name: string,
    status: 'not-submitted' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled',
    category: 'marketing' | 'utility' | 'authentication' | 'service' | null = 'utility',
    rejectionReason: string | null = null,
  ): void {
    this.templates.set(name, { status, category, rejectionReason });
  }

  /**
   * Builds an inbound message as a webhook would deliver it, holding the bytes
   * so `fetchMedia` can later return them — and stamping the expiry, so code
   * that waits too long is genuinely refused rather than quietly succeeding.
   */
  simulateInbound(input: {
    from: string; toPhoneNumberId: string; text?: string | null;
    profileName?: string | null;
    attachment?: {
      bytes: Buffer; filename: string; contentType: string; kind?: WhatsAppMediaKind;
    };
    occurredAt?: Date;
    /** Overrides the expiry, for exercising the expired path. */
    mediaExpiresAt?: Date;
  }): WhatsAppInbound {
    const occurredAt = input.occurredAt ?? new Date();
    let media: WhatsAppInbound['media'] = null;

    if (input.attachment) {
      const kind = input.attachment.kind ?? 'document';
      const limit = sizeLimitFor(kind);
      if (input.attachment.bytes.length > limit) {
        // 131052 is the platform's "media file size too big".
        throw Object.assign(new Error('Media file size too big.'), { code: 131052 });
      }
      const id = `media.${randomUUID()}`;
      const expiresAt = input.mediaExpiresAt
        ?? new Date(occurredAt.getTime() + WHATSAPP_LIMITS.mediaIdDays * 86_400_000);
      this.media.set(id, {
        bytes: input.attachment.bytes,
        contentType: input.attachment.contentType,
        filename: input.attachment.filename,
        expiresAt,
      });
      media = {
        providerMediaId: id, kind,
        filename: input.attachment.filename,
        mimeType: input.attachment.contentType,
        byteSize: input.attachment.bytes.length,
        sha256: createHash('sha256').update(input.attachment.bytes).digest('hex'),
        expiresAt,
      };
    }

    return {
      providerMessageId: `wamid.${randomUUID()}`,
      from: input.from,
      toPhoneNumberId: input.toPhoneNumberId,
      text: input.text ?? null,
      occurredAt,
      profileName: input.profileName ?? null,
      media,
    };
  }

  async sendText(input: {
    phoneNumberId: string; to: string; body: string; windowOpenUntil: Date | null;
  }): Promise<WhatsAppSendResult> {
    if (!input.windowOpenUntil || input.windowOpenUntil <= new Date()) {
      return {
        providerMessageId: '', status: 'failed', simulated: true, requiresTemplate: true,
        failureReason:
          'More than 24 hours since the client last wrote, so WhatsApp will not carry a '
          + 'free-form message. Send an approved template instead.',
      };
    }
    if (!input.body.trim()) {
      return { providerMessageId: '', status: 'failed', simulated: true,
               failureReason: 'An empty message cannot be sent.' };
    }
    return { providerMessageId: `wamid.${randomUUID()}`, status: 'sent', simulated: true };
  }

  async sendTemplate(input: {
    phoneNumberId: string; to: string; templateName: string;
    languageCode: string; variables: readonly string[];
  }): Promise<WhatsAppSendResult> {
    const template = this.templates.get(input.templateName);
    if (!template || template.status !== 'approved') {
      return {
        providerMessageId: '', status: 'failed', simulated: true,
        failureReason: template
          ? `The template "${input.templateName}" is ${template.status} with the provider`
            + `${template.rejectionReason ? `: ${template.rejectionReason}` : '.'}`
          : `The template "${input.templateName}" has not been submitted for approval.`,
      };
    }
    return { providerMessageId: `wamid.${randomUUID()}`, status: 'sent', simulated: true };
  }

  async fetchMedia(providerMediaId: string): Promise<{
    bytes: Buffer; contentType: string; filename: string;
  }> {
    const held = this.media.get(providerMediaId);
    if (!held) throw new Error('That media id is not known to the provider.');
    if (held.expiresAt < new Date()) {
      // What the real platform does once the id ages out, and the reason
      // attachments are fetched on arrival rather than on demand.
      throw new Error('That media id has expired and can no longer be downloaded.');
    }
    return { bytes: held.bytes, contentType: held.contentType, filename: held.filename };
  }

  async templateStatus(input: { phoneNumberId: string; templateName: string }): Promise<{
    status: 'not-submitted' | 'pending' | 'approved' | 'rejected' | 'paused' | 'disabled';
    category: 'marketing' | 'utility' | 'authentication' | 'service' | null;
    rejectionReason: string | null;
  }> {
    return this.templates.get(input.templateName)
      ?? { status: 'not-submitted', category: null, rejectionReason: null };
  }
}
