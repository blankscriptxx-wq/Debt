/**
 * Connection configuration.
 *
 * Three distinct database roles, three distinct pools. The separation is the
 * security control: application requests can only ever be served by a
 * connection that has no way to read across tenants.
 */
export type DbRole = 'app' | 'platform' | 'owner';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  ssl: boolean;
  users: Record<DbRole, { user: string; password: string }>;
  maxConnections: number;
  statementTimeoutMs: number;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function loadDbConfig(): DbConfig {
  return {
    host: required('PGHOST', '127.0.0.1'),
    port: Number(required('PGPORT', '5432')),
    database: required('PGDATABASE', 'solvenda_dev'),
    ssl: process.env['PGSSL'] === 'require',
    users: {
      app: {
        user: required('PGUSER_APP', 'solvenda_app'),
        password: required('PGPASSWORD_APP', 'dev_app_pw'),
      },
      platform: {
        user: required('PGUSER_PLATFORM', 'solvenda_platform'),
        password: required('PGPASSWORD_PLATFORM', 'dev_platform_pw'),
      },
      owner: {
        user: required('PGUSER_OWNER', 'solvenda_owner'),
        password: required('PGPASSWORD_OWNER', 'dev_owner_pw'),
      },
    },
    maxConnections: Number(process.env['PGPOOL_MAX'] ?? '10'),
    statementTimeoutMs: Number(process.env['PG_STATEMENT_TIMEOUT_MS'] ?? '15000'),
  };
}
