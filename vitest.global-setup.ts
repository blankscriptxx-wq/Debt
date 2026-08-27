/**
 * Points the suite at the dedicated test database and brings the schema up to
 * date before anything runs. Tests execute against real Postgres because the
 * security properties under test (RLS, FORCE RLS, append-only triggers, hash
 * chaining) live in the database and cannot be meaningfully mocked.
 */
export default async function setup() {
  process.env['PGDATABASE'] ??= 'solvenda_test';
  process.env['PGHOST'] ??= '127.0.0.1';

  const { migrate } = await import('./packages/db/src/migrate.js');
  const { closeDatabase } = await import('./packages/db/src/client.js');
  await migrate({ silent: true });
  await closeDatabase();
}
