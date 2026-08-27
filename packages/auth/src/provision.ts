import { sql, withPlatform, withTenant, type Database } from '@solvenda/db';
import { recordAudit } from '@solvenda/audit';
import { PERMISSIONS, ROLE_TEMPLATES } from './permissions.js';
import { hashPassword } from './password.js';

/**
 * Publishes the permission catalogue and role templates into the global
 * reference tables. Idempotent, so it runs on every deploy and keeps the
 * database in step with the code that defines the vocabulary.
 */
export async function seedGlobalCatalogues(operatorId: string): Promise<void> {
  await withPlatform({ operatorId, reason: 'publish permission and role catalogues' }, async (db) => {
    for (const perm of PERMISSIONS) {
      await db.execute(sql`
        INSERT INTO permissions (key, resource, action, description, is_regulated)
        VALUES (${perm.key}, ${perm.resource}, ${perm.action}, ${perm.description},
                ${perm.regulated === true})
        ON CONFLICT (key) DO UPDATE
          SET description = EXCLUDED.description,
              is_regulated = EXCLUDED.is_regulated`);
    }

    for (const template of ROLE_TEMPLATES) {
      await db.execute(sql`
        INSERT INTO role_templates (key, name, description, permissions)
        VALUES (${template.key}, ${template.name}, ${template.description},
                string_to_array(${template.permissions.join(',')}, ','))
        ON CONFLICT (key) DO UPDATE
          SET name = EXCLUDED.name,
              description = EXCLUDED.description,
              permissions = EXCLUDED.permissions`);
    }
  });
}

export interface ProvisionTenantInput {
  operatorId: string;
  slug: string;
  legalName: string;
  tradingName?: string;
  jurisdictions?: string[];
  admin: { email: string; fullName: string; password: string };
}

export interface ProvisionedTenant {
  tenantId: string;
  adminUserId: string;
  roleIds: Record<string, string>;
}

/**
 * Stands up a new firm: the tenant record, a copy of every role template it can
 * then edit, and one administrator who can invite everyone else.
 *
 * Roles are copied rather than referenced so a firm can diverge from the
 * template without the platform silently changing what its staff can do.
 */
export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionedTenant> {
  const passwordHash = await hashPassword(input.admin.password);

  const tenantId = await withPlatform(
    { operatorId: input.operatorId, reason: `provision firm ${input.slug}` },
    async (db) => {
      const res = await db.execute<{ id: string }>(sql`
        INSERT INTO tenants (slug, legal_name, trading_name, status, jurisdictions)
        VALUES (${input.slug}, ${input.legalName}, ${input.tradingName ?? null}, 'trial',
                string_to_array(${(input.jurisdictions ?? ['england-wales']).join(',')}, ','))
        RETURNING id`);
      return res.rows[0]!.id;
    },
  );

  const result = await withTenant(
    { tenantId, actorType: 'system', actorLabel: 'provisioning' },
    async (db) => {
      const roleIds = await copyRoleTemplates(db);

      const userRes = await db.execute<{ id: string }>(sql`
        INSERT INTO users (email, full_name, user_type, status, password_hash, mfa_required)
        VALUES (${input.admin.email}, ${input.admin.fullName}, 'staff', 'active',
                ${passwordHash}, true)
        RETURNING id`);
      const adminUserId = userRes.rows[0]!.id;

      await db.execute(sql`
        INSERT INTO user_roles (user_id, role_id)
        VALUES (${adminUserId}, ${roleIds['firm-administrator']!})`);

      await recordAudit(db, { tenantId, actorType: 'system', actorLabel: 'provisioning' }, {
        action: 'access.role.granted',
        resourceType: 'user',
        resourceId: adminUserId,
        reason: 'Initial firm administrator created during provisioning',
        source: 'provisioning',
        after: { email: input.admin.email, roles: ['firm-administrator'] },
      });

      return { adminUserId, roleIds };
    },
  );

  return { tenantId, ...result };
}

/** Copies every global role template into the tenant. */
export async function copyRoleTemplates(db: Database): Promise<Record<string, string>> {
  const templates = await db.execute<{ key: string; name: string; description: string; permissions: string[] }>(
    sql`SELECT key, name, description, permissions FROM role_templates ORDER BY key`,
  );

  const roleIds: Record<string, string> = {};
  for (const template of templates.rows) {
    const res = await db.execute<{ id: string }>(sql`
      INSERT INTO roles (key, name, description, template_key, is_system)
      VALUES (${template.key}, ${template.name}, ${template.description}, ${template.key}, true)
      ON CONFLICT (tenant_id, key) DO UPDATE SET name = EXCLUDED.name
      RETURNING id`);
    const roleId = res.rows[0]!.id;
    roleIds[template.key] = roleId;

    for (const permissionKey of template.permissions) {
      await db.execute(sql`
        INSERT INTO role_permissions (role_id, permission_key)
        VALUES (${roleId}, ${permissionKey})
        ON CONFLICT DO NOTHING`);
    }
  }
  return roleIds;
}
