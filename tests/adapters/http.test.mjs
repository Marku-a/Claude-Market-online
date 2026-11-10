import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterError, createHttp, need, htmlShape, assertPageSafe, runDiagnose, safeDetail,
} from '../../extension/sites/http.js';
import { createAdapter as createRami } from '../../extension/sites/ramilevy.js';
import { createAdapter as createShufersal } from '../../extension/sites/shufersal.js';
import { createAdapter as createHazi } from '../../extension/sites/hazihinam.js';
import meta from '../../extension/sites/shufersal.js';
import { createState } from '../e2e/mocks/server.mjs';
import { startMock, makeEnv, ramyStorage } from './helpers.mjs';

const chain = {
  id: 'hazihinam', origin: 'https://shop.hazi-hinam.co.il', apiOrigins: [], forbidden: [],
};
const resp = (status, body, url) => ({ status, url, text: async () => body });

test('need() names the missing path', () => {
  assert.equal(need({ a: { b: [1] } }, 'a.b', 'array').length, 1);
  assert.throws(() => need({ a: {} }, 'a.b.c'), (e) => e instanceof AdapterError && e.code === 'SHAPE_CHANGED' && /a\.b\.c/.test(e.message));
  assert.throws(() => need({ a: 'x' }, 'a', 'array'), (e) => e.code === 'SHAPE_CHANGED' && /a/.test(e.message));
  assert.throws(() => need({ a: NaN }, 'a', 'number'), (e) => e.code === 'SHAPE_CHANGED');
  assert.throws(() => need(null, 'a'), (e) => e.code === 'SHAPE_CHANGED');
});

test('status / network / parse mapping', async () => {
  const mk = (r) => createHttp(chain, async () => (r instanceof Error ? Promise.reject(r) : r));
  const url = 'https://shop.hazi-hinam.co.il/x';
  await assert.rejects(() => mk(new Error('boom')).getJson(url), (e) => e.code === 'NETWORK');
  await assert.rejects(() => mk(resp(401, 'no', url)).getJson(url), (e) => e.code === 'NOT_LOGGED_IN');
  await assert.rejects(() => mk(resp(403, 'no', url)).getText(url), (e) => e.code === 'NOT_LOGGED_IN');
  await assert.rejects(() => mk(resp(403, '<title>Just a moment...</title>', url)).getJson(url), (e) => e.code === 'BLOCKED');
  await assert.rejects(() => mk(resp(500, 'err', url)).getJson(url), (e) => e.code === 'NETWORK' && /500/.test(e.message));
  await assert.rejects(() => mk(resp(200, '<html>nope</html>', url)).getJson(url), (e) => e.code === 'SHAPE_CHANGED');
  await assert.rejects(() => mk(resp(200, '<title>Just a moment...</title>', url)).getJson(url), (e) => e.code === 'BLOCKED');
  assert.deepEqual(await mk(resp(200, '{"a":1}', url)).getJson(url), { a: 1 });
  assert.equal(await mk(resp(200, 'hi', url)).getText(url), 'hi');
});

test('requests are sent with credentials:include through safeFetch', async () => {
  let seen;
  const h = createHttp(chain, async (u, init) => { seen = { u, init }; return resp(200, '{}', u); });
  await h.postJson('https://shop.hazi-hinam.co.il/proxy/api/x', { a: 1 }, { headers: { 'x-a': '1' } });
  assert.equal(seen.init.credentials, 'include');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, '{"a":1}');
  assert.equal(seen.init.headers['x-a'], '1');
  await h.postForm('https://shop.hazi-hinam.co.il/f', { a: 'b c' });
  assert.equal(seen.init.body, 'a=b+c');
  assert.deepEqual(h.lastRaw, '{}'); // text result keeps the string
});

