import test from 'node:test';
import assert from 'node:assert/strict';
import adapterDefault, {
  createAdapter, parseSearch, parseCart, parseCustomer, _resetCache,
} from '../../extension/sites/ramilevy.js';
import { fixture, startMock, makeEnv, ramyStorage, leaks } from './helpers.mjs';
import { RL_TOKEN } from '../e2e/mocks/server.mjs';

test('default export imports cleanly in Node and carries metadata', () => {
  assert.equal(adapterDefault.id, 'ramilevy');
  assert.equal(adapterDefault.origin, 'https://www.rami-levy.co.il');
  assert.deepEqual(adapterDefault.apiOrigins, ['https://www-api.rami-levy.co.il']);
  assert.ok(adapterDefault.forbidden.every((r) => r instanceof RegExp));
  assert.match(adapterDefault.cartHint, /[֐-׿]/);
});

test('parseSearch maps fields, promo, kg, stock', () => {
  const p = parseSearch(fixture('ramilevy-search.json'), { store: 331 });
  assert.equal(p.length, 3); // item without price skipped
  assert.deepEqual(p[0], {
    chain: 'ramilevy', id: '425127', barcode: '7290119672066', name: 'תערובת חליטת צמחים בטעם קרמל מלוח רמי לוי',
    brand: 'רמי לוי', category: 'משקאות ואלכוהול', price: 8.9, unitPrice: null, unitLabel: null, inStock: true,
    promo: null, soldBy: 'unit',
  });
  assert.deepEqual(p[1].promo, { description: '2 ב-12 ש"ח', minQty: 2, totalPrice: 12, clubOnly: true });
  assert.equal(p[2].soldBy, 'kg');
  assert.equal(p[2].inStock, false); // 331 not in available_in
  assert.equal(p[2].promo, null); // cmt 0 ignored
  assert.equal(p[2].brand, null);
});

test('parseSearch: missing available_in = in stock; SHAPE_CHANGED without data', () => {
  const p = parseSearch({ data: [{ id: 1, name: 'x', price: { price: 1 } }] }, { store: 331 });
  assert.equal(p[0].inStock, true);
  assert.equal(p[0].barcode, null);
  assert.throws(() => parseSearch({ foo: 1 }, {}), (e) => e.code === 'SHAPE_CHANGED' && /data/.test(e.message));
});

test('parseCart / parseCustomer', () => {
  const v = parseCart(fixture('ramilevy-cart.json'), null);
  assert.deepEqual(v.lines.map((l) => [l.id, l.qty, l.lineTotal]), [['425127', 1, 8.9], ['100001', 2, 12]]);
  assert.equal(v.itemsTotal, 20.9);
  assert.equal(v.deliveryFee, 29.9);
  assert.ok(Math.abs(v.grandTotal - 50.8) < 1e-9);
  assert.equal(v.minOrder, null);
  const noDel = parseCart({ items: [], price: 0 }, 12);
  assert.equal(noDel.deliveryFee, 12);
  assert.equal(parseCart({ items: [], price: 0 }, null).deliveryFee, null);
  assert.throws(() => parseCart({ items: [] }), (e) => e.code === 'SHAPE_CHANGED');
  const c = parseCustomer(fixture('ramilevy-customer.json'));
  assert.deepEqual(c.items, { 425127: '1.00', 100001: '2.00' });
  assert.equal(c.deliveryFee, 29.9);
  assert.deepEqual(parseCustomer({ user: {}, cart: { items: [] } }).items, {});
  assert.throws(() => parseCustomer({ user: {} }), (e) => e.code === 'SHAPE_CHANGED');
});

async function setup(mutate) {
  _resetCache();
  const mock = await startMock();
  if (mutate) mutate(mock.state);
  const env = makeEnv(mock, { localStorage: ramyStorage(mock.state) });
  return { mock, env, a: createAdapter(env), state: mock.state };
}

