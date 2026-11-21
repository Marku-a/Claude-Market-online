import test from 'node:test';
import assert from 'node:assert/strict';
import adapterDefault, {
  createAdapter, parseSearch, parseCart, parseSummary, unwrap, parseCartLines, parseOrderHistory, parseOrderLines,
} from '../../extension/sites/hazihinam.js';
import { fixture, startMock, makeEnv, leaks } from './helpers.mjs';

test('default export imports cleanly in Node and carries metadata', () => {
  assert.equal(adapterDefault.id, 'hazihinam');
  assert.equal(adapterDefault.origin, 'https://shop.hazi-hinam.co.il');
  assert.deepEqual(adapterDefault.apiOrigins, []);
  assert.match(adapterDefault.cartHint, /[֐-׿]/);
});

test('envelope check', () => {
  assert.deepEqual(unwrap({ IsOK: true, Results: { a: 1 } }), { a: 1 });
  assert.throws(() => unwrap({ IsOK: false, ErrorResponse: { ErrorCode: 'UNAUTHORIZED', ErrorDescription: 'x' } }),
    (e) => e.code === 'NOT_LOGGED_IN');
  assert.throws(() => unwrap({ IsOK: false, ErrorResponse: { ErrorCode: 'E1', ErrorDescription: 'פריט לא נמצא' } }),
    (e) => e.code === 'NETWORK' && /פריט/.test(e.message));
  assert.throws(() => unwrap({ Results: {} }), (e) => e.code === 'SHAPE_CHANGED');
});

test('parseSearch: price promo, informational promo, kg, stock, optional fields', () => {
  const p = parseSearch(fixture('hazihinam-search.json'));
  assert.equal(p.length, 3);
  assert.deepEqual(p[0], {
    chain: 'hazihinam', id: '7357', barcode: '7290000000012', name: 'חלב תנובה 3% 1 ליטר', brand: 'תנובה', category: null,
    price: 6.2, unitPrice: 6.2, unitLabel: 'ליטר', inStock: true,
    promo: { description: 'מבצע מיוחד', minQty: 1, totalPrice: 6.2, clubOnly: true }, soldBy: 'unit',
  });
  assert.equal(p[1].soldBy, 'kg');
  assert.deepEqual(p[1].promo, { description: '2 ב-20', minQty: 1, totalPrice: 12.9, clubOnly: false }); // informational
  assert.equal(p[2].inStock, false);
  assert.equal(p[2].barcode, null);
  assert.equal(p[2].promo, null);
  assert.throws(() => parseSearch({ IsOK: true, Results: { foo: 1 } }), (e) => e.code === 'SHAPE_CHANGED' && /Results\.Items/.test(e.message));
  assert.throws(() => parseSearch({}), (e) => e.code === 'SHAPE_CHANGED');
});

test('parseCart / parseSummary', () => {
  const v = parseCart(fixture('hazihinam-cart-items.json'), fixture('hazihinam-cart-summary.json'));
  assert.deepEqual(v.lines, [
    { id: '7357', name: 'חלב תנובה 3% 1 ליטר', qty: 2, lineTotal: 12.4 },
    { id: '7358', name: 'עגבניות שרי', qty: 0.5, lineTotal: 6.45 }, // falls back to Price_NET * qty
  ]);
  assert.equal(v.itemsTotal, 18.85);
  assert.equal(v.deliveryFee, 25);
  assert.equal(v.grandTotal, 43.85);
  assert.equal(v.minOrder, 150);
  const s = parseSummary({ Results: { CartSummary: { Price_NET_TOTAL: 0 } } });
  assert.deepEqual(s, { itemsTotal: 0, deliveryFee: null, grandTotal: null, minOrder: null });
  assert.throws(() => parseSummary({ Results: {} }), (e) => e.code === 'SHAPE_CHANGED');
  assert.throws(() => parseCart({ Results: {} }, {}), (e) => e.code === 'SHAPE_CHANGED');
});

