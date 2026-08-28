/**
 * Runs every browser and API suite against already-running servers.
 *
 * The suites are independent — the API suite writes only to the seeded sandbox
 * fixture client, which exists so that it does not disturb what the console and
 * the client portal assert on. They are run in one process here so the API key
 * and sandbox client id are wired up once rather than remembered.
 *
 * Expects one server on :3000 - the marketing site at /, the console at /app,
 * the client portal at /portal and Control at /control - and a seeded database.
 * Set SOLVENDA_SIGNIN_OPERATOR_ID, which the seed prints.
 */
import { execFileSync } from 'node:child_process';

const SUITES = ['smoke', 'client-portal', 'control', 'public-api', 'marketing',
                'demo-login', 'case-file'];

const operatorId = process.env['SOLVENDA_SIGNIN_OPERATOR_ID'];
if (!operatorId) {
  console.error('Set SOLVENDA_SIGNIN_OPERATOR_ID (the seed prints it).');
  process.exit(1);
}

const run = (args, env) =>
  execFileSync('npx', ['tsx', ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['inherit', 'pipe', 'inherit'],
  });

const [apiKey, sandboxClientId] =
  run(['e2e/make-api-key.mjs'], { SOLVENDA_SIGNIN_OPERATOR_ID: operatorId }).trim().split(' ');

let failed = 0;
for (const suite of SUITES) {
  process.stdout.write(`\n─── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}\n`);
  try {
    process.stdout.write(
      run([`e2e/${suite}.mjs`], { API_KEY: apiKey, SANDBOX_CLIENT_ID: sandboxClientId }));
  } catch (error) {
    process.stdout.write(String(error.stdout ?? ''));
    console.error(`${suite} FAILED`);
    failed += 1;
  }
}

console.log(failed === 0 ? '\nAll suites passed.' : `\n${failed} suite(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
