import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSize, splitQuery, sameSize, formatSize, unitPriceOf, formatUnitPrice, productSize,
} from '../../extension/engine/size.js';
import { cand } from './helpers.mjs';

describe('parseSize: real names from the sites', () => {
  const cases = [
    ['חלב 3% טרה 2 ליטר', { amount: 2000, unit: 'ml' }],
    ['חלב תנובה 3% שומן 1 ל\' קרטון בד"צ', { amount: 1000, unit: 'ml' }],
    ['קוטג\' תנובה 5% שומן 250 ג\' בד"צ', { amount: 250, unit: 'g' }],
    ['אורז פרסי 1קג שקדיה', { amount: 1000, unit: 'g' }],
    ['אטריות ביצים דקות 400ג רמילוי', { amount: 400, unit: 'g' }],
    ['שמן זית כתית מעולה 750 מ"ל', { amount: 750, unit: 'ml' }],
    ['מארז 12 ביצים L', { amount: 12, unit: 'unit' }],
    ['ביצים 12 יח גדול L', { amount: 12, unit: 'unit' }],
    ['פיתות 500גר פרו', { amount: 500, unit: 'g' }],
    ['מארז 11 פיתות', { amount: 11, unit: 'unit' }],
    ['תפוצ\'יפס 50 ג', { amount: 50, unit: 'g' }],
    ['שמנת 200 מל', { amount: 200, unit: 'ml' }],
    ['אטריות ביצים בינוניות מספר 12 אוריינט 200 גרם', { amount: 200, unit: 'g' }],
    ['מארז 30 ביצים תבנית L', { amount: 30, unit: 'unit' }],
  ];
  for (const [name, want] of cases) test(name, () => assert.deepEqual(parseSize(name), want));
});

describe('parseSize: units and spellings', () => {
  test('kilo spellings', () => {
    for (const n of ['סוכר 1 ק"ג', 'סוכר 1 ק״ג', 'סוכר 1 קג', 'סוכר 1 קילו', 'סוכר 1kg']) {
      assert.deepEqual(parseSize(n), { amount: 1000, unit: 'g' }, n);
    }
    assert.deepEqual(parseSize('קמח 1.5 ק"ג'), { amount: 1500, unit: 'g' });
  });
  test('gram spellings', () => {
    for (const n of ['במבה 80 גרם', 'במבה 80 גר\'', 'במבה 80גר', 'במבה 80 ג׳', 'במבה 80g', 'במבה 80 gr']) {
      assert.deepEqual(parseSize(n), { amount: 80, unit: 'g' }, n);
    }
  });
  test('litre and millilitre spellings', () => {
    assert.deepEqual(parseSize('מיץ 1.5 ליטר'), { amount: 1500, unit: 'ml' });
    assert.deepEqual(parseSize('משקה 1.5L'), { amount: 1500, unit: 'ml' });
    assert.deepEqual(parseSize('מים 2 ל'), { amount: 2000, unit: 'ml' });
    assert.deepEqual(parseSize('יוגורט 150 מ״ל'), { amount: 150, unit: 'ml' });
    assert.deepEqual(parseSize('יוגורט 150ml'), { amount: 150, unit: 'ml' });
  });
  test('multipacks: total = n x size, with count', () => {
    assert.deepEqual(parseSize('מים מינרליים 6*1 ליטר'), { amount: 6000, unit: 'ml', count: 6 });
    assert.deepEqual(parseSize('יוגורט 4X200 גרם'), { amount: 800, unit: 'g', count: 4 });
    assert.deepEqual(parseSize('מים 6 × 1.5 ליטר'), { amount: 9000, unit: 'ml', count: 6 });
    assert.deepEqual(parseSize('קוטג\' 250 גרם*4'), { amount: 1000, unit: 'g', count: 4 });
    assert.deepEqual(parseSize('מארז 4 יוגורט 150 גרם'), { amount: 600, unit: 'g', count: 4 });
  });
  test('item counts', () => {
    assert.deepEqual(parseSize('מגבונים 72 יחידות'), { amount: 72, unit: 'unit' });
    assert.deepEqual(parseSize('לחמניות 6 יח\''), { amount: 6, unit: 'unit' });
    assert.deepEqual(parseSize('תבניות אלומיניום 10 במארז'), { amount: 10, unit: 'unit' });
  });
});

describe('parseSize: no false positives', () => {
  const none = [
    'קוטג\' 5%', 'חלב 3%', 'שוקולד 70%', 'תבנית אפייה 22.7*17.7*3 ס"מ', 'מגבת 50x70 ס"מ',
    'ביצים L', 'ביצים חופש 12 L', 'כפפות משק מידה L', 'חולצה M', 'ג\'ל רחצה', '2 לחמניות', 'iPhone 13',
    'סוללות AA', 'מדפסת A320', 'לחם אחיד', '', null,
    // two different sizes / ambiguous each-or-total: unsure, so no size
    'שמפו 700 מ"ל + מרכך 300 מ"ל', 'קפסולות 10 יח 55 גרם', 'חלב 1 ליטר ושמנת 200 גרם',
  ];
  for (const n of none) test(String(n), () => assert.equal(parseSize(n), null));
});

