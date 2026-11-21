import test from 'node:test';
import assert from 'node:assert/strict';
import adapterDefault, {
  createAdapter, parseSearch, parseCart, parseCustomer, parseOrderList, parseOrderDetail, parseItemsInfo, parseAvailability, _resetCache,
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
  assert.deepEqual(c.items, { 425127: 1, 100001: 2 }); // real site: numbers (verified 2026-11-20)
  assert.equal(c.deliveryFee, null); // deliveryTimesCustomer is null before a slot is chosen
  assert.equal(c.storeId, null); // the account's own store_id is NOT the delivery store (verified 2026-11-21)
  assert.equal(parseCustomer({ user: { store_id: '179' }, deliveryTimesCustomer: { store_id: 5, price: 1 }, cart: null }).storeId, 5);
  assert.equal(parseCustomer({ user: {}, cart: null }).items && Object.keys(parseCustomer({ user: {}, cart: null }).items).length, 0);
  assert.equal(parseCustomer({ user: {}, deliveryTimesCustomer: { store_id: 5, price: 29.9 }, cart: null }).deliveryFee, 29.9);
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

    const orders = await a.getOrders(5);
    assert.equal(orders.length, 1);
    assert.equal(a.lastNote, null);
    assert.deepEqual(state.forbiddenHits, []);

    // the api host was used with ecomtoken + bearer + locale, and CORS preflight host exists
    const apiReqs = state.requests.filter((r) => r.host === 'www-api.rami-levy.co.il');
    assert.ok(apiReqs.some((r) => r.path.startsWith('/api/v2/site/clubs/customer/4242')));
    assert.ok(apiReqs.some((r) => r.path === '/api/v3/site/orders'));
    assert.ok(apiReqs.some((r) => r.path === '/api/v3/site/orders/9001'));
  } finally {
    await mock.close();
  }
});

test('parseOrderList: date from supply_at else created_at, newest first, undated skipped', () => {
  const l = parseOrderList(fixture('ramilevy-orders.json'));
  assert.deepEqual(l, [{ id: 9001, date: '2026-10-01' }, { id: 9000, date: '2026-08-15' }]);
  assert.deepEqual(parseOrderList({ data: { data: { data: [{ id: 1 }, { id: 2, created_at: 'x' }] } } }), []);
  assert.throws(() => parseOrderList({ data: {} }), (e) => e.code === 'SHAPE_CHANGED');
});

test('parseOrderDetail: delivery line skipped, barcode/brand/category mapped, strings to numbers', () => {
  const map = parseItemsInfo(fixture('ramilevy-items.json'));
  const o = parseOrderDetail(fixture('ramilevy-order-detail.json'), 9001, '2026-10-01', map);
  assert.equal(o.chain, 'ramilevy');
  assert.equal(o.id, '9001');
  assert.equal(o.date, '2026-10-01');
  assert.deepEqual(o.items[1], {
    id: '100001', barcode: '7290000000012', name: 'חלב טרי 3% בקבוק 1 ליטר', brand: 'תנובה', category: 'מוצרי חלב', qty: 2, price: 6.9,
  });
  assert.equal(o.items.length, 2);
  const bare = parseOrderDetail(fixture('ramilevy-order-detail.json'), 9001, '2026-10-01', null);
  assert.equal(bare.items[0].barcode, null);
  assert.equal(bare.items[0].brand, null);
  assert.throws(() => parseOrderDetail({ data: {} }, 1, 'd'), (e) => e.code === 'SHAPE_CHANGED');
});

