import { sql, type Database, type TenantContext } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { requirePermission, type Principal } from '@solvenda/auth';
import {
  applyTransform, TransformError, type EntityMapping, type MigrationPlan,
} from './mapping.js';

/**
 * The migration runner.
 *
 * Three properties matter more than throughput.
 *
 * A dry run writes nothing but produces the same report as a live run, so a
 * firm can iterate on the mapping until the report is clean before anything
 * touches their data.
 *
 * Every source record produces a row, including the ones that were skipped and
 * the ones that failed. A migration that quietly drops 300 notes looks
 * identical to one that migrated everything, unless the skipped records are
 * counted.
 *
 * Unmapped source fields are reported, not ignored. Data loss in a migration is
 * almost never a crash; it is a column nobody mapped.
 */

export interface SourceRecord {
  [field: string]: unknown;
}

export interface EntityOutcome {
  entity: string;
  read: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  unmappedFields: string[];
  warnings: string[];
}

export interface MigrationReport {
  runId: string;
  mode: 'dry-run' | 'live';
  sourceSystem: string;
  entities: EntityOutcome[];
  totals: { read: number; written: number; skipped: number; failed: number };
  /** True when nothing failed and nothing was silently dropped. */
  clean: boolean;
  unmappedFieldsBySource: Record<string, string[]>;
  startedAt: string;
  completedAt: string;
}

export interface RunInput {
  plan: MigrationPlan;
  /** Source records by entity, in the plan's order. */
  source: Record<string, SourceRecord[]>;
  mode?: 'dry-run' | 'live';
}

