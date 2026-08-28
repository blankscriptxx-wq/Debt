/**
 * End-to-end test of the marketing site.
 *
 * Two things this suite exists to catch. First, every navigation target must
 * exist: Next prefetches links, so a route referenced by the header, footer or
 * sitemap and never created is a 404 the moment a page renders. Second, the
 * contact form must actually write — a form that renders and posts nowhere is
 * the exact failure mode this project treats as "not built".
 */
import { chromium } from 'playwright';
import { totpCodeAt } from '../packages/auth/src/totp.js';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots';

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
// A distinct forwarded address per run. The contact form throttles per source,
// so a fixed address would make this suite pass once an hour; a real deployment
// sets this header at the proxy and must not trust a client-supplied one.
// Random rather than time-derived: `Date.now() % 200` cycles, and two runs
// minutes apart collided often enough to look like a real failure.
const octets = () => `${1 + Math.floor(Math.random() * 254)}.${1 + Math.floor(Math.random() * 254)}`;
const CLIENT_IP = `198.51.${octets()}`;
const page = await browser.newPage({
  viewport: { width: 1440, height: 960 },
  extraHTTPHeaders: { 'x-forwarded-for': CLIENT_IP },
});

const errors = [];
const missing = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', (r) => {
  if (r.status() !== 404) return;
  const { pathname } = new URL(r.url());
  missing.push(pathname);
  errors.push(`404 ${pathname}`);
});

