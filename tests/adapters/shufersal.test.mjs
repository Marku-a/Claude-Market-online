import test from 'node:test';
import assert from 'node:assert/strict';
import adapterDefault, {
  createAdapter, parseSearch, parseCartDoc, parseSummaryTotal, parsePrice, parseDeliveryFee,
  parseOrderList, parseOrderDetail, toIsoDate,
} from '../../extension/sites/shufersal.js';
import { fixture, startMock, makeEnv, parseHtml, leaks } from './helpers.mjs';

test('default export imports cleanly in Node and carries metadata', () => {
  assert.equal(adapterDefault.id, 'shufersal');
  assert.equal(adapterDefault.cartUrl, 'https://www.shufersal.co.il/online/he/cart/cartsummary');
  assert.ok(adapterDefault.forbidden.some((r) => r.test('/online/he/cart/cartFromOrder')));
  assert.ok(adapterDefault.forbidden.some((r) => r.test('/online/he/checkout/x')));
  assert.ok(!adapterDefault.forbidden.some((r) => r.test('/online/he/authentication/get-status-includes-otp')));
});

test('parsePrice', () => {
  assert.equal(parsePrice('12.90 ₪'), 12.9);
  assert.equal(parsePrice('₪ 7'), 7);
  assert.equal(parsePrice('1,234.50 ₪'), 1234.5);
  assert.equal(parsePrice('סה"כ: 99.5'), 99.5);
  assert.equal(parsePrice('אין'), null);
  assert.equal(parsePrice(null), null);
});

test('parseSearch', () => {
  const p = parseSearch(fixture('shufersal-search.json'));
  assert.equal(p.length, 4);
  assert.deepEqual(p[0], {
    chain: 'shufersal', id: 'P_522319', barcode: null, name: 'חלב טרי מהגולן 3%', brand: 'גולן', category: null,
    price: 7.35, unitPrice: null, unitLabel: null, inStock: true, promo: null, soldBy: 'unit',
  });
  assert.equal(p[1].barcode, '7290000000999');
  assert.deepEqual(p[1].promo, { description: 'מבצע', minQty: 2, totalPrice: 11.8, clubOnly: false });
  assert.equal(p[2].soldBy, 'kg');
  assert.equal(p[2].unitPrice, 9.9);
  assert.equal(p[2].inStock, true); // missing stock -> true
  assert.equal(p[3].inStock, false);
  assert.throws(() => parseSearch({ foo: 1 }), (e) => e.code === 'SHAPE_CHANGED' && /results/.test(e.message));
});

test('parseCartDoc / parseSummaryTotal', () => {
  const doc = parseHtml(fixture('shufersal-cart.html'));
  assert.deepEqual(parseCartDoc(doc), [
    { id: 'P_522319', name: 'חלב טרי מהגולן 3%', qty: 2, lineTotal: 14.7, entryNumber: 0 },
    { id: 'P_100200', name: 'בננות', qty: 1.5, lineTotal: 1014.85, entryNumber: 1 },
  ]);
  assert.equal(parseSummaryTotal(parseHtml(fixture('shufersal-cartsummary.html'))), 29.55);
  assert.equal(parseSummaryTotal(parseHtml('<div></div>')), null);
  assert.deepEqual(parseCartDoc(parseHtml('<div></div>')), []);
  assert.throws(() => parseCartDoc(parseHtml('<article data-product-code="P_1"></article>')), (e) => e.code === 'SHAPE_CHANGED');
});

test('parseDeliveryFee searches recursively and never throws', () => {
  assert.equal(parseDeliveryFee(fixture('shufersal-slots.json')), 19.9);
  assert.equal(parseDeliveryFee([{ price: { value: 5 } }, { price: { value: 3 } }]), 3);
  assert.equal(parseDeliveryFee({ foo: 1 }), null);
  assert.equal(parseDeliveryFee(null), null);
});

test('orders parsing', () => {
  const list = parseOrderList(fixture('shufersal-orders.json'));
  assert.deepEqual(list, [{ code: '70001', date: '2026-09-15' }, { code: '70002', date: '2026-10-03' }]); // garbage date skipped
  assert.equal(toIsoDate('31/02/2026'), null);
  assert.equal(toIsoDate('1.2.2026'), '2026-02-01');
  const o = parseOrderDetail(fixture('shufersal-order-detail.json'), '70001', '2026-09-15');
  assert.deepEqual(o, {
    chain: 'shufersal', id: '70001', date: '2026-09-15',
    items: [{ id: 'P_522319', barcode: null, name: 'חלב טרי מהגולן 3%', brand: null, category: null, qty: 2, price: 7.35 }],
  }); // delivery item skipped
  assert.throws(() => parseOrderList({ activeOrders: [] }), (e) => e.code === 'SHAPE_CHANGED');
  assert.throws(() => parseOrderDetail({}, 'x', 'd'), (e) => e.code === 'SHAPE_CHANGED');
});

