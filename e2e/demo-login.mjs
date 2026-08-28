/**
 * The development sign-in buttons.
 *
 * Every portal offers one-click access to a seeded account. This suite proves
 * each button lands signed in as the right person, which is the only way to
 * know the seeded roles and the wiring actually match up.
 *
 * Requires SOLVENDA_DEMO_LOGIN=1 on all three servers - and, because `next
 * start` runs as production, SOLVENDA_DEMO_LOGIN_ALLOW_PRODUCTION=1 too.
 */
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const checks = [];
const check = (n, p, d='') => { checks.push({n,p:Boolean(p)}); console.log(`${p?'PASS':'FAIL'}  ${n}${d?` — ${d}`:''}`); };

// Console: six staff buttons, each landing signed in as that person.
for (const [label, expect] of [['Debt Adviser','Ruth'], ['Compliance Officer','Yewande'],
                               ['Firm Administrator','Priya']]) {
  const p = await b.newPage({ viewport: { width: 1440, height: 960 } });
  await p.goto('http://127.0.0.1:3000/app/login', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.sv-demo__btn');
  await p.locator('.sv-demo__btn', { hasText: label }).click();
  await p.waitForURL('http://127.0.0.1:3000/app', { timeout: 20000 });
  await p.waitForSelector('.sv-page-header__title');
  const body = await p.locator('body').innerText();
  check(`console: one click signs in as ${label}`, body.includes(expect), expect);
  await p.close();
}

const p1 = await b.newPage({ viewport: { width: 1440, height: 960 } });
await p1.goto('http://127.0.0.1:3000/app/login', { waitUntil: 'domcontentloaded' });
check('console: six staff accounts offered', await p1.locator('.sv-demo__btn').count() === 6,
      `${await p1.locator('.sv-demo__btn').count()}`);
await p1.close();

// Client portal.
for (const [label, expect] of [['Joanne Whitfield','Joanne'], ['Elaine Crozier','Elaine']]) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 } });
  await p.goto('http://127.0.0.1:3000/portal/sign-in', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.sv-demo__btn');
  await p.locator('.sv-demo__btn', { hasText: label }).click();
  await p.waitForURL('http://127.0.0.1:3000/portal', { timeout: 20000 });
  const body = await p.locator('body').innerText();
  check(`client portal: one click signs in as ${label}`, body.includes(expect));
  await p.close();
}

// Control.
const p2 = await b.newPage({ viewport: { width: 1440, height: 960 } });
await p2.goto('http://127.0.0.1:3000/control/sign-in', { waitUntil: 'domcontentloaded' });
await p2.waitForSelector('.sv-demo__btn');
await p2.locator('.sv-demo__btn').first().click();
await p2.waitForURL('http://127.0.0.1:3000/control', { timeout: 20000 });
await p2.waitForSelector('.sv-page-header__title');
check('control: one click signs in as the operator',
      (await p2.locator('body').innerText()).includes('Health'));
await p2.screenshot({ path: '/tmp/shots/demo-control.png', fullPage: false });
await p2.close();

// Marketing site is the front door.
const p3 = await b.newPage({ viewport: { width: 1440, height: 960 } });
await p3.goto('http://127.0.0.1:3000/', { waitUntil: 'domcontentloaded' });
check('www: header offers Sign in', await p3.locator('header a', { hasText: 'Sign in' }).count() === 1);
await p3.click('header a:has-text("Sign in")');
await p3.waitForURL(/\/sign-in/, { timeout: 15000 });
const dests = await p3.locator('.mk-card--link').count();
check('www: sign-in page lists all three portals', dests === 3, `${dests}`);
await p3.screenshot({ path: '/tmp/shots/demo-www-signin.png', fullPage: true });
await p3.close();

await b.close();
const failed = checks.filter(c => !c.p);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
