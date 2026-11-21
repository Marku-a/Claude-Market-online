import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildProfile } from '../../extension/engine/profile.js';
import {
  matchLine, applyDiscounts, summarize, recommend, runLine, REASON_REMOVED, REASON_UNAVAILABLE, annotateSizes,
} from '../../extension/engine/compare.js';
import { parseListLine } from '../../extension/engine/text.js';
import { chooseForLine } from '../../extension/engine/choose.js';
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

describe('real-site regressions (2026-11-21)', () => {
  // Rami Levy's real top results for "ביצים L 12": the eggs are first, cheaper unrelated hits follow.
  const RL_EGGS = [
    ['425667', 'ביצים 12 יח גדול L', 14.5], ['425668', 'ביצים 12 יח בינוני M', 13.4],
    ['5523', 'אטריות ביצים בינוניות מספר 12 אוריינט 200 גרם', 8.8], ['328225', "אטריות ביצים פטוצ'יני", 10.8],
    ['356183', 'אטריות ביצים דקות 400ג רמילוי', 8], ['356184', 'אטריות ביצים רחבות 400ג רמילוי', 8],
    ['248816', 'אטריות ביצים רצועות 500 גר', 9.8], ['321227', 'כפפות משק מידה L', 5.9],
    ['307029', 'כפפות ניטריל כחולות רפואיות L', 29.6], ['410808', 'מאסטר שף אטריות ביצים עבות 340 גרם', 10],
  ].map(([id, name, price]) => cand(id, name, price, { chain: 'ramilevy' }));

  test('cheap unrelated results do not beat the product the query names', () => {
    const ch = chooseForLine(L('ביצים L 12'), RL_EGGS, buildProfile([], TODAY));
    assert.equal(ch.product.name, 'ביצים 12 יח גדול L');
    assert.ok(ch.ranked.every((p) => !/אטריות|כפפות/.test(p.name)), 'unrelated hits are not even candidates');
  });

  test('a usual product that contradicts a number in the line is not the reference', () => {
    const usual = ['c9', "קוטג' 9%", 'תנובה', 'מוצרי חלב'];
    const p = buildProfile([order('1', '2026-10-01', [...usual, 1, 6.1]), order('2', '2026-10-08', [...usual, 1, 6.1])], TODAY);
    const m = matchLine(L("קוטג' 5%"), {
      hazihinam: [cand('c9', "קוטג' 9%", 6.1), cand('c5', "קוטג' 5%", 5.5)],
      ramilevy: [cand('r5', "קוטג' תנובה 5% שומן 250 ג'", 5.9, { chain: 'ramilevy' })],
    }, p);
    assert.equal(m.reference, null);
    assert.equal(m.chains.hazihinam.product.name, "קוטג' 5%");
    assert.equal(m.chains.ramilevy.match, 'similar');
    // a plain line still uses the usual product
    assert.equal(matchLine(L('קוטג'), { hazihinam: [cand('c9', "קוטג' 9%", 6.1), cand('c5', "קוטג' 5%", 5.5)] }, p).chains.hazihinam.product.name, "קוטג' 9%");
  });

  test('numbers in the line beat habit inside one chain', () => {
    const usual = ['e18', 'מארז 18 ביצים L', null, 'ביצים'];
    const p = buildProfile([order('1', '2026-10-01', [...usual, 1, 21.7]), order('2', '2026-10-08', [...usual, 1, 21.7])], TODAY);
    const res = [cand('e12', 'מארז 12 ביצים L', 14.5), cand('e18', 'מארז 18 ביצים L', 21.7), cand('o12', 'מארז 12 ביצים אורגניות L', 27.3)];
    assert.equal(chooseForLine(L('ביצים L 12'), res, p).product.name, 'מארז 12 ביצים L');
    assert.equal(chooseForLine(L('ביצים'), res, p).product.name, 'מארז 18 ביצים L'); // no number: the usual one
  });

  test('a product missing one of the words the user wrote is badged different', () => {
    const p = buildProfile([], TODAY);
    const m = matchLine(L('תבניות ביצים'), {
      hazihinam: [cand('a', 'תבניות אלומיניום + מכסים 10 במארז', 9.9)],
      ramilevy: [cand('e', 'מארז 30 ביצים תבנית L', 29.9, { chain: 'ramilevy' })],
    }, p);
    assert.equal(m.chains.hazihinam.match, 'different');
    assert.equal(m.chains.ramilevy.match, 'similar'); // "תבנית" ~ "תבניות", "ביצים" present
    assert.equal(matchLine(L('ביצים'), { shufersal: [cand('s', 'ביצי חופש L', 22)] }, p).chains.shufersal.match, 'similar');
  });

  test("a 'different' product is never the line's cheapest", () => {
    const s = summarize({ hazihinam: run([['identical', 21.7]]), ramilevy: run([['different', 8]]), shufersal: run([['similar', 21.81]]) }, {});
    assert.deepEqual(s.perLineCheapest.map((x) => x.chain), ['hazihinam']);
  });
});