export async function runMigration(
  db: Database,
  ctx: TenantContext,
  principal: Principal,
  input: RunInput,
): Promise<MigrationReport> {
  // Migrating a firm's history is a write across almost every table, so it
  // needs the broadest configuration permission rather than case:write.
  requirePermission(principal, 'tenant:configure', { tenantId: ctx.tenantId });

  const mode = input.mode ?? 'dry-run';
  const startedAt = new Date().toISOString();

  const runRes = await db.execute<{ id: string }>(sql`
    INSERT INTO migration_runs (source_system, source_version, mode, mapping, started_by)
    VALUES (${input.plan.sourceSystem}, ${input.plan.sourceVersion ?? null}, ${mode},
            ${JSON.stringify(input.plan)}::jsonb,
            ${principal.kind === 'user' ? principal.userId : null})
    RETURNING id`);
  const runId = runRes.rows[0]!.id;

  const entities: EntityOutcome[] = [];
  const unmappedFieldsBySource: Record<string, string[]> = {};
  // Source id to target id, so a case can find the client it belongs to.
  const identityMap = new Map<string, Map<string, string>>();

  try {
    for (const mapping of input.plan.entities) {
      const records = input.source[mapping.entity] ?? [];
      const outcome = await migrateEntity(
        db, runId, mapping, records, mode, identityMap);
      entities.push(outcome);
      if (outcome.unmappedFields.length) {
        unmappedFieldsBySource[mapping.entity] = outcome.unmappedFields;
      }
    }

    await db.execute(sql`
      UPDATE migration_runs SET status = 'completed', completed_at = now()
       WHERE id = ${runId}`);
  } catch (error) {
    await db.execute(sql`
      UPDATE migration_runs SET status = 'failed', completed_at = now(),
             error_detail = ${(error as Error).message}
       WHERE id = ${runId}`);
    throw error;
  }

  const totals = entities.reduce(
    (acc, e) => ({
      read: acc.read + e.read,
      written: acc.written + e.created + e.updated,
      skipped: acc.skipped + e.skipped,
      failed: acc.failed + e.failed,
    }),
    { read: 0, written: 0, skipped: 0, failed: 0 },
  );

  const report: MigrationReport = {
    runId, mode,
    sourceSystem: input.plan.sourceSystem,
    entities,
    totals,
    clean: totals.failed === 0 && Object.keys(unmappedFieldsBySource).length === 0,
    unmappedFieldsBySource,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  await recordAudit(db, ctx, {
    action: mode === 'live' ? 'data.exported' : 'compliance.check.run',
    resourceType: 'migration_run',
    resourceId: runId,
    source: `migration:${input.plan.sourceSystem}`,
    severity: mode === 'live' ? 'security' : 'info',
    reason: mode === 'live'
      ? `Migrated ${totals.written} records from ${input.plan.sourceSystem}`
      : `Dry run against ${input.plan.sourceSystem}`,
    after: { mode, totals, clean: report.clean, unmapped: unmappedFieldsBySource },
  });

  return report;
}

async function migrateEntity(
  db: Database,
  runId: string,
  mapping: EntityMapping,
  records: readonly SourceRecord[],
  mode: 'dry-run' | 'live',
  identityMap: Map<string, Map<string, string>>,
): Promise<EntityOutcome> {
  const mappedSources = new Set(
    mapping.fields.map((f) => f.source).filter((s): s is string => s !== null),
  );
  for (const field of mapping.fields) {
    if (field.transform.type === 'join') {
      for (const source of field.transform.fields) mappedSources.add(source);
    }
  }
  mappedSources.add(mapping.sourceIdField);

  const unmapped = new Set<string>();
  const warnings: string[] = [];
  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (const record of records) {
    const sourceId = String(record[mapping.sourceIdField] ?? '');
    if (!sourceId) {
      failed++;
      await recordOutcome(db, runId, mapping.entity, `(missing ${mapping.sourceIdField})`,
        record, null, null, 'failed',
        `Source record has no ${mapping.sourceIdField}`, [], []);
      continue;
    }

    // Anything the source carried that no mapping consumes. Reported per run
    // rather than per record, but collected here.
    for (const key of Object.keys(record)) {
      if (!mappedSources.has(key)) unmapped.add(key);
    }

    if (mapping.filter && !matchesFilter(record, mapping.filter)) {
      skipped++;
      await recordOutcome(db, runId, mapping.entity, sourceId, record, null, null,
        'skipped', 'Excluded by the plan filter', [], []);
      continue;
    }

    let target: Record<string, unknown>;
    try {
      target = buildTarget(mapping, record, identityMap);
    } catch (error) {
      failed++;
      await recordOutcome(db, runId, mapping.entity, sourceId, record, mapping.targetTable,
        null, 'failed', (error as Error).message, [...unmapped], []);
      continue;
    }

    if (mode === 'dry-run') {
      // A dry run produces the same report without writing anything, so a firm
      // can iterate on the mapping until the report is clean.
      created++;
      await recordOutcome(db, runId, mapping.entity, sourceId, record, mapping.targetTable,
        null, 'created', 'Dry run: not written', [...unmapped], []);
      continue;
    }

    try {
      const targetId = await writeRecord(db, mapping, target);
      let map = identityMap.get(mapping.entity);
      if (!map) { map = new Map(); identityMap.set(mapping.entity, map); }
      map.set(sourceId, targetId);
      created++;
      await recordOutcome(db, runId, mapping.entity, sourceId, record, mapping.targetTable,
        targetId, 'created', null, [...unmapped], []);
    } catch (error) {
      failed++;
      await recordOutcome(db, runId, mapping.entity, sourceId, record, mapping.targetTable,
        null, 'failed', (error as Error).message, [...unmapped], []);
    }
  }

  if (unmapped.size > 0) {
    warnings.push(
      `${unmapped.size} source field${unmapped.size === 1 ? '' : 's'} were not mapped and ` +
      `carry no data into the platform: ${[...unmapped].join(', ')}`);
  }

  return {
    entity: mapping.entity,
    read: records.length,
    created, updated, skipped, failed,
    unmappedFields: [...unmapped].sort(),
    warnings,
  };
}

function buildTarget(
  mapping: EntityMapping,
  record: SourceRecord,
  identityMap: Map<string, Map<string, string>>,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};

  for (const field of mapping.fields) {
    const raw = field.source === null ? null : record[field.source];
    let value: unknown;
    try {
      value = applyTransform(field.transform, raw, record);
    } catch (error) {
      throw new TransformError(`${field.target}: ${(error as Error).message}`);
    }

    // A reference to another migrated entity is resolved through the identity
    // map, so relationships survive the change of identifier scheme.
    if (field.target.endsWith('_id') && typeof value === 'string' && value) {
      const entity = field.target.replace(/_id$/, '');
      const resolved = identityMap.get(entity)?.get(value);
      if (resolved) value = resolved;
    }

    if (field.required && (value === null || value === undefined || value === '')) {
      throw new TransformError(`${field.target} is required but the source value is empty`);
    }
    target[field.target] = value;
  }

  return target;
}