async function setup(mutate, envExtra) {
  const mock = await startMock();
  if (mutate) mutate(mock.state);
  const env = makeEnv(mock, envExtra);
  return { mock, env, a: createAdapter(env), state: mock.state };
}
const paths = (state, re) => state.requests.filter((r) => re.test(r.path));

test('full flow: login, search, add/change/remove, cart totals + fee, empty, orders; CSRF fetched from home', async () => {
  const { mock, a, state } = await setup();
  try {
    assert.deepEqual(await a.checkLogin(), { loggedIn: true });
    const found = await a.search('חלב');
    assert.deepEqual(found.map((p) => p.id), ['P_522319', 'P_7290000000999', 'P_100300']);

    // add (ordering: the mock rejects add before load with 400, and POST without CSRF with 403)
    assert.deepEqual(await a.setItem('P_522319', 2, found[0]), { ok: true, qty: 2 });
    assert.deepEqual(state.shufersal.cart, [{ code: 'P_522319', qty: 2 }]);
    const firstLoad = state.requests.findIndex((r) => r.path.endsWith('/cart/load'));
    const firstAdd = state.requests.findIndex((r) => r.path.endsWith('/cart/add'));
    assert.ok(firstLoad >= 0 && firstLoad < firstAdd, 'cart/load before cart/add');
    // CSRF came from the home page (no document available)
    assert.equal(paths(state, /^\/online\/he\/?$/).length, 1);

    // kg item as BY_WEIGHT
    assert.deepEqual(await a.setItem('P_100200', 1.5, { soldBy: 'kg' }), { ok: true, qty: 1.5 });
    // change quantity of existing line -> update
    assert.deepEqual(await a.setItem('P_522319', 3, found[0]), { ok: true, qty: 3 });
    assert.equal(state.shufersal.cart.find((l) => l.code === 'P_522319').qty, 3);

    const cart = await a.getCart();
    assert.equal(cart.lines.length, 2);
    assert.deepEqual(cart.lines[0], { id: 'P_522319', name: 'חלב טרי מהגולן 3%', qty: 3, lineTotal: 22.05, entryNumber: 0 });
    assert.equal(cart.itemsTotal, 22.05 + 14.85);
    assert.equal(cart.deliveryFee, 19.9);
    assert.equal(cart.minOrder, null);
    assert.ok(Math.abs(cart.grandTotal - (cart.itemsTotal + 19.9)) < 1e-9);
    assert.deepEqual(await a.getDeliveryContext(), { addressLabel: null, storeLabel: null, deliveryFee: 19.9, minOrder: null });

    // remove first line: entry numbers renumber, adapter re-reads
    assert.deepEqual(await a.setItem('P_522319', 0), { ok: true, qty: 0 });
    assert.deepEqual(state.shufersal.cart.map((l) => l.code), ['P_100200']);
    assert.deepEqual(await a.setItem('P_100200', 0), { ok: true, qty: 0 });

    // out-of-stock product -> add failed
    await assert.rejects(() => a.setItem('P_100300', 1, found[2]), (e) => e.code === 'NETWORK' && /add failed/.test(e.message));
    // unknown cart line with qty 0 -> no-op
    assert.deepEqual(await a.setItem('P_522319', 0), { ok: true, qty: 0 });

    // emptyCart removes the first line repeatedly
    await a.setItem('P_522319', 1, found[0]);
    await a.setItem('P_7290000000999', 2, found[1]);
    await a.setItem('P_100200', 1, { soldBy: 'kg' });
    assert.equal(state.shufersal.cart.length, 3);
    assert.deepEqual(await a.emptyCart(), { ok: true });
    assert.deepEqual(state.shufersal.cart, []);

    const orders = await a.getOrders(5);
    assert.equal(orders.length, 1);
    assert.deepEqual(orders[0].items.map((i) => i.id), ['P_522319']);
    assert.equal(orders[0].date, '2026-09-15');

    assert.deepEqual(state.forbiddenHits, []);
    assert.ok(state.requests.every((r) => !/cartFromOrder|checkout|payment/i.test(r.path)));
    // CSRF cached: home fetched once overall
    assert.equal(paths(state, /^\/online\/he\/?$/).length, 1);
  } finally {
    await mock.close();
  }
});

