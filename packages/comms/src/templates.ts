import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import {
  renderTemplate, resolveSignature, templateCanBeSigned,
  SIGNATURE_VARIABLE, SignatureError,
} from './signature.js';
import { sendCommunication, type SendInput } from './send.js';
import type { ChannelAdapter } from './channels.js';
import { attachToConversation } from './conversations.js';

/**
 * The letters a firm sends, as templates.
 *
 * Most of what a debt advice firm sends is not written from scratch: an
 * appointment confirmation, a request for a payslip, a reminder that a review is
 * due. Those are letters whether they go by post, email or WhatsApp, and a firm
 * wants them worded once, approved once, and sent consistently.
 *
 * WhatsApp adds two rules that are not ours to negotiate. Outside the 24-hour
 * service window **only an approved template will be carried at all**, and an
 * approved template's body is **fixed by Meta** — variables are filled, nothing
 * is appended. Both are enforced here rather than discovered when a message
 * fails to arrive.
 *
 * A template cannot give advice. The templates a firm writes are for
 * arrangements, requests and reminders; a recommendation is a regulated
 * decision with its own screen, its own permission and its own immutable
 * record, and it does not belong in something sent at the press of a button.
 */

export class TemplateError extends Error {}

export interface TemplateSummary {
  id: string;
  key: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  requiredVariables: string[];
  version: number;
  providerStatus: string | null;
  providerCategory: string | null;
  /** Whether this can actually be sent on this channel, right now. */
  sendable: boolean;
  /** Why not, when it is not. */
  blockedBecause: string | null;
}

/**
 * Templates for a channel, each already knowing whether it can be sent.
 *
 * `windowOpen` matters because the same template is sendable inside the service
 * window and refused outside it. Offering one that will be rejected is how an
 * adviser ends up believing a client was told something they were not.
 */
interface TemplateRow extends Record<string, unknown> {
  id: string;
  key: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  required_variables: unknown;
  version: string;
  provider_status: string | null;
  provider_category: string | null;
}

