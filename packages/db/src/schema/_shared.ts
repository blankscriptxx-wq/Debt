import { sql } from 'drizzle-orm';
import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Every tenant-scoped table uses this column definition. The database default
 * means application code never has to supply the tenant id, and the RLS
 * WITH CHECK clause means it cannot successfully supply the wrong one.
 */
export const tenantId = () =>
  uuid('tenant_id')
    .notNull()
    .default(sql`app.current_tenant_id()`);

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
