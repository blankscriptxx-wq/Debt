import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, sql } from '@solvenda/db';
import { createTestTenant, ensureTestOperator, type TestTenant } from '@solvenda/testing';
import { seedGlobalCatalogues, type Principal } from '@solvenda/auth';
import {
  applyTransform, parseMigrationPlan, MappingError, TransformError,
  runMigration, reconcile, MIGRATION_PROFILES, profile,
} from '@solvenda/migration';

let tenant: TestTenant;

function admin(): Principal {
  return {
    kind: 'user', tenantId: tenant.id, userId: tenant.userId,
    permissions: new Set(['tenant:configure']),
    competencies: [], mfaSatisfied: true, status: 'active',
  };
}

beforeAll(async () => {
  await seedGlobalCatalogues(await ensureTestOperator());
  tenant = await createTestTenant('migration');
});
afterAll(async () => { await closeDatabase(); });

describe('transforms', () => {
  it('converts pounds to integer pence, rounding rather than truncating', () => {
    const t = { type: 'pounds-to-pence' } as const;
    expect(applyTransform(t, '1234.56', {})).toBe(123_456);
    expect(applyTransform(t, '£1,234.56', {})).toBe(123_456);
    expect(applyTransform(t, 45, {})).toBe(4_500);
    expect(applyTransform(t, '0.5', {})).toBe(50);
    expect(applyTransform(t, '-12.34', {})).toBe(-1_234);
    expect(applyTransform(t, '', {})).toBeNull();
  });

  it('refuses an amount it cannot read exactly', () => {
    expect(() => applyTransform({ type: 'pounds-to-pence' }, 'approx 50', {}))
      .toThrow(TransformError);
  });

  it('reads UK dates, which is what these systems store', () => {
    expect(applyTransform({ type: 'date', format: 'uk' }, '12/03/1985', {}))
      .toBe('1985-03-12');
    expect(applyTransform({ type: 'date', format: 'uk' }, '3/7/1990', {}))
      .toBe('1990-07-03');
    expect(() => applyTransform({ type: 'date', format: 'uk' }, '1985-03-12', {}))
      .toThrow(TransformError);
  });

  it('fails a lookup with no fallback rather than guessing', () => {
    const t = { type: 'lookup', table: { DMP: 'dmp' }, fallback: null } as const;
    expect(applyTransform(t, 'DMP', {})).toBe('dmp');
    // A case migrated as the wrong type gets the wrong rules for its whole life.
    expect(() => applyTransform(t, 'IVA-LITE', {})).toThrow(/not in the lookup table/);
  });

  it('joins address lines, skipping the empty ones', () => {
    const t = { type: 'join', fields: ['a1', 'a2', 'a3'], separator: ', ' } as const;
    expect(applyTransform(t, null, { a1: '9 New Road', a2: '', a3: 'Leeds' }))
      .toBe('9 New Road, Leeds');
    expect(applyTransform(t, null, { a1: '', a2: '', a3: '' })).toBeNull();
  });

  it('reads the boolean spellings legacy systems actually use', () => {
    const t = { type: 'boolean', trueValues: ['1', 'y', 'true', 'yes'] } as const;
    expect(applyTransform(t, 'Y', {})).toBe(true);
    expect(applyTransform(t, '1', {})).toBe(true);
    expect(applyTransform(t, 'N', {})).toBe(false);
    expect(applyTransform(t, '', {})).toBeNull();
  });
});

describe('plan validation', () => {
  it('accepts the shipped profiles', () => {
    for (const p of MIGRATION_PROFILES) {
      expect(() => parseMigrationPlan(p.plan)).not.toThrow();
    }
  });

  it('states its own limitations rather than implying a certified connector', () => {
    const generic = profile('generic-csv')!;
    expect(generic.caveats.length).toBeGreaterThan(0);
    expect(generic.caveats.join(' ')).toMatch(/Column names almost certainly differ/);
    expect(generic.caveats.join(' ')).toMatch(/[Cc]onsent/);
  });

  it('refuses a plan that would orphan records', () => {
    // Debts before cases means every debt points at a case that does not exist.
    expect(() => parseMigrationPlan({
      sourceSystem: 'x',
      entities: [
        { entity: 'debt', targetTable: 'debts', sourceIdField: 'id',
          fields: [{ target: 'creditor_name', source: 'c', transform: { type: 'copy' } }] },
        { entity: 'case', targetTable: 'cases', sourceIdField: 'id',
          fields: [{ target: 'reference', source: 'r', transform: { type: 'copy' } }] },
        { entity: 'client', targetTable: 'clients', sourceIdField: 'id',
          fields: [{ target: 'reference', source: 'r', transform: { type: 'copy' } }] },
      ],
    })).toThrow(/before client|would orphan/);
  });

  it('refuses two mappings writing to the same column', () => {
    expect(() => parseMigrationPlan({
      sourceSystem: 'x',
      entities: [{ entity: 'client', targetTable: 'clients', sourceIdField: 'id',
        fields: [
          { target: 'first_name', source: 'a', transform: { type: 'copy' } },
          { target: 'first_name', source: 'b', transform: { type: 'copy' } },
        ]}],
    })).toThrow(/two mappings write to/);
  });

  it('refuses a field with no source and no constant', () => {
    expect(() => parseMigrationPlan({
      sourceSystem: 'x',
      entities: [{ entity: 'client', targetTable: 'clients', sourceIdField: 'id',
        fields: [{ target: 'first_name', source: null, transform: { type: 'copy' } }] }],
    })).toThrow(MappingError);
  });
});