describe('runLine (plan entry after filling -> chainRuns line)', () => {
  const entry = (kw = {}) => ({ product: cand('p1', 'תבניות ביצים', 9), match: 'similar', qty: 2, lineTotal: 18, missingReason: null, ...kw });
  const item = (kw = {}) => ({ actualQty: 2, existingQty: 0, share: 17, ...kw });
  const cart = (lines) => ({ lines, itemsTotal: 17 });

  test('in the cart: our share of the site price', () => {
    const l = runLine('תבניות', entry(), item(), cart([{ id: 'p1', name: 'x', qty: 2, lineTotal: 17 }]));
    assert.deepEqual(l, { line: 'תבניות', match: 'similar', product: entry().product, qty: 2, lineTotal: 17, missingReason: null });
    assert.equal(runLine('a', entry(), item({ share: null }), null).lineTotal, 18); // no re-read cart: estimate
  });

  test('excluded by the user at this chain: missing with reason "removed", even if still in the cart', () => {
    const l = runLine('a', entry({ excluded: true }), null, cart([{ id: 'p1', qty: 2, lineTotal: 17 }]));
    assert.equal(l.match, 'missing');
    assert.equal(l.product, null);
    assert.equal(l.lineTotal, 0);
    assert.equal(l.missingReason, REASON_REMOVED);
    assert.equal(REASON_REMOVED, 'הוסר על ידך');
  });

  test('the site reports the cart line unavailable: missing, out-of-stock reason, product name kept', () => {
    const l = runLine('a', entry(), item(), cart([{ id: 'p1', name: 'תבנית אלומיניום', qty: 2, lineTotal: 17, available: false }]));
    assert.equal(l.match, 'missing');
    assert.equal(l.missingReason, REASON_UNAVAILABLE);
    assert.equal(REASON_UNAVAILABLE, 'אזל במלאי באתר');
    assert.equal(l.name, 'תבנית אלומיניום');
    // available true / absent = in stock
    assert.equal(runLine('a', entry(), item(), cart([{ id: 'p1', qty: 2, lineTotal: 17, available: true }])).match, 'similar');
  });

  test('not added / not in the re-read cart / nothing chosen', () => {
    assert.equal(runLine('a', entry(), null, null).match, 'missing');
    assert.equal(runLine('a', entry(), item(), cart([])).match, 'missing');
    assert.equal(runLine('a', entry(), item({ actualQty: 3, existingQty: 3 }), cart([{ id: 'p1', qty: 3 }])).match, 'missing');
    const none = runLine('a', entry({ product: null, match: 'missing', missingReason: 'לא נמצא באתר' }), null, null);
    assert.equal(none.missingReason, 'לא נמצא באתר');
  });
});