export async function listTemplates(
  db: Database, channel: string, windowOpen: boolean,
): Promise<TemplateSummary[]> {
  const res = await db.execute<TemplateRow>(sql`
    SELECT DISTINCT ON (key) id, key, name, channel, subject, body,
           required_variables, version::text, provider_status, provider_category
      FROM communication_templates
     WHERE channel = ${channel} AND status = 'active'
     ORDER BY key, version DESC`);

  return res.rows.map((r) => ({
    id: r.id, key: r.key, name: r.name, channel: r.channel,
    subject: r.subject, body: r.body,
    requiredVariables: parseVariables(r.required_variables),
    version: Number(r.version),
    providerStatus: r.provider_status,
    providerCategory: r.provider_category,
    ...verdict(r, channel, windowOpen),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Whether a template can be sent on this channel right now, and why not. */
function verdict(
  r: Pick<TemplateRow, 'body' | 'provider_status' | 'name'>,
  channel: string, windowOpen: boolean,
): { sendable: boolean; blockedBecause: string | null } {
  // Only WhatsApp requires provider approval; an email template is the firm's
  // own business.
  const needsApproval = channel === 'whatsapp' && !windowOpen;

  let blockedBecause: string | null = null;
  if (needsApproval && r.provider_status !== 'approved') {
    blockedBecause = r.provider_status === 'rejected'
      ? 'The provider rejected this template, so it will not be carried.'
      : `The provider has not approved this template (${r.provider_status ?? 'not submitted'}), `
        + 'and more than 24 hours have passed since the client last wrote.';
  } else if (!templateCanBeSigned(r.body)) {
    blockedBecause = `This has no {{${SIGNATURE_VARIABLE}}} in it, so it cannot be signed by `
      + 'whoever sends it.';
  }

  return { sendable: blockedBecause === null, blockedBecause };
}

/**
 * The variables a caller must supply.
 *
 * The signature is not among them. It is resolved from the authenticated user,
 * so asking anybody to provide it — or letting them — would defeat the point.
 */
function parseVariables(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : typeof raw === 'string'
      // Some drivers hand back the array literal rather than an array.
      ? raw.replace(/^\{|\}$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''))
      : [];
  return values.map((v) => v.trim()).filter((v) => v && v !== SIGNATURE_VARIABLE);
}

/**
 * Sends a template, filled and signed.
 *
 * The signature is not among the variables the caller supplies; it is resolved
 * from the authenticated user and written into the body here, which is the only
 * way a template can be both fixed by Meta and attributable to a person.
 */
export async function sendTemplate(
  db: Database, ctx: TenantContext, principal: Principal, adapter: ChannelAdapter,
  input: {
    templateKey: string;
    clientId: string;
    caseId?: string | null;
    channel: SendInput['channel'];
    variables?: Readonly<Record<string, string>>;
    /** Set when the letter is sent from a thread, so it appears in it. */
    conversationId?: string | null;
    /** True while the client's 24-hour service window is still open. */
    windowOpen: boolean;
  },
): Promise<{ communicationId: string; delivered: boolean }> {
  requirePermission(principal, 'comms:send', { tenantId: ctx.tenantId });

  const res = await db.execute<TemplateRow>(sql`
    SELECT id, key, name, channel, subject, body, required_variables, version::text,
           provider_status, provider_category
      FROM communication_templates
     WHERE key = ${input.templateKey} AND channel = ${input.channel} AND status = 'active'
     ORDER BY version DESC LIMIT 1`);
  const template = res.rows[0];
  if (!template) {
    throw new TemplateError(`No active ${input.channel} template called "${input.templateKey}".`);
  }

  // The same judgement the picker showed, applied again at the moment of
  // sending. A list drawn a minute ago is not a permission, and the window can
  // close between choosing a template and pressing send.
  const { sendable, blockedBecause } = verdict(template, input.channel, input.windowOpen);
  if (!sendable) throw new TemplateError(`"${template.name}": ${blockedBecause}`);

  const signature = await resolveSignature(db, principal);

  let body: string;
  try {
    body = renderTemplate(template.body, input.variables ?? {}, signature);
  } catch (cause) {
    throw cause instanceof SignatureError ? new TemplateError(cause.message) : cause;
  }

  const sent = await sendCommunication(db, ctx, principal, adapter, {
    caseId: input.caseId ?? null,
    clientId: input.clientId,
    channel: input.channel,
    templateKey: template.key,
    subject: template.subject,
    body,
    // Already signed: the signature went into the template's own variable,
    // because appending to an approved template would change what Meta approved.
    signed: true,
  });

  if (input.conversationId) {
    await attachToConversation(db, input.conversationId, sent.communicationId, body);
  }

  await recordAudit(db, ctx, {
    action: 'comms.message.sent',
    resourceType: 'communication', resourceId: sent.communicationId,
    caseId: input.caseId ?? null,
    reason: `Sent the "${template.name}" template`,
    source: 'console',
    after: {
      template: template.key, version: Number(template.version),
      channel: input.channel,
      providerCategory: template.provider_category,
      signedBy: signature.text, humanSigned: signature.human,
    },
  });

  return sent;
}

/**
 * Activates a template, refusing one that cannot be signed.
 *
 * The check lives at activation rather than at send. An approved WhatsApp
 * template cannot be altered when it is used, so a template without a signature
 * variable is not a message missing a line — it is a message that can never be
 * attributed to anybody, and the moment to catch that is before a firm builds a
 * process on it.
 */
export async function activateTemplate(
  db: Database, ctx: TenantContext, principal: Principal,
  input: { templateId: string },
): Promise<void> {
  requirePermission(principal, 'tenant:configure', { tenantId: ctx.tenantId });

  const res = await db.execute<{ body: string; name: string; channel: string }>(sql`
    SELECT body, name, channel FROM communication_templates WHERE id = ${input.templateId}`);
  const template = res.rows[0];
  if (!template) throw new TemplateError('No such template.');

  if (template.channel !== 'letter' && !templateCanBeSigned(template.body)) {
    throw new TemplateError(
      `"${template.name}" has no {{${SIGNATURE_VARIABLE}}} in it. Every message a client `
      + 'receives says who it is from, so add it before activating this.');
  }

  await db.execute(sql`
    UPDATE communication_templates
       SET status = 'active', approved_by = ${ctx.userId ?? null}, approved_at = now()
     WHERE id = ${input.templateId}`);

  await recordAudit(db, ctx, {
    action: 'comms.template.activated',
    resourceType: 'communication_template', resourceId: input.templateId,
    reason: `"${template.name}" made available for sending`,
    source: 'console',
  });
}
