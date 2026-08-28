import { withTenant, withPlatform, sql, closeDatabase } from '../packages/db/src/index.js';
import { createApiKey } from '../packages/integrations/src/index.js';

const operatorId = process.env.SOLVENDA_SIGNIN_OPERATOR_ID;
const tenantId = await withPlatform(
  { operatorId, reason: 'issue a development API key' },
  async (db) => {
    const r = await db.execute(sql`SELECT id FROM tenants WHERE slug = 'northgate'`);
    return r.rows[0].id;
  },
);

const ctx = { tenantId, actorType: 'system', actorLabel: 'seed' };
const userId = await withTenant(ctx, async (db) => {
  const r = await db.execute(sql`SELECT id FROM users WHERE user_type = 'staff' LIMIT 1`);
  return r.rows[0].id;
});

const principal = {
  kind: 'user', tenantId, userId,
  permissions: new Set(['integration:configure']),
  competencies: [], mfaSatisfied: true, status: 'active',
};

const created = await withTenant({ ...ctx, userId }, (db) =>
  createApiKey(db, { ...ctx, userId }, principal, {
    name: 'Development integration',
    // Deliberately narrow: the API test asserts that a scope the key lacks is refused.
    scopes: ['case:read', 'case:write', 'report:read'],
  }));

// The suite writes cases, so it needs a client it is safe to write to. The
// seeded sandbox fixture exists for exactly this and has no case of its own.
const sandboxClientId = await withTenant(ctx, async (db) => {
  const r = await db.execute(sql`SELECT id FROM clients WHERE reference = 'CL-9000'`);
  return r.rows[0]?.id ?? null;
});
if (!sandboxClientId) {
  throw new Error('Sandbox fixture client CL-9000 is missing. Run the seed.');
}

console.log(`${created.key} ${sandboxClientId}`);
await closeDatabase();
