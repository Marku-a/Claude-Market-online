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

test('fill: failing pre-read is a chain error; failing re-read gives a null cart', async () => {
  const { runner } = makeEnv({ 'ramilevy.getCart': () => { throw err('SHAPE_CHANGED'); } });
  const plan = await runner.buildPlan('חלב', ['ramilevy']);
  const fr = await runner.fill(plan, ['ramilevy'], {});
  assert.equal(fr.ramilevy.error.code, 'SHAPE_CHANGED'); // never guess existing quantities
  let n = 0;
  const e2 = makeEnv({ 'ramilevy.getCart': () => { if (++n > 1) throw err('SHAPE_CHANGED'); return { lines: [] }; } });
  const plan2 = await e2.runner.buildPlan('חלב', ['ramilevy']);
  const fr2 = await e2.runner.fill(plan2, ['ramilevy'], {});
  assert.equal(fr2.ramilevy.cart, null);
  assert.equal(fr2.ramilevy.error, null);
});

test('keep: overlapping product is raised to existing + wanted; only our units are compared', async () => {
  const { runner, carts, calls } = makeEnv();
  const plan = await runner.buildPlan('2 חלב\nלחם', ['ramilevy']);
  carts.ramilevy.push({ id: '1', name: 'חלב תנובה 3%', qty: 5, lineTotal: 32.5 }); // 5 x 6.5 already there
  carts.ramilevy.push({ id: 'x', name: 'ישן', qty: 1, lineTotal: 4 });
  const fr = await runner.fill(plan, ['ramilevy'], { ramilevy: 'keep' });
  const sets = calls.filter((c) => c.method === 'setItem').map((c) => [c.args[0], c.args[1]]);
  assert.deepEqual(sets, [['1', 7], ['2', 1]]); // absolute set of existing + wanted
  assert.equal(carts.ramilevy.find((l) => l.id === '1').qty, 7);
  assert.deepEqual(fr.ramilevy.items.map((i) => [i.existingQty, i.wantedQty, i.actualQty, i.ok]), [[5, 2, 7, true], [0, 1, 1, true]]);
  // our share: 2 of 7 units of milk (13) + bread 7 = 20; the rest is "extra"
  assert.equal(fr.ramilevy.cart.itemsTotal, 20);
  assert.equal(fr.ramilevy.cart.grandTotal, null);
  assert.deepEqual(fr.ramilevy.extra, { count: 2, total: r2(4 + 32.5) });
  const out = await runner.finish(plan, fr, { discounts: [], deliveryOverrides: {} });
  const run = out.summary.chains.ramilevy;
  assert.equal(run.itemsTotal, 20);
  assert.deepEqual(out.summary.lines.map((l) => l.chains.ramilevy.match), ['similar', 'similar']);
});

function r2(x) { return Math.round(x * 100) / 100; }

test('keep never lowers a quantity (Hatzi-style sites that cannot decrease)', async () => {
  let current = 3;
  const { runner, calls } = makeEnv({
    'hazihinam.getCart': () => ({ lines: [{ id: '1', name: 'חלב תנובה 3%', qty: current, lineTotal: 6 * current }], itemsTotal: 6 * current }),
    'hazihinam.setItem': (args) => {
      if (args[1] < current) throw err('UNSUPPORTED');
      current = args[1];
      return { ok: true, qty: current };
    },
  });
  const plan = await runner.buildPlan('2 חלב', ['hazihinam']);
  assert.equal(plan.lines[0].chains.hazihinam.product.id, '9'); // cheapest; pick the overlapping one explicitly
  await runner.setChoice(plan, 0, 'hazihinam', '1');
  const fr = await runner.fill(plan, ['hazihinam'], { hazihinam: 'keep' });
  assert.equal(fr.hazihinam.items[0].code, null);
  assert.equal(current, 5);
  assert.deepEqual(calls.filter((c) => c.method === 'setItem').map((c) => c.args[1]), [5]);
  assert.equal(fr.hazihinam.cart.itemsTotal, 12); // 2 of 5 units at 6
});

test('keep: an over-incrementing site is reported honestly (not ok, extra units counted as ours only up to wanted)', async () => {
  let current = 3;
  const { runner } = makeEnv({
    'hazihinam.getCart': () => ({ lines: [{ id: '1', name: 'חלב תנובה 3%', qty: current, lineTotal: 6 * current }], itemsTotal: 6 * current }),
    'hazihinam.setItem': (args) => { current += args[1]; return { ok: false, qty: current, code: 'UNSUPPORTED' }; },
  });
  const plan = await runner.buildPlan('2 חלב', ['hazihinam']);
  await runner.setChoice(plan, 0, 'hazihinam', '1');
  const fr = await runner.fill(plan, ['hazihinam'], { hazihinam: 'keep' });
  const it = fr.hazihinam.items[0];
  assert.equal(it.ok, false);
  assert.equal(it.actualQty, 8);
  assert.equal(it.code, 'UNSUPPORTED');
  assert.equal(fr.hazihinam.cart.itemsTotal, r2((6 * 8 * 2) / 8));
});

