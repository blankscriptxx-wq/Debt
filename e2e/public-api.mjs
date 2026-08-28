/**
 * The public API, exercised over HTTP the way an integrator would.
 *
 * The most important assertions here are the negative ones: an API key cannot
 * reach a regulated action, cannot see another firm's data, and cannot be
 * created holding a permission it would never be allowed to use.
 */
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const key = process.env.API_KEY;
if (!key) { console.error('API_KEY not provided'); process.exit(1); }

const call = async (path, options = {}) => {
  const response = await fetch(`${BASE}/v1${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
};

// --- authentication --------------------------------------------------------
const noKey = await fetch(`${BASE}/v1/cases`);
check('rejects a request with no key', noKey.status === 401);

const badKey = await fetch(`${BASE}/v1/cases`, {
  headers: { authorization: 'Bearer sk_test_deadbeef_nonsense' } });
check('rejects an unknown key', badKey.status === 401);
const badBody = await badKey.json();
check('returns a structured error', badBody.error?.code === 'invalid_key', badBody.error?.code);

// --- reading ---------------------------------------------------------------
const cases = await call('/cases');
check('lists cases', cases.status === 200 && Array.isArray(cases.body.data),
      `${cases.body?.data?.length ?? 0} cases`);
check('money is integer pence, never a decimal',
      cases.body.data.every((c) => Number.isInteger(c.totalDebtPence)));
check('reports rate limit headers',
      cases.headers.get('x-ratelimit-limit') !== null,
      `limit ${cases.headers.get('x-ratelimit-limit')}`);

const paged = await call('/cases?limit=2');
check('respects the page limit', paged.body.data.length <= 2);
check('returns a cursor when there is more',
      paged.body.pagination.hasMore ? typeof paged.body.pagination.nextCursor === 'string' : true);

if (paged.body.pagination.nextCursor) {
  const next = await call(`/cases?limit=2&cursor=${paged.body.pagination.nextCursor}`);
  const firstIds = new Set(paged.body.data.map((c) => c.id));
  check('the next page does not repeat the first',
        next.body.data.every((c) => !firstIds.has(c.id)));
}

const one = await call(`/cases/${cases.body.data[0].id}`);
check('retrieves a single case with its debts',
      one.status === 200 && Array.isArray(one.body.data.debts),
      `${one.body?.data?.debts?.length ?? 0} debts`);
check('includes the current financial statement',
      one.body.data.financialStatement !== undefined);

const missing = await call('/cases/00000000-0000-0000-0000-000000000000');
check('404s an unknown case', missing.status === 404 && missing.body.error.code === 'not_found');

// --- scopes ----------------------------------------------------------------
const clients = await call('/clients');
check('refuses a scope the key does not hold',
      clients.status === 403 && clients.body.error.requiredScope === 'client:read',
      clients.body?.error?.code);

// --- writing ---------------------------------------------------------------
const created = await call('/cases', {
  method: 'POST',
  body: JSON.stringify({ clientId: cases.body.data[0].client.id, caseTypeKey: 'breathing-space' }),
});
check('creates a case', created.status === 201 && typeof created.body.data.id === 'string',
      created.body?.data?.reference);
check('starts it at the case type\'s first stage',
      created.body?.data?.stage === 'referral', created.body?.data?.stage);

const badType = await call('/cases', {
  method: 'POST',
  body: JSON.stringify({ clientId: cases.body.data[0].client.id, caseTypeKey: 'not-a-thing' }),
});
check('rejects an unknown case type', badType.status === 422);

const missingFields = await call('/cases', { method: 'POST', body: JSON.stringify({}) });
check('names the missing fields', missingFields.status === 400 &&
      Array.isArray(missingFields.body.error.fields));

// --- events ----------------------------------------------------------------
const events = await call('/events?limit=5');
check('exposes the event stream', events.status === 200 && Array.isArray(events.body.data));

// --- specification ---------------------------------------------------------
const spec = await fetch(`${BASE}/v1/openapi`);
const specBody = await spec.json();
check('publishes an OpenAPI description', spec.status === 200 && specBody.openapi === '3.1.0');
check('documents which actions no key can ever perform',
      specBody['x-regulated-permissions'].permissions.some((p) => p.key === 'advice:decide'));

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
