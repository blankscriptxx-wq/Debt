import { sql } from 'drizzle-orm';
import { bigint, index, inet, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenantId } from './_shared.js';

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type').notNull(),
    actorLabel: text('actor_label').notNull(),

    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    caseId: uuid('case_id'),

    reason: text('reason'),
    source: text('source').notNull(),

    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    changedFields: text('changed_fields').array(),

    requestId: text('request_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    aiInvocationId: uuid('ai_invocation_id'),
    severity: text('severity').notNull().default('info'),

    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [
    uniqueIndex('audit_events_tenant_id_seq_key').on(t.tenantId, t.seq),
    index('audit_events_case').on(t.tenantId, t.caseId, t.occurredAt),
    index('audit_events_resource').on(t.tenantId, t.resourceType, t.resourceId, t.occurredAt),
  ],
);

export const auditChainSql = sql;