test('parseCartLines: Items null = empty cart; other shapes still SHAPE_CHANGED', () => {
  assert.deepEqual(parseCartLines({ IsOK: true, Results: { CartItemsCount: 0, CartItems: { Items: null } } }), []);
  assert.deepEqual(parseCartLines({ Results: { CartItems: { Items: [] } } }), []);
  for (const bad of [{ Results: {} }, { Results: { CartItems: null } }, { Results: { CartItems: {} } },
    { Results: { CartItems: { Items: 'x' } } }, { Results: { CartItems: { Items: {} } } }]) {
    assert.throws(() => parseCartLines(bad), (e) => e.code === 'SHAPE_CHANGED');
  }
});

test('parseOrderHistory / parseOrderLines: drafts and bad dates skipped, newest first, qty null', () => {
  assert.deepEqual(parseOrderHistory(fixture('hazihinam-order-history.json')), [
    { id: '5103', date: '2026-10-21' }, { id: '5101', date: '2026-09-03' },
  ]);
  assert.throws(() => parseOrderHistory({ Results: {} }), (e) => e.code === 'SHAPE_CHANGED');
  const o = parseOrderLines(fixture('hazihinam-order-items.json'), '5101', '2026-09-03');
  assert.deepEqual(o, {
    chain: 'hazihinam', id: '5101', date: '2026-09-03',
    items: [
      { id: '7357', barcode: '7290000000012', name: 'חלב תנובה 3% 1 ליטר', brand: 'תנובה', category: 'מוצרי חלב', qty: null, price: 6.2 },
      { id: '7358', barcode: null, name: 'עגבניות שרי', brand: null, category: null, qty: null, price: 12.9 },
    ],
  });
  assert.throws(() => parseOrderLines({ Results: {} }, '1', '2026-01-01'), (e) => e.code === 'SHAPE_CHANGED');
});

async function setup(mutate) {
  const mock = await startMock();
  if (mutate) mutate(mock.state);
  return { mock, a: createAdapter(makeEnv(mock)), state: mock.state };
}

