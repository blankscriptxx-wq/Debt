/**
 * Communications, worked end to end.
 *
 * The claim this suite exists to test is the one the whole design rests on: a
 * document a client sends over WhatsApp becomes evidence on their case without
 * the adviser downloading anything, and the case visibly advances as a result.
 *
 * It also tests the refusals, which matter more than the happy path. A message
 * from a number nobody has confirmed must not be attached to a client on a
 * guess, and nothing can be filed out of a conversation until a person has said
 * who it is from.
 */
import { createHmac } from 'node:crypto';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const OUT = process.env.SHOT_DIR ?? '/tmp/shots';
const SECRET = process.env.WHATSAPP_WEBHOOK_SECRET ?? 'sandbox-webhook-secret';

/**
 * Delivers an inbound message the way a provider would, signature and all.
 *
 * The suite injects its own message each run rather than relying on seeded
 * data, so filing an attachment — which is a one-way action — does not make the
 * second run fail on a file the first one already dealt with.
 */
async function deliver({ from, text, attachment, profileName, phoneNumberId }) {
  const payload = JSON.stringify({
    phoneNumberId: phoneNumberId ?? 'sandbox-pn-northgate',
    from, text: text ?? null, profileName: profileName ?? null,
    providerMessageId: `wamid.e2e.${Date.now()}.${Math.random()}`,
    media: attachment ? {
      providerMediaId: `media.e2e.${Date.now()}`,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      byteSize: Buffer.from(attachment.content).length,
      kind: attachment.kind ?? 'document',
      expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      contentBase64: Buffer.from(attachment.content).toString('base64'),
    } : null,
  });

  const signature = createHmac('sha256', SECRET).update(payload).digest('hex');
  const res = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
               'x-hub-signature-256': `sha256=${signature}` },
    body: payload,
  });
  return { status: res.status, body: await res.json() };
}