test('empty: emptyCart {ok:false} counts as couldNotEmpty and continues as keep', async () => {
  const { runner, carts, calls } = makeEnv({ 'shufersal.emptyCart': () => ({ ok: false }) });
  const plan = await runner.buildPlan('חלב', ['shufersal']);
  carts.shufersal.push({ id: '1', name: 'חלב תנובה 3%', qty: 4, lineTotal: 28 });
  const fr = await runner.fill(plan, ['shufersal'], { shufersal: 'empty' });
  assert.equal(fr.shufersal.couldNotEmpty, true);
  assert.equal(calls.find((c) => c.method === 'setItem').args[1], 5); // keep semantics: 4 + 1
  assert.equal(fr.shufersal.items[0].existingQty, 4);
  assert.deepEqual(fr.shufersal.extra, { count: 1, total: 28 }); // the 4 units that were already there (4 x 7)
  assert.equal(fr.shufersal.cart.itemsTotal, 7); // our 1 of 5 units
});

test('empty: successful emptyCart sets absolute quantities (no pre-read)', async () => {
  const { runner, carts, calls } = makeEnv();
  const plan = await runner.buildPlan('חלב', ['shufersal']);
  carts.shufersal.push({ id: '1', name: 'חלב תנובה 3%', qty: 4, lineTotal: 28 });
  const fr = await runner.fill(plan, ['shufersal'], { shufersal: 'empty' });
  assert.equal(fr.shufersal.couldNotEmpty, false);
  assert.equal(calls.find((c) => c.method === 'setItem').args[1], 1);
  assert.equal(fr.shufersal.extra, null);
  assert.equal(calls.filter((c) => c.method === 'getCart').length, 1); // only the verification read
});

test('finish: a line is missing only when absent from the re-read cart or nothing was added', async () => {
  const { runner } = makeEnv({
    'ramilevy.setItem': (args, cart) => {
      if (args[0] === '1') return { ok: false, qty: 0 };
      cart.push({ id: args[0], name: 'x', qty: args[1], lineTotal: 7 * args[1] });
      return { ok: true, qty: args[1] };
    },
  });
  const plan = await runner.buildPlan('חלב\nלחם', ['ramilevy']);
  const fr = await runner.fill(plan, ['ramilevy'], { ramilevy: 'keep' });
  const out = await runner.finish(plan, fr, { discounts: [], deliveryOverrides: {} });
  assert.deepEqual(out.summary.lines.map((l) => l.chains.ramilevy.match), ['missing', 'similar']);
});

test('buildPlan: non-fatal search failure affects only that line; fatal codes fail the chain', async () => {
  const { runner } = makeEnv({
    'hazihinam.search': (args) => { if (args[0] === 'לחם') throw err('NETWORK'); return [prod('hazihinam', '1', 'חלב תנובה 3%', 6)]; },
    'ramilevy.search': () => { throw err('REDIRECT'); },
    'shufersal.search': (args) => { if (args[0] === 'לחם') throw err('FORBIDDEN'); throw err('UNSUPPORTED'); },
  });
  const plan = await runner.buildPlan('חלב\nלחם', ALL);
  assert.equal(plan.chainErrors.ramilevy.code, 'REDIRECT');
  assert.equal(plan.chainErrors.shufersal.code, 'FORBIDDEN'); // every line failed -> last code
  assert.equal(plan.chainErrors.hazihinam, undefined);
  const h = plan.lines.map((l) => l.chains.hazihinam);
  assert.equal(h[0].searchError, undefined);
  assert.ok(h[0].product);
  assert.equal(h[1].searchError, 'NETWORK');
  assert.equal(h[1].product, null);
  assert.deepEqual(h[1].results, []);
  assert.equal(h[1].match, 'missing');
  for (const code of ['SHAPE_CHANGED', 'NOT_LOGGED_IN', 'BLOCKED']) {
    const e = makeEnv({ 'hazihinam.search': (args) => { if (args[0] === 'לחם') throw err(code); return [prod('hazihinam', '1', 'חלב', 6)]; } });
    const p = await e.runner.buildPlan('חלב\nלחם', ['hazihinam']);
    assert.equal(p.chainErrors.hazihinam.code, code);
  }
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
