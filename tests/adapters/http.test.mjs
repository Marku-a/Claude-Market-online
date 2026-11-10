import test from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, createHttp, need, htmlShape, assertPageSafe } from '../../extension/sites/http.js';
import { createAdapter as createRami } from '../../extension/sites/ramilevy.js';
import { createAdapter as createShufersal } from '../../extension/sites/shufersal.js';
import { createAdapter as createHazi } from '../../extension/sites/hazihinam.js';
import meta from '../../extension/sites/shufersal.js';
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