test('safeFetch rejects forbidden, cross-origin and redirected-to-forbidden URLs', async () => {
  let called = 0;
  const h = createHttp(chain, async (u) => { called++; return resp(200, '{}', u.includes('redir') ? 'https://shop.hazi-hinam.co.il/checkout' : u); });
  await assert.rejects(() => h.getJson('https://shop.hazi-hinam.co.il/checkout'), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(() => h.getJson('https://shop.hazi-hinam.co.il/a/../checkout/x'), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(() => h.getJson('https://shop.hazi-hinam.co.il/proxy/api/%63heckout'), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(() => h.getJson('https://evil.example/x'), (e) => e.code === 'FORBIDDEN');
  assert.equal(called, 0);
  await assert.rejects(() => h.getJson('https://shop.hazi-hinam.co.il/redir'), (e) => e.code === 'FORBIDDEN'); // final URL checked
});

test('Rami Levy api host is allowed only through apiOrigins', async () => {
  const rl = { id: 'ramilevy', origin: 'https://www.rami-levy.co.il', apiOrigins: ['https://www-api.rami-levy.co.il'], forbidden: [] };
  const h = createHttp(rl, async (u) => resp(200, '{}', u));
  assert.deepEqual(await h.getJson('https://www-api.rami-levy.co.il/api/v3/site/orders'), {});
  await assert.rejects(() => h.getJson('https://www-api.rami-levy.co.il/checkout'), (e) => e.code === 'FORBIDDEN');
  await assert.rejects(() => h.getJson('https://api.other.co.il/x'), (e) => e.code === 'FORBIDDEN');
  const noApi = createHttp({ ...rl, apiOrigins: [] }, async (u) => resp(200, '{}', u));
  await assert.rejects(() => noApi.getJson('https://www-api.rami-levy.co.il/x'), (e) => e.code === 'FORBIDDEN');
});

test('htmlShape reports counts, no content', () => {
  const s = htmlShape('<article data-product-code="P_1"></article><article data-product-code="P_2"></article>');
  assert.equal(s.selectorsFound['article[data-product-code]'], 2);
  assert.match(s.html, /^<string:\d+>$/);
});

test('assertPageSafe: ok on the chain page, FORBIDDEN on a payment page, no-op without a location', () => {
  assertPageSafe(meta, {});
  assertPageSafe(meta, { document: { location: { href: 'https://www.shufersal.co.il/online/he/' } } });
  assert.throws(() => assertPageSafe(meta, { document: { location: { href: 'https://www.shufersal.co.il/online/he/checkout/x' } } }),
    (e) => e.code === 'FORBIDDEN');
  assert.throws(() => assertPageSafe(meta, { document: { location: { href: 'https://evil.example/' } } }),
    (e) => e.code === 'FORBIDDEN');
});

test('every adapter method refuses to run on a payment page', async () => {
  const mock = await startMock();
  try {
    const cases = [
      [createRami, 'https://www.rami-levy.co.il/he/dashboard/checkout', { localStorage: ramyStorage(mock.state) }],
      [createShufersal, 'https://www.shufersal.co.il/online/he/cart/checkout', {}],
      [createHazi, 'https://shop.hazi-hinam.co.il/checkout', {}],
    ];
    for (const [make, href, extra] of cases) {
      const a = make(makeEnv(mock, { document: { location: { href }, querySelector: () => null }, ...extra }));
      for (const fn of [() => a.checkLogin(), () => a.search('x'), () => a.getCart(), () => a.setItem('1', 1),
        () => a.emptyCart(), () => a.getOrders(1), () => a.getDeliveryContext()]) {
        await assert.rejects(fn, (e) => e.code === 'FORBIDDEN', `${a.id} on ${href}`);
      }
    }
    assert.equal(mock.state.requests.length, 0);
    assert.deepEqual(mock.state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('network failure maps to NETWORK through an adapter', async () => {
  const a = createHazi({
    fetch: async () => { throw new TypeError('Failed to fetch'); }, localStorage: null, now: () => new Date(),
  });
  await assert.rejects(() => a.search('x'), (e) => e.code === 'NETWORK');
});

test('redirects are never followed: redirect:manual is sent and 3xx / opaqueredirect throw REDIRECT', async () => {
  const inits = [];
  const url = 'https://shop.hazi-hinam.co.il/x';
  const mk = (r) => createHttp(chain, async (u, init) => { inits.push(init); return r; });
  await assert.rejects(() => mk(resp(302, '', url)).getJson(url), (e) => e.code === 'REDIRECT');
  await assert.rejects(() => mk({ type: 'opaqueredirect', status: 0, url, text: async () => '' }).getText(url), (e) => e.code === 'REDIRECT');
  await assert.rejects(() => mk(resp(301, '', url)).postJson(url, {}), (e) => e.code === 'REDIRECT');
  await assert.rejects(() => mk(resp(307, '', url)).postForm(url, { a: 1 }), (e) => e.code === 'REDIRECT');
  assert.equal(inits.length, 4);
  assert.ok(inits.every((i) => i.redirect === 'manual'), 'every request uses redirect:manual');
  assert.ok(inits.every((i) => i.signal && typeof i.signal.aborted === 'boolean'), 'every request has an abort signal');
});

test('request timeout aborts and maps to NETWORK timeout', async () => {
  const url = 'https://shop.hazi-hinam.co.il/slow';
  const h = createHttp(chain, (u, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }), { timeoutMs: 20 });
  await assert.rejects(() => h.getJson(url), (e) => e.code === 'NETWORK' && e.message === 'timeout');
});

test('safeDetail only lets fixed forms through', () => {
  assert.equal(safeDetail('HTTP 500'), 'HTTP 500');
  assert.equal(safeDetail('missing field: Results.Items'), 'missing field: Results.Items');
  assert.equal(safeDetail('timeout'), 'timeout');
  assert.equal(safeDetail('redirect'), 'redirect');
  assert.equal(safeDetail('no method foo'), 'no method');
  for (const bad of ['SECRET-MARKER-123', 'missing field: a b', 'missing field: https://x/y', 'HTTP 500 at https://x', 'request failed: x',
    'missing field: a.b/c', '', undefined, null, 'unexpected type at: a']) {
    assert.equal(safeDetail(bad), undefined, String(bad));
  }
});

test('runDiagnose rows carry code + whitelisted detail, never free text', async () => {
  const fake = { lastRaw: undefined, resetRaw() { this.lastRaw = undefined; } };
  const rows = await runDiagnose(fake, [
    ['a', async () => { fake.lastRaw = { x: 'secret' }; }],
    ['b', async () => { throw new AdapterError('SHAPE_CHANGED', 'missing field: Results.Items'); }],
    ['c', async () => { throw new AdapterError('NETWORK', 'SECRET-MARKER-123 https://x/y 7357'); }],
    ['d', async () => { throw new AdapterError('NETWORK', 'HTTP 502'); }],
  ]);
  assert.deepEqual(rows.map((r) => [r.step, r.ok, r.code, r.detail]), [
    ['a', true, undefined, undefined], ['b', false, 'SHAPE_CHANGED', 'missing field: Results.Items'],
    ['c', false, 'NETWORK', undefined], ['d', false, 'NETWORK', 'HTTP 502'],
  ]);
  assert.ok(rows.every((r) => !('message' in r)));
  assert.equal(JSON.stringify(rows).includes('SECRET-MARKER'), false);
  assert.deepEqual(rows[0].shape, { x: '<string:6>' });
});

test('Shufersal: a redirect from a cart write throws REDIRECT; cartsummary redirect falls back to line sum', async () => {
  const state = createState();
  state.shufersal.cart = [{ code: 'P_522319', qty: 1 }];
  state.shufersal.redirectTo = '/online/he/checkout/payment';
  const mock = await startMock(state);
  try {
    const a = createShufersal(makeEnv(mock));
    await assert.rejects(() => a.setItem('P_100200', 1, { soldBy: 'unit' }), (e) => e.code === 'REDIRECT');
    assert.deepEqual(state.forbiddenHits, []);
    assert.deepEqual(state.requests.filter((r) => /checkout|payment/.test(r.path)), []);
  } finally {
    await mock.close();
  }
  const sum = createShufersal({
    ...makeEnv({ fetchImpl: async (u) => (String(u).endsWith('/cart/cartsummary')
      ? { status: 302, url: u, text: async () => '' }
      : { status: 200, url: u, text: async () => (String(u).includes('cart/load')
        ? '<article data-product-code="P_1" data-entry-number="0" data-entry-qty="1.0"><div class="miglog-prod-name">x</div><div class="miglog-prod-totalPrize">5.00 ₪</div></article>' : '[]') }) }),
  });
  const cart = await sum.getCart();
  assert.equal(cart.itemsTotal, 5);
  assert.equal(cart.grandTotal, null);
});
