import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@solvenda/db/plans': r('./packages/db/src/plans.ts'),
      '@solvenda/db': r('./packages/db/src/index.ts'),
      '@solvenda/testing': r('./packages/testing/src/index.ts'),
      '@solvenda/core': r('./packages/core/src/index.ts'),
      '@solvenda/auth': r('./packages/auth/src/index.ts'),
      '@solvenda/audit': r('./packages/audit/src/index.ts'),
      '@solvenda/ai': r('./packages/ai/src/index.ts'),
      '@solvenda/workflow': r('./packages/workflow/src/index.ts'),
      '@solvenda/integrations': r('./packages/integrations/src/index.ts'),
      '@solvenda/config': r('./packages/config/src/index.ts'),
    },
  },
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Database tests share one Postgres instance; tenant isolation is the thing
    // under test, so parallel files are fine, but keep concurrency modest.
    pool: 'threads',
    poolOptions: { threads: { maxThreads: 4 } },
    sequence: { concurrent: false },
  },
});