test('full flow (set semantics): login, search, add, raise, decrease, remove, cart', async () => {
  const { mock, a, state } = await setup();
  try {
    assert.deepEqual(await a.checkLogin(), { loggedIn: true, userLabel: 'דנה' });
    const found = await a.search('חלב');
    assert.deepEqual(found.map((p) => p.id), ['7357', '7359']);
    const adds = () => state.requests.filter((r) => r.path.endsWith('/addItemToCart')).length;

    assert.deepEqual(await a.setItem('7357', 2, found[0]), { ok: true, qty: 2 });
    assert.deepEqual(await a.setItem('7357', 2, found[0]), { ok: true, qty: 2 }); // no request needed
    assert.deepEqual(await a.setItem('7357', 4, found[0]), { ok: true, qty: 4 });
    assert.deepEqual(await a.setItem('7358', 0.5, { soldBy: 'kg' }), { ok: true, qty: 0.5 });
    assert.equal(adds(), 3);

    const cart = await a.getCart();
    assert.equal(cart.lines.length, 2);
    assert.equal(cart.itemsTotal, 31.25); // 4*6.2 + 0.5*12.9 = 24.8 + 6.45
    assert.equal(cart.deliveryFee, 25);
    assert.equal(cart.grandTotal, 56.25);
    assert.equal(cart.minOrder, 150);
    assert.deepEqual(await a.getDeliveryContext(), { addressLabel: null, storeLabel: null, deliveryFee: 25, minOrder: 150 });

    // decrease and remove are real now (set semantics, 0 removes)
    assert.deepEqual(await a.setItem('7357', 1, found[0]), { ok: true, qty: 1 });
    assert.equal(state.hazihinam.cart[7357], 1);
    assert.deepEqual(await a.setItem('7357', 0, found[0]), { ok: true, qty: 0 });
    assert.equal(7357 in state.hazihinam.cart, false);
    assert.equal(adds(), 5);
    assert.deepEqual(await a.setItem('9999', 0), { ok: true, qty: 0 }); // not in cart, 0 = no-op
    assert.equal(adds(), 5);
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('empty cart reads as no lines (Items null) and emptyCart uses DELETE removeItemsInCart', async () => {
  const { mock, a, state } = await setup();
  try {
    assert.deepEqual((await a.getCart()).lines, []);
    await a.setItem('7357', 2);
    await a.setItem('7358', 1, { soldBy: 'kg' });
    assert.deepEqual(await a.emptyCart(), { ok: true });
    assert.deepEqual(state.hazihinam.cart, {});
    const del = state.requests.filter((r) => r.method === 'DELETE');
    assert.deepEqual(del.map((r) => r.path), ['/proxy/api/item/removeItemsInCart']);
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('checkLogin label: first word of FName', async () => {
  const { mock, a, state } = await setup();
  try {
    assert.deepEqual(await a.checkLogin(), { loggedIn: true, userLabel: 'דנה' });
    assert.equal(state.hazihinam.loggedIn, true);
  } finally {
    await mock.close();
  }
  const fake = { fetch: async () => ({ status: 200, ok: true, headers: { get: () => null },
    text: async () => JSON.stringify({ IsOK: true, Results: { UserInfo: { FName: 'דנה לוי' } } }) }) };
  assert.deepEqual(await createAdapter(fake).checkLogin(), { loggedIn: true, userLabel: 'דנה' });
});

test('getOrders: draft skipped, dates converted, newest first, qty null, limit', async () => {
  const { mock, a, state } = await setup();
  try {
    const orders = await a.getOrders();
    assert.deepEqual(orders.map((o) => [o.id, o.date]), [['5103', '2026-10-21'], ['5101', '2026-09-03']]);
    assert.equal(orders[1].items.length, 2);
    assert.ok(orders.every((o) => o.chain === 'hazihinam' && o.items.every((i) => i.qty === null)));
    assert.equal(orders[0].items[0].category, 'כללי');
    assert.equal(state.requests.some((r) => r.path.endsWith('/getItemsByOrder/5102')), false); // draft never fetched
    assert.equal((await a.getOrders(1)).length, 1);
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('getOrders: hostile non-numeric order Id is never put in a URL', async () => {
  const { mock, a, state } = await setup((s) => {
    s.hazihinam.orders = [{ Id: '../../checkout', Date: '01/01/2026', IsDraftOrder: false, itemIds: [] },
      { Id: '12/../x', Date: '02/01/2026', IsDraftOrder: false, itemIds: [] }];
  });
  try {
    await assert.rejects(() => a.getOrders(), (e) => e.code === 'FORBIDDEN');
    assert.equal(state.requests.some((r) => r.path.includes('getItemsByOrder')), false);
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('logged out (guest session): checkLogin false, search/cart still work', async () => {
  const { mock, a } = await setup((s) => { s.hazihinam.loggedIn = false; });
  try {
    assert.deepEqual(await a.checkLogin(), { loggedIn: false });
    assert.equal((await a.search('חלב')).length, 2);
    assert.deepEqual(await a.setItem('7357', 1), { ok: true, qty: 1 });
  } finally {
    await mock.close();
  }
});

test('shape change and unknown item', async () => {
  const { mock, a } = await setup((s) => { s.hazihinam.variant = 'shape-changed'; });
  try {
    await assert.rejects(() => a.search('חלב'), (e) => e.code === 'SHAPE_CHANGED');
  } finally {
    await mock.close();
  }
  const m2 = await startMock();
  try {
    const b = createAdapter(makeEnv(m2));
    await assert.rejects(() => b.setItem('424242', 1), (e) => e.code === 'NETWORK' && /item not found/.test(e.message));
  } finally {
    await m2.close();
  }
});

test('ids must be digits: tampered ids are FORBIDDEN before any request', async () => {
  const { mock, a, state } = await setup();
  try {
    for (const bad of ['../../checkout', '7357/../payment', '73a', '', '1e3']) {
      await assert.rejects(() => a.setItem(bad, 1), (e) => e.code === 'FORBIDDEN');
    }
    assert.equal(state.requests.length, 0);
    assert.deepEqual(state.forbiddenHits, []);
  } finally {
    await mock.close();
  }
});

test('diagnose: structure only, every step ok', async () => {
  const { mock, a } = await setup();
  try {
    const d = await a.diagnose();
    assert.deepEqual(d.map((s) => [s.step, s.ok]), [
      ['checkLogin', true], ['search', true], ['getCart', true], ['getOrders', true], ['getDeliveryContext', true],
    ]);
    assert.equal(d[1].shape.Results.Items[1], '<+1 more>');
    assert.equal(leaks(d, 'תנובה'), false);
  } finally {
    await mock.close();
  }
});
