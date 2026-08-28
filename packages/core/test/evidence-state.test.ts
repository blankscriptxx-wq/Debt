import { describe, expect, it } from 'vitest';
import {
  resolveEvidenceState, evidenceMap, outstandingEvidence,
  CASE_TYPE_TEMPLATES, type EvidenceRecords, type CaseTypeDefinition,
} from '@solvenda/core';

/**
 * Evidence state.
 *
 * These tests exist because the product used to answer this question from the
 * consents table alone, which meant "identity verified" and "statement
 * complete" could only ever be true if someone had written them as consents —
 * and the seed did exactly that, so the product looked correct and was not.
 */

const dmp = CASE_TYPE_TEMPLATES.find((t) => t.key === 'dmp')! as CaseTypeDefinition;

const NOTHING: EvidenceRecords = {
  verificationItems: [],
  consents: [],
  vulnerability: { assessed: false, recordId: null },
  statement: null,
};

const at = (records: Partial<EvidenceRecords>, stage = 'fact-find', today = '2026-08-28') =>
  resolveEvidenceState(dmp, stage, { ...NOTHING, ...records }, today);

const find = (records: Partial<EvidenceRecords>, key: string, stage = 'fact-find') =>
  at(records, stage).find((r) => r.key === key)!;

describe('an empty case', () => {
  it('reports every requirement missing rather than satisfied', () => {
    const resolved = at({});
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.every((r) => r.state === 'missing')).toBe(true);
  });

  it('separates what is owed now from what comes later', () => {
    const resolved = at({});
    const now = resolved.filter((r) => r.timing === 'now').map((r) => r.key);
    // A payment mandate belongs to a later stage; consent was owed at onboarding
    // and is still owed at fact find, because an item owed earlier is more
    // overdue rather than less.
    expect(now).toContain('consent.processing');
    expect(now).toContain('sfs.complete');
    expect(now).not.toContain('payment.mandate');
  });
});

describe('consent', () => {
  it('is satisfied by a granted consent for that purpose', () => {
    const r = find({ consents: [
      { id: 'c1', purpose: 'consent.processing', granted: true, withdrawnAt: null }] },
      'consent.processing');
    expect(r.state).toBe('verified');
    expect(r.source).toEqual({ type: 'consent', id: 'c1' });
  });

  it('is not satisfied once withdrawn', () => {
    const r = find({ consents: [
      { id: 'c1', purpose: 'consent.processing', granted: true, withdrawnAt: '2026-08-01' }] },
      'consent.processing');
    expect(r.state).toBe('missing');
  });
});

describe('the declared/verified distinction', () => {
  it('treats a completed statement with unevidenced lines as declared, not verified', () => {
    const r = find({ statement: {
      id: 's1', completedAt: '2026-08-20', lineCount: 6, evidencedLineCount: 2 } },
      'sfs.complete');
    expect(r.state).toBe('declared');
    expect(r.because).toContain('4 of 6');
  });

  it('treats a fully evidenced statement as verified', () => {
    const r = find({ statement: {
      id: 's1', completedAt: '2026-08-20', lineCount: 6, evidencedLineCount: 6 } },
      'sfs.complete');
    expect(r.state).toBe('verified');
  });

  it('treats an incomplete statement as declared', () => {
    const r = find({ statement: {
      id: 's1', completedAt: null, lineCount: 3, evidencedLineCount: 3 } }, 'sfs.complete');
    expect(r.state).toBe('declared');
  });

  it('treats a verbally confirmed item as declared however it is marked', () => {
    const r = find({ verificationItems: [{
      id: 'v1', requirementKey: 'identity.verified', status: 'verified',
      method: 'verbal', expiresOn: null }] }, 'identity.verified');
    expect(r.state).toBe('declared');
    expect(r.because).toContain('not independent evidence');
  });

  it('does not downgrade a consent or an assessment for how it was captured', () => {
    // There is no document a vulnerability assessment could be checked against.
    // Marking it declared would tell an adviser to go and verify something that
    // cannot be verified.
    const r = find({ verificationItems: [{
      id: 'v2', requirementKey: 'vulnerability.assessed', status: 'verified',
      method: 'other', expiresOn: null }] }, 'vulnerability.assessed');
    expect(r.state).toBe('verified');
  });

  it('treats a documented item as verified', () => {
    const r = find({ verificationItems: [{
      id: 'v1', requirementKey: 'identity.verified', status: 'verified',
      method: 'document', expiresOn: null }] }, 'identity.verified');
    expect(r.state).toBe('verified');
  });
});