describe('splitQuery', () => {
  test('a written size and the rest of the line', () => {
    const q = splitQuery('אורז 1 קג');
    assert.deepEqual(q.size, { amount: 1000, unit: 'g' });
    assert.equal(q.rest.trim(), 'אורז');
    assert.deepEqual(splitQuery('חלב 3% 1 ליטר').size, { amount: 1000, unit: 'ml' });
    assert.match(splitQuery('חלב 3% 1 ליטר').rest, /3%/);
  });
  test('a bare number is a loose count', () => {
    assert.deepEqual(splitQuery('ביצים 12'), { size: { amount: 12, unit: 'unit', loose: true }, rest: 'ביצים' });
    assert.deepEqual(splitQuery('ביצים L 12').size, { amount: 12, unit: 'unit', loose: true });
    assert.equal(splitQuery('קוטג\' 5%').size, null);
    assert.equal(splitQuery('חלב').size, null);
  });
});

test('sameSize: same unit, within tolerance', () => {
  assert.equal(sameSize({ amount: 1000, unit: 'ml' }, { amount: 1000, unit: 'ml' }), true);
  assert.equal(sameSize({ amount: 1000, unit: 'ml' }, { amount: 960, unit: 'ml' }), true);
  assert.equal(sameSize({ amount: 1000, unit: 'ml' }, { amount: 900, unit: 'ml' }), false);
  assert.equal(sameSize({ amount: 1000, unit: 'ml' }, { amount: 900, unit: 'ml' }, 0.1), true);
  assert.equal(sameSize({ amount: 200, unit: 'ml' }, { amount: 200, unit: 'g' }), false);
  assert.equal(sameSize(null, { amount: 1, unit: 'unit' }), false);
});

test('formatSize', () => {
  assert.equal(formatSize({ amount: 2000, unit: 'ml' }), '2 ליטר');
  assert.equal(formatSize({ amount: 750, unit: 'ml' }), '750 מ"ל');
  assert.equal(formatSize({ amount: 1500, unit: 'g' }), '1.5 ק"ג');
  assert.equal(formatSize({ amount: 250, unit: 'g' }), '250 גרם');
  assert.equal(formatSize({ amount: 12, unit: 'unit' }), "12 יח'");
  assert.equal(formatSize({ amount: 6000, unit: 'ml', count: 6 }), '6 × 1 ליטר');
});

describe('unitPriceOf', () => {
  test('from the name: per litre / kg / item', () => {
    assert.equal(formatUnitPrice(unitPriceOf(cand('a', 'חלב 3% טרה 2 ליטר', 14.9))), '₪7.45 לליטר');
    assert.equal(formatUnitPrice(unitPriceOf(cand('a', 'קוטג\' 250 ג\'', 5.5))), '₪22.00 לק"ג');
    assert.equal(formatUnitPrice(unitPriceOf(cand('a', 'מארז 12 ביצים L', 14.5))), '₪1.21 ליחידה');
    assert.equal(unitPriceOf(cand('a', 'חלב 2 ליטר', 14.9)).source, 'name');
  });
  test("the site's own figure is preferred when it agrees", () => {
    const up = unitPriceOf(cand('a', 'חלב 1 ליטר', 6.2, { unitPrice: 6.1, unitLabel: 'ליטר' }));
    assert.deepEqual(up, { value: 6.1, unit: 'ml', label: 'לליטר', source: 'site' });
    // per 100 g -> per kg
    assert.equal(unitPriceOf(cand('a', 'קפה 200 גרם', 21.9, { unitPrice: 10.95, unitLabel: '100 גרם' })).value, 109.5);
    // disagrees with the name (wrong pack, wrong unit): the name wins
    assert.equal(unitPriceOf(cand('a', 'חלב 2 ליטר', 14.9, { unitPrice: 14.9, unitLabel: 'ליטר' })).value, 7.45);
    assert.equal(unitPriceOf(cand('a', 'חלב 2 ליטר', 14.9, { unitPrice: 7.45, unitLabel: 'ק"ג' })).source, 'name');
    // unreadable label -> computed
    assert.equal(unitPriceOf(cand('a', 'חלב 2 ליטר', 14.9, { unitPrice: 7.45, unitLabel: null })).source, 'name');
  });
  test('no size in the name: the site figure as is, else none', () => {
    assert.deepEqual(unitPriceOf(cand('a', 'קפה נמס', 21.9, { unitPrice: 9.9, unitLabel: 'ק"ג' })),
      { value: 9.9, unit: 'g', label: 'לק"ג', source: 'site' });
    assert.equal(unitPriceOf(cand('a', 'לחם אחיד', 7.5)), null);
    assert.equal(unitPriceOf(cand('a', 'חלב 1 ליטר', 0)), null);
  });
  test('sold by weight: the price is per kg, no size', () => {
    const p = cand('a', 'עגבניות 1 ק"ג', 8.9, { soldBy: 'kg' });
    assert.equal(productSize(p), null);
    assert.equal(formatUnitPrice(unitPriceOf(p)), '₪8.90 לק"ג');
  });
});

test('size inferred from the site unit price when the name has none (Shufersal)', () => {
  const s = productSize({ name: 'חלב 3% בבקבוק', price: 7.35, unitPrice: 0.74, unitLabel: '100 מ"ל', soldBy: 'unit' });
  assert.deepEqual([s.amount, s.unit], [1000, 'ml']); // 993 ml estimate snaps to 1 litre
  assert.equal(productSize({ name: 'אורז פרסי', price: 10.9, unitPrice: 1.09, unitLabel: '100 גרם', soldBy: 'unit' }).amount, 1000);
  assert.equal(productSize({ name: 'ביצים ארוזות L', price: 21.81, unitPrice: 1.21, unitLabel: 'יחידה', soldBy: 'unit' }), null);
  assert.equal(productSize({ name: 'חלב', price: 7, unitPrice: null, unitLabel: null }), null);
});
