/**
 * Solvenda Control, the platform operator console.
 *
 * The assertions that matter are about restraint: an operator sees firm
 * configuration and cross-firm health, and does not see client data without a
 * recorded grant.
 */
import { chromium } from 'playwright';
import { totpCodeAt } from '../packages/auth/src/totp.js';

/** Matches the seed. Development values; nothing here is a real credential. */
const OPERATOR_TOTP_SECRET = process.env.SEED_OPERATOR_TOTP_SECRET
  ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const OPERATOR_ID = process.env.SOLVENDA_SIGNIN_OPERATOR_ID
  ?? '00000000-0000-0000-0000-000000000001';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3002';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots';
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
const missing = [];
page.on('response', (r) => { if (r.status() === 404) missing.push(new URL(r.url()).pathname); });

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('unauthenticated access redirects to sign-in', page.url().includes('/sign-in'));

  await page.fill('input[name=email]', 'operator@solvenda.test');
  await page.fill('input[name=password]', 'definitely wrong');
  await page.click('button[type=submit]');
  await page.waitForURL(/error=/, { timeout: 15000 });
  check('rejects bad operator credentials', page.url().includes('error='));

  // A password alone is no longer enough: operator sign-in refuses an account
  // with no second factor and refuses a missing code.
  await page.fill('input[name=email]', 'operator@solvenda.test');
  await page.fill('input[name=password]', 'a perfectly reasonable passphrase');
  await page.click('button[type=submit]');
  await page.waitForURL(/error=mfa_required/, { timeout: 15000 });
  check('refuses a correct password without a second factor',
        page.url().includes('error=mfa_required'));

  // The cookie is a bearer token, not the operator's id. Setting the id by hand
  // used to be a complete authentication bypass.
  const forged = await browser.newPage();
  await forged.context().addCookies([{
    name: 'solvenda_operator', value: OPERATOR_ID, url: BASE,
  }]);
  await forged.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('a hand-set operator id does not authenticate', forged.url().includes('/sign-in'),
        forged.url());
  await forged.close();

  await page.fill('input[name=email]', 'operator@solvenda.test');
  await page.fill('input[name=password]', 'a perfectly reasonable passphrase');
  await page.fill('input[name=totp]', totpCodeAt(OPERATOR_TOTP_SECRET, Date.now()));
  await page.click('button[type=submit]');
  await page.waitForURL(`${BASE}/`, { timeout: 20000 });
  await page.waitForSelector('.sv-page-header__title');

  const health = await page.locator('body').innerText();
  check('health page renders', health.includes('Health'));
  check('verifies audit chains across every firm', health.includes('All chains verify'));
  check('reports schema state', /\d+ migrations applied/.test(health));
  await page.screenshot({ path: `${OUT}/a1-health.png`, fullPage: true });

  for (const [path, expected] of [
    ['/tenants', 'Every firm on this deployment'],
    ['/plans', 'Plans'],
    ['/providers', 'Provider catalogue'],
    ['/capabilities', 'Capabilities'],
    ['/access', "Who can see a firm's data, and why"],
    ['/activity', 'Security and regulated events'],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sv-page-header__title');
    const title = await page.locator('.sv-page-header__title').innerText();
    check(`${path} renders`, title.includes(expected.split(' ')[0]), title);
  }

  await page.goto(`${BASE}/tenants`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-table tbody tr');
  const tenants = await page.locator('body').innerText();
  check('lists the seeded firm', tenants.includes('Northgate'));
  check('shows firm configuration, not client data',
        tenants.includes('northgate') && !tenants.includes('Whitfield'));
  check('warns that client data needs a grant', tenants.includes('requires a time-boxed grant'));
  await page.screenshot({ path: `${OUT}/a2-tenants.png`, fullPage: true });

  await page.goto(`${BASE}/providers`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-table tbody tr');
  const providers = await page.locator('body').innerText();
  check('states plainly that every provider is simulated',
        providers.includes('Every provider is a sandbox simulator'));

  await page.goto(`${BASE}/plans`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-table tbody tr');
  const plans = await page.locator('body').innerText();
  check('shows the commercial plans', plans.includes('Practice') && plans.includes('Enterprise'));
  check('prices are enterprise-positioned', plans.includes('£2,850.00'));
  await page.screenshot({ path: `${OUT}/a3-plans.png`, fullPage: true });

  await page.goto(`${BASE}/capabilities`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-table tbody tr');
  const capabilities = await page.locator('body').innerText();
  check('shows AI capabilities with acceptance rate framing',
        capabilities.includes('Why acceptance rate is the number that matters'));

  check('no missing routes', missing.length === 0, [...new Set(missing)].join(', '));
  check('no uncaught client errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