describe('running a migration', () => {
  const plan = parseMigrationPlan({
    sourceSystem: 'legacy-test',
    entities: [
      { entity: 'client', targetTable: 'clients', sourceIdField: 'client_ref',
        fields: [
          { target: 'reference', source: 'client_ref', required: true, transform: { type: 'trim' } },
          { target: 'first_name', source: 'forename', required: true, transform: { type: 'trim' } },
          { target: 'last_name', source: 'surname', required: true, transform: { type: 'trim' } },
          { target: 'date_of_birth', source: 'dob', transform: { type: 'date', format: 'uk' } },
        ]},
      { entity: 'case', targetTable: 'cases', sourceIdField: 'case_ref',
        fields: [
          { target: 'reference', source: 'case_ref', required: true, transform: { type: 'trim' } },
          { target: 'client_id', source: 'client_ref', required: true, transform: { type: 'trim' } },
          { target: 'case_type_key', source: 'product', required: true,
            transform: { type: 'lookup', table: { DMP: 'dmp', IVA: 'iva' }, fallback: null } },
          { target: 'case_type_version', source: null, required: true,
            transform: { type: 'constant', value: 1 } },
          { target: 'stage', source: null, required: true,
            transform: { type: 'constant', value: 'live' } },
        ]},
    ],
  });

  const source = {
    client: [
      { client_ref: 'C-1', forename: 'Joanne', surname: 'Whitfield', dob: '12/03/1985',
        // A column nobody mapped: this is how history quietly gets lost.
        legacy_notes_count: 42, old_adviser_code: 'RE' },
      { client_ref: 'C-2', forename: 'Marcus', surname: 'Adeyemi', dob: '02/11/1979' },
      { client_ref: 'C-3', forename: 'Bad', surname: 'Date', dob: 'not a date' },
    ],
    case: [
      { case_ref: 'DMP-1', client_ref: 'C-1', product: 'DMP' },
      { case_ref: 'IVA-1', client_ref: 'C-2', product: 'IVA' },
      { case_ref: 'X-1', client_ref: 'C-2', product: 'UNKNOWN-PRODUCT' },
    ],
  };

  it('writes nothing on a dry run, but reports everything', async () => {
    const before = await tenant.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM clients`);
      return Number(r.rows[0]!.n);
    });

    const report = await tenant.as((db) =>
      runMigration(db, tenant.context, admin(), { plan, source, mode: 'dry-run' }));

    const after = await tenant.as(async (db) => {
      const r = await db.execute<{ n: string }>(sql`SELECT count(*)::text AS n FROM clients`);
      return Number(r.rows[0]!.n);
    });

    expect(after).toBe(before);
    expect(report.mode).toBe('dry-run');
    expect(report.totals.read).toBe(6);
    // The bad date and the unknown product both fail, in the dry run, before
    // anything touches the firm's data.
    expect(report.totals.failed).toBe(2);
    expect(report.clean).toBe(false);
  });

  it('names the source fields nobody mapped', async () => {
    const report = await tenant.as((db) =>
      runMigration(db, tenant.context, admin(), { plan, source, mode: 'dry-run' }));

    expect(report.unmappedFieldsBySource['client']).toEqual(
      expect.arrayContaining(['legacy_notes_count', 'old_adviser_code']));
    const clientOutcome = report.entities.find((e) => e.entity === 'client')!;
    expect(clientOutcome.warnings[0]).toMatch(/were not mapped and carry no data/);
  });

  it('explains each failure rather than reporting a count', async () => {
    const report = await tenant.as((db) =>
      runMigration(db, tenant.context, admin(), { plan, source, mode: 'dry-run' }));

    const failures = await tenant.as(async (db) => {
      const r = await db.execute<{ entity: string; source_id: string; reason: string }>(sql`
        SELECT entity, source_id, reason FROM migration_records
         WHERE run_id = ${report.runId} AND outcome = 'failed' ORDER BY entity`);
      return r.rows;
    });

    expect(failures).toHaveLength(2);
    expect(failures.find((f) => f.source_id === 'X-1')!.reason)
      .toMatch(/not in the lookup table/);
    expect(failures.find((f) => f.source_id === 'C-3')!.reason)
      .toMatch(/is not a UK date/);
  });

  it('migrates for real and resolves relationships across entities', async () => {
    const clean = {
      client: source.client.slice(0, 2),
      case: source.case.slice(0, 2),
    };

    const report = await tenant.as((db) =>
      runMigration(db, tenant.context, admin(), { plan, source: clean, mode: 'live' }));

    expect(report.totals.failed).toBe(0);
    expect(report.totals.written).toBe(4);

    const linked = await tenant.as(async (db) => {
      const r = await db.execute<{ case_ref: string; client_ref: string }>(sql`
        SELECT k.reference AS case_ref, c.reference AS client_ref
          FROM cases k JOIN clients c ON c.id = k.client_id
         WHERE k.reference IN ('DMP-1','IVA-1') ORDER BY k.reference`);
      return r.rows;
    });

    // The legacy client reference became a platform uuid, and the case still
    // points at the right person.
    expect(linked).toEqual([
      { case_ref: 'DMP-1', client_ref: 'C-1' },
      { case_ref: 'IVA-1', client_ref: 'C-2' },
    ]);
  });

  it('records the migration as a security event when it is live', async () => {
    const event = await tenant.as(async (db) => {
      const r = await db.execute<{ severity: string; reason: string }>(sql`
        SELECT severity, reason FROM audit_events
         WHERE resource_type = 'migration_run' ORDER BY seq DESC LIMIT 1`);
      return r.rows[0]!;
    });
    expect(event.severity).toBe('security');
    expect(event.reason).toMatch(/Migrated \d+ records/);
  });

  it('refuses to run without the configuration permission', async () => {
    await expect(
      tenant.as((db) => runMigration(db, tenant.context,
        { ...admin(), permissions: new Set(['case:write']) },
        { plan, source, mode: 'dry-run' })),
    ).rejects.toThrow(/tenant:configure/);
  });
});

describe('reconciliation', () => {
  it('answers "did everything come across" by counting what did not', async () => {
    const plan = parseMigrationPlan({
      sourceSystem: 'recon-test',
      entities: [{ entity: 'client', targetTable: 'clients', sourceIdField: 'ref',
        fields: [
          { target: 'reference', source: 'ref', required: true, transform: { type: 'trim' } },
          { target: 'first_name', source: 'fn', required: true, transform: { type: 'trim' } },
          { target: 'last_name', source: 'sn', required: true, transform: { type: 'trim' } },
          { target: 'date_of_birth', source: 'dob', transform: { type: 'date', format: 'uk' } },
        ],
        filter: { include: true } }],
    });

    const report = await tenant.as((db) => runMigration(db, tenant.context, admin(), {
      plan,
      source: { client: [
        { ref: 'R-1', fn: 'A', sn: 'B', dob: '01/01/1980', include: true },
        { ref: 'R-2', fn: 'C', sn: 'D', dob: '01/01/1980', include: false },
        { ref: 'R-3', fn: 'E', sn: 'F', dob: 'rubbish', include: true },
      ]},
      mode: 'dry-run',
    }));

    const result = await tenant.as((db) => reconcile(db, report.runId, { client: 3 }));

    const clients = result.entities.find((e) => e.entity === 'client')!;
    expect(clients.sourceCount).toBe(3);
    expect(clients.migrated).toBe(1);
    expect(clients.skipped).toBe(1);   // excluded by the filter, recorded not dropped
    expect(clients.failed).toBe(1);
    expect(clients.accountedFor).toBe(true);
    // Every source row is accounted for, but one failed, so it does not balance.
    expect(result.balanced).toBe(false);
    expect(result.unaccountedRecords).toHaveLength(1);
    expect(result.unaccountedRecords[0]!.sourceId).toBe('R-3');
  });

  it('reports a source count that does not match as unaccounted', async () => {
    const plan = parseMigrationPlan({
      sourceSystem: 'count-test',
      entities: [{ entity: 'client', targetTable: 'clients', sourceIdField: 'ref',
        fields: [
          { target: 'reference', source: 'ref', required: true, transform: { type: 'trim' } },
          { target: 'first_name', source: 'fn', required: true, transform: { type: 'trim' } },
          { target: 'last_name', source: 'sn', required: true, transform: { type: 'trim' } },
        ]}],
    });
    const report = await tenant.as((db) => runMigration(db, tenant.context, admin(), {
      plan, source: { client: [{ ref: 'Z-1', fn: 'A', sn: 'B' }] }, mode: 'dry-run',
    }));

    // The firm says the export had 10 clients; only 1 arrived.
    const result = await tenant.as((db) => reconcile(db, report.runId, { client: 10 }));
    expect(result.entities[0]!.accountedFor).toBe(false);
    expect(result.balanced).toBe(false);
  });
});
