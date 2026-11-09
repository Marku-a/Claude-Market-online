import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile } from '../../extension/engine/profile.js';
import { matchLine, applyDiscounts, summarize, recommend } from '../../extension/engine/compare.js';
import { parseListLine } from '../../extension/engine/text.js';
import { TODAY, order, cand, MILK } from './helpers.mjs';

const hist = (n = 3) => Array.from({ length: n }, (_, i) =>
  order(String(i), `2026-10-${String(i + 1).padStart(2, '0')}`, [...MILK, 2, 7.0]));
const prof = () => buildProfile(hist(), TODAY);
const L = (s) => parseListLine(s);

describe('matchLine', () => {
  test('identical by barcode, qty from favourite', () => {
    const m = matchLine(L('חלב'), {
      hazihinam: [cand('1', MILK[1], 7.4)],
      shufersal: [cand('x9', 'שם אחר לגמרי', 3, { barcode: '1' })],
    }, prof());
    assert.equal(m.reference.id, '1');
    assert.equal(m.chains.hazihinam.match, 'identical');
    assert.equal(m.chains.shufersal.match, 'identical');
    assert.equal(m.chains.shufersal.product.id, 'x9');
    assert.equal(m.chains.hazihinam.qty, 2);
    assert.equal(m.chains.shufersal.qty, 2);
    assert.equal(m.chains.shufersal.lineTotal, 6);
  });

  test('similar and different', () => {
    const m = matchLine(L('חלב'), {
      hazihinam: [cand('1', MILK[1], 7.4)],
      ramilevy: [cand('r1', 'חלב טרה 3% 1 ליטר', 6.5)],
      shufersal: [cand('s1', 'שוקולד פרה', 5)],
    }, prof());
    assert.equal(m.chains.ramilevy.match, 'similar');
    assert.equal(m.chains.shufersal.match, 'different');
  });

  test('missing when no in-stock result; others unaffected', () => {
    const m = matchLine(L('חלב'), {
      hazihinam: [cand('1', MILK[1], 7.4)],
      ramilevy: [cand('r1', 'חלב', 6, { inStock: false })],
      shufersal: [],
    }, prof());
    assert.equal(m.chains.ramilevy.match, 'missing');
    assert.equal(m.chains.ramilevy.missingReason, 'אזל מהמלאי');
    assert.equal(m.chains.ramilevy.lineTotal, 0);
    assert.equal(m.chains.shufersal.missingReason, 'לא נמצא באתר');
    assert.equal(m.chains.hazihinam.match, 'identical');
  });

  test('no reference -> similar, qty parsed or 1, same across chains', () => {
    const m = matchLine(L('3 שמן'), {
      hazihinam: [cand('a', 'שמן קנולה', 10)],
      ramilevy: [cand('b', 'שמן זית', 9)],
    }, buildProfile([], TODAY));
    assert.equal(m.reference, null);
    assert.equal(m.chains.hazihinam.match, 'similar');
    assert.equal(m.chains.ramilevy.match, 'similar');
    assert.equal(m.chains.hazihinam.qty, 3);
    assert.equal(m.chains.ramilevy.qty, 3);
    assert.equal(matchLine(L('שמן'), { a: [cand('a', 'שמן', 1)] }, buildProfile([], TODAY)).qty, 1);
  });

  test('parsed qty beats favourite typical qty', () => {
    const m = matchLine(L('5 חלב'), { hazihinam: [cand('1', MILK[1], 7.4)] }, prof());
    assert.equal(m.qty, 5);
  });
});

describe('applyDiscounts', () => {
  const d = (o) => ({ chain: 'x', label: 'L', type: 'percent', value: 10, minBasket: 0, cap: null, enabled: true, ...o });
  test('percent', () => assert.equal(applyDiscounts(200, [d({})]).discountTotal, 20));
  test('percent capped', () => {
    const r = applyDiscounts(500, [d({ cap: 30 })]);
    assert.equal(r.discountTotal, 30);
    assert.equal(r.afterDiscount, 470);
  });
  test('fixed', () => assert.equal(applyDiscounts(100, [d({ type: 'fixed', value: 15 })]).discountTotal, 15));
  test('minBasket not met', () => {
    const r = applyDiscounts(99, [d({ minBasket: 100 })]);
    assert.equal(r.discountTotal, 0);
    assert.deepEqual(r.applied, []);
    assert.equal(applyDiscounts(100, [d({ minBasket: 100 })]).discountTotal, 10);
  });
  test('stacking is additive on itemsTotal', () => {
    const r = applyDiscounts(200, [d({}), d({ type: 'fixed', value: 5, label: 'F' })]);
    assert.equal(r.discountTotal, 25);
    assert.equal(r.applied.length, 2);
  });
  test('floor at 0', () => {
    const r = applyDiscounts(10, [d({ type: 'fixed', value: 30 })]);
    assert.equal(r.discountTotal, 10);
    assert.equal(r.afterDiscount, 0);
  });
  test('disabled ignored', () => assert.equal(applyDiscounts(100, [d({ enabled: false })]).discountTotal, 0));
});

