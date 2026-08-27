import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withOwner, closeDatabase } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations in filename order, each in its own transaction,
 * and records a checksum so an edited-after-the-fact migration is caught
 * rather than silently ignored.
 */
export async function migrate(options: { silent?: boolean } = {}): Promise<MigrationResult> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  const skipped: string[] = [];

  await withOwner(async (client) => {
    await client.query(`CREATE SCHEMA IF NOT EXISTS app`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS app.schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM app.schema_migrations',
    );
    const seen = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const file of files) {
      const sqlText = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sqlText).digest('hex');
      const previous = seen.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration ${file} has changed since it was applied. Migrations are immutable; ` +
              `add a new one instead.`,
          );
        }
        skipped.push(file);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(sqlText);
        await client.query(
          'INSERT INTO app.schema_migrations(filename, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(file);
      if (!options.silent) console.log(`  applied ${file}`);
    }
  });

  return { applied, skipped };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) {
  migrate()
    .then((r) => {
      console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already present`);
      return closeDatabase();
    })
    .catch(async (e) => {
      console.error(e);
      await closeDatabase();
      process.exit(1);
    });
}
