import pg from 'pg';

/**
 * A connection that bypasses row level security entirely.
 *
 * This exists for exactly one purpose: proving that the audit hash chain
 * detects history being rewritten by someone who already has database-level
 * access. Every other test uses the ordinary application path. If superuser
 * credentials are not configured the dependent tests skip rather than pass
 * silently, so an unverified chain never looks verified.
 */
export function superuserCredentialsAvailable(): boolean {
  return Boolean(process.env['PGPASSWORD_SUPER'] && process.env['PGUSER_SUPER']);
}

export async function withSuperuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  if (!superuserCredentialsAvailable()) {
    throw new Error('Superuser credentials are not configured (PGUSER_SUPER / PGPASSWORD_SUPER)');
  }
  const client = new pg.Client({
    host: process.env['PGHOST'] ?? '127.0.0.1',
    port: Number(process.env['PGPORT'] ?? '5432'),
    database: process.env['PGDATABASE'] ?? 'solvenda_test',
    user: process.env['PGUSER_SUPER'],
    password: process.env['PGPASSWORD_SUPER'],
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