describe('removed and out-of-stock lines in summary and recommendation', () => {
  const OOS_REASON = 'ייתכן שהסכום באתר כולל מוצרים שאזלו';
  const withReason = (r, i, reason, name) => {
    r.lines[i].missingReason = reason;
    if (name) r.lines[i].name = name;
    return r;
  };

  test('a line removed at one chain is priced at the cheapest other chain, like a missing line', () => {
    const s = summarize({
      hazihinam: withReason(run([['missing', 0], ['identical', 10]], cartOf(10)), 0, REASON_REMOVED),
      ramilevy: run([['similar', 5], ['identical', 11]], cartOf(16)),
      shufersal: run([['similar', 6], ['identical', 12]], cartOf(18)),
    }, {});
    assert.equal(s.chains.hazihinam.missingCount, 1);
    assert.equal(s.chains.hazihinam.removedCount, 1);
    assert.deepEqual(s.chains.hazihinam.unavailable, []);
    assert.equal(s.lines[0].chains.hazihinam.missingReason, REASON_REMOVED);
    const r = recommend(s);
    const hz = r.ranking.find((x) => x.chain === 'hazihinam');
    assert.equal(hz.adjustedFinal, 15); // 10 + the cheapest other chain's line (5)
    assert.equal(r.best, 'hazihinam');
    assert.ok(!hz.reasons.includes(OOS_REASON));
  });

  test('out of stock: listed by name, not compared, the site total is NOT reduced, reason added', () => {
    const s = summarize({
      ramilevy: withReason(run([['missing', 0], ['identical', 11]], cartOf(20)), 0, REASON_UNAVAILABLE, 'ביצים L'),
      shufersal: run([['similar', 9], ['identical', 12]], cartOf(21)),
    }, {});
    const rl = s.chains.ramilevy;
    assert.deepEqual(rl.unavailable, [{ line: 'l0', name: 'ביצים L' }]);
    assert.equal(rl.itemsTotal, 20); // the site's own total, untouched
    assert.equal(rl.missingCount, 1);
    assert.equal(rl.removedCount, 0);
    assert.equal(rl.comparableTotal, 11); // only the line present in both chains
    const r = recommend(s);
    assert.ok(r.ranking.find((x) => x.chain === 'ramilevy').reasons.includes(OOS_REASON));
    assert.ok(!r.ranking.find((x) => x.chain === 'shufersal').reasons.includes(OOS_REASON));
  });
});

