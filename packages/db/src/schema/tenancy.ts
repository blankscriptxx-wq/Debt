import { sql } from 'drizzle-orm';
import {
  boolean, index, inet, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { citext } from './_types.js';
import { createdAt, tenantId, updatedAt } from './_shared.js';

// --- platform scope ---------------------------------------------------------

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: citext('slug').notNull().unique(),
  legalName: text('legal_name').notNull(),
  tradingName: text('trading_name'),
  status: text('status').notNull().default('trial'),
  dataRegion: text('data_region').notNull().default('eu-west'),
  planKey: text('plan_key'),
  fcaFirmReference: text('fca_firm_reference'),
  regulatedActivities: text('regulated_activities').array().notNull().default(sql`'{}'`),
  jurisdictions: text('jurisdictions').array().notNull().default(sql`ARRAY['england-wales']`),
  settings: jsonb('settings').notNull().default({}),
  branding: jsonb('branding').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const platformOperators = pgTable('platform_operators', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  mfaSecret: text('mfa_secret'),
  mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
  status: text('status').notNull().default('active'),
  operatorRole: text('operator_role').notNull().default('support'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const platformAccessGrants = pgTable('platform_access_grants', {
  id: uuid('id').primaryKey().defaultRandom(),
  operatorId: uuid('operator_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  reason: text('reason').notNull(),
  ticketRef: text('ticket_ref'),
  scope: text('scope').notNull().default('read'),
  approvedBy: uuid('approved_by'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

// --- global catalogues ------------------------------------------------------

export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  description: text('description').notNull(),
  isRegulated: boolean('is_regulated').notNull().default(false),
});

export const featureDefinitions = pgTable('feature_definitions', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  category: text('category').notNull(),
  defaultState: boolean('default_state').notNull().default(false),
  metered: boolean('metered').notNull().default(false),
});

export const roleTemplates = pgTable('role_templates', {
  key: text('key').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  permissions: text('permissions').array().notNull().default(sql`'{}'`),
});

// --- tenant scope -----------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    email: citext('email').notNull(),
    fullName: text('full_name').notNull(),
    userType: text('user_type').notNull().default('staff'),
    status: text('status').notNull().default('invited'),
    passwordHash: text('password_hash'),
    mfaSecret: text('mfa_secret'),
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
    mfaRequired: boolean('mfa_required').notNull().default(false),
    competencies: text('competencies').array().notNull().default(sql`'{}'`),
    jobTitle: text('job_title'),
    phone: text('phone'),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_tenant_id_email_key').on(t.tenantId, t.email)],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    templateKey: text('template_key'),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_tenant_id_key_key').on(t.tenantId, t.key)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: tenantId(),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const userRoles = pgTable(
  'user_roles',
  {
    tenantId: tenantId(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id').notNull(),
    grantedBy: uuid('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: tenantId(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    mfaSatisfied: boolean('mfa_satisfied').notNull().default(false),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    deviceLabel: text('device_label'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [index('sessions_user').on(t.tenantId, t.userId, t.revokedAt)],
);

export const tenantFeatures = pgTable(
  'tenant_features',
  {
    tenantId: tenantId(),
    featureKey: text('feature_key').notNull(),
    enabled: boolean('enabled').notNull(),
    config: jsonb('config').notNull().default({}),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.featureKey] })],
);
