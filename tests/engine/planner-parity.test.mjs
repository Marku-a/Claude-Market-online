// Translation of tests/test_planner.py (engine parts) with the same numbers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, similarity, parseListLine, productKey } from '../../extension/engine/text.js';
import { buildProfile, coPurchases } from '../../extension/engine/profile.js';
import { lineCost, promoWorth } from '../../extension/engine/choose.js';
import { TODAY, order, cand, MILK, BREAD, EGGS, runPlan } from './helpers.mjs';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);
const dated = (i) => `2026-10-${String(i + 1).padStart(2, '0')}`;

describe('text', () => {
  test('normalize', () => {
    assert.equal(normalize('חָלָב,  תנובה!! 3%'), 'חלב תנובה 3%');
    assert.equal(normalize('  Milk-2 '), 'milk 2');
    assert.equal(normalize('חלב־טרה'), 'חלב טרה');
  });
  test('similarity', () => {
    assert.equal(similarity('', 'חלב'), 0);
    assert.equal(similarity('חלב 3%', 'חלב 3%'), 1);
    near(similarity('חלב 3%', 'חלב'), 0.5);
  });
  test('parse', () => {
    let p = parseListLine('2 חלב');
    assert.deepEqual([p.qty, p.query], [2, 'חלב']);
    for (const s of ['חלב x2', 'חלב X2', 'חלב ×2', 'חלב *2', 'חלב×2']) {
      p = parseListLine(s);
      assert.deepEqual([p.qty, p.query], [2, 'חלב'], s);
    }
    p = parseListLine('חלב 3%');
    assert.deepEqual([p.qty, p.query], [null, 'חלב 3%']);
    assert.equal(parseListLine('3% חלב').qty, null);
    p = parseListLine('חלב 2');
    assert.deepEqual([p.qty, p.query], [null, 'חלב 2']);
    assert.equal(parseListLine('100 חלב').qty, null);
    assert.equal(parseListLine('   '), null);
    assert.equal(parseListLine('# הערה'), null);
  });
  test('latin word ending in x is not qty', () => {
    assert.equal(parseListLine('MAX2').qty, null);
    assert.equal(parseListLine('במבה x3').qty, 3);
    assert.equal(parseListLine('במבה×3').qty, 3);
  });
  test('productKey: barcode else normalized name', () => {
    assert.equal(productKey({ barcode: '123', name: 'x' }), '123');
    assert.equal(productKey({ barcode: null, name: 'עגבניות!' }), 'עגבניות');
  });
});

describe('profile', () => {
  const h = [
    order('a', '2026-10-01', [...MILK, 2, 6.9], [...BREAD, 1, 7.5]),
    order('b', '2026-10-11', [...MILK, 3, 7.0], [...BREAD, 1, 7.5]),
    order('c', '2026-10-31', [...MILK, 2, 7.1], [...BREAD, 1, 7.5]),
  ];
  test('profile', () => {
    const pr = buildProfile(h, TODAY);
    const m = pr.products['1'];
    assert.equal(m.orderCount, 3);
    assert.equal(m.totalQty, 7);
    assert.equal(m.typicalQty, 2);
    assert.equal(m.lastPrice, 7.1);
    assert.equal(m.lastDate, '2026-10-31');
    assert.equal(m.avgIntervalDays, 15);
    assert.equal(m.daysSinceLast, 9);
    assert.deepEqual(pr.brandCounts['חלב'], { 'תנובה': 3 });
    assert.equal(pr.meta.orders, 3);
  });
  test('interval null and name key', () => {
    const o = { chain: 'x', id: 'x', date: '2026-10-01', items: [{ id: null, barcode: null, name: 'עגבניות!', qty: 1, price: 5 }] };
    const pr = buildProfile([o], TODAY);
    assert.ok('עגבניות' in pr.products);
    assert.equal(pr.products['עגבניות'].avgIntervalDays, null);
  });
  test('typical qty half up', () => {
    const o = [order('a', '2026-10-01', [...MILK, 2, 7]), order('b', '2026-10-08', [...MILK, 3, 7])];
    assert.equal(buildProfile(o, TODAY).products['1'].typicalQty, 3);
  });
  test('orderCount merges chains', () => {
    const a = order('a', '2026-10-01', [...MILK, 1, 7]);
    const b = { ...order('b', '2026-10-01', [...MILK, 1, 7]), chain: 'ramilevy' };
    const pr = buildProfile([a, b], TODAY);
    assert.equal(pr.products['1'].orderCount, 2);
    assert.equal(pr.products['1'].avgIntervalDays, null); // same day -> no gap
    assert.equal(pr.meta.orders, 2);
  });
  test('co purchases', () => {
    const o = [
      order('a', '2026-10-01', [...MILK, 1, 7], [...BREAD, 1, 7], [...EGGS, 1, 12]),
      order('b', '2026-10-08', [...MILK, 1, 7], [...BREAD, 1, 7]),
      order('c', '2026-10-15', [...MILK, 1, 7], [...BREAD, 1, 7]),
      order('d', '2026-10-22', [...BREAD, 1, 7]),
    ];
    const co = coPurchases(o);
    const d = Object.fromEntries(co.map((r) => [r.a + '|' + r.b, r]));
    assert.equal(d['1|2'].support, 3);
    near(d['1|2'].confidence, 1);
    near(d['2|1'].confidence, 0.75);
    assert.ok(!('1|3' in d));
    assert.equal(co[0].confidence, 1);
  });
});

