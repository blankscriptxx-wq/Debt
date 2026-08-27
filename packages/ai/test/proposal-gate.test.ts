import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql, withPlatform } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, expectDbError, type TestTenant } from '@solvenda/testing';
import { aiPrincipal, workflowPrincipal, seedGlobalCatalogues, PERMISSIONS, type Principal } from '@solvenda/auth';
import {
  StubAiProvider, invokeCapability, createProposals, decideProposal, pendingProposals,
  CapabilityNotEnabledError, CAPABILITIES, capability, ProposalError,
} from '@solvenda/ai';

let tenant: TestTenant;
let caseId: string;
let operatorId: string;
const provider = new StubAiProvider();

function adviser(overrides: Partial<Extract<Principal, { kind: 'user' }>> = {}): Principal {
  return {
    kind: 'user', tenantId: tenant.id, userId: tenant.userId,
    permissions: new Set(['ai:invoke', 'ai:accept_proposal', 'case:read']),
    competencies: ['debt-advice'], mfaSatisfied: true, status: 'active',
    ...overrides,
  };
}

const CASE_CONTEXT = {
  case: { reference: 'DMP-0001', type: 'dmp', stage: 'advice', jurisdiction: 'england-wales',
          openedAt: '2026-01-04', owner: 'A Adviser', nextReviewDue: '2027-01-04' },
  client: { householdAdults: 1, householdChildren: 2, employmentStatus: 'employed',
            jurisdiction: 'england-wales', nationalInsuranceNumber: 'AB123456C' },
  sfs: { totalIncomePence: 198_000, totalExpenditurePence: 176_000, surplusPence: 22_000,
         lines: [], exceedances: [], completedAt: '2026-02-01' },
  debt: { total: 1_420_000, count: 8, creditorCount: 8, list: [] },
  timeline: { recentEvents: [] }, vulnerability: { summary: 'none recorded' },
  tasks: { open: [] }, comms: { recent: [] },
};

beforeAll(async () => {
  operatorId = await ensureTestOperator();
  await seedGlobalCatalogues(operatorId);

  // The capability catalogue is platform reference data.
  await withPlatform({ operatorId, reason: 'publish AI capability catalogue for tests' }, async (db) => {
    for (const c of CAPABILITIES) {
      await db.execute(sql`
        INSERT INTO ai_capability_catalogue
          (key, name, description, category, produces_proposals, touches_regulated_fields, default_enabled)
        VALUES (${c.key}, ${c.name}, ${c.description}, ${c.category},
                ${c.producesProposals}, ${c.touchesRegulatedFields}, ${c.defaultEnabled})
        ON CONFLICT (key) DO NOTHING`);
    }
  });

  tenant = await createTestTenant('ai');
  caseId = await tenant.as(async (db) => {
    const c = await db.execute<{ id: string }>(sql`
      INSERT INTO clients (reference, first_name, last_name) VALUES ('CL-1','Jo','W') RETURNING id`);
    const k = await db.execute<{ id: string }>(sql`
      INSERT INTO cases (reference, client_id, case_type_key, case_type_version, stage)
      VALUES ('DMP-1', ${c.rows[0]!.id}, 'dmp', 1, 'advice') RETURNING id`);
    return k.rows[0]!.id;
  });
});

afterAll(async () => { await closeDatabase(); });