const marker = `e2e-${Date.now()}`;

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  check('homepage renders', (await page.locator('h1').innerText()).length > 0,
        await page.locator('h1').innerText());
  await page.screenshot({ path: `${OUT}/20-www-home.png`, fullPage: true });

  const home = await page.locator('body').innerText();
  check('states the regulatory position rather than implying approval',
        home.includes('not authorised or regulated by the Financial Conduct Authority'));
  check('claims are paired with a mechanism', await page.locator('.mk-claim__how').count() > 0,
        `${await page.locator('.mk-claim__how').count()} mechanisms`);
  check('says on the page what is not built', await page.locator('.mk-honest').count() > 0);

  // No unearned claims anywhere on the site.
  const FORBIDDEN = [
    /ISO\s?27001[- ]certified/i, /SOC\s?2\s?(Type\s?[12]\s?)?(certified|compliant)/i,
    /FCA[- ]approved/i, /FCA[- ]authorised platform/i,
    /trusted by \d/i, /\d+\+? (firms|customers|clients) (use|trust)/i,
    /award[- ]winning/i, /industry[- ]leading/i, /market leader/i,
  ];

  // Every page reachable from the navigation, the footer and the sitemap.
  const sitemap = await (await fetch(`${BASE}/sitemap.xml`)).text();
  const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((m) => new URL(m[1]).pathname || '/');
  check('sitemap lists the real pages', paths.length >= 10, paths.join(' '));

  for (const path of paths) {
    const res = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const title = await page.locator('h1').first().innerText();
    check(`${path} renders`, res.status() === 200 && title.length > 0, `${res.status()} ${title}`);

    const text = await page.locator('body').innerText();
    const hit = FORBIDDEN.find((re) => re.test(text));
    check(`${path} makes no unearned claim`, !hit, hit ? String(hit) : '');
  }

  // Pricing shows the same figures the platform is configured with.
  await page.goto(`${BASE}/pricing`, { waitUntil: 'domcontentloaded' });
  const pricing = await page.locator('body').innerText();
  for (const figure of ['£950', '£2,850', '£7,500', '£95', '£85', '£70']) {
    check(`pricing shows ${figure}`, pricing.includes(figure));
  }
  check('pricing says these are not observed contract values',
        /not observed contract values/i.test(pricing));
  check('pricing says Solvenda has no customers', /no customers/i.test(pricing));
  const plans = await page.locator('.mk-plan').count();
  check('three plans are published', plans === 3, `${plans} plans`);
  await page.screenshot({ path: `${OUT}/21-www-pricing.png`, fullPage: true });

  // The contact form writes for real.
  await page.goto(`${BASE}/contact`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form.mk-form');
  await page.screenshot({ path: `${OUT}/22-www-contact.png`, fullPage: true });

  // Validation has to hold server-side. `type=email` stops an honest mistake in
  // the browser, and proves nothing about a client that does not use the form,
  // so turn the browser's own checking off before submitting: that is the case
  // the server is actually defending against.
  await page.evaluate(() => document.querySelector('form.mk-form').noValidate = true);
  await page.fill('#name', 'Marcus Adeyemi');
  await page.fill('#organisation', 'Halewood Money Advice');
  await page.fill('#email', 'not-an-email');
  await page.fill('#message', `Rejected submission ${marker}`);
  await page.click('button[type=submit]');
  await page.waitForURL(/error=/, { timeout: 20000 });
  await page.waitForSelector('.mk-form__error');
  const rejected = await page.locator('.mk-form__error').innerText();
  check('a bad email address is rejected server-side', /email address/i.test(rejected), rejected);

  await page.fill('#name', 'Marcus Adeyemi');
  await page.fill('#organisation', 'Halewood Money Advice');
  await page.fill('#email', `marcus+${marker}@halewood.test`);
  await page.selectOption('#enquiryType', 'migration');
  await page.fill('#message', `Moving 6,000 live DMPs off an incumbent system. ${marker}`);
  await page.click('button[type=submit]');
  await page.waitForURL(/sent=1/, { timeout: 20000 });
  const confirmation = await page.locator('body').innerText();
  check('a valid enquiry is accepted', confirmation.includes('Received'));
  await page.screenshot({ path: `${OUT}/23-www-contact-sent.png`, fullPage: true });

  // The throttle. Deliberately driven with submissions that fail validation, so
  // this asserts the limit without depositing five more rows.
  const flooder = await browser.newPage({
    viewport: { width: 1440, height: 960 },
    extraHTTPHeaders: { 'x-forwarded-for': `203.0.${octets()}` },
  });
  let throttled = '';
  for (let i = 0; i < 6; i += 1) {
    await flooder.goto(`${BASE}/contact`, { waitUntil: 'domcontentloaded' });
    await flooder.evaluate(() => document.querySelector('form.mk-form').noValidate = true);
    await flooder.fill('#name', 'Flood Test');
    await flooder.fill('#email', 'still-not-an-email');
    await flooder.fill('#message', `flood ${i}`);
    await flooder.click('button[type=submit]');
    await flooder.waitForURL(/error=/, { timeout: 20000 });
    throttled = await flooder.locator('.mk-form__error').innerText();
  }
  check('repeated submissions from one source are throttled',
        /too many/i.test(throttled), throttled);
  await flooder.close();

  // The write is only real if an operator can see it, so check the database and
  // then check Solvenda Control, which is the only thing that can read it back.
  const { withPlatform, sql, closeDatabase } = await import('../packages/db/src/index.js');
  const NIL = '00000000-0000-0000-0000-000000000000';
  const operatorId = await withPlatform(
    { operatorId: NIL, reason: 'e2e: resolve the seeded operator' },
    async (db) => {
      const r = await db.execute(sql`
        SELECT id FROM platform_operators WHERE email = 'operator@solvenda.test'`);
      return r.rows[0]?.id;
    },
  );

  const rows = await withPlatform(
    { operatorId, reason: 'e2e verification of the public enquiry path' },
    async (db) => {
      const r = await db.execute(sql`
        SELECT name, organisation, enquiry_type, source_path, status, message
          FROM platform_enquiries WHERE email = ${`marcus+${marker}@halewood.test`}`);
      return r.rows;
    },
  );
  check('the enquiry reached the database', rows.length === 1, `${rows.length} rows`);
  check('it is stored with the details submitted',
        rows[0]?.enquiry_type === 'migration' && rows[0]?.status === 'new'
        && String(rows[0]?.message ?? '').includes(marker),
        JSON.stringify(rows[0] ?? {}).slice(0, 120));

  const rejectedRows = await withPlatform(
    { operatorId, reason: 'e2e verification that rejected enquiries are not stored' },
    async (db) => {
      const r = await db.execute(sql`
        SELECT count(*)::int AS n FROM platform_enquiries WHERE email = 'not-an-email'`);
      return r.rows[0].n;
    },
  );
  check('the rejected submission was not stored', rejectedRows === 0, `${rejectedRows} rows`);
  await closeDatabase();

  // And an operator can actually see it, through the console rather than a query.
  const CONTROL = `${BASE}/control`;
  const control = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await control.goto(`${CONTROL}/sign-in`, { waitUntil: 'domcontentloaded' });
  await control.fill('input[name=email]', 'operator@solvenda.test');
  await control.fill('input[name=password]', 'a perfectly reasonable passphrase');
  await control.fill('input[name=totp]',
                     totpCodeAt(process.env.SEED_OPERATOR_TOTP_SECRET
                                ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', Date.now()));
  await control.click('button[type=submit]');
  await control.waitForURL(CONTROL, { timeout: 20000 });
  await control.goto(`${CONTROL}/enquiries`, { waitUntil: 'domcontentloaded' });
  await control.waitForSelector('.sv-table tbody tr, .sv-empty');
  const inbox = await control.locator('body').innerText();
  check('the enquiry is visible to a platform operator',
        inbox.includes('Marcus Adeyemi') && inbox.includes('migration'));
  await control.screenshot({ path: `${OUT}/25-control-enquiries.png`, fullPage: true });

  // Mobile.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  for (const path of ['/', '/pricing', '/contact']) {
    await mobile.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    const overflow = await mobile.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1);
    check(`no horizontal overflow on mobile at ${path}`, overflow);
  }
  await mobile.screenshot({ path: `${OUT}/24-www-mobile-pricing.png`, fullPage: true });

  check('no missing routes behind the navigation', missing.length === 0,
        [...new Set(missing)].join(', '));
  check('no uncaught client errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