describe('plan', () => {
  const milkHist = (n, qty = 1, price = 7.4) =>
    Array.from({ length: n }, (_, i) => order(String(i), dated(i), [...MILK, qty, price]));

  test('prefers history over cheaper', () => {
    const h = milkHist(4, 2, 7.0);
    const res = runPlan(h, ['חלב 3%'], [{ line: 'חלב 3%', results: [
      cand('9', 'חלב כלשהו 3%', 5.0, { brand: 'X', category: 'חלב' }),
      cand('1', MILK[1], 7.4, { brand: 'תנובה', category: 'חלב' })] }]);
    const it = res.items[0];
    assert.equal(it.product.id, '1');
    assert.equal(it.qty, 2);
    assert.ok(it.reasons.includes('קנית את המוצר הזה ב-4 הזמנות'));
    assert.equal(it.alternatives[0].id, '9');
  });

  test('cheapest without history', () => {
    const res = runPlan([], ['שמן'], [{ line: 'שמן', results: [
      cand('a', 'שמן קנולה', 12.0), cand('b', 'שמן קנולה', 9.0), cand('c', 'שמן קנולה', 10.0)] }]);
    const it = res.items[0];
    assert.equal(it.product.id, 'b');
    assert.equal(it.qty, 1);
    assert.ok(it.reasons.includes('הזול ביותר מבין התוצאות'));
  });

  test('missing', () => {
    const res = runPlan([], ['אורז', 'שוקולד'], [
      { line: 'אורז', results: [cand('a', 'אורז', 9, { inStock: false })] },
      { line: 'שוקולד', results: [] }]);
    assert.deepEqual(Object.fromEntries(res.missing.map((m) => [m.line, m.reason])),
      { 'אורז': 'אזל מהמלאי', 'שוקולד': 'לא נמצא באתר' });
    assert.ok(res.items.every((i) => i.status === 'missing'));
    assert.equal(res.estimatedTotal, 0);
  });

  test('line match by normalized', () => {
    const res = runPlan([], ['חלב  3%!'], [{ line: 'חלב 3%', results: [cand('a', 'חלב 3%', 6)] }]);
    assert.equal(res.items[0].status, 'ok');
  });

  test('promo applied', () => {
    const promo = { description: '2 ב-12', minQty: 2, totalPrice: 12.0 };
    const res = runPlan([], ['3 חלב'], [{ line: '3 חלב', results: [cand('1', 'חלב', 7.4, { promo })] }]);
    const it = res.items[0];
    assert.equal(it.promoApplied, true);
    assert.equal(it.promoSaving, 2.8);
    assert.equal(it.lineTotal, 19.4);
    assert.equal(res.estimatedTotal, 19.4);
  });

  test('deal suggestion', () => {
    const promo = { description: '2 ב-12', minQty: 2, totalPrice: 12.0 };
    const searches = [{ line: 'חלב', results: [cand('1', MILK[1], 7.4, { promo })] }];
    let res = runPlan(milkHist(3), ['חלב'], searches);
    assert.equal(res.items[0].promoApplied, false);
    const d = res.deals[0];
    assert.deepEqual([d.currentQty, d.suggestedQty], [1, 2]);
    assert.equal(d.extraCost, 4.6);
    assert.equal(d.savingPerUnit, 1.4);
    res = runPlan(milkHist(2), ['חלב'], searches);
    assert.deepEqual(res.deals, []);
  });

  test('swap threshold', () => {
    const h = Array.from({ length: 4 }, (_, i) => order(String(i), dated(i), ['1', 'חלב תנובה 3%', 'תנובה', 'חלב', 2, 10.0]));
    const go = (alt) => runPlan(h, ['2 חלב'], [{ line: '2 חלב', results: [
      cand('1', 'חלב תנובה 3%', 10.0, { brand: 'תנובה' }), cand('2', 'חלב טרה 3%', alt)] }]).swaps;
    assert.equal(go(9.0).length, 1);
    assert.deepEqual(go(9.01), []);
    const s = go(8.0)[0];
    assert.deepEqual([s.savingPerUnit, s.savingTotal], [2.0, 4.0]);
    assert.equal(s.to.id, '2');
  });

  test('price change threshold', () => {
    const h = [order('a', '2026-10-01', ['1', 'מוצר א', 'x', 'c', 1, 10], ['2', 'מוצר ב', 'x', 'c', 1, 10],
      ['3', 'מוצר ג', 'x', 'c', 1, 10], ['4', 'מוצר ד', 'x', 'c', 1, 10])];
    const res = runPlan(h, ['מוצר א'], [{ line: 'מוצר א', results: [cand('1', 'מוצר א', 10.3)] }],
      [cand('2', 'מוצר ב', 10.29), cand('3', 'מוצר ג', 9.7), cand('4', 'מוצר ד', 9.71)]);
    assert.deepEqual(Object.fromEntries(res.changes.map((c) => [c.id, c.pct])), { '1': 3.0, '3': -3.0 });
    assert.deepEqual(res.changes.map((c) => c.id), ['1', '3']);
  });

  test('price change skips lastPrice <= 0', () => {
    const h = [order('a', '2026-10-01', ['1', 'מוצר א', 'x', 'c', 1, 0])];
    const res = runPlan(h, ['מוצר א'], [{ line: 'מוצר א', results: [cand('1', 'מוצר א', 10)] }]);
    assert.deepEqual(res.changes, []);
  });

  const periodic = () => [
    order('a', '2026-08-01', [...MILK, 1, 7], [...BREAD, 1, 7]),
    order('b', '2026-08-15', [...MILK, 1, 7], [...BREAD, 1, 7]),
    order('c', '2026-08-29', [...MILK, 1, 7], [...BREAD, 1, 7]),
    order('d', '2026-10-31', [...BREAD, 1, 7]),
  ];

  test('maybe forgot', () => {
    const res = runPlan(periodic(), ['לחם'], [{ line: 'לחם', results: [cand('2', BREAD[1], 7)] }]);
    assert.deepEqual(res.forgot.map((f) => f.key), ['1']);
    assert.ok(res.forgot[0].reason.includes('14'));
  });

  test('maybe forgot excluded when on list', () => {
    const res = runPlan(periodic(), ['חלב תנובה 3% 1 ליטר'], [{ line: 'חלב תנובה 3% 1 ליטר', results: [] }]);
    assert.deepEqual(res.forgot.filter((f) => f.key === '1'), []);
  });

  test('forgot excludes any result key', () => {
    const h = [
      order('a', '2026-08-01', [...MILK, 1, 7], [...BREAD, 1, 7]),
      order('b', '2026-08-15', [...MILK, 1, 7], [...BREAD, 1, 7]),
      order('c', '2026-08-29', [...MILK, 1, 7], [...BREAD, 1, 7])];
    const res = runPlan(h, ['לחם', 'אורז'], [
      { line: 'לחם', results: [cand('2', BREAD[1], 7)] },
      { line: 'אורז', results: [cand('1', MILK[1], 7, { inStock: false })] }]);
    assert.deepEqual(res.forgot, []);
  });

  test('goes with', () => {
    const h = ['2026-10-12', '2026-10-26', '2026-11-09'].map((d, i) =>
      order(String(i), d, [...MILK, 1, 7], [...EGGS, 1, 12]));
    let res = runPlan(h, ['חלב'], [{ line: 'חלב', results: [cand('1', MILK[1], 7)] }]);
    assert.equal(res.goes.length, 1);
    const g = res.goes[0];
    assert.deepEqual([g.key, g.with, g.confidence], ['3', MILK[1], 1.0]);
    res = runPlan(h, ['חלב', 'ביצים'], [{ line: 'חלב', results: [cand('1', MILK[1], 7)] },
      { line: 'ביצים', results: [cand('3', EGGS[1], 12)] }]);
    assert.deepEqual(res.goes, []);
  });

  test('swap accounts for applied promo', () => {
    const promo = { description: '2 ב-12', minQty: 2, totalPrice: 12.0 };
    const h = Array.from({ length: 4 }, (_, i) => order(String(i), dated(i), [...MILK, 2, 7.0]));
    const res = runPlan(h, ['2 חלב'], [{ line: '2 חלב', results: [
      cand('1', MILK[1], 7.4, { brand: 'תנובה', category: 'חלב', promo }),
      cand('2', 'חלב טרה 3% 1 ליטר', 6.2, { category: 'חלב' })] }]);
    assert.equal(res.items[0].product.id, '1');
    assert.deepEqual(res.swaps, []);
  });

  test('swap still worth after promo', () => {
    const promo = { description: '2 ב-14', minQty: 2, totalPrice: 14.0 };
    const h = Array.from({ length: 4 }, (_, i) => order(String(i), dated(i), ['1', 'חלב תנובה 3%', 'תנובה', 'חלב', 2, 10.0]));
    const res = runPlan(h, ['2 חלב'], [{ line: '2 חלב', results: [
      cand('1', 'חלב תנובה 3%', 10.0, { brand: 'תנובה' }), cand('2', 'חלב טרה 3%', 9.5, { promo })] }]);
    const s = res.swaps[0];
    assert.deepEqual([s.savingTotal, s.savingPerUnit], [6.0, 3.0]);
  });

  test('zero price no crash', () => {
    const res = runPlan([], ['שקית'], [{ line: 'שקית', results: [cand('1', 'שקית', 0), cand('2', 'שקית גדולה', 0)] }]);
    assert.deepEqual(res.swaps, []);
    assert.equal(res.estimatedTotal, 0);
  });

  test('mixed unit price uses price', () => {
    const h = Array.from({ length: 4 }, (_, i) => order(String(i), dated(i), ['1', 'קפה נמס עלית 200 גרם', 'עלית', 'קפה', 1, 21.9]));
    const res = runPlan(h, ['קפה'], [{ line: 'קפה', results: [
      cand('1', 'קפה נמס עלית 200 גרם', 21.9, { unitPrice: 10.95, brand: 'עלית', category: 'קפה' }),
      cand('2', 'קפה נמס עלית 100 גרם', 13.5, { brand: 'עלית', category: 'קפה' })] }]);
    assert.equal(res.items[0].product.id, '1');
    assert.deepEqual(res.swaps, []);
  });
});