test('getOrders against the mock: delivery skipped, barcodes, date, limit, no personal fields', async () => {
  const { mock, a, state } = await setup((s) => {
    s.ramilevy.orders.push({
      id: 9002, final_price: 50, supply_at: '2026-11-05 10:00:00', created_at: '2026-11-01T10:00:00.000000Z', items: [100001],
      lines: [{ item_id: 100001, name: 'חלב טרי 3% בקבוק 1 ליטר', price: '6.90', quantity: 3 }],
    });
  });
  try {
    const orders = await a.getOrders(10);
    assert.deepEqual(orders.map((o) => [o.id, o.date]), [['9002', '2026-11-05'], ['9001', '2026-10-01']]);
    const o = orders[1];
    assert.deepEqual(o.items.map((i) => i.id), ['425127', '100001']);
    assert.equal(o.items[0].barcode, '7290119672066');
    assert.equal(o.items[1].qty, 2);
    assert.equal(o.items[1].price, 6.9);
    assert.deepEqual(Object.keys(o).sort(), ['chain', 'date', 'id', 'items']);
    assert.equal((await a.getOrders(1)).length, 1);
    assert.equal(leaks(orders, RL_TOKEN), false);
    assert.equal(leaks(orders, 'supply'), false);
    assert.ok(state.requests.some((r) => r.host === 'www.rami-levy.co.il' && r.path === '/api/items' && r.method === 'POST'));
  } finally {
    await mock.close();
  }
});

test('getOrders: barcode lookup failure still returns lines with null barcodes', async () => {
  const { mock, a, state } = await setup();
  try {
    state.ramilevy.catalog = [];
    const orders = await a.getOrders(5);
    assert.equal(orders[0].items.length, 2);
    assert.ok(orders[0].items.every((i) => i.barcode === null && i.brand === null));
  } finally {
    await mock.close();
  }
});

test('getOrders: hostile non-numeric order id is never put in a URL', async () => {
  const { mock, a, state } = await setup((s) => { s.ramilevy.orders[0].id = '../../checkout'; });
  try {
    await assert.rejects(() => a.getOrders(), (e) => e.code === 'FORBIDDEN');
    assert.deepEqual(state.forbiddenHits, []);
    assert.ok(state.requests.every((r) => !/orders\/./.test(r.path)));
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

test('parseAvailability: available = cart store in available_in; no available_in = unknown', () => {
  const m = parseAvailability({ status: 200, total: 3, data: [
    { id: 1, available_in: [82, 331] }, { id: 2, available_in: ['82'] }, { id: 3 }, null,
  ] }, 331);
  assert.equal(m.get('1'), true);
  assert.equal(m.get('2'), false);
  assert.equal(m.has('3'), false);
  assert.equal(parseAvailability({ data: [{ id: 2, available_in: ['82'] }] }, '82').get('2'), true);
  assert.throws(() => parseAvailability({ foo: 1 }, 331), (e) => e.code === 'SHAPE_CHANGED');
});

test('getCart marks a line the cart store cannot supply as available:false (one /api/items call)', async () => {
  const { mock, a, state } = await setup((s) => { s.ramilevy.cart = { 100001: '1.00', 100003: '2.00' }; }); // soya: only store 82
  try {
    const cart = await a.getCart();
    const by = Object.fromEntries(cart.lines.map((l) => [l.id, l]));
    assert.equal(by['100003'].available, false);
    assert.equal('available' in by['100001'], false); // in stock: field absent
    // the real site leaves the unavailable line out of the priced response: it is reported from the stored cart
    assert.equal(by['100003'].lineTotal, 0);
    assert.equal(by['100003'].qty, 2);
    assert.ok(by['100003'].name.length > 0, 'name comes from /api/items');
    assert.equal(cart.itemsTotal, by['100001'].lineTotal); // the site's own total, untouched by us
    const items = state.requests.filter((r) => r.path === '/api/items');
    assert.equal(items.length, 1);
    assert.equal(items[0].host, 'www.rami-levy.co.il');
    assert.equal(items[0].method, 'POST');
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('getCart: availability lookup failing never throws; lines the site left out are still unavailable', async () => {
  const { mock, a } = await setup((s) => { s.ramilevy.cart = { 100003: '1.00' }; s.ramilevy.itemsFail = true; });
  try {
    const cart = await a.getCart();
    // the lookup failed, but the line the site left out of the priced cart is still reported as unavailable
    assert.equal(cart.lines.length, 1);
    assert.equal(cart.lines[0].available, false);
    assert.equal(cart.lines[0].id, '100003');
    assert.equal(cart.itemsTotal, 0);
  } finally {
    await mock.close();
  }
});

test('getCart: an empty cart makes no availability call', async () => {
  const { mock, a, state } = await setup();
  try {
    assert.deepEqual((await a.getCart()).lines, []);
    assert.ok(!state.requests.some((r) => r.path === '/api/items'));
  } finally {
    await mock.close();
  }
});