describe('invocation', () => {
  it('runs an enabled capability and records the invocation', async () => {
    const result = await tenant.as((db) => invokeCapability(db, tenant.context, adviser(), provider, {
      capabilityKey: 'case-summary', caseId, context: CASE_CONTEXT, source: 'console',
    }));

    expect(result.simulated).toBe(true);
    expect(result.output).toHaveProperty('summary');

    const row = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT * FROM ai_invocations WHERE id = ${result.invocationId}`);
      return r.rows[0]!;
    });
    expect(row['capability_key']).toBe('case-summary');
    expect(row['requested_by']).toBe(tenant.userId);
    expect(row['output_valid']).toBe(true);
    expect(row['input_fingerprint']).toMatch(/^[0-9a-f]{32}$/);
    // Field identifiers, not a second copy of the client's data.
    expect(JSON.stringify(row['input_references'])).toContain('case.reference');
    expect(JSON.stringify(row['input_references'])).not.toContain('AB123456C');
  });

  it('refuses a capability the firm has not enabled', async () => {
    await expect(
      tenant.as((db) => invokeCapability(db, tenant.context, adviser(), provider, {
        capabilityKey: 'vulnerability-indicators', caseId, context: CASE_CONTEXT, source: 'console',
      })),
    ).rejects.toThrow(CapabilityNotEnabledError);
  });

  it('runs it once the firm switches it on', async () => {
    await tenant.as((db) => db.execute(sql`
      INSERT INTO ai_capabilities (capability_key, enabled)
      VALUES ('vulnerability-indicators', true)
      ON CONFLICT (tenant_id, capability_key) DO UPDATE SET enabled = true`));

    const result = await tenant.as((db) => invokeCapability(db, tenant.context, adviser(), provider, {
      capabilityKey: 'vulnerability-indicators', caseId, context: CASE_CONTEXT, source: 'console',
    }));
    expect(result.output).toHaveProperty('signals');
  });

  it('refuses a principal without ai:invoke', async () => {
    await expect(
      tenant.as((db) => invokeCapability(db, tenant.context,
        adviser({ permissions: new Set(['case:read']) }), provider, {
          capabilityKey: 'case-summary', caseId, context: CASE_CONTEXT, source: 'console',
        })),
    ).rejects.toThrow(/does not include ai:invoke/);
  });

  it('lets a workflow invoke, because analysis is not a regulated act', async () => {
    const result = await tenant.as((db) => invokeCapability(db, tenant.context,
      workflowPrincipal(tenant.id, 'run-1', ['ai:invoke']), provider, {
        capabilityKey: 'case-summary', caseId, context: CASE_CONTEXT, source: 'workflow:run-1',
      }));
    expect(result.output).toBeTruthy();

    const row = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT requested_by, requested_by_type FROM ai_invocations WHERE id = ${result.invocationId}`);
      return r.rows[0]!;
    });
    expect(row['requested_by']).toBeNull();
    expect(row['requested_by_type']).toBe('workflow');
  });

  it('records the invocation on the audit ledger', async () => {
    const event = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT action, source, after_state FROM audit_events
         WHERE action LIKE 'ai.invocation%' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(event['source']).toMatch(/^ai:/);
    expect((event['after_state'] as Record<string, unknown>)['fieldsWithheld']).toBeGreaterThan(0);
  });

  it('cannot be edited or deleted afterwards', async () => {
    await expectDbError(
      tenant.as((db) => db.execute(sql`UPDATE ai_invocations SET output = '{}'::jsonb`)),
      /permission denied|append-only/i,
    );
  });
});

