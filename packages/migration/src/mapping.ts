import { z } from 'zod';

/**
 * Field mapping.
 *
 * A migration is mostly an argument about what a field in the old system
 * means. Expressing the mapping as data - rather than as a script someone wrote
 * once - means a firm can review it before the run, the run can store the
 * version it used, and a reconciliation two years later can still be
 * interpreted.
 */

export const transformSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('copy') }),
  z.object({ type: z.literal('trim') }),
  z.object({ type: z.literal('uppercase') }),
  z.object({ type: z.literal('lowercase') }),
  /** Pounds as a decimal string or number, to integer pence. */
  z.object({ type: z.literal('pounds-to-pence') }),
  /** Pence already; validates it is a whole number. */
  z.object({ type: z.literal('pence') }),
  z.object({ type: z.literal('date'), format: z.enum(['iso', 'uk', 'us']).default('iso') }),
  z.object({ type: z.literal('boolean'),
             trueValues: z.array(z.string()).default(['1', 'true', 'y', 'yes']) }),
  z.object({ type: z.literal('lookup'), table: z.record(z.string(), z.string()),
             fallback: z.string().nullable().default(null) }),
  z.object({ type: z.literal('constant'), value: z.unknown() }),
  /** Concatenates several source fields, e.g. address lines. */
  z.object({ type: z.literal('join'), fields: z.array(z.string()), separator: z.string().default(', ') }),
]);
export type Transform = z.infer<typeof transformSchema>;

export const fieldMappingSchema = z.object({
  target: z.string().min(1),
  source: z.string().nullable(),
  transform: transformSchema.default({ type: 'copy' }),
  required: z.boolean().default(false),
  /** Shown in the mapping review so a firm knows what a decision means. */
  note: z.string().default(''),
});
export type FieldMapping = z.infer<typeof fieldMappingSchema>;

export const entityMappingSchema = z.object({
  entity: z.enum([
    'client', 'case', 'creditor', 'debt', 'financial-statement', 'document',
    'note', 'communication', 'consent', 'vulnerability', 'advice-decision',
    'user', 'task', 'custom-field',
  ]),
  targetTable: z.string(),
  /** Identifies the source record, so a re-run updates rather than duplicates. */
  sourceIdField: z.string(),
  fields: z.array(fieldMappingSchema),
  /** Source records failing this are skipped with a reason, not dropped. */
  filter: z.record(z.string(), z.unknown()).optional(),
});
export type EntityMapping = z.infer<typeof entityMappingSchema>;

export const migrationPlanSchema = z.object({
  sourceSystem: z.string().min(1),
  sourceVersion: z.string().optional(),
  entities: z.array(entityMappingSchema).min(1),
});
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;

export class MappingError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Migration plan is not valid:\n  - ${issues.join('\n  - ')}`);
    this.name = 'MappingError';
  }
}

export function parseMigrationPlan(input: unknown): MigrationPlan {
  const parsed = migrationPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new MappingError(parsed.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }

  const plan = parsed.data;
  const issues: string[] = [];

  for (const entity of plan.entities) {
    const targets = new Set<string>();
    for (const field of entity.fields) {
      if (targets.has(field.target)) {
        issues.push(`${entity.entity}: two mappings write to "${field.target}"`);
      }
      targets.add(field.target);
      if (field.source === null && field.transform.type !== 'constant') {
        issues.push(
          `${entity.entity}.${field.target}: has no source and no constant, so it would ` +
          `always be empty`);
      }
      if (field.required && field.source === null && field.transform.type !== 'constant') {
        issues.push(`${entity.entity}.${field.target}: required but unmapped`);
      }
    }
  }

  // Cases reference clients, debts reference cases. Migrating them out of order
  // produces orphans, so the order is checked rather than assumed.
  const order = plan.entities.map((e) => e.entity);
  const dependencies: Partial<Record<EntityMapping['entity'], EntityMapping['entity'][]>> = {
    case: ['client'],
    debt: ['case'],
    'financial-statement': ['case'],
    'advice-decision': ['case'],
    document: ['case'],
    communication: ['case'],
    consent: ['client'],
    vulnerability: ['client'],
    task: ['case'],
  };
  for (const [entity, needs] of Object.entries(dependencies)) {
    const position = order.indexOf(entity as EntityMapping['entity']);
    if (position === -1) continue;
    for (const need of needs ?? []) {
      const needPosition = order.indexOf(need);
      if (needPosition === -1) {
        issues.push(`${entity} depends on ${need}, which is not in the plan`);
      } else if (needPosition > position) {
        issues.push(`${entity} is migrated before ${need}, which would orphan it`);
      }
    }
  }

  if (issues.length) throw new MappingError(issues);
  return plan;
}

export class TransformError extends Error {
  constructor(message: string) { super(message); this.name = 'TransformError'; }
}

export function applyTransform(
  transform: Transform,
  value: unknown,
  record: Record<string, unknown>,
): unknown {
  switch (transform.type) {
    case 'constant': return transform.value;
    case 'copy': return value ?? null;
    case 'trim': return typeof value === 'string' ? value.trim() : (value ?? null);
    case 'uppercase': return typeof value === 'string' ? value.toUpperCase() : (value ?? null);
    case 'lowercase': return typeof value === 'string' ? value.toLowerCase() : (value ?? null);

    case 'pounds-to-pence': {
      if (value === null || value === undefined || value === '') return null;
      const cleaned = String(value).replace(/[£,\s]/g, '');
      if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
        throw new TransformError(`Cannot read "${value}" as an amount in pounds`);
      }
      // Round rather than truncate: a legacy system storing 12.345 means
      // 12.35, and silently losing the half penny across ten thousand rows is
      // how a reconciliation ends up out by a few hundred pounds.
      const pounds = Number(cleaned);
      return pounds < 0 ? -Math.round(-pounds * 100) : Math.round(pounds * 100);
    }

    case 'pence': {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      if (!Number.isInteger(n)) {
        throw new TransformError(`"${value}" is not a whole number of pence`);
      }
      return n;
    }

    case 'date': {
      if (!value) return null;
      const raw = String(value).trim();
      if (transform.format === 'uk') {
        const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
        if (!match) throw new TransformError(`"${raw}" is not a UK date`);
        return `${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`;
      }
      if (transform.format === 'us') {
        const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
        if (!match) throw new TransformError(`"${raw}" is not a US date`);
        return `${match[3]}-${match[1]!.padStart(2, '0')}-${match[2]!.padStart(2, '0')}`;
      }
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) throw new TransformError(`"${raw}" is not a date`);
      return parsed.toISOString().slice(0, 10);
    }

    case 'boolean': {
      if (value === null || value === undefined || value === '') return null;
      return transform.trueValues.includes(String(value).toLowerCase());
    }

    case 'lookup': {
      if (value === null || value === undefined) return transform.fallback;
      const mapped = transform.table[String(value)];
      if (mapped === undefined) {
        if (transform.fallback === null) {
          throw new TransformError(
            `"${value}" is not in the lookup table and there is no fallback`);
        }
        return transform.fallback;
      }
      return mapped;
    }

    case 'join': {
      const parts = transform.fields
        .map((f) => record[f])
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== '')
        .map((v) => String(v).trim());
      return parts.length ? parts.join(transform.separator) : null;
    }
  }
}
