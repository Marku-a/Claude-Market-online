import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../../extension/app/orchestrator.js';
import { CHAINS } from '../../extension/sites/registry.js';

const TODAY = '2026-11-09';
const ALLOWED = new Set(['checkLogin', 'getDeliveryContext', 'getOrders', 'search', 'getCart', 'setItem', 'emptyCart']);

const prod = (chain, id, name, price, kw = {}) => ({
  chain, id, barcode: id, name, brand: null, category: null, price, unitPrice: null, unitLabel: null,
  inStock: true, promo: null, soldBy: 'unit', ...kw,
});
const err = (code) => Object.assign(new Error(code), { code });

function makeEnv(overrides = {}) {
  const calls = [];
  const carts = { hazihinam: [], ramilevy: [], shufersal: [] };
  const catalog = {
    hazihinam: { חלב: [prod('hazihinam', '1', 'חלב תנובה 3%', 6), prod('hazihinam', '9', 'חלב שטראוס 3%', 5)], לחם: [prod('hazihinam', '2', 'לחם אחיד', 8)] },
    ramilevy: { חלב: [prod('ramilevy', '1', 'חלב תנובה 3%', 6.5)], לחם: [prod('ramilevy', '2', 'לחם אחיד', 7)] },
    shufersal: { חלב: [prod('shufersal', '1', 'חלב תנובה 3%', 7)], לחם: [prod('shufersal', '2', 'לחם אחיד', 9)] },
  };
  const rpc = async (chain, method, args) => {
    calls.push({ chain, method, args });
    if (!ALLOWED.has(method)) throw new Error('forbidden method ' + method);
    const o = overrides[`${chain}.${method}`];
    if (o) return o(args, carts[chain]);
    switch (method) {
      case 'checkLogin': return { loggedIn: true, userLabel: 'דנה' };
      case 'getDeliveryContext': return { addressLabel: 'א', storeLabel: 'ב', deliveryFee: 30, minOrder: 10 };
      case 'getOrders': return [];
      case 'search': return catalog[chain][args[0]] || [];
      case 'emptyCart': carts[chain].length = 0; return { ok: true };
      case 'setItem': {
        const [id, qty, p] = args;
        const i = carts[chain].findIndex((l) => l.id === id);
        if (i >= 0) carts[chain].splice(i, 1);
        if (qty > 0) carts[chain].push({ id, name: p.name, qty, lineTotal: p.price * qty });
        return { ok: true, qty };
      }
      case 'getCart': {
        const t = carts[chain].reduce((s, l) => s + l.lineTotal, 0);
        return { lines: [...carts[chain]], itemsTotal: t, deliveryFee: 30, grandTotal: t + 30, minOrder: 10 };
      }
    }
  };
  const m = new Map();
  const store = { get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : undefined), set: async (k, v) => { m.set(k, structuredClone(v)); } };
  return { runner: createRunner({ rpc, store, today: TODAY, chains: CHAINS }), calls, carts, store, m };
}
const ALL = ['hazihinam', 'ramilevy', 'shufersal'];

test('connect states', async () => {
  const { runner } = makeEnv({
    'hazihinam.checkLogin': () => ({ loggedIn: false }),
    'ramilevy.checkLogin': () => { throw err('BLOCKED'); },
    'shufersal.getDeliveryContext': () => { throw err('SHAPE_CHANGED'); },
  });
  const r = await runner.connect();
  assert.equal(r.hazihinam.state, 'logged_out');
  assert.equal(r.ramilevy.state, 'blocked');
  assert.equal(r.shufersal.state, 'ok');
  assert.equal(r.shufersal.userLabel, 'דנה');
  assert.equal(r.shufersal.delivery, null);
});

test('refreshHistory merges, dedupes, notes UNSUPPORTED', async () => {
  const order = { chain: 'ramilevy', id: 'o1', date: '2026-10-01', items: [] };
  const { runner, m } = makeEnv({
    'ramilevy.getOrders': () => [order],
    'hazihinam.getOrders': () => { throw err('UNSUPPORTED'); },
  });
  let r = await runner.refreshHistory(ALL);
  assert.equal(r.ramilevy.added, 1);
  assert.ok(r.hazihinam.note);
  assert.ok(r.shufersal.note); // empty
  r = await runner.refreshHistory(ALL);
  assert.equal(r.ramilevy.added, 0);
  assert.equal(m.get('orders').length, 1);
});

function histOrders() {
  const it = { id: '9', barcode: '9', name: 'חלב שטראוס 3%', brand: null, category: null, qty: 2, price: 5 };
  return [1, 2, 3].map((n) => ({ chain: 'hazihinam', id: 'h' + n, date: `2026-0${n}-01`, items: [it] }));
}