describe('promo math', () => {
  const p = (price, promo, soldBy = 'unit') => cand('1', 'x', price, { promo, soldBy });
  test('promoWorth threshold', () => {
    assert.equal(promoWorth(p(10, { minQty: 2, totalPrice: 19 })), true);
    assert.equal(promoWorth(p(10, { minQty: 2, totalPrice: 19.1 })), false);
    assert.equal(promoWorth(p(0, { minQty: 2, totalPrice: 1 })), false);
    assert.equal(promoWorth(p(10, null)), false);
  });
  test('lineCost promo and remainder', () => {
    const c = lineCost(p(7.4, { minQty: 2, totalPrice: 12 }), 5);
    assert.deepEqual(c, { total: 12 * 2 + 7.4, promoApplied: true, promoSaving: 5.6 });
  });
  test('lineCost below minQty has no promo', () => {
    assert.deepEqual(lineCost(p(7.4, { minQty: 2, totalPrice: 12 }), 1), { total: 7.4, promoApplied: false, promoSaving: 0 });
  });
  test('lineCost kg: fractional qty, promo ignored', () => {
    assert.deepEqual(lineCost(p(10, { minQty: 1, totalPrice: 5 }, 'kg'), 1.5),
      { total: 15, promoApplied: false, promoSaving: 0 });
  });
});