// chainRuns builder: lines = [[match, lineTotal], ...]
const run = (lines, cart = null, status = 'ok') => ({
  status, cart,
  lines: lines.map(([match, lineTotal], i) => ({
    line: `l${i}`, match, product: match === 'missing' ? null : cand(`p${i}`, `p${i}`, lineTotal), qty: 1, lineTotal,
  })),
});
const cartOf = (itemsTotal, extra = {}) => ({ lines: [], itemsTotal, deliveryFee: null, grandTotal: null, minOrder: null, ...extra });

describe('summarize', () => {
  test('site vs estimate source', () => {
    const s = summarize({
      hazihinam: run([['identical', 10], ['identical', 20]], cartOf(31.5, { deliveryFee: 29 })),
      ramilevy: run([['identical', 11], ['identical', 19]]),
    }, {});
    assert.equal(s.chains.hazihinam.itemsSource, 'site');
    assert.equal(s.chains.hazihinam.itemsTotal, 31.5);
    assert.equal(s.chains.hazihinam.final, 60.5);
    assert.equal(s.chains.ramilevy.itemsSource, 'estimate');
    assert.equal(s.chains.ramilevy.itemsTotal, 30);
  });

  test('unknown delivery fee flagged; override used otherwise', () => {
    const s = summarize({ hazihinam: run([['identical', 10]]), ramilevy: run([['identical', 10]]) },
      { deliveryOverrides: { ramilevy: { fee: 20, minOrder: 50 } } });
    assert.equal(s.chains.hazihinam.deliveryFee, null);
    assert.equal(s.chains.hazihinam.deliveryFeeUnknown, true);
    assert.equal(s.chains.hazihinam.final, 10);
    assert.equal(s.chains.ramilevy.deliveryFee, 20);
    assert.equal(s.chains.ramilevy.deliveryFeeUnknown, false);
    assert.equal(s.chains.ramilevy.final, 30);
    assert.equal(s.chains.ramilevy.belowMinimum, true);
    assert.equal(s.chains.hazihinam.belowMinimum, false);
  });

  test('site fee beats override; site minOrder', () => {
    const s = summarize({ hazihinam: run([['identical', 100]], cartOf(100, { deliveryFee: 0, minOrder: 150 })) },
      { deliveryOverrides: { hazihinam: { fee: 30, minOrder: 10 } } });
    assert.equal(s.chains.hazihinam.deliveryFee, 0);
    assert.equal(s.chains.hazihinam.belowMinimum, true);
  });

  test('discounts only for own chain; counts', () => {
    const s = summarize({
      hazihinam: run([['identical', 100], ['different', 50], ['missing', 0]]),
      ramilevy: run([['identical', 100]]),
    }, { discounts: [{ chain: 'hazihinam', label: 'club', type: 'percent', value: 10, minBasket: 0, cap: null, enabled: true }] });
    assert.equal(s.chains.hazihinam.discountTotal, 15);
    assert.equal(s.chains.hazihinam.final, 135);
    assert.equal(s.chains.ramilevy.discountTotal, 0);
    assert.equal(s.chains.hazihinam.missingCount, 1);
    assert.equal(s.chains.hazihinam.differentCount, 1);
  });

  test('comparableTotal only over lines identical|similar in every chain', () => {
    const s = summarize({
      hazihinam: run([['identical', 10], ['similar', 20], ['different', 30], ['identical', 40]]),
      ramilevy: run([['identical', 11], ['similar', 21], ['identical', 31], ['missing', 0]]),
    }, {});
    assert.equal(s.chains.hazihinam.comparableTotal, 30);
    assert.equal(s.chains.ramilevy.comparableTotal, 32);
  });

  test('non-ok chains are excluded', () => {
    const s = summarize({ hazihinam: run([['identical', 10]]), ramilevy: { status: 'error', lines: [], cart: null },
      shufersal: { status: 'skipped', lines: [], cart: null } }, {});
    assert.equal(s.chains.ramilevy.status, 'error');
    assert.equal(s.chains.shufersal.status, 'skipped');
    assert.equal(s.chains.hazihinam.comparableTotal, 10);
  });
});

