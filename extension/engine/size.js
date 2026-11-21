// Package size parsing ("2 ליטר", "400ג", "מארז 12 ביצים") and per-unit prices. Pure, browser-compatible.
// Sizes are normalized to grams ('g'), millilitres ('ml') or a count of items ('unit').
import { normalize } from './text.js';

const NUM = String.raw`(\d+(?:\.\d+)?)`;
// a number starts here: not glued to a digit, a decimal point or a Latin letter (model numbers like "A320")
const START = String.raw`(?<![A-Za-z\d.])`;
// the unit word ends here: "ג'ל" is gel, not grams; "2 לחמניות" is not litres
const END = String.raw`(?![\p{L}\p{N}])`;
// [pattern, unit, factor]; longest alternatives first
const UNITS = [
  [String.raw`ק"ג|קג|קילוגרם|קילו|kg`, 'g', 1000],
  [String.raw`גרם|גר'|גר|ג'|ג|gr|g`, 'g', 1],
  [String.raw`מ"ל|מל|מיליליטר|ml`, 'ml', 1],
  [String.raw`ליטרים|ליטר|ל'|ל`, 'ml', 1000],
];
// Latin "L" only glued to the number ("1.5L"): a spaced "L" is the egg size ("ביצים 12 L").
const LATIN_LITRE = new RegExp(START + NUM + String.raw`(?:ltr|lt|l)(?![A-Za-z\p{L}\p{N}])`, 'giu');
const UNIT_ALT = UNITS.map((u) => u[0]).join('|');
const unitOf = (word) => {
  for (const [pat, unit, factor] of UNITS) if (new RegExp(`^(?:${pat})$`, 'iu').test(word)) return { unit, factor };
  return null;
};
const MEASURE = new RegExp(START + NUM + String.raw`\s*(` + UNIT_ALT + ')' + END, 'giu');
// multipacks: "6*1 ליטר", "4X200 גרם" and "200 גרם*4"
const MULTI = new RegExp(START + String.raw`(\d+)\s*[*xX×]\s*` + NUM + String.raw`\s*(` + UNIT_ALT + ')' + END, 'giu');
const MULTI_REV = new RegExp(START + NUM + String.raw`\s*(` + UNIT_ALT + String.raw`)\s*[*xX×]\s*(\d+)(?![\d.%])`, 'giu');
// dimensions ("22.7*17.7*3 ס"מ") are not sizes: removed before anything else
const DIMS = new RegExp(String.raw`\d+(?:\.\d+)?(?:\s*[*xX×]\s*\d+(?:\.\d+)?)+\s*(?:ס"מ|סמ|מ"מ|ממ|מטר|cm|mm|m)` + END, 'giu');
const PERCENT = /\d+(?:\.\d+)?\s*%/g;
const PACK = new RegExp(String.raw`מארז\s*(?:של\s*)?(\d+)(?![\d.%])`, 'gu');
const PACK_AFTER = new RegExp(START + String.raw`(\d+)\s*ב(?:מארז|חבילה)` + END, 'gu');
const UNIT_COUNT = new RegExp(START + String.raw`(\d+)\s*(?:יחידות|יחידה|יחי'|יח')` + '|' + START + String.raw`(\d+)\s*יח` + END, 'gu');