test('buildPlan: favourite extra search merged, chain error isolated, pins applied', async () => {
  const searches = [];
  const { runner, store, calls } = makeEnv({
    'shufersal.search': () => { throw err('NETWORK'); },
    'hazihinam.search': (args) => {
      searches.push(args[0]);
      if (args[0] === 'חלב שטראוס') return [prod('hazihinam', '1', 'חלב תנובה 3%', 6)];
      if (args[0] === 'חלב שטראוס 3%') return [prod('hazihinam', '9', 'חלב שטראוס 3%', 5)];
      return [prod('hazihinam', '2', 'לחם אחיד', 8)];
    },
  });
  await store.set('orders', histOrders());
  const plan = await runner.buildPlan('2 חלב שטראוס\n\nלחם', ALL);
  assert.deepEqual(searches, ['חלב שטראוס', 'חלב שטראוס 3%', 'לחם']);
  assert.equal(plan.lines.length, 2);
  assert.equal(plan.lines[0].qty, 2);
  assert.equal(plan.lines[0].chains.hazihinam.results.length, 2);
  assert.equal(plan.lines[0].chains.hazihinam.product.id, '9');
  assert.equal(plan.chainErrors.shufersal.code, 'NETWORK');
  assert.equal(plan.lines[0].chains.shufersal, undefined);
  assert.equal(plan.lines[0].chains.ramilevy.match, 'missing');
  assert.ok(plan.lines[1].chains.ramilevy.product);
  // one request at a time per chain is implied by sequential awaits
  assert.ok(calls.filter((c) => c.method === 'search' && c.chain === 'ramilevy').length >= 2);

  // pin overrides the favourite
  await store.set('pins', { 'חלב שטראוס': { barcode: '1', name: 'חלב תנובה 3%' } });
  const plan2 = await runner.buildPlan('חלב שטראוס', ['hazihinam']);
  assert.equal(plan2.lines[0].chains.hazihinam.product.id, '1');
});

test('setChoice stores pin and updates totals; setQty; toggleLine', async () => {
  const { runner, store } = makeEnv();
  const plan = await runner.buildPlan('חלב', ['hazihinam']);
  assert.equal(plan.lines[0].chains.hazihinam.product.id, '9');
  await runner.setChoice(plan, 0, 'hazihinam', '1');
  assert.equal(plan.lines[0].chains.hazihinam.lineTotal, 6);
  assert.deepEqual((await store.get('pins'))['חלב'], { barcode: '1', name: 'חלב תנובה 3%' });
  runner.setQty(plan, 0, 3);
  assert.equal(plan.lines[0].chains.hazihinam.lineTotal, 18);
  runner.toggleLine(plan, 0, false);
  assert.equal(plan.lines[0].enabled, false);
});

test('fill: empty / keep / UNSUPPORTED / item failure / extra lines', async () => {
  const { runner, carts, calls } = makeEnv({
    'shufersal.emptyCart': () => { throw err('UNSUPPORTED'); },
    'ramilevy.setItem': (args) => { if (args[0] === '1') throw err('NETWORK'); return { ok: true, qty: args[1] }; },
  });
  const plan = await runner.buildPlan('חלב\nלחם', ALL);
  carts.hazihinam.push({ id: 'x', name: 'ישן', qty: 1, lineTotal: 4 });
  carts.shufersal.push({ id: 'y', name: 'ישן', qty: 1, lineTotal: 10 });
  const fr = await runner.fill(plan, ALL, { hazihinam: 'empty', ramilevy: 'keep', shufersal: 'empty' });
  assert.equal(calls.some((c) => c.chain === 'hazihinam' && c.method === 'emptyCart'), true);
  assert.equal(calls.some((c) => c.chain === 'ramilevy' && c.method === 'emptyCart'), false);
  assert.equal(fr.hazihinam.extra, null);
  assert.equal(fr.hazihinam.cart.itemsTotal, 13);
  assert.equal(fr.shufersal.couldNotEmpty, true);
  assert.deepEqual(fr.shufersal.extra, { count: 1, total: 10 });
  assert.equal(fr.shufersal.cart.itemsTotal, 16);
  assert.equal(fr.shufersal.cart.grandTotal, null);
  assert.equal(fr.ramilevy.items.length, 2);
  assert.equal(fr.ramilevy.items[0].ok, false);
  assert.equal(fr.ramilevy.items[0].code, 'NETWORK');
  assert.equal(fr.ramilevy.items[1].ok, true);
});

test('fill: getCart failure gives null cart', async () => {
  const { runner } = makeEnv({ 'ramilevy.getCart': () => { throw err('SHAPE_CHANGED'); } });
  const plan = await runner.buildPlan('חלב', ['ramilevy']);
  const fr = await runner.fill(plan, ['ramilevy'], {});
  assert.equal(fr.ramilevy.cart, null);
});

test('finish saves runs (max 10), ownHistory, lastList; only allowed rpc methods', async () => {
  const { runner, store, calls } = makeEnv();
  let out;
  for (let i = 0; i < 12; i++) {
    const plan = await runner.buildPlan('חלב\nלחם', ALL);
    const fr = await runner.fill(plan, ALL, {});
    out = await runner.finish(plan, fr, { discounts: [], deliveryOverrides: {} });
  }
  assert.equal(out.recommendation.best, 'hazihinam');
  assert.equal(out.summary.chains.hazihinam.itemsSource, 'site');
  assert.equal((await store.get('runs')).length, 10);
  assert.equal((await store.get('lastList')), 'חלב\nלחם');
  const own = await store.get('ownHistory');
  assert.equal(own.length, 12);
  assert.equal(own[0].chain, 'app');
  assert.equal(own[0].items.length, 2);
  assert.ok(calls.length > 0);
  for (const c of calls) assert.ok(ALLOWED.has(c.method), c.method);
});
