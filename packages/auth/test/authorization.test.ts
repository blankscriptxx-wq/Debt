import { describe, expect, it } from 'vitest';
import {
  authorize, requirePermission, PermissionDeniedError,
  aiPrincipal, workflowPrincipal, isRegulatedPermission, PERMISSIONS, ROLE_TEMPLATES,
  type Principal,
} from '@solvenda/auth';

function adviser(overrides: Partial<Extract<Principal, { kind: 'user' }>> = {}): Principal {
  return {
    kind: 'user',
    tenantId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    permissions: new Set(['case:read', 'advice:decide', 'sfs:write', 'ai:accept_proposal']),
    competencies: ['debt-advice'],
    mfaSatisfied: true,
    status: 'active',
    ...overrides,
  };
}

describe('authorization', () => {
  it('allows a granted, competent, MFA-satisfied adviser to record advice', () => {
    expect(authorize(adviser(), 'advice:decide')).toEqual({ allowed: true });
  });

  it('refuses a permission that was never granted', () => {
    const d = authorize(adviser(), 'insolvency:certify');
    expect(d).toMatchObject({ allowed: false, code: 'not_granted' });
  });

  it('refuses an unknown permission rather than defaulting open', () => {
    expect(authorize(adviser(), 'case:obliterate')).toMatchObject({
      allowed: false, code: 'unknown_permission',
    });
  });

  it('requires a second factor for regulated work even when granted', () => {
    expect(authorize(adviser({ mfaSatisfied: false }), 'advice:decide')).toMatchObject({
      allowed: false, code: 'mfa_required',
    });
    // Non-regulated work is unaffected.
    expect(authorize(adviser({ mfaSatisfied: false }), 'case:read')).toEqual({ allowed: true });
  });

  it('requires the firm to have signed the person off as competent', () => {
    expect(authorize(adviser({ competencies: [] }), 'advice:decide')).toMatchObject({
      allowed: false, code: 'missing_competency',
    });
  });

  it('refuses a suspended account regardless of its roles', () => {
    expect(authorize(adviser({ status: 'suspended' }), 'case:read')).toMatchObject({
      allowed: false, code: 'account_not_active',
    });
  });

  it('refuses a principal from another firm', () => {
    expect(
      authorize(adviser(), 'case:read', { tenantId: '33333333-3333-3333-3333-333333333333' }),
    ).toMatchObject({ allowed: false, code: 'wrong_tenant' });
  });
});

describe('automation cannot exercise regulated permissions', () => {
  const regulated = PERMISSIONS.filter((p) => p.regulated).map((p) => p.key);

  it('has regulated permissions to protect', () => {
    expect(regulated.length).toBeGreaterThan(5);
    expect(regulated).toContain('advice:decide');
  });

  it.each(regulated)('refuses %s to an AI principal', (permission) => {
    const decision = authorize(
      aiPrincipal('11111111-1111-1111-1111-111111111111', 'advice-rationale', 'inv-1'),
      permission,
    );
    expect(decision).toMatchObject({
      allowed: false, code: 'regulated_action_requires_human',
    });
  });

  it.each(regulated)('refuses %s to a workflow, even if it is listed in its grant', (permission) => {
    // The workflow is deliberately configured with the permission, to prove the
    // rule holds regardless of misconfiguration.
    const decision = authorize(
      workflowPrincipal('11111111-1111-1111-1111-111111111111', 'run-1', [permission]),
      permission,
    );
    expect(decision).toMatchObject({
      allowed: false, code: 'regulated_action_requires_human',
    });
  });

  it.each(regulated)('refuses %s to an API key holding every scope', (permission) => {
    const decision = authorize(
      {
        kind: 'api_key',
        tenantId: '11111111-1111-1111-1111-111111111111',
        keyId: 'key-1',
        scopes: new Set(PERMISSIONS.map((p) => p.key)),
      },
      permission,
    );
    expect(decision).toMatchObject({
      allowed: false, code: 'regulated_action_requires_human',
    });
  });

  it('still lets automation read, analyse and propose', () => {
    const ai = aiPrincipal('11111111-1111-1111-1111-111111111111', 'case-summary', 'inv-2');
    expect(authorize(ai, 'case:read')).toEqual({ allowed: true });
    expect(authorize(ai, 'sfs:read')).toEqual({ allowed: true });
    expect(authorize(ai, 'ai:invoke')).toEqual({ allowed: true });
    // ...but not write to the financial statement it just analysed.
    expect(authorize(ai, 'sfs:write')).toMatchObject({ allowed: false, code: 'not_granted' });
  });

  it('refuses platform operators any permission inside a firm', () => {
    const decision = authorize(
      { kind: 'platform_operator', operatorId: '44444444-4444-4444-4444-444444444444' },
      'case:read',
    );
    expect(decision).toMatchObject({
      allowed: false, code: 'platform_operator_cannot_act_in_tenant',
    });
  });
});

describe('requirePermission', () => {
  it('throws with the denial code attached', () => {
    try {
      requirePermission(adviser({ competencies: [] }), 'advice:decide');
      throw new Error('should not reach here');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      expect((error as PermissionDeniedError).code).toBe('missing_competency');
    }
  });
});

describe('role templates', () => {
  it('only references permissions that exist', () => {
    const known = new Set(PERMISSIONS.map((p) => p.key));
    for (const template of ROLE_TEMPLATES) {
      for (const key of template.permissions) {
        expect(known.has(key), `${template.key} references unknown permission ${key}`).toBe(true);
      }
    }
  });

  it('keeps regulated permissions out of external-party roles', () => {
    for (const key of ['client', 'creditor', 'introducer'] as const) {
      const template = ROLE_TEMPLATES.find((t) => t.key === key)!;
      const regulated = template.permissions.filter((p) => isRegulatedPermission(p));
      expect(regulated, `${key} should hold no regulated permissions`).toEqual([]);
    }
  });

  it('gives case administrators no ability to record advice', () => {
    const admin = ROLE_TEMPLATES.find((t) => t.key === 'case-administrator')!;
    expect(admin.permissions).not.toContain('advice:decide');
    expect(admin.permissions).not.toContain('advice:recommend');
  });
});
