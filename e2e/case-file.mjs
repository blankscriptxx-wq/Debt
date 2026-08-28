/**
 * The adviser case file, worked end to end.
 *
 * This is the suite that proves the platform can be used rather than only read.
 * It signs in, opens a seeded case and works it: client details, a household
 * member, an employment record, an asset, a debt, and income and expenditure —
 * then checks that the figures it entered reach the totals and that Case
 * Intelligence responds to them.
 *
 * The last part matters most. Every screen could save correctly and the product
 * would still be broken if what an adviser entered never reached the advice.
 *
 * It works DMP-9100, a case the seed creates for this suite and nothing else,
 * and it asserts on movement rather than absolute totals — so it can be run
 * repeatedly against the same database without either spoiling another suite's
 * fixtures or being spoiled by its own previous run.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots';

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

/** Scoped to the tab's own form: the sidebar sign-out is also a submit button. */
const save = async (label) => {
  await page.click('form.sv-form button[type=submit]');
  await page.waitForURL(/saved=1|error=/, { timeout: 20000 });
  const banner = await page.locator('.sv-form__result').first().innerText();
  check(label, page.url().includes('saved=1'), banner.slice(0, 90));
};

const stamp = Date.now().toString().slice(-6);

/**
 * Reads a figure out of the sticky summary bar, in pence.
 *
 * The suite runs repeatedly against the same seeded case, so every record it
 * adds is still there on the next run. Asserting an absolute total would pass
 * once and fail forever after. Every figure check below is therefore a delta or
 * an internal consistency check — which is also the stronger assertion: it
 * proves the number moved by what was entered, not merely that it looks right.
 */
const figure = async (label) => {
  const cell = page.locator('.sv-summary__cell', {
    has: page.locator('.sv-summary__label', { hasText: new RegExp(label, 'i') }),
  }).first();
  const text = await cell.locator('.sv-summary__value').innerText();
  const negative = text.trim().startsWith('-');
  const pence = Math.round(Number(text.replace(/[^0-9.]/g, '')) * 100);
  return negative ? -pence : pence;
};