const BASE = { g: 1000, ml: 1000, unit: 1 };
const PER_LABEL = { g: 'לק"ג', ml: 'לליטר', unit: 'ליחידה' };
const r2 = (x) => Math.round((x + Math.sign(x) * 1e-9) * 100) / 100;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function clean(text) {
  return String(text ?? '').replace(/[״“”]/g, '"').replace(/[׳`’‘]/g, "'");
}

// -> { size: {amount, unit, count?}|null, spans: [[start, end]] }
function scan(text) {
  let s = clean(text).replace(DIMS, (m) => ' '.repeat(m.length)).replace(PERCENT, (m) => ' '.repeat(m.length));
  const spans = [];
  const blank = (m, i) => { spans.push([i, i + m.length]); s = s.slice(0, i) + ' '.repeat(m.length) + s.slice(i + m.length); };
  const measures = []; // {amount, unit, count?}
  const collect = (re, fn) => {
    const found = [...s.matchAll(re)];
    for (const m of found) {
      const v = fn(m);
      if (v) measures.push(v);
    }
    for (const m of found) blank(m[0], m.index);
  };
  collect(MULTI, (m) => {
    const u = unitOf(m[3]);
    const n = Number(m[1]);
    return u && n >= 1 ? { amount: n * Number(m[2]) * u.factor, unit: u.unit, count: n } : null;
  });
  collect(MULTI_REV, (m) => {
    const u = unitOf(m[2]);
    const n = Number(m[3]);
    return u && n >= 1 ? { amount: n * Number(m[1]) * u.factor, unit: u.unit, count: n } : null;
  });
  collect(MEASURE, (m) => {
    const u = unitOf(m[2]);
    return u ? { amount: Number(m[1]) * u.factor, unit: u.unit } : null;
  });
  collect(LATIN_LITRE, (m) => ({ amount: Number(m[1]) * 1000, unit: 'ml' }));
  const counts = (re) => [...s.matchAll(re)].map((m) => { blank(m[0], m.index); return Number(m[1] ?? m[2]); });
  const packs = [...new Set([...counts(PACK), ...counts(PACK_AFTER)])];
  const units = [...new Set(counts(UNIT_COUNT))];

  const valid = measures.filter((m) => m.amount > 0);
  const distinct = valid.filter((m, i) => valid.findIndex((o) => o.unit === m.unit && o.amount === m.amount) === i);
  if (distinct.length > 1 || packs.length > 1 || units.length > 1) return { size: null, spans }; // several sizes: unsure
  const pack = packs[0];
  const unitCount = units[0];
  if (distinct.length) {
    const m = distinct[0];
    if (m.count) return { size: m, spans };
    // "מארז 4 יוגורט 150 גרם" = 4 x 150 g
    if (pack > 1 && pack <= 100) return { size: { amount: m.amount * pack, unit: m.unit, count: pack }, spans };
    // "10 יח 55 גרם": each or in total? Unknown, so no size.
    if (unitCount > 1) return { size: null, spans };
    return { size: { amount: m.amount, unit: m.unit }, spans };
  }
  if (pack && unitCount && pack !== unitCount) return { size: null, spans };
  const n = pack || unitCount;
  if (n >= 1 && n <= 1000) return { size: { amount: n, unit: 'unit' }, spans };
  return { size: null, spans };
}

// "חלב 3% טרה 2 ליטר" -> {amount: 2000, unit: 'ml'}; "מארז 12 ביצים L" -> {amount: 12, unit: 'unit'};
// "6*1 ליטר" -> {amount: 6000, unit: 'ml', count: 6}. null when there is no size or it is ambiguous.
export function parseSize(name) {
  return scan(name).size;
}

// A list line's size and the line without it. A bare number the user wrote ("ביצים 12") is read as a count of
// items (loose: it only ever matters against products whose size is a count).
// -> { size: {amount, unit, count?, loose?}|null, rest: string }
export function splitQuery(query) {
  const raw = clean(query);
  const { size, spans } = scan(raw);
  if (size) {
    let rest = raw;
    for (const [a, b] of spans) rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
    return { size, rest };
  }
  const bare = normalize(raw).split(' ').filter((t) => /^\d+$/.test(t));
  if (bare.length === 1 && Number(bare[0]) >= 2 && Number(bare[0]) <= 100) {
    const rest = normalize(raw).split(' ').filter((t) => t !== bare[0]).join(' ');
    return { size: { amount: Number(bare[0]), unit: 'unit', loose: true }, rest };
  }
  return { size: null, rest: raw };
}

// Same unit and amounts within `tol` (share of the larger one).
export function sameSize(a, b, tol = 0.05) {
  if (!a || !b || a.unit !== b.unit || !(a.amount > 0) || !(b.amount > 0)) return false;
  return Math.abs(a.amount - b.amount) <= tol * Math.max(a.amount, b.amount);
}

const trimNum = (x) => String(r2(x));
// {amount: 2000, unit: 'ml'} -> "2 ליטר"; with count: "6 × 1 ליטר"
export function formatSize(size) {
  if (!size) return '';
  if (size.unit === 'unit') return `${trimNum(size.amount)} יח'`;
  if (size.count > 1) return `${size.count} × ${formatSize({ amount: size.amount / size.count, unit: size.unit })}`;
  if (size.unit === 'g') return size.amount >= 1000 ? `${trimNum(size.amount / 1000)} ק"ג` : `${trimNum(size.amount)} גרם`;
  return size.amount >= 1000 ? `${trimNum(size.amount / 1000)} ליטר` : `${trimNum(size.amount)} מ"ל`;
}

// The site's own unit label ("ליטר", "ק\"ג", "100 גרם", "יחידה") as a size, or null.
function labelSize(label) {
  if (typeof label !== 'string' || !label.trim()) return null;
  const l = clean(label).trim();
  return parseSize(/\d/.test(l) ? l : '1 ' + l);
}

// A product's size; products sold by weight have none (their price already is per kg).
export function productSize(product) {
  if (!product || product.soldBy === 'kg') return null;
  const named = parseSize(product.name);
  if (named) return named;
  // No size in the name: infer it from the site's own unit price when it is per a measured amount
  // (Shufersal "חלב 3% בבקבוק": ₪7.35 at ₪0.74 per 100 מ"ל -> ~1 ליטר; verified 2026-11-21). Count units are not inferred.
  const ls = isNum(product.unitPrice) && product.unitPrice > 0 && isNum(product.price) && product.price > 0
    ? labelSize(product.unitLabel) : null;
  if (!ls || ls.unit === 'unit') return null;
  const amount = (product.price / product.unitPrice) * ls.amount;
  // Site unit prices are rounded to the agora, so the estimate is a few % off: snap to a common pack size when close.
  const PACKS = [100, 125, 150, 200, 250, 300, 330, 400, 500, 600, 700, 750, 800, 1000, 1500, 2000, 2500, 3000, 5000];
  const near = PACKS.find((p) => Math.abs(amount - p) / p <= 0.03);
  const step = amount >= 1000 ? 50 : 10;
  return { amount: near ?? Math.round(amount / step) * step, unit: ls.unit, inferred: true };
}

// Regular price per 1 kg / 1 litre / 1 item -> { value, unit, label: 'לליטר'|..., source: 'site'|'name' } | null.
// The site's own figure (Shufersal pricePerUnit, Hatzi Hinam PricePerUnit) is preferred when its label is readable
// and it agrees (within 15%) with the size in the name; with no size in the name it is used as is.
export function unitPriceOf(product, size = productSize(product)) {
  if (!product || !(product.price > 0)) return null;
  const out = (value, unit, source) => ({ value: r2(value), unit, label: PER_LABEL[unit], source });
  if (product.soldBy === 'kg') return out(product.price, 'g', 'site');
  const computed = size ? product.price / size.amount * BASE[size.unit] : null;
  const ls = isNum(product.unitPrice) && product.unitPrice > 0 ? labelSize(product.unitLabel) : null;
  const site = ls ? product.unitPrice * BASE[ls.unit] / ls.amount : null;
  if (computed != null) {
    if (site != null && ls.unit === size.unit && Math.abs(site - computed) <= 0.15 * computed) return out(site, ls.unit, 'site');
    return out(computed, size.unit, 'name');
  }
  return site != null ? out(site, ls.unit, 'site') : null;
}

// "₪7.45 לליטר"
export function formatUnitPrice(up) {
  return up ? `₪${up.value.toFixed(2)} ${up.label}` : '';
}