describe('size and weight', () => {
  const none = () => buildProfile([], TODAY);
  const MILKS = [cand('m2', 'חלב 3% טרה 2 ליטר', 12.9), cand('m1', 'חלב תנובה 3% שומן 1 ל\' קרטון בד"צ', 7.2)];

  test('a size in the line wins: same size (within 5%) competes first', () => {
    assert.equal(chooseForLine(L('חלב 1 ליטר'), MILKS, none()).product.id, 'm1');
    assert.equal(chooseForLine(L('חלב 2 ליטר'), MILKS, none()).product.id, 'm2');
    const rice = [cand('r5', 'אורז פרסי 500 גרם', 5), cand('r1', 'אורז פרסי 1קג שקדיה', 9.9)];
    assert.equal(chooseForLine(L('אורז 1 קג'), rice, none()).product.id, 'r1'); // "1קג" fits although token "1" is absent
    const eggs = [cand('e18', 'מארז 18 ביצים L', 21.7), cand('e12', 'ביצים 12 יח גדול L', 14.5)];
    assert.equal(chooseForLine(L('ביצים 12'), eggs, none()).product.id, 'e12');
    // no candidate of that size: the rule does not filter
    assert.equal(chooseForLine(L('חלב 3 ליטר'), MILKS, none()).status, 'ok');
  });

  test('a favourite of another size is not the reference for a sized line', () => {
    const fav = ['m1', 'חלב תנובה 3% 1 ליטר', 'תנובה', 'חלב'];
    const p = buildProfile([order('1', '2026-10-01', [...fav, 1, 7]), order('2', '2026-10-08', [...fav, 1, 7])], TODAY);
    const m = matchLine(L('חלב 2 ליטר'), {
      hazihinam: [cand('m1', 'חלב תנובה 3% 1 ליטר', 7), cand('m2', 'חלב תנובה 3% 2 ליטר', 13)],
    }, p);
    assert.equal(m.reference, null);
    assert.equal(m.chains.hazihinam.product.id, 'm2');
  });

  test('chosen size differs > 10% from the line size: different, with sizeNote', () => {
    const m = matchLine(L('חלב 1 ליטר'), {
      hazihinam: [cand('h1', 'חלב תנובה 3% 1 ליטר', 7)],
      ramilevy: [cand('r2', 'חלב 3% טרה 2 ליטר', 12.9, { chain: 'ramilevy' })],
    }, none());
    assert.equal(m.chains.hazihinam.match, 'similar');
    assert.equal(m.chains.hazihinam.sizeNote, null);
    assert.equal(m.chains.ramilevy.match, 'different');
    assert.equal(m.chains.ramilevy.sizeDiff, true);
    assert.equal(m.chains.ramilevy.sizeNote, 'גודל שונה: 2 ליטר מול 1 ליטר');
    assert.deepEqual(m.chains.ramilevy.size, { amount: 2000, unit: 'ml' });
    assert.equal(m.chains.ramilevy.unitPrice.value, 6.45);
  });

  test('baseline is the reference size; identical barcode is never downgraded', () => {
    const m = matchLine(L('חלב'), {
      hazihinam: [cand('1', MILK[1], 7.4)],
      ramilevy: [cand('r2', 'חלב תנובה 3% 2 ליטר', 12.9, { chain: 'ramilevy' })],
      shufersal: [cand('s1', 'חלב תנובה 3% 0.97 ליטר', 7.1, { chain: 'shufersal' })],
    }, prof());
    assert.equal(m.chains.hazihinam.match, 'identical');
    assert.equal(m.chains.ramilevy.match, 'different');
    assert.equal(m.chains.ramilevy.sizeNote, 'גודל שונה: 2 ליטר מול 1 ליטר');
    assert.equal(m.chains.shufersal.match, 'similar'); // 3% off: same size
  });

  test('no line size, no reference: majority decides; a tie marks both', () => {
    const three = matchLine(L('חלב'), {
      hazihinam: [cand('a', 'חלב 1 ליטר', 7)], ramilevy: [cand('b', 'חלב 1 ליטר', 6.9)], shufersal: [cand('c', 'חלב 2 ליטר', 12)],
    }, none());
    assert.deepEqual(Object.values(three.chains).map((e) => e.match), ['similar', 'similar', 'different']);
    const two = matchLine(L('חלב'), { hazihinam: [cand('a', 'חלב 1 ליטר', 7)], ramilevy: [cand('b', 'חלב 2 ליטר', 12)] }, none());
    assert.equal(two.chains.hazihinam.sizeNote, 'גודל שונה: 1 ליטר מול 2 ליטר');
    assert.equal(two.chains.ramilevy.sizeNote, 'גודל שונה: 2 ליטר מול 1 ליטר');
    assert.equal(two.chains.hazihinam.match, 'different');
    // unknown size or another unit: no judgement
    const mixed = matchLine(L('שמנת'), { hazihinam: [cand('a', 'שמנת 200 מל', 5)], ramilevy: [cand('b', 'שמנת 250 גרם', 6)],
      shufersal: [cand('c', 'שמנת מתוקה', 6)] }, none());
    assert.ok(Object.values(mixed.chains).every((e) => e.match === 'similar' && !e.sizeNote));
  });

  test('annotateSizes re-applies after a choice changes', () => {
    const m = matchLine(L('חלב 1 ליטר'), {
      hazihinam: [cand('h1', 'חלב 1 ליטר', 7)],
      ramilevy: [cand('r2', 'חלב 2 ליטר', 12.9), cand('r1', 'חלב טרה 1 ליטר', 6.9)],
    }, none());
    assert.equal(m.chains.ramilevy.product.id, 'r1');
    Object.assign(m.chains.ramilevy, { product: cand('r2', 'חלב 2 ליטר', 12.9), match: 'similar', baseMatch: undefined });
    annotateSizes('חלב 1 ליטר', m.reference, m.chains);
    assert.equal(m.chains.ramilevy.match, 'different');
    Object.assign(m.chains.ramilevy, { product: cand('r1', 'חלב טרה 1 ליטר', 6.9), match: 'similar', baseMatch: undefined });
    annotateSizes('חלב 1 ליטר', m.reference, m.chains);
    assert.equal(m.chains.ramilevy.match, 'similar');
    assert.equal(m.chains.ramilevy.sizeNote, null);
  });

  test('runLine carries the size note through', () => {
    const e = { product: cand('p', 'חלב 2 ליטר', 12), match: 'different', qty: 1, lineTotal: 12, sizeNote: 'גודל שונה: 2 ליטר מול 1 ליטר', sizeDiff: true };
    const l = runLine('חלב', e, { actualQty: 1, existingQty: 0, share: 12 }, null);
    assert.equal(l.sizeNote, e.sizeNote);
    assert.equal(l.sizeDiff, true);
  });

  // chainRuns with one line holding a real product name
  const sized = (name, lineTotal, kw = {}) => ({
    status: 'ok', cart: null,
    lines: [{ line: 'חלב', match: 'similar', product: cand(name, name, lineTotal), qty: 1, lineTotal, ...kw }],
  });

  test('sizes differ, same unit: the cheapest is decided by unit price', () => {
    const s = summarize({
      hazihinam: sized('חלב 1 ליטר', 7.0),
      ramilevy: sized('חלב 2 ליטר', 12.9, { match: 'different', sizeDiff: true, sizeNote: 'גודל שונה: 2 ליטר מול 1 ליטר' }),
    }, {});
    assert.deepEqual(s.perLineCheapest, [{ line: 'חלב', chain: 'ramilevy', price: 12.9, by: 'unit', unitPrice: 6.45, unitLabel: 'לליטר' }]);
    assert.deepEqual(s.lines[0].cheapest, ['ramilevy']);
    assert.equal(s.lines[0].cheapestBy, 'unit');
    assert.equal(s.lines[0].chains.ramilevy.sizeNote, 'גודל שונה: 2 ליטר מול 1 ליטר');
    assert.equal(s.lines[0].chains.hazihinam.unitPrice.value, 7);
    assert.equal(s.chains.hazihinam.comparableTotal, 0); // not like-for-like in totals
    assert.equal(s.chains.ramilevy.differentCount, 1);
  });

  test('unit price uses what the line really costs (promo / qty)', () => {
    const s = summarize({
      hazihinam: { status: 'ok', cart: null, lines: [{ line: 'x', match: 'similar', product: cand('a', 'חלב 1 ליטר', 7), qty: 2, lineTotal: 10 }] },
      ramilevy: { status: 'ok', cart: null, lines: [{ line: 'x', match: 'different', sizeDiff: true, product: cand('b', 'חלב 2 ליטר', 12), qty: 2, lineTotal: 24 }] },
    }, {});
    assert.equal(s.perLineCheapest[0].chain, 'hazihinam'); // ₪5 per litre vs ₪6
  });

  test('unrelated different product, no unit price, or equal sizes: line total among comparable only', () => {
    const unrelated = summarize({
      hazihinam: sized('חלב 1 ליטר', 7.0),
      ramilevy: sized('שוקו 2 ליטר', 5, { match: 'different' }),
    }, {});
    assert.deepEqual(unrelated.perLineCheapest.map((x) => x.chain), ['hazihinam']);
    assert.equal(unrelated.lines[0].competitors, 1);
    const noSize = summarize({
      hazihinam: sized('חלב 1 ליטר', 7.0),
      ramilevy: sized('חלב טרה', 5, { match: 'different', sizeDiff: true }),
    }, {});
    assert.deepEqual(noSize.perLineCheapest, [{ line: 'חלב', chain: 'hazihinam', price: 7 }]);
    const equal = summarize({ hazihinam: sized('חלב 1 ליטר', 7.0), ramilevy: sized('חלב טרה 1 ליטר', 6.5) }, {});
    assert.deepEqual(equal.perLineCheapest, [{ line: 'חלב', chain: 'ramilevy', price: 6.5 }]);
    assert.equal(equal.lines[0].cheapestBy, 'total');
  });
});

test('size and unit words in the line do not make a product "different"', () => {
  const m = matchLine(L('אורז פרסי 1 קג'), { hazihinam: [cand('a', 'אורז פרסי', 9.9)], ramilevy: [cand('b', 'אורז פרסי 1קג שקדיה', 5.9, { chain: 'ramilevy' })] }, buildProfile([], TODAY));
  assert.notEqual(m.chains.hazihinam.match, 'different');
});