describe('the proposal gate', () => {
  let regulatedProposalId: string;
  let ordinaryProposalId: string;

  beforeAll(async () => {
    const invocation = await tenant.as((db) => invokeCapability(db, tenant.context, adviser(), provider, {
      capabilityKey: 'case-summary', caseId, context: CASE_CONTEXT, source: 'console',
    }));

    const ids = await tenant.as((db) => createProposals(db, tenant.context, [
      {
        invocationId: invocation.invocationId, caseId,
        proposalType: 'expenditure-adjustment',
        targetTable: 'financial_statement_lines', targetField: 'amount_pence',
        currentValue: 40_000, proposedValue: 62_000,
        reasoning: 'Bank data shows sustained spending well above the declared figure for this category.',
        confidence: 0.86, touchesRegulatedField: true,
      },
      {
        invocationId: invocation.invocationId, caseId,
        proposalType: 'duplicate-debt', targetTable: 'debts', targetField: 'status',
        currentValue: 'active', proposedValue: 'duplicate',
        reasoning: 'Same account reference and original creditor as another debt on this case.',
        confidence: 0.91, touchesRegulatedField: false,
      },
    ]));
    regulatedProposalId = ids[0]!;
    ordinaryProposalId = ids[1]!;
  });

  it('changes nothing on its own', async () => {
    const proposals = await tenant.as((db) => pendingProposals(db, caseId));
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.status === 'pending')).toBe(true);
    // Regulated proposals surface first: they need the most careful attention.
    expect(proposals[0]!.touchesRegulatedField).toBe(true);
  });

  it('refuses an AI principal any decision on a regulated proposal', async () => {
    await expect(
      tenant.as((db) => decideProposal(db, tenant.context,
        aiPrincipal(tenant.id, 'ie-discrepancy', 'inv-1'),
        { proposalId: regulatedProposalId, decision: 'accepted' })),
    ).rejects.toThrow(/can only be exercised by an authenticated person/);
  });

  it('refuses a workflow a decision on a regulated proposal, however configured', async () => {
    await expect(
      tenant.as((db) => decideProposal(db, tenant.context,
        workflowPrincipal(tenant.id, 'run-1', PERMISSIONS.map((p) => p.key)),
        { proposalId: regulatedProposalId, decision: 'accepted' })),
    ).rejects.toThrow(/can only be exercised by an authenticated person/);
  });

  it('refuses an API key holding every scope', async () => {
    await expect(
      tenant.as((db) => decideProposal(db, tenant.context,
        { kind: 'api_key', tenantId: tenant.id, keyId: 'k', scopes: new Set(PERMISSIONS.map((p) => p.key)) },
        { proposalId: regulatedProposalId, decision: 'accepted' })),
    ).rejects.toThrow(/can only be exercised by an authenticated person/);
  });

  it('requires a second factor even from a permitted adviser', async () => {
    await expect(
      tenant.as((db) => decideProposal(db, tenant.context, adviser({ mfaSatisfied: false }),
        { proposalId: regulatedProposalId, decision: 'accepted' })),
    ).rejects.toThrow(/second factor/);
  });

  it('leaves the proposal pending after every refusal', async () => {
    const proposals = await tenant.as((db) => pendingProposals(db, caseId));
    expect(proposals.find((p) => p.id === regulatedProposalId)?.status).toBe('pending');
  });

  it('lets a workflow decide a proposal that touches nothing regulated', async () => {
    const decided = await tenant.as((db) => decideProposal(db, tenant.context,
      workflowPrincipal(tenant.id, 'run-1', ['ai:invoke']),
      { proposalId: ordinaryProposalId, decision: 'accepted' }));
    expect(decided.valueToApply).toBe('duplicate');
    expect(decided.touchesRegulatedField).toBe(false);
  });

  it('accepts a regulated proposal from a person, and records it as regulated', async () => {
    const decided = await tenant.as((db) => decideProposal(db, tenant.context, adviser(), {
      proposalId: regulatedProposalId, decision: 'modified', appliedValue: 55_000,
      note: 'Client confirmed some of the spending was a one-off school uniform cost.',
    }));

    expect(decided.decision).toBe('modified');
    // The value applied is the adviser's, not the model's.
    expect(decided.valueToApply).toBe(55_000);

    const event = await tenant.as(async (db) => {
      const r = await db.execute<Record<string, unknown>>(sql`
        SELECT action, severity, actor_user_id, before_state, after_state
          FROM audit_events WHERE action = 'ai.proposal.modified' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(event['severity']).toBe('regulated');
    expect(event['actor_user_id']).toBe(tenant.userId);
    expect((event['before_state'] as Record<string, unknown>)['value']).toBe(40_000);
    expect((event['after_state'] as Record<string, unknown>)['value']).toBe(55_000);
  });

  it('refuses a second decision on a decided proposal', async () => {
    await expect(
      tenant.as((db) => decideProposal(db, tenant.context, adviser(),
        { proposalId: regulatedProposalId, decision: 'accepted' })),
    ).rejects.toThrow(/already modified/);
  });

  it('requires a note when rejecting, so patterns can be reviewed', async () => {
    const invocation = await tenant.as((db) => invokeCapability(db, tenant.context, adviser(), provider, {
      capabilityKey: 'case-summary', caseId, context: CASE_CONTEXT, source: 'console' }));
    const [id] = await tenant.as((db) => createProposals(db, tenant.context, [{
      invocationId: invocation.invocationId, caseId, proposalType: 'test',
      targetTable: 'debts', proposedValue: 'x',
      reasoning: 'A reason long enough to be meaningful.', touchesRegulatedField: false,
    }]));

    await expect(
      tenant.as((db) => decideProposal(db, tenant.context, adviser(),
        { proposalId: id!, decision: 'rejected' })),
    ).rejects.toThrow(ProposalError);

    const decided = await tenant.as((db) => decideProposal(db, tenant.context, adviser(),
      { proposalId: id!, decision: 'rejected', note: 'Creditors are genuinely distinct entities.' }));
    expect(decided.valueToApply).toBeNull();
  });

  it('will not let a proposal be rewritten or deleted', async () => {
    await expectDbError(
      tenant.as((db) => db.execute(sql`
        UPDATE ai_proposals SET reasoning = 'something else' WHERE id = ${regulatedProposalId}`)),
      /substance of an AI proposal is immutable/,
    );
    await expectDbError(
      tenant.as((db) => db.execute(sql`DELETE FROM ai_proposals WHERE id = ${regulatedProposalId}`)),
      /cannot be deleted/,
    );
  });
});

describe('every capability that touches regulated data is gated', () => {
  it('marks its proposals as regulated by definition', () => {
    for (const c of CAPABILITIES.filter((x) => x.producesProposals && x.touchesRegulatedFields)) {
      expect(capability(c.key)!.touchesRegulatedFields).toBe(true);
    }
  });
});
