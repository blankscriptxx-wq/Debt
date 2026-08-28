import { describe, expect, it } from 'vitest';
import {
  SimulatedWhatsApp, serviceWindowOpenUntil, sizeLimitFor, WHATSAPP_LIMITS,
} from '@solvenda/integrations';

/**
 * The WhatsApp simulator.
 *
 * These assert the platform's awkward rules rather than the happy path, because
 * the awkward rules are the ones the product has to be designed around: the
 * service window closing, a template not being approved, and a media id ageing
 * out from under a file somebody still needs.
 */

const PDF = Buffer.from('%PDF-1.7 bank statement');

describe('the customer service window', () => {
  it('is open for 24 hours after the client last wrote', () => {
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const until = serviceWindowOpenUntil(anHourAgo);
    expect(until).not.toBeNull();
    expect(until!.getTime() - anHourAgo.getTime())
      .toBe(WHATSAPP_LIMITS.serviceWindowHours * 60 * 60 * 1000);
  });

  it('is closed once a day has passed, and closed when they never wrote', () => {
    expect(serviceWindowOpenUntil(new Date(Date.now() - 25 * 60 * 60 * 1000))).toBeNull();
    expect(serviceWindowOpenUntil(null)).toBeNull();
  });
});

describe('sending', () => {
  it('carries free text while the window is open', async () => {
    const wa = new SimulatedWhatsApp();
    const result = await wa.sendText({
      phoneNumberId: 'pn-1', to: '+447700900123', body: 'Thanks, received.',
      windowOpenUntil: serviceWindowOpenUntil(new Date()),
    });
    expect(result.status).toBe('sent');
    expect(result.simulated).toBe(true);
  });

  it('refuses free text once it has closed, and says what to do instead', async () => {
    const wa = new SimulatedWhatsApp();
    const result = await wa.sendText({
      phoneNumberId: 'pn-1', to: '+447700900123', body: 'Are you still there?',
      windowOpenUntil: serviceWindowOpenUntil(new Date(Date.now() - 26 * 60 * 60 * 1000)),
    });
    expect(result.status).toBe('failed');
    expect(result.requiresTemplate).toBe(true);
    expect(result.failureReason).toContain('approved template');
  });

  it('refuses a template the provider has not approved, naming its state', async () => {
    const wa = new SimulatedWhatsApp();
    wa.setTemplate('appointment-reminder', 'rejected', 'utility',
                   'Content resembles a restricted category');

    const result = await wa.sendTemplate({
      phoneNumberId: 'pn-1', to: '+447700900123',
      templateName: 'appointment-reminder', languageCode: 'en_GB', variables: [],
    });
    expect(result.status).toBe('failed');
    expect(result.failureReason).toContain('rejected');
    expect(result.failureReason).toContain('restricted category');
  });

  it('refuses a template nobody has submitted', async () => {
    const wa = new SimulatedWhatsApp();
    const result = await wa.sendTemplate({
      phoneNumberId: 'pn-1', to: '+447700900123',
      templateName: 'never-submitted', languageCode: 'en_GB', variables: [],
    });
    expect(result.failureReason).toContain('not been submitted');
  });

  it('sends an approved one', async () => {
    const wa = new SimulatedWhatsApp();
    wa.setTemplate('appointment-reminder', 'approved', 'utility');
    const result = await wa.sendTemplate({
      phoneNumberId: 'pn-1', to: '+447700900123',
      templateName: 'appointment-reminder', languageCode: 'en_GB', variables: ['Tuesday'],
    });
    expect(result.status).toBe('sent');
  });
});

describe('inbound media', () => {
  it('hands back an id, a hash and an expiry', () => {
    const wa = new SimulatedWhatsApp();
    const inbound = wa.simulateInbound({
      from: '+447700900123', toPhoneNumberId: 'pn-1',
      attachment: { bytes: PDF, filename: 'statement.pdf', contentType: 'application/pdf' },
    });

    expect(inbound.media).not.toBeNull();
    expect(inbound.media!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inbound.media!.byteSize).toBe(PDF.length);
    // Seven days is what makes fetching on arrival non-negotiable.
    const days = (inbound.media!.expiresAt.getTime() - inbound.occurredAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(WHATSAPP_LIMITS.mediaIdDays);
  });

  it('serves the bytes while the id is live', async () => {
    const wa = new SimulatedWhatsApp();
    const inbound = wa.simulateInbound({
      from: '+447700900123', toPhoneNumberId: 'pn-1',
      attachment: { bytes: PDF, filename: 'statement.pdf', contentType: 'application/pdf' },
    });
    const fetched = await wa.fetchMedia(inbound.media!.providerMediaId);
    expect(fetched.bytes.equals(PDF)).toBe(true);
    expect(fetched.filename).toBe('statement.pdf');
  });

  it('refuses once the id has aged out, which is why we fetch on arrival', async () => {
    const wa = new SimulatedWhatsApp();
    const inbound = wa.simulateInbound({
      from: '+447700900123', toPhoneNumberId: 'pn-1',
      attachment: { bytes: PDF, filename: 'statement.pdf', contentType: 'application/pdf' },
      mediaExpiresAt: new Date(Date.now() - 1000),
    });
    await expect(wa.fetchMedia(inbound.media!.providerMediaId)).rejects.toThrow(/expired/);
  });

  it('rejects a file over the limit for its kind, as the platform does', () => {
    const wa = new SimulatedWhatsApp();
    const tooBig = Buffer.alloc(WHATSAPP_LIMITS.image + 1);
    expect(() => wa.simulateInbound({
      from: '+447700900123', toPhoneNumberId: 'pn-1',
      attachment: { bytes: tooBig, filename: 'huge.png', contentType: 'image/png', kind: 'image' },
    })).toThrow(/too big/);
  });

  it('applies a different ceiling per kind', () => {
    expect(sizeLimitFor('image')).toBeLessThan(sizeLimitFor('video'));
    expect(sizeLimitFor('video')).toBeLessThan(sizeLimitFor('document'));
    // A voice note is audio, not a document, and gets the audio ceiling.
    expect(sizeLimitFor('voice')).toBe(sizeLimitFor('audio'));
  });
});