test('full flow against the mock: login, search, set/replace/remove, cart totals, empty, orders', async () => {
  const { mock, a, state } = await setup();
  try {
    assert.deepEqual(await a.checkLogin(), { loggedIn: true, userLabel: 'דנה' });
    const found = await a.search('חלב');
    assert.deepEqual(found.map((p) => p.id), ['100001', '100003']);
    assert.equal(found[0].promo.minQty, 2);
    assert.equal(found[1].inStock, false);

    assert.deepEqual(await a.setItem('425127', 1), { ok: true, qty: 1 });
    // replace semantics: adding a second item must preserve the first
    assert.deepEqual(await a.setItem('100001', 2), { ok: true, qty: 2 });
    assert.deepEqual(state.ramilevy.cart, { 425127: '1.00', 100001: '2.00' });
    // change quantity
    assert.deepEqual(await a.setItem('100001', 3), { ok: true, qty: 3 });
    assert.equal(state.ramilevy.cart[100001], '3.00');
    assert.equal(state.ramilevy.cart[425127], '1.00');

    const cart = await a.getCart();
    assert.equal(cart.lines.length, 2);
    assert.equal(cart.itemsTotal, 29.6);
    assert.equal(cart.deliveryFee, 29.9);
    assert.ok(Math.abs(cart.grandTotal - 59.5) < 1e-9);
    assert.equal(cart.minOrder, null);
    assert.deepEqual(await a.getDeliveryContext(), { addressLabel: null, storeLabel: '331', deliveryFee: 29.9, minOrder: null });

    // remove
    assert.deepEqual(await a.setItem('100001', 0), { ok: true, qty: 0 });
    assert.deepEqual(state.ramilevy.cart, { 425127: '1.00' });

    assert.deepEqual(await a.emptyCart(), { ok: true });
    assert.deepEqual(state.ramilevy.cart, {});
    assert.equal((await a.getCart()).lines.length, 0);

    assert.deepEqual(await a.getOrders(5), []);
    assert.equal(a.lastNote, 'ORDER_LINES_UNKNOWN');
    assert.deepEqual(state.forbiddenHits, []);

    // the api host was used with ecomtoken + bearer + locale, and CORS preflight host exists
    const apiReqs = state.requests.filter((r) => r.host === 'www-api.rami-levy.co.il');
    assert.ok(apiReqs.some((r) => r.path.startsWith('/api/v2/site/clubs/customer/4242')));
    assert.ok(apiReqs.some((r) => r.path === '/api/v3/site/orders'));
  } finally {
    await mock.close();
  }
});

test('writes without ecomtoken do not persist (mock) - adapter sends it', async () => {
  const { mock, a, state } = await setup();
  try {
    await a.setItem('425127', 1);
    assert.equal(state.ramilevy.cart[425127], '1.00');
  } finally {
    await mock.close();
  }
});

test('logged out: search works with store 331, no auth headers; cart methods throw NOT_LOGGED_IN', async () => {
  const { mock, state } = await setup((s) => { s.ramilevy.loggedIn = false; });
  try {
    const env = makeEnv(mock); // empty localStorage -> logged out
    const a = createAdapter(env);
    assert.deepEqual(await a.checkLogin(), { loggedIn: false });
    const found = await a.search('חלב');
    assert.equal(found.length, 2);
    assert.ok(state.requests.every((r) => r.host !== 'www-api.rami-levy.co.il'));
    for (const fn of [() => a.getCart(), () => a.setItem('425127', 1), () => a.emptyCart(), () => a.getDeliveryContext(), () => a.getOrders(1)]) {
      await assert.rejects(fn, (e) => e.code === 'NOT_LOGGED_IN');
    }
    // stale token in localStorage but server says logged out -> 401 -> NOT_LOGGED_IN
    const stale = createAdapter(makeEnv(mock, { localStorage: ramyStorage(state) }));
    await assert.rejects(() => stale.getCart(), (e) => e.code === 'NOT_LOGGED_IN');
  } finally {
    await mock.close();
  }
});

test('shape change surfaces as SHAPE_CHANGED', async () => {
  const { mock, a } = await setup((s) => { s.ramilevy.variant = 'shape-changed'; });
  try {
    await assert.rejects(() => a.search('חלב'), (e) => e.code === 'SHAPE_CHANGED');
  } finally {
    await mock.close();
  }
});

test('ids are validated: tampered ids are FORBIDDEN and nothing reaches the network', async () => {
  const { mock, a, state } = await setup();
  try {
    for (const bad of ['../../checkout', '12/../payment', '1a', '', '١٢']) {
      await assert.rejects(() => a.setItem(bad, 1), (e) => e.code === 'FORBIDDEN');
    }
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('token never appears in any method result', async () => {
  const { mock, a } = await setup();
  try {
    const results = [
      await a.checkLogin(), await a.search('חלב'), await a.setItem('425127', 1), await a.getCart(),
      await a.getDeliveryContext(), await a.getOrders(1), await a.emptyCart(), await a.diagnose(),
    ];
    assert.equal(leaks(results, RL_TOKEN), false);
    assert.equal(leaks(results, 'Bearer'), false);
  } finally {
    await mock.close();
  }
});

test('diagnose returns redacted shapes only', async () => {
  const { mock, a } = await setup();
  try {
    const d = await a.diagnose();
    assert.deepEqual(d.map((s) => s.step), ['checkLogin', 'search', 'getCart', 'getOrders', 'getDeliveryContext']);
    assert.ok(d.every((s) => s.ok));
    assert.equal(d[0].shape, null); // localStorage only, no request
    assert.deepEqual(Object.keys(d[1].shape).sort(), ['data', 'q', 'status', 'total']);
    assert.match(JSON.stringify(d[1].shape), /<string:\d+>/);
    assert.equal(JSON.stringify(d).includes('חלב'), false);
  } finally {
    await mock.close();
  }
});
