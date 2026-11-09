import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isForbiddenUrl, assertSafe, makeSafeFetch } from '../../extension/sites/guard.js';
import { CHAINS, chainForUrl } from '../../extension/sites/registry.js';

const H = 'https://shop.hazi-hinam.co.il';
const R = 'https://www.rami-levy.co.il';
const S = 'https://www.shufersal.co.il';

describe('isForbiddenUrl', () => {
  const allowed = [
    H + '/', H + '/cart', H + '/online/he/cart', H + '/api/catalog', H + '/search?q=חלב',
    R + '/', R + '/api/search?q=milk', R + '/cart', S + '/online/he/cart', S + '/online/he/search?q=%D7%97%D7%9C%D7%91',
  ];
  const blocked = [
    H + '/checkout', R + '/cart/checkout', S + '/payment', S + '/online/he/CHECKOUT/step1',
    H + '/#/checkout', H + '/cart#/checkout', R + '/pay', R + '/pay?x=1', S + '/x/billing', S + '/credit-card',
    H + '/tashlum', R + '/order-confirm', S + '/secure/login', H + '/cart?next=%2Fcheckout',
    'https://evil.example.com/cart', 'https://shop.hazi-hinam.co.il.evil.com/cart',
    'http://shop.hazi-hinam.co.il/cart', 'https://www.google.com/', 'javascript:alert(1)', 'not a url', '',
  ];
  for (const u of allowed) test('allowed: ' + u, () => assert.equal(isForbiddenUrl(u, CHAINS), false));
  for (const u of blocked) test('blocked: ' + JSON.stringify(u), () => assert.equal(isForbiddenUrl(u, CHAINS), true));

  test('per-chain patterns apply', () => {
    const reg = { a: { origin: H, forbidden: [/\/wallet/g] } };
    assert.equal(isForbiddenUrl(H + '/wallet', reg), true);
    assert.equal(isForbiddenUrl(H + '/wallet', reg), true); // stateless despite /g
    assert.equal(isForbiddenUrl(H + '/cart', reg), false);
  });

  test('localhost only with allowLocalhost === true', () => {
    assert.equal(isForbiddenUrl('http://localhost:3000/cart', CHAINS), true);
    assert.equal(isForbiddenUrl('http://127.0.0.1:3000/cart', CHAINS), true);
    const reg = { ...CHAINS, allowLocalhost: true };
    assert.equal(isForbiddenUrl('http://localhost:3000/cart', reg), false);
    assert.equal(isForbiddenUrl('http://127.0.0.1:3000/cart', reg), false);
    assert.equal(isForbiddenUrl('http://localhost:3000/checkout', reg), true);
    assert.equal(isForbiddenUrl('http://evil.com/cart', reg), true);
    assert.equal(isForbiddenUrl('http://localhost.evil.com/cart', reg), true);
    assert.equal(isForbiddenUrl('http://localhost:3000/cart', { ...CHAINS, allowLocalhost: 'yes' }), true);
  });

  test('assertSafe throws FORBIDDEN', () => {
    assert.doesNotThrow(() => assertSafe(H + '/cart', CHAINS));
    assert.throws(() => assertSafe(H + '/checkout', CHAINS), (e) => e.code === 'FORBIDDEN');
  });
});

describe('registry', () => {
  test('three chains with exact origins', () => {
    assert.deepEqual(Object.keys(CHAINS), ['hazihinam', 'ramilevy', 'shufersal']);
    assert.equal(CHAINS.hazihinam.origin, H);
    assert.equal(CHAINS.ramilevy.origin, R);
    assert.equal(CHAINS.shufersal.origin, S);
    for (const c of Object.values(CHAINS)) {
      assert.ok(c.cartUrl.startsWith(c.origin));
      assert.ok(Array.isArray(c.forbidden));
    }
  });
  test('chainForUrl', () => {
    assert.equal(chainForUrl(R + '/x').id, 'ramilevy');
    assert.equal(chainForUrl('https://evil.com/'), null);
    assert.equal(chainForUrl('nope'), null);
  });
});

describe('makeSafeFetch', () => {
  const calls = [];
  const fake = async (url, init) => { calls.push(url); return { ok: true, url }; };
  const sf = makeSafeFetch(H, CHAINS, fake);

  test('allows same-origin, resolves relative', async () => {
    await sf('/api/catalog');
    await sf(H + '/cart', { method: 'GET' });
    assert.deepEqual(calls, [H + '/api/catalog', H + '/cart']);
  });
  test('rejects cross-origin (even other registry chains)', async () => {
    calls.length = 0;
    await assert.rejects(sf('https://evil.example.com/x'), (e) => e.code === 'FORBIDDEN');
    await assert.rejects(sf(R + '/cart'), (e) => e.code === 'FORBIDDEN');
    assert.deepEqual(calls, []);
  });
  test('rejects forbidden paths', async () => {
    calls.length = 0;
    await assert.rejects(sf('/checkout'), (e) => e.code === 'FORBIDDEN');
    await assert.rejects(sf(H + '/cart/checkout'), (e) => e.code === 'FORBIDDEN');
    assert.deepEqual(calls, []);
  });
  test('rejects redirect to forbidden/cross-origin final URL', async () => {
    const redir = makeSafeFetch(H, CHAINS, async () => ({ url: H + '/payment' }));
    await assert.rejects(redir('/cart'), (e) => e.code === 'FORBIDDEN');
    const redir2 = makeSafeFetch(H, CHAINS, async () => ({ url: 'https://evil.com/' }));
    await assert.rejects(redir2('/cart'), (e) => e.code === 'FORBIDDEN');
  });
});
