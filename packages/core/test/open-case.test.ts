import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import {
  seedGlobalCatalogues, PermissionDeniedError, type Principal,
} from '@solvenda/auth';
import {
  createClient, openCase, referencePrefix, CaseworkError,
  CASE_TYPE_TEMPLATES, type CaseTypeDefinition,
} from '@solvenda/core';

/**
 * Opening a client and a case.
 *
 * Both used to live inline in the public API routes, with two defects this
 * covers: the reference prefix ignored the format the case type declares, and
 * references were allocated by counting rows, which two advisers doing the same
 * thing at once resolve to the same number.
 */

let tenant: TestTenant;

const dmp = CASE_TYPE_TEMPLATES.find((t) => t.key === 'dmp')! as CaseTypeDefinition;
const breathing = CASE_TYPE_TEMPLATES.find((t) => t.key === 'breathing-space')! as CaseTypeDefinition;
const trustDeed = CASE_TYPE_TEMPLATES.find((t) => t.key === 'trust-deed')! as CaseTypeDefinition;

function adviser(permissions = ['client:write', 'case:write', 'case:read']): Principal {
  return {
    kind: 'user', tenantId: tenant.id, userId: tenant.userId,
    permissions: new Set(permissions), competencies: ['debt-advice'],
    mfaSatisfied: true, status: 'active',
  };
}

const person = (first: string, jurisdiction: NonNullable<Parameters<typeof createClient>[3]['jurisdiction']> = 'england-wales') =>
  tenant.as((db) => createClient(db, tenant.context, adviser(), {
    firstName: first, lastName: 'Okonkwo', jurisdiction,
  }));

beforeAll(async () => {
  await seedGlobalCatalogues(await ensureTestOperator());
  tenant = await createTestTenant('casework');
});

afterAll(async () => { await closeDatabase(); });

describe('reference prefixes', () => {
  it('comes from the case type\'s declared format, not its key', () => {
    // The key is "breathing-space", so the old code produced BREA-0007 while
    // the definition plainly said BSP-{SEQ}.
    expect(breathing.referenceFormat).toBe('BSP-{SEQ}');
    expect(referencePrefix(breathing)).toBe('BSP');
    expect(referencePrefix(dmp)).toBe('DMP');
  });

  it('falls back to the key only when no format is configured', () => {
    expect(referencePrefix({ key: 'bespoke-thing', referenceFormat: '{SEQ}' })).toBe('BESP');
  });
});

describe('opening a client', () => {
  it('allocates a sequential reference and records it', async () => {
    const first = await person('Ade');
    expect(first.reference).toMatch(/^CL-\d{4}$/);

    const second = await person('Bisi');
    expect(Number(second.reference.slice(3))).toBe(Number(first.reference.slice(3)) + 1);
  });

  it('refuses a client with no name rather than storing a blank record', async () => {
    await expect(tenant.as((db) => createClient(db, tenant.context, adviser(), {
      firstName: '  ', lastName: 'Okonkwo',
    }))).rejects.toBeInstanceOf(CaseworkError);
  });

  it('refuses a principal without client:write', async () => {
    await expect(tenant.as((db) => createClient(db, tenant.context, adviser(['case:read']), {
      firstName: 'Ade', lastName: 'Okonkwo',
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('opening a case', () => {
  it('starts it at the case type\'s own first stage', async () => {
    const client = await person('Chidi');
    const opened = await tenant.as((db) => openCase(db, tenant.context, adviser(), {
      clientId: client.id, caseType: dmp, caseTypeVersion: 1,
    }));

    const first = [...dmp.stages].sort((a, b) => a.order - b.order)[0]!.key;
    expect(opened.stage).toBe(first);
    expect(opened.reference).toMatch(/^DMP-\d{4}$/);
  });

  it('uses the prefix the case type asks for', async () => {
    const client = await person('Dami');
    const opened = await tenant.as((db) => openCase(db, tenant.context, adviser(), {
      clientId: client.id, caseType: breathing, caseTypeVersion: 1,
    }));
    expect(opened.reference.startsWith('BSP-')).toBe(true);
  });

  it('takes the jurisdiction from the client and refuses a remedy they cannot use', async () => {
    // A trust deed is a Scottish remedy. Offering it to a client in England is
    // not a slip to correct later, it is advice that could not lawfully be
    // given, so the case is refused rather than opened and flagged.
    const english = await person('Efe', 'england-wales');
    await expect(tenant.as((db) => openCase(db, tenant.context, adviser(), {
      clientId: english.id, caseType: trustDeed, caseTypeVersion: 1,
    }))).rejects.toBeInstanceOf(CaseworkError);

    const scottish = await person('Fiona', 'scotland');
    const opened = await tenant.as((db) => openCase(db, tenant.context, adviser(), {
      clientId: scottish.id, caseType: trustDeed, caseTypeVersion: 1,
    }));
    expect(opened.reference.startsWith('PTD-')).toBe(true);

    const stored = await tenant.as(async (db) => {
      const r = await db.execute<{ jurisdiction: string; owner: string | null }>(sql`
        SELECT jurisdiction, owner_user_id AS owner FROM cases WHERE reference = ${opened.reference}`);
      return r.rows[0]!;
    });
    expect(stored.jurisdiction).toBe('scotland');
    // Whoever opened it owns it until someone reassigns it.
    expect(stored.owner).toBe(tenant.userId);
  });

  it('refuses an unknown client', async () => {
    await expect(tenant.as((db) => openCase(db, tenant.context, adviser(), {
      clientId: '00000000-0000-0000-0000-000000000000', caseType: dmp, caseTypeVersion: 1,
    }))).rejects.toBeInstanceOf(CaseworkError);
  });

  it('refuses a principal without case:write', async () => {
    const client = await person('Gbemi');
    await expect(tenant.as((db) => openCase(db, tenant.context, adviser(['case:read']), {
      clientId: client.id, caseType: dmp, caseTypeVersion: 1,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('gives concurrent cases distinct references', async () => {
    // Counting rows and adding one gave two advisers working at the same moment
    // the same number, and the unique constraint rejected the second.
    const client = await person('Hauwa');
    const opened = await Promise.all([1, 2, 3, 4].map(() =>
      tenant.as((db) => openCase(db, tenant.context, adviser(), {
        clientId: client.id, caseType: dmp, caseTypeVersion: 1,
      }))));

    const refs = opened.map((o) => o.reference);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('audits the opening with the reference and stage', async () => {
    const client = await person('Ify');
    const opened = await tenant.as((db) => openCase(db, tenant.context, adviser(), {
      clientId: client.id, caseType: dmp, caseTypeVersion: 1,
    }));

    const audited = await tenant.as(async (db) => {
      const r = await db.execute<{ action: string; after_state: { reference?: string } }>(sql`
        SELECT action, after_state FROM audit_events
         WHERE resource_id = ${opened.id} AND action = 'case.created'`);
      return r.rows[0]!;
    });
    expect(audited.after_state.reference).toBe(opened.reference);
  });
});
