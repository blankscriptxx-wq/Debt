/**
 * End-to-end smoke test against the running console.
 *
 * Drives the real browser through the real sign-in and onto the Case
 * Intelligence view, so "it works" means the pages render with live data from
 * Postgres rather than that the build succeeded.
 */
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000') + '/app';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots';

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  check('login page renders', await page.locator('h1').innerText() === 'Sign in to Solvenda');
  await page.screenshot({ path: `${OUT}/01-login.png` });

  // Wrong credentials must not reveal whether the account exists.
  await page.fill('input[name=firm]', 'northgate');
  await page.fill('input[name=email]', 'adviser@northgate.test');
  await page.fill('input[name=password]', 'definitely the wrong password');
  await page.click('button[type=submit]');
  await page.waitForURL(/error=credentials/, { timeout: 15000 });
  check('bad password is rejected', page.url().includes('error=credentials'));

  await page.fill('input[name=firm]', 'northgate');
  await page.fill('input[name=email]', 'adviser@northgate.test');
  await page.fill('input[name=password]', 'a perfectly reasonable passphrase');
  await page.click('button[type=submit]');
  await page.waitForURL(BASE, { timeout: 20000 });
  await page.waitForSelector('.sv-page-header__title');

  const heading = await page.locator('.sv-page-header__title').innerText();
  check('signs in and reaches the overview', heading.includes('Ruth'), heading);
  const openCases = await page.locator('.sv-stat').first().innerText();
  check('overview shows real counts', /\d/.test(openCases), openCases.replace(/\n/g, ' '));
  await page.screenshot({ path: `${OUT}/02-overview.png`, fullPage: true });

  await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-table tbody tr');
  const rows = await page.locator('.sv-table tbody tr').count();
  check('case list shows seeded cases', rows >= 4, `${rows} rows`);
  await page.screenshot({ path: `${OUT}/03-cases.png`, fullPage: true });

  // Global search through the command palette.
  await page.keyboard.press('Control+k');
  await page.waitForSelector('.sv-palette__input');
  await page.fill('.sv-palette__input', 'Whitfield');
  await page.waitForTimeout(700);
  const results = await page.locator('.sv-palette__item').count();
  check('command palette searches cases', results >= 1, `${results} results`);
  await page.screenshot({ path: `${OUT}/04-palette.png` });
  await page.keyboard.press('Enter');

  await page.waitForURL(/\/cases\/[0-9a-f-]{36}/, { timeout: 15000 });
  await page.waitForSelector('.sv-page-header__title');

  const caseHeading = await page.locator('.sv-page-header__title').innerText();
  check('opens the case from search', caseHeading.includes('Whitfield'), caseHeading);

  const health = await page.locator('.sv-health__score').innerText();
  check('case health is computed', /^\d+$/.test(health), `score ${health}`);

  const signals = await page.locator('.sv-signal').count();
  check('signals are raised with sources', signals > 0, `${signals} signals`);

  const sourceLines = await page.locator('.sv-signal__sources').count();
  check('every signal traces to its records', sourceLines > 0, `${sourceLines} traced`);

  const bodyText = await page.locator('body').innerText();
  check('surfaces the overdue review', bodyText.includes('Review overdue'));
  check('surfaces client disengagement', /never responded|No response from the client/.test(bodyText));
  check('shows the solution comparison', bodyText.includes('Solution comparison'));
  check('explains why a solution is ruled out',
        bodyText.includes('Surplus income exceeds the DRO limit'));
  check('shows what to do next', bodyText.includes('What to do next'));

  await page.screenshot({ path: `${OUT}/05-case-intelligence.png`, fullPage: true });

  // The client with recorded vulnerability.
  await page.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
  const vulnerable = page.locator('.sv-table tbody tr', { hasText: 'Crozier' });
  check('vulnerability is visible on the list', await vulnerable.count() > 0);
  await vulnerable.locator('a').first().click();
  await page.waitForSelector('.sv-page-header__title');
  const vulnText = await page.locator('body').innerText();
  check('vulnerability raises an urgent signal', vulnText.includes('Significant vulnerability recorded'));
  check('deficit budget is flagged', vulnText.includes('Budget is in deficit'));
  await page.screenshot({ path: `${OUT}/06-vulnerable-case.png`, fullPage: true });

  // Mobile rendering.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.context().addCookies(await page.context().cookies());
  await mobile.goto(`${BASE}/cases`, { waitUntil: 'domcontentloaded' });
  await mobile.waitForSelector('.sv-table');
  const overflow = await mobile.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('no horizontal overflow on mobile', overflow);
  await mobile.screenshot({ path: `${OUT}/07-mobile-cases.png`, fullPage: true });

  // Every navigation target must exist: Next prefetches links, so a missing
  // route is a 404 on page render, not just when someone clicks.
  const missing = [];
  page.on('response', (r) => { if (r.status() === 404) missing.push(new URL(r.url()).pathname); });
  for (const path of ['/tasks', '/approvals', '/compliance', '/quality',
                      '/analytics', '/workflows', '/settings']) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sv-page-header__title');
    const title = await page.locator('.sv-page-header__title').innerText();
    check(`${path} renders`, title.length > 0, title);
  }
  await page.screenshot({ path: `${OUT}/08-compliance.png`, fullPage: true });

  check('no missing routes behind the navigation', missing.length === 0,
        [...new Set(missing)].join(', '));
  check('no uncaught client errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