describe('verification item states', () => {
  const item = (over: Record<string, unknown>) => ({
    verificationItems: [{
      id: 'v1', requirementKey: 'identity.verified', status: 'verified' as const,
      method: 'document', expiresOn: null, ...over,
    }],
  } as Partial<EvidenceRecords>);

  it('reports a waiver as waived, not as missing', () => {
    expect(find(item({ status: 'waived' }), 'identity.verified').state).toBe('waived');
  });

  it('reports received-but-unchecked as declared', () => {
    expect(find(item({ status: 'received' }), 'identity.verified').state).toBe('declared');
  });

  it('reports a rejection as missing', () => {
    expect(find(item({ status: 'rejected' }), 'identity.verified').state).toBe('missing');
  });

  it('reports not-applicable as not required', () => {
    expect(find(item({ status: 'not-applicable' }), 'identity.verified').state)
      .toBe('not-required');
  });

  it('reports evidence past its expiry as expired, not verified', () => {
    const r = find(item({ expiresOn: '2026-01-31' }), 'identity.verified');
    expect(r.state).toBe('expired');
    expect(r.because).toContain('2026-01-31');
  });

  it('leaves evidence that has not yet expired verified', () => {
    expect(find(item({ expiresOn: '2027-01-31' }), 'identity.verified').state).toBe('verified');
  });
});

describe('vulnerability', () => {
  it('counts a recorded "no indicators identified" as assessed', () => {
    const r = find({ vulnerability: { assessed: true, recordId: 'vr1' } },
                   'vulnerability.assessed');
    expect(r.state).toBe('verified');
    expect(r.source).toEqual({ type: 'vulnerability_record', id: 'vr1' });
  });

  it('says plainly what is missing when nothing was recorded', () => {
    expect(find({}, 'vulnerability.assessed').because).toContain('no indicators identified');
  });
});

describe('completeness the software cannot infer', () => {
  it('leaves "debts captured" missing until someone confirms it', () => {
    // Debts existing does not mean every debt was disclosed. That is a human
    // judgement, so it needs a human record rather than a derived one.
    expect(find({}, 'debts.captured').state).toBe('missing');
    const confirmed = find({ verificationItems: [{
      id: 'v9', requirementKey: 'debts.captured', status: 'verified',
      method: 'document', expiresOn: null }] }, 'debts.captured');
    expect(confirmed.state).toBe('verified');
  });
});

describe('the boolean map the rest of the platform consumes', () => {
  it('counts verified and waived as satisfied, and declared and expired as not', () => {
    const map = evidenceMap([
      { key: 'a', label: '', kind: 'document', blocking: true, state: 'verified',
        timing: 'now', because: '', source: null },
      { key: 'b', label: '', kind: 'document', blocking: true, state: 'waived',
        timing: 'now', because: '', source: null },
      { key: 'c', label: '', kind: 'document', blocking: true, state: 'declared',
        timing: 'now', because: '', source: null },
      { key: 'd', label: '', kind: 'document', blocking: true, state: 'expired',
        timing: 'now', because: '', source: null },
    ]);
    expect(map).toEqual({ a: true, b: true, c: false, d: false });
  });
});

describe('what to chase', () => {
  it('lists what is owed now worst first, blocking items ahead of the rest', () => {
    const resolved = at({
      consents: [{ id: 'c1', purpose: 'consent.processing', granted: true, withdrawnAt: null }],
      statement: { id: 's1', completedAt: '2026-08-20', lineCount: 4, evidencedLineCount: 1 },
    });
    const out = outstandingEvidence(resolved);
    expect(out.map((r) => r.key)).not.toContain('consent.processing');
    expect(out.map((r) => r.key)).toContain('sfs.complete');
    // Missing sorts ahead of declared: nothing at all beats something unproven.
    const states = out.map((r) => r.state);
    expect(states.indexOf('missing')).toBeLessThan(states.lastIndexOf('declared'));
  });

  it('does not chase what this stage has not reached yet', () => {
    expect(outstandingEvidence(at({})).map((r) => r.key)).not.toContain('payment.mandate');
  });
});