async function writeRecord(
  db: Database,
  mapping: EntityMapping,
  target: Record<string, unknown>,
): Promise<string> {
  const columns = Object.keys(target).filter((k) => target[k] !== undefined);
  if (columns.length === 0) throw new Error('Nothing to write');

  const columnList = sql.join(columns.map((c) => sql.identifier(c)), sql`, `);
  const valueList = sql.join(columns.map((c) => sql`${target[c]}`), sql`, `);

  const res = await db.execute<{ id: string }>(sql`
    INSERT INTO ${sql.identifier(mapping.targetTable)} (${columnList})
    VALUES (${valueList}) RETURNING id`);
  return res.rows[0]!.id;
}

async function recordOutcome(
  db: Database, runId: string, entity: string, sourceId: string,
  payload: SourceRecord, targetTable: string | null, targetId: string | null,
  outcome: string, reason: string | null, unmapped: string[], warnings: string[],
): Promise<void> {
  await db.execute(sql`
    INSERT INTO migration_records (run_id, entity, source_id, source_payload, target_table,
                                   target_id, outcome, reason, unmapped_fields, warnings)
    VALUES (${runId}, ${entity}, ${sourceId}, ${JSON.stringify(payload)}::jsonb,
            ${targetTable}, ${targetId}, ${outcome}, ${reason},
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(unmapped)}::jsonb)),
            ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(warnings)}::jsonb)))
    ON CONFLICT (run_id, entity, source_id) DO NOTHING`);
}

function matchesFilter(record: SourceRecord, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    const actual = record[key];
    if (Array.isArray(expected)) return expected.includes(actual as never);
    return actual === expected;
  });
}

/**
 * Reconciliation.
 *
 * The question a firm actually asks after a migration is "did everything come
 * across", and the only honest answer counts what did not.
 */
export interface Reconciliation {
  runId: string;
  entities: {
    entity: string;
    sourceCount: number;
    migrated: number;
    skipped: number;
    failed: number;
    accountedFor: boolean;
  }[];
  unaccountedRecords: { entity: string; sourceId: string; reason: string | null }[];
  balanced: boolean;
}

export async function reconcile(
  db: Database,
  runId: string,
  sourceCounts: Record<string, number>,
): Promise<Reconciliation> {
  const res = await db.execute<{ entity: string; outcome: string; n: string }>(sql`
    SELECT entity, outcome, count(*)::text AS n FROM migration_records
     WHERE run_id = ${runId} GROUP BY entity, outcome`);

  const byEntity = new Map<string, Record<string, number>>();
  for (const row of res.rows) {
    const entry = byEntity.get(row.entity) ?? {};
    entry[row.outcome] = Number(row.n);
    byEntity.set(row.entity, entry);
  }

  const entities = [...byEntity].map(([entity, counts]) => {
    const migrated = (counts['created'] ?? 0) + (counts['updated'] ?? 0);
    const skipped = counts['skipped'] ?? 0;
    const failed = counts['failed'] ?? 0;
    const sourceCount = sourceCounts[entity] ?? migrated + skipped + failed;
    return {
      entity, sourceCount, migrated, skipped, failed,
      accountedFor: migrated + skipped + failed === sourceCount,
    };
  });

  const problems = await db.execute<{ entity: string; source_id: string; reason: string | null }>(sql`
    SELECT entity, source_id, reason FROM migration_records
     WHERE run_id = ${runId} AND outcome IN ('failed', 'deferred')
     ORDER BY entity, source_id LIMIT 500`);

  return {
    runId,
    entities,
    unaccountedRecords: problems.rows.map((r) => ({
      entity: r.entity, sourceId: r.source_id, reason: r.reason,
    })),
    balanced: entities.every((e) => e.accountedFor) && problems.rows.length === 0,
  };
}