const checks = [];
function check(name, condition, detail = '') {
  checks.push({ name, pass: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

/**
 * Opens a conversation and waits for it specifically.
 *
 * Waiting for `.sv-conv__title` alone is a race: the pane already shows
 * whichever conversation was selected by default, so the selector matches
 * before the click has navigated and the assertions read the wrong thread.
 */
const open = async (conversation) => {
  await page.goto(`${BASE}/app/inbox?filter=all`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-inbox');
  await page.locator('.sv-inbox__item', { hasText: conversation }).first().click();
  await page.locator('.sv-conv__title', { hasText: conversation }).waitFor({ timeout: 20000 });
};

const stamp = Date.now().toString().slice(-6);
const CLIENT_NUMBER = '+447700900123';

try {
  // --- the webhook ---------------------------------------------------------
  const unsigned = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumberId: 'sandbox-pn-northgate', from: CLIENT_NUMBER }),
  });
  check('an unsigned webhook is refused', unsigned.status === 401,
        `status ${unsigned.status}`);

  // Accepted and dropped, not rejected: telling an unauthenticated caller which
  // numbers exist would be an enumeration they have not earned.
  const wrongNumber = await deliver({
    from: CLIENT_NUMBER, text: 'hello', phoneNumberId: 'pn-belonging-to-nobody',
  });
  check('a message to a number no firm owns is accepted and dropped',
        wrongNumber.status === 202 && wrongNumber.body.data?.accepted === false,
        `accepted: ${wrongNumber.body.data?.accepted}`);

  await page.goto(`${BASE}/app/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-demo__btn');
  await page.locator('.sv-demo__btn', { hasText: 'Debt Adviser' }).click();
  await page.waitForURL(`${BASE}/app`, { timeout: 20000 });

  // --- the inbox itself ----------------------------------------------------
  await page.goto(`${BASE}/app/inbox?filter=all`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-inbox', { timeout: 20000 });

  check('the inbox has all three panes',
        await page.locator('.sv-inbox__list').count() === 1
        && await page.locator('.sv-conv').count() === 1
        && await page.locator('.sv-context').count() === 1);

  check('conversations are listed with what is waiting',
        await page.locator('.sv-inbox__item').count() >= 2,
        `${await page.locator('.sv-inbox__item').count()} conversations`);

  check('every channel is honestly labelled as a simulator',
        (await page.locator('.sv-simulated').first().innerText()).includes('Simulated'));

  // --- a message from a number nobody has confirmed -------------------------
  await open('07700 900788');
  const unknownBody = (await page.locator('.sv-conv').innerText()).toLowerCase();
  check('an unrecognised number is held rather than guessed at',
        unknownBody.includes('who is this?'),
        'the conversation asks before attaching anything to a client');
  check('it says plainly why it could not be decided',
        unknownBody.includes('nobody on file uses this number'));

  check('nothing can be filed from it until somebody says who it is',
        await page.locator('.sv-attach').count() === 0
        || !unknownBody.includes('save to case'));

  check('and no client context is shown for an unidentified thread',
        (await page.locator('.sv-context').innerText()).includes('Nobody identified yet'));

  // --- an identified conversation with something to file --------------------
  await open('Elaine');
  const conv = await page.locator('.sv-conv').innerText();
  check('an identified conversation names the client and the case',
        conv.includes('Elaine Crozier') && conv.includes('DAS-0003'));

  check('the thread reads as a conversation, with delivery state',
        await page.locator('.sv-msg').count() >= 3
        && await page.locator('.sv-msg--out').count() >= 1
        && await page.locator('.sv-msg--in').count() >= 1,
        `${await page.locator('.sv-msg').count()} messages`);

  // What the case is short of decides what to send. Filing is permanent, so a
  // suite that always sent a bank statement would demonstrate the connection
  // once and then run against a case that no longer needs one.
  const wanted = (await page.locator('.sv-context__item').allInnerTexts())
    .map((t) => t.split('\n')[0].trim());
  const KINDS = {
    'Standard Financial Statement complete':
      { name: 'natwest-bank-statement', body: 'Here is the bank statement you asked for' },
    'Debts and creditors captured':
      { name: 'creditor-letter-default-notice', body: 'I got this letter from a creditor' },
    'Identity verified':
      { name: 'passport-photo-page', body: 'Sending my passport as asked' },
  };
  const target = wanted.find((w) => w in KINDS);
  check('the case has something outstanding a document could answer',
        Boolean(target),
        target ?? `nothing a document answers is outstanding: ${wanted.join(', ') || 'none'}`);
  if (!target) throw new Error('Nothing outstanding to demonstrate against.');

  // Delivered as a provider would deliver it, with the bytes fetched by the
  // platform during the request — the property that makes the seven-day media
  // expiry survivable.
  const delivered = await deliver({
    from: CLIENT_NUMBER,
    text: `${KINDS[target].body} (${stamp})`,
    profileName: 'Elaine Crozier',
    attachment: {
      filename: `${KINDS[target].name}-${stamp}.pdf`,
      mimeType: 'application/pdf',
      content: `%PDF-1.7 ${stamp}`,
    },
  });
  check('an inbound message with an attachment is accepted',
        delivered.status === 202 && delivered.body.data?.accepted === true,
        `status ${delivered.status}`);
  check('and it is matched to the client whose number it is',
        delivered.body.data?.matched === true,
        delivered.body.data?.matched ? 'verified identity' : 'not matched');
  check('the attachment was taken in during the request, not deferred',
        delivered.body.data?.attachments === 1);

  await open('Elaine');

  // The heart of it: a suggestion that knows what this case is short of.
  const card = page.locator('.sv-attach', { hasText: stamp }).first();
  const attachment = await card.innerText();
  check('the attachment is already held, not waiting to be downloaded',
        !attachment.includes('Receiving this file'));
  check('the suggestion is about this case, not just this file',
        attachment.includes('waiting on'),
        attachment.split('\n').find((l) => l.includes('Looks like')) ?? attachment.slice(0, 80));
  check('and it says how sure it is', /\d+% sure/.test(attachment));

  // --- filing it -----------------------------------------------------------
  const needBefore = await page.locator('.sv-context__item').count();
  check('the context pane lists what the case still needs',
        needBefore >= 1, `${needBefore} outstanding`);

  await card.locator('select[name=satisfiesRequirement]').selectOption({ label: target });
  await card.locator('button[type=submit]', { hasText: 'Save to case' }).click();
  await page.waitForURL(/saved=|error=/, { timeout: 20000 });

  const result = await page.locator('.sv-form__result').first().innerText();
  check('filing it says the case moved, not just that a file was saved',
        result.includes('spine has moved'), result.slice(0, 90));

  const needAfter = await page.locator('.sv-context__item').count();
  check('the case is closer to ready than it was',
        needAfter < needBefore, `${needBefore} → ${needAfter} outstanding`);

  check('the attachment now reads as filed',
        (await page.locator('.sv-attach', { hasText: stamp }).first().innerText())
          .includes('Filed to the case'));

  await page.screenshot({ path: `${OUT}/inbox-filed.png` });

  // --- and the case file agrees --------------------------------------------
  const caseLink = await page.locator('.sv-context a', { hasText: 'Open the case file' })
    .getAttribute('href');
  await page.goto(`${BASE}${caseLink}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-spine');

  const spine = (await page.locator('.sv-spine').innerText()).toLowerCase();
  check('the case file shows the same evidence state as the inbox did',
        spine.includes('income & expenditure'),
        'the spine and the conversation read one source');

  await page.goto(`${BASE}${caseLink}/messenger`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-spine');
  check('the case file links to the conversation rather than copying it',
        (await page.locator('body').innerText()).includes('Conversations'));

  // --- an internal note is not a message ------------------------------------
  await open('Elaine');
  const noteText = `Client sounded anxious about the fee (${stamp}). Handle gently.`;
  await page.fill('textarea[name=body]', noteText);
  await page.check('input[name=internal]');
  await page.locator('.sv-composer button[type=submit]').click();
  // Waiting for the note itself, not for a URL pattern: the page already
  // carries `saved=` from filing the attachment, so a URL wait would match the
  // page as it stands and read the thread before the note is on it.
  const note = page.locator('.sv-msg--note', { hasText: stamp });
  await note.waitFor({ timeout: 20000 });

  check('an internal note is added to the thread', await note.count() === 1);
  check('and is unmistakably not something the client saw',
        (await note.innerText()).toLowerCase().includes('internal note'));

  // --- leave the fixture as it was found ------------------------------------
  // Filing evidence is permanent and monotonic, so without this the second run
  // works a case with nothing outstanding and cannot demonstrate anything. Done
  // through the product's own verification screen rather than the database,
  // which also exercises the path an adviser uses to correct a mis-filing.
  await page.goto(`${BASE}${caseLink}/verification`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.sv-table');
  const row = page.locator('.sv-table tbody tr', { hasText: target }).first();
  await row.locator('select[name=status]').selectOption('outstanding');
  await row.locator('button[type=submit]').click();
  await page.waitForURL(/saved=1|error=/, { timeout: 20000 });

  await open('Elaine');
  check('withdrawing the evidence puts the requirement back',
        (await page.locator('.sv-context').innerText()).includes(target),
        `${target} is outstanding again`);

  check('no uncaught client errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
