/**
 * Channel adapters.
 *
 * Every adapter here is a sandbox simulator. No live credentials exist for any
 * provider, and the platform is explicit about that rather than quietly
 * pretending: every message records `simulated: true`, and the console shows
 * it. Swapping in a real provider means implementing this interface; nothing
 * above it changes.
 */

export interface OutboundMessage {
  channel: 'email' | 'sms' | 'whatsapp' | 'letter' | 'portal';
  to: string;
  subject?: string | null;
  body: string;
  caseReference?: string | null;
}

export interface DeliveryResult {
  providerMessageId: string;
  status: 'queued' | 'sent' | 'failed';
  simulated: boolean;
  failureReason?: string;
}

export interface ChannelAdapter {
  readonly channel: OutboundMessage['channel'];
  readonly providerName: string;
  readonly simulated: boolean;
  send(message: OutboundMessage): Promise<DeliveryResult>;
}

/**
 * A deterministic simulator. Behaves like a real provider - it validates the
 * recipient, it can fail - so the code paths around it are genuinely exercised
 * rather than always taking the happy route.
 */
export class SimulatedChannel implements ChannelAdapter {
  readonly simulated = true;
  readonly providerName: string;

  constructor(readonly channel: OutboundMessage['channel']) {
    this.providerName = `sandbox-${channel}`;
  }

  async send(message: OutboundMessage): Promise<DeliveryResult> {
    const invalid = this.validate(message);
    if (invalid) {
      return { providerMessageId: '', status: 'failed', simulated: true, failureReason: invalid };
    }
    const id = `sim-${this.channel}-${hash(message.to + message.body)}`;
    return { providerMessageId: id, status: 'sent', simulated: true };
  }

  private validate(message: OutboundMessage): string | null {
    if (!message.body.trim()) return 'Message body is empty';
    switch (this.channel) {
      case 'email':
        return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(message.to) ? null : 'Not a valid email address';
      case 'sms':
      case 'whatsapp':
        return /^\+?[\d\s()-]{10,}$/.test(message.to) ? null : 'Not a valid phone number';
      case 'letter':
        return message.to.trim().length > 5 ? null : 'Postal address looks incomplete';
      case 'portal':
        return message.to.trim().length > 0 ? null : 'No portal recipient';
    }
  }
}

function hash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function defaultChannels(): Map<OutboundMessage['channel'], ChannelAdapter> {
  return new Map([
    ['email', new SimulatedChannel('email')],
    ['sms', new SimulatedChannel('sms')],
    ['whatsapp', new SimulatedChannel('whatsapp')],
    ['letter', new SimulatedChannel('letter')],
    ['portal', new SimulatedChannel('portal')],
  ] as const);
}
