import { describe, expect, it } from 'vitest';
import { assembleContext, scrub, CAPABILITIES, capability, jsonSchemaOf, systemPromptOf } from '@solvenda/ai';

describe('data minimisation', () => {
  const fullCase = {
    case: { reference: 'DMP-0001', type: 'dmp', stage: 'advice', notes: 'internal only' },
    client: {
      firstName: 'Joanne', lastName: 'Whitfield',
      nationalInsuranceNumber: 'QQ123456C',
      dateOfBirth: '1985-03-12',
      householdAdults: 1, householdChildren: 2,
      employmentStatus: 'employed', jurisdiction: 'england-wales',
    },
    sfs: { totalIncomePence: 198_000, totalExpenditurePence: 176_000, surplusPence: 22_000 },
    payment: { sortCode: '12-34-56', accountNumber: '12345678' },
  };

  it('sends only the fields the capability declares', () => {
    const assembled = assembleContext(fullCase, ['case.reference', 'sfs.surplusPence']);
    expect(assembled.payload).toEqual({
      case: { reference: 'DMP-0001' },
      sfs: { surplusPence: 22_000 },
    });
  });

  it('never lets an undeclared field reach the model', () => {
    const assembled = assembleContext(fullCase, ['case.reference', 'client.householdAdults']);
    const serialised = JSON.stringify(assembled.payload);
    expect(serialised).not.toContain('QQ123456C');
    expect(serialised).not.toContain('Whitfield');
    expect(serialised).not.toContain('12345678');
    expect(serialised).not.toContain('1985-03-12');
  });

  it('records what was withheld, so the decision is auditable', () => {
    const assembled = assembleContext(fullCase, ['case.reference']);
    expect(assembled.withheld).toContain('client.nationalInsuranceNumber');
    expect(assembled.withheld).toContain('payment.accountNumber');
    expect(assembled.withheld).not.toContain('case.reference');
  });

  it('reports fields the capability wanted but the case does not have', () => {
    const assembled = assembleContext(fullCase, ['case.reference', 'bank.categorisedTotals']);
    expect(assembled.missing).toEqual(['bank.categorisedTotals']);
  });

  it('fingerprints the payload so an invocation can be tied to its input', () => {
    const a = assembleContext(fullCase, ['case.reference']);
    const b = assembleContext(fullCase, ['case.reference']);
    const c = assembleContext(fullCase, ['case.type']);
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
});

describe('scrubbing free text', () => {
  it('removes identifiers that appear inside notes', () => {
    // An allowlist cannot anticipate what a person types into a note field.
    const { text, applied } = scrub(
      'Client called re NI QQ 12 34 56 C, paying from 12-34-56, ' +
      'card 4111 1111 1111 1111, reachable on 07700 900123 or jo@example.com',
    );
    expect(text).not.toMatch(/QQ ?12 ?34 ?56 ?C/);
    expect(text).not.toContain('12-34-56');
    expect(text).not.toContain('4111 1111 1111 1111');
    expect(text).not.toContain('jo@example.com');
    expect(applied).toEqual(expect.arrayContaining(['national-insurance', 'card-number', 'sort-code', 'email']));
  });

  it('scrubs inside nested structures, not just top-level strings', () => {
    const assembled = assembleContext(
      { comms: { recent: [{ body: 'My NI is QQ123456C' }] } },
      ['comms.recent'],
    );
    expect(JSON.stringify(assembled.payload)).not.toContain('QQ123456C');
    expect(assembled.redactionsApplied).toContain('national-insurance');
  });

  it('leaves ordinary text alone', () => {
    const { text, applied } = scrub('Client is working reduced hours until March.');
    expect(text).toBe('Client is working reduced hours until March.');
    expect(applied).toEqual([]);
  });
});

describe('capability definitions', () => {
  it('declares an allowlist for every capability', () => {
    for (const c of CAPABILITIES) {
      expect(c.permittedFields.length, `${c.key} must declare permitted fields`).toBeGreaterThan(0);
    }
  });

  it('produces a closed JSON schema for strict tool use', () => {
    for (const c of CAPABILITIES) {
      const schema = jsonSchemaOf(c) as Record<string, unknown>;
      expect(schema['additionalProperties'], `${c.key} schema must be closed`).toBe(false);
      expect(schema['type']).toBe('object');
    }
  });

  it('gives every capability the house rules', () => {
    for (const c of CAPABILITIES) {
      const prompt = systemPromptOf(c);
      expect(prompt).toContain('You never give advice to a consumer and you never decide anything');
      expect(prompt).toContain('Never state or imply which debt solution the client should take');
    }
  });

  it('keeps direct identifiers off every allowlist', () => {
    // Nothing needs a National Insurance number, a bank account or a date of
    // birth to do its job.
    const forbidden = ['client.nationalInsuranceNumber', 'client.dateOfBirth',
      'payment.accountNumber', 'payment.sortCode', 'client.lastName'];
    for (const c of CAPABILITIES) {
      for (const field of forbidden) {
        expect(c.permittedFields, `${c.key} must not request ${field}`).not.toContain(field);
      }
    }
  });

  it('marks the capabilities that touch regulated information', () => {
    expect(capability('ie-discrepancy')!.touchesRegulatedFields).toBe(true);
    expect(capability('vulnerability-indicators')!.touchesRegulatedFields).toBe(true);
    expect(capability('case-summary')!.touchesRegulatedFields).toBe(false);
  });

  it('leaves the most sensitive capabilities off by default', () => {
    // A firm switches these on deliberately, having reviewed them.
    expect(capability('vulnerability-indicators')!.defaultEnabled).toBe(false);
    expect(capability('advice-rationale-draft')!.defaultEnabled).toBe(false);
    expect(capability('qa-review')!.defaultEnabled).toBe(false);
  });
});