describe('recommend', () => {
  test('cheapest wins, with Hebrew reason', () => {
    const r = recommend(summarize({
      hazihinam: run([['identical', 50]]), ramilevy: run([['identical', 40]]), shufersal: run([['identical', 45]]),
    }, {}));
    assert.equal(r.best, 'ramilevy');
    assert.deepEqual(r.ranking.map((x) => x.chain), ['ramilevy', 'shufersal', 'hazihinam']);
    assert.ok(r.ranking[0].reasons.includes('הסל הזול ביותר כולל משלוח'));
    assert.deepEqual(r.perLineCheapest, [{ line: 'l0', chain: 'ramilevy', price: 40 }]);
  });

  test('delivery changes the winner', () => {
    const r = recommend(summarize({
      hazihinam: run([['identical', 50]], cartOf(50, { deliveryFee: 0 })),
      ramilevy: run([['identical', 40]], cartOf(40, { deliveryFee: 25 })),
    }, {}));
    assert.equal(r.best, 'hazihinam');
  });

  test('incomplete cheap cart loses via adjustedFinal', () => {
    const r = recommend(summarize({
      hazihinam: run([['identical', 30], ['identical', 40]]),
      ramilevy: run([['identical', 40], ['missing', 0]]),
    }, {}));
    const rami = r.ranking.find((x) => x.chain === 'ramilevy');
    assert.equal(rami.final, 40);
    assert.equal(rami.adjustedFinal, 80);
    assert.equal(r.best, 'hazihinam');
    assert.ok(rami.reasons.includes('חסר מוצר אחד — הושלם במחיר מהרשת הזולה לצורך ההשוואה'));
  });

  test('plural missing reason and belowMinimum reason', () => {
    const r = recommend(summarize({
      hazihinam: run([['identical', 30], ['identical', 40], ['identical', 5]]),
      ramilevy: run([['identical', 28], ['missing', 0], ['missing', 0]], cartOf(28, { minOrder: 100 })),
    }, {}));
    const rami = r.ranking.find((x) => x.chain === 'ramilevy');
    assert.ok(rami.reasons.includes('חסרים 2 מוצרים — הושלמו במחיר מהרשת הזולה לצורך ההשוואה'));
    assert.ok(rami.reasons.includes('מתחת למינימום הזמנה'));
  });

  test('single chain', () => {
    const r = recommend(summarize({ hazihinam: run([['identical', 10]]), ramilevy: { status: 'skipped', lines: [], cart: null } }, {}));
    assert.equal(r.best, 'hazihinam');
    assert.equal(r.ranking.length, 1);
  });

  test('none ok -> best null', () => {
    const r = recommend(summarize({ hazihinam: { status: 'error', lines: [], cart: null }, ramilevy: { status: 'skipped', lines: [], cart: null } }, {}));
    assert.equal(r.best, null);
    assert.deepEqual(r.ranking, []);
    assert.deepEqual(r.perLineCheapest, []);
  });
});

import { test as _t2 } from 'node:test';
import _a2 from 'node:assert/strict';
import { recommend as _rec } from '../../extension/engine/compare.js';
const _chain = (o) => ({ status: 'ok', final: 0, itemsTotal: 0, missingCount: 0, differentCount: 0, belowMinimum: false,
  deliveryFeeUnknown: false, itemsSource: 'site', discountTotal: 0, ...o });
_t2('recommend: an empty cart or one below the minimum order never wins', () => {
  const line = (a, b, c) => ({ line: 'x', chains: { a, b, c } });
  const got = { match: 'identical', lineTotal: 50 };
  const miss = { match: 'missing', lineTotal: 0 };
  const summary = {
    chains: {
      a: _chain({ final: 80, itemsTotal: 50 }),
      b: _chain({ final: 20, itemsTotal: 0, missingCount: 1 }),
      c: _chain({ final: 60, itemsTotal: 50, belowMinimum: true }),
    },
    lines: [line(got, miss, got)], perLineCheapest: [],
  };
  const r = _rec(summary);
  _a2.equal(r.best, 'a');
  _a2.equal(r.ranking[0].chain, 'a');
  summary.chains.a.belowMinimum = true;
  _a2.equal(_rec(summary).best, null);
});