try {
  await page.goto(`${BASE}/app/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-demo__btn');
  await page.locator('.sv-demo__btn', { hasText: 'Debt Adviser' }).click();
  await page.waitForURL(`${BASE}/app`, { timeout: 20000 });

  // DMP-9100 exists for this suite alone. Working a demonstration case here
  // would change the totals the console and client portal suites assert on and
  // reset the review date the overdue-review signal is derived from.
  await page.goto(`${BASE}/app/cases`, { waitUntil: 'domcontentloaded' });
  await page.locator('.sv-table tbody tr', { hasText: 'DMP-9100' }).locator('a').first().click();
  await page.waitForSelector('.sv-tabs');
  const caseUrl = new URL(page.url()).pathname;
  check('the case file opens with its tabs', await page.locator('.sv-tabs__tab').count() === 12,
        `${await page.locator('.sv-tabs__tab').count()} tabs`);

  // Every tab must render: a missing one is a 404 on click, not at build time.
  const missing = [];
  page.on('response', (r) => { if (r.status() === 404) missing.push(new URL(r.url()).pathname); });
  for (const slug of ['client', 'living', 'employment', 'assets', 'debts', 'finances',
                      'advice', 'verification', 'appointments', 'checklist', 'messenger']) {
    const res = await page.goto(`${BASE}${caseUrl}/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sv-tabs');
    check(`${slug} renders`, res.status() === 200, String(res.status()));
  }

  // --- client details ------------------------------------------------------
  await page.goto(`${BASE}${caseUrl}/client`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name=placeOfBirth]', 'Leeds');
  await page.selectOption('select[name=maritalStatus]', 'single');
  await page.selectOption('select[name=occupancyStatus]', 'private-tenant');
  await page.check('input[name="service:email"]');
  await save('client details save');
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('client details persist',
        await page.inputValue('input[name=placeOfBirth]') === 'Leeds'
        && await page.isChecked('input[name="service:email"]'));

  // --- household -----------------------------------------------------------
  await page.goto(`${BASE}${caseUrl}/living`, { waitUntil: 'domcontentloaded' });
  const adultsBefore = await page.locator('.sv-summary__cell').first().innerText();
  await page.fill('input[name=fullName]', `Child ${stamp}`);
  await page.selectOption('select[name=relationship]', 'child');
  await page.fill('input[name=ageYears]', '9');
  await save('household member added');
  // innerText reflects the rendered text, and the summary labels are uppercased
  // in CSS, so compare case-insensitively rather than against the source casing.
  const composition = (await page.locator('.sv-summary').innerText()).toLowerCase();
  check('household composition recomputes', composition.includes('children'),
        composition.replace(/\n/g, ' ').slice(0, 80));
  check('the child is banded as a child, not an adult',
        adultsBefore.replace(/\D/g, '') === (await page.locator('.sv-summary__cell')
          .first().innerText()).replace(/\D/g, ''));

  // A member with neither a date of birth nor an age cannot be banded.
  await page.fill('input[name=fullName]', 'No age given');
  await page.fill('input[name=ageYears]', '');
  await page.click('form.sv-form button[type=submit]');
  await page.waitForURL(/error=/, { timeout: 20000 });
  check('a member without an age is refused',
        (await page.locator('.sv-form__result').innerText()).includes('date of birth'));

  // --- employment ----------------------------------------------------------
  await page.goto(`${BASE}${caseUrl}/employment`, { waitUntil: 'domcontentloaded' });
  const workIncomeBefore = await figure('income from work');
  await page.selectOption('select[name=status]', 'employed');
  await page.fill('input[name=employerName]', `Aveley Logistics ${stamp}`);
  await page.fill('input[name=netPay]', '500');
  await page.selectOption('select[name=payFrequency]', 'four-weekly');
  await save('employment recorded');
  // £500 four-weekly is £541.67 monthly, not £500. Getting this wrong overstates
  // annual income by a month's pay.
  const workIncomeAdded = await figure('income from work') - workIncomeBefore;
  check('four-weekly pay is normalised, not treated as monthly',
        workIncomeAdded === 54167, `household income from work rose by ${workIncomeAdded}p`);

  // Earnings against a non-earning status must be refused.
  await page.selectOption('select[name=status]', 'unemployed');
  await page.fill('input[name=netPay]', '900');
  await page.click('form.sv-form button[type=submit]');
  await page.waitForURL(/error=/, { timeout: 20000 });
  check('pay against a non-earning status is refused',
        (await page.locator('.sv-form__result').innerText()).toLowerCase().includes('status'));

  // --- assets --------------------------------------------------------------
  await page.goto(`${BASE}${caseUrl}/assets`, { waitUntil: 'domcontentloaded' });
  const equityBefore = await figure('equity counted');
  const grossBefore = await figure('gross value');
  await page.selectOption('select[name=assetType]', 'property');
  await page.fill('input[name=description]', `Home ${stamp}`);
  await page.fill('input[name=value]', '200000');
  await page.fill('input[name=securedDebt]', '150000');
  await page.fill('input[name=share]', '50');
  await save('asset recorded');
  // £200,000 less £150,000 secured is £50,000 of equity, of which the client
  // owns half. Counting the whole £50,000 would wrongly rule out a DRO.
  const equityAdded = await figure('equity counted') - equityBefore;
  const grossAdded = await figure('gross value') - grossBefore;
  check('equity is attributed to the client share only',
        equityAdded === 2_500_000 && grossAdded === 20_000_000,
        `equity +${equityAdded}p against gross +${grossAdded}p`);

  // An exemption without a reason is refused.
  await page.fill('input[name=description]', 'Van');
  await page.fill('input[name=value]', '3000');
  await page.fill('input[name=exemption]', 'needed-for-work');
  await page.click('form.sv-form button[type=submit]');
  await page.waitForURL(/error=/, { timeout: 20000 });
  check('an exemption without a reason is refused',
        (await page.locator('.sv-form__result').innerText()).toLowerCase().includes('why'));

  // --- debts ---------------------------------------------------------------
  await page.goto(`${BASE}${caseUrl}/debts`, { waitUntil: 'domcontentloaded' });
  check('the credit search is labelled as simulated',
        (await page.locator('.sv-simulated').innerText()).includes('Simulated'));
  const securedBefore = await figure('total secured');
  const unsecuredBefore = await figure('total unsecured');
  await page.fill('input[name=creditorName]', `Fairhurst Finance ${stamp}`);
  await page.selectOption('select[name=debtType]', 'secured');
  await page.fill('input[name=balance]', '4200');
  await page.fill('input[name=payment]', '85');
  await save('debt added');
  // A secured debt belongs in the secured total and nowhere near the unsecured
  // one: the unsecured figure is what a DMP or an IVA would distribute against.
  const securedAdded = await figure('total secured') - securedBefore;
  const unsecuredAdded = await figure('total unsecured') - unsecuredBefore;
  check('secured debt is totalled apart from unsecured',
        securedAdded === 420_000 && unsecuredAdded === 0,
        `secured +${securedAdded}p, unsecured +${unsecuredAdded}p`);

  // --- income and expenditure ---------------------------------------------
  await page.goto(`${BASE}${caseUrl}/finances`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="income:wages:amount"]', '1800');
  await page.selectOption('select[name="income:wages:frequency"]', 'monthly');
  await page.selectOption('select[name="income:wages:evidence"]', 'document');
  await page.fill('input[name="expenditure:rent-or-mortgage:amount"]', '750');
  await page.fill('input[name="expenditure:food-and-housekeeping:amount"]', '400');
  await page.fill('input[name=reason]', 'Worked through in the case file suite');
  await save('statement saved');

  // The form carries the whole statement, not just the two lines edited here, so
  // the expenditure total legitimately includes the categories already on file.
  // What must hold is that the wages figure entered is the wages figure counted,
  // and that the balance is the arithmetic of the two totals rather than a
  // separately maintained number that can drift away from them.
  const income = await figure('total household income');
  const expenditure = await figure('total expenditure');
  const balance = await figure('balance');
  check('income total reflects what was entered', income === 180_000, `${income}p`);
  check('expenditure total sums the categories',
        expenditure >= 115_000, `${expenditure}p, including the categories already on file`);
  check('the balance is income less expenditure', balance === income - expenditure,
        `${income}p − ${expenditure}p = ${balance}p`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  check('saving creates a new version rather than editing',
        (await page.locator('.sv-card__title').first().innerText()).includes('version'),
        await page.locator('.sv-card__title').first().innerText());
  await page.screenshot({ path: `${OUT}/case-finances.png`, fullPage: true });

  // --- does any of it reach the advice? -----------------------------------
  await page.goto(`${BASE}${caseUrl}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-health__score');
  const overview = await page.locator('body').innerText();
  // The whole point of the file: what the adviser typed into the I&E is the
  // figure the solution comparison reasons about, not a stale seeded one.
  const surplus = (balance / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  check('Case Intelligence uses the surplus just entered',
        overview.includes(surplus), `looking for £${surplus} on the overview`);
  await page.screenshot({ path: `${OUT}/case-overview.png`, fullPage: true });

  await page.goto(`${BASE}${caseUrl}/checklist`, { waitUntil: 'domcontentloaded' });
  check('the checklist derives from the case type',
        (await page.locator('body').innerText()).includes('Advice readiness'));

  check('no missing routes behind the tabs', missing.length === 0,
        [...new Set(missing)].join(', '));
  check('no uncaught client errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