test('CSRF is read from the page meta tag when a document is available (no home fetch)', async () => {
  const doc = parseHtml('<html><head><meta name="_csrf" content="test-csrf"></head></html>');
  const document = { location: { href: 'https://www.shufersal.co.il/online/he/' }, querySelector: (s) => doc.querySelector(s) };
  const { mock, a, state } = await setup(null, { document });
  try {
    assert.deepEqual(await a.setItem('P_522319', 1, { soldBy: 'unit' }), { ok: true, qty: 1 });
    assert.equal(paths(state, /^\/online\/he\/?$/).length, 0);
  } finally {
    await mock.close();
  }
});

test('wrong CSRF -> NOT_LOGGED_IN (403) and nothing is added', async () => {
  const { mock, a, state } = await setup((s) => { s.shufersal.csrf = 'rotated'; });
  try {
    // home still serves the current csrf, so poison the cache by pre-seeding via a bad meta document
    const doc = parseHtml('<meta name="_csrf" content="stale">');
    const bad = createAdapter(makeEnv(mock, { document: { querySelector: (s) => doc.querySelector(s) } }));
    await assert.rejects(() => bad.setItem('P_522319', 1), (e) => e.code === 'NOT_LOGGED_IN');
    assert.deepEqual(state.shufersal.cart, []);
    assert.deepEqual(await a.setItem('P_522319', 1), { ok: true, qty: 1 });
  } finally {
    await mock.close();
  }
});

test('logged out: checkLogin false; cartsummary 401 -> itemsTotal = sum of lines, grandTotal null', async () => {
  const { mock, a, state } = await setup((s) => {
    s.shufersal.loggedIn = false;
    s.shufersal.cart = [{ code: 'P_522319', qty: 2 }];
  });
  try {
    assert.deepEqual(await a.checkLogin(), { loggedIn: false });
    const cart = await a.getCart();
    assert.equal(cart.itemsTotal, 14.7);
    assert.equal(cart.grandTotal, null);
    assert.equal(cart.lines.length, 1);
    await assert.rejects(() => a.getOrders(1), (e) => e.code === 'NOT_LOGGED_IN');
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('shape change -> SHAPE_CHANGED', async () => {
  const { mock, a } = await setup((s) => { s.shufersal.variant = 'shape-changed'; });
  try {
    await assert.rejects(() => a.search('חלב'), (e) => e.code === 'SHAPE_CHANGED');
  } finally {
    await mock.close();
  }
});

test('tampered product codes are FORBIDDEN before any request', async () => {
  const { mock, a, state } = await setup();
  try {
    for (const bad of ['../../checkout', 'P_1/../payment', 'P 1', 'P_1?x=1', '']) {
      await assert.rejects(() => a.setItem(bad, 1), (e) => e.code === 'FORBIDDEN');
    }
    assert.equal(state.requests.length, 0);
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('a hostile order code from the server is never fetched', async () => {
  const { mock, a, state } = await setup((s) => {
    s.shufersal.orders = [{ code: '../checkout', createdString: '01/01/2026', total: 1, entries: [] }];
  });
  try {
    assert.deepEqual(await a.getOrders(5), []);
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('token-like values never leak; diagnose gives structure only', async () => {
  const { mock, a } = await setup();
  try {
    const results = [await a.checkLogin(), await a.search('חלב'), await a.setItem('P_522319', 1), await a.getCart(),
      await a.getDeliveryContext(), await a.getOrders(1), await a.emptyCart()];
    assert.equal(leaks(results, 'test-csrf'), false);
    await a.setItem('P_522319', 1);
    const d = await a.diagnose();
    assert.equal(leaks(d, 'test-csrf'), false);
    assert.deepEqual(d.map((s) => s.step), ['checkLogin', 'search', 'getCart', 'getOrders', 'getDeliveryContext']);
    assert.ok(d.every((s) => s.ok), JSON.stringify(d));
    const cartShape = d[2].shape;
    assert.equal(cartShape.selectorsFound['.miglog-cart-summary-totalprice'], 1); // last response of getCart = cartsummary
    assert.match(cartShape.html, /^<string:\d+>$/);
    assert.equal(d[3].shape.entries[0].product.code, '<string:8>'); // last response = order detail
  } finally {
    await mock.close();
  }
});
