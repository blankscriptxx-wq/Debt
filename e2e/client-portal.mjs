/**
 * The consumer portal, driven at a phone viewport.
 *
 * The things being checked are the ones that matter for someone in financial
 * difficulty on a phone: it fits, the text is legible, targets are big enough
 * to hit, nothing pretends to work when it does not, and internal notes about
 * them never appear.
 */
import { chromium, devices } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000') + '/portal';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots';
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const context = await browser.newContext(devices['iPhone 13']);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'domcontentloaded' });
  check('sign-in renders', (await page.locator('h1').innerText()).includes('Sign in'));
  await page.screenshot({ path: `${OUT}/c1-signin.png`, fullPage: true });

  await page.fill('input[name=firm]', 'northgate');
  await page.fill('input[name=email]', 'joanne.whitfield@example.test');
  await page.fill('input[name=password]', 'a perfectly reasonable passphrase');
  await page.click('button[type=submit]');
  await page.waitForURL(BASE, { timeout: 20000 });
  await page.waitForSelector('.cp-h1');

  const body = await page.locator('body').innerText();
  check('greets the client by name', body.includes('Hello Joanne'));
  check('shows the case reference', body.includes('DMP-0001'));
  check('names the adviser', body.includes('Ruth Ellery'));
  check('explains the solution in plain English',
        body.includes('one affordable payment each month'));
  check('shows progress steps', await page.locator('.cp-step').count() >= 4);
  check('marks where the client is now', body.includes('where you are now'));
  check('shows the figures', body.includes('Total you owe') && body.includes('£8,709.00'));

  // The adviser's internal note about this client must never appear here.
  check('internal notes stay internal', !body.includes('sounded stressed'));

  await page.screenshot({ path: `${OUT}/c2-progress.png`, fullPage: true });

  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check('fits a phone screen without sideways scrolling', noOverflow);

  // Touch targets: 44px is the accessibility floor for a finger.
  const small = await page.evaluate(() => {
    const targets = [...document.querySelectorAll('a, button, input')];
    return targets.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.height < 44;
    }).map((el) => `${el.tagName}:${(el.textContent ?? '').trim().slice(0, 24)}`);
  });
  check('every touch target is at least 44px tall', small.length === 0, small.join(', '));

  await page.goto(`${BASE}/messages`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cp-h1');
  const messages = await page.locator('body').innerText();
  check('messages are listed', messages.includes('annual review'));
  check('internal notes are absent from messages', !messages.includes('sounded stressed'));
  await page.screenshot({ path: `${OUT}/c3-messages.png`, fullPage: true });

  await page.goto(`${BASE}/documents`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cp-h1');
  const documents = await page.locator('body').innerText();
  check('upload is honestly labelled as not connected',
        documents.includes('Not yet connected'));
  const disabled = await page.locator('.cp-btn[disabled]').count();
  check('the upload control is disabled rather than fake', disabled > 0);
  await page.screenshot({ path: `${OUT}/c4-documents.png`, fullPage: true });

  check('no uncaught client errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
