// Cross-chain matching, totals, personal discounts, recommendation (SPEC section 6).
import { similarity, productKey, queryNumbers, hasAllNumbers, coversQueryWords } from './text.js';
import { chooseForLine, lineCost } from './choose.js';
import { parseSize, splitQuery, sameSize, productSize, unitPriceOf, formatSize } from './size.js';

const r2 = (x) => Math.round((x + Math.sign(x) * 1e-9) * 100) / 100;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const COMPARABLE = new Set(['identical', 'similar']);
// Chosen products whose sizes differ by more than this share (same unit) are not like-for-like.
export const SIZE_DIFF_TOL = 0.10;
const BASE = { g: 1000, ml: 1000, unit: 1 };

// Size rule over one line's entries {chain: entry} (mutates them; call again after the user changes a choice).
// Sets entry.size, entry.unitPrice (size.js unitPriceOf), entry.sizeNote ("גודל שונה: 2 ליטר מול 1 ליטר") and
// entry.sizeDiff. Baseline size: the size the user wrote, else the reference product's, else the size a unique
// largest group (>= 2) of chosen products shares. A 'similar' entry whose size differs from the baseline by > 10%
// (same unit) becomes 'different' with sizeDiff = true; an 'identical' (same barcode) entry never does. With no
// baseline (1 ליטר at one chain, 2 ליטר at the other: nothing says which is right) every disagreeing entry is
// marked. entry.baseMatch keeps the name-only match so the rule can be re-applied.
export function annotateSizes(query, reference, chains) {
  const qs = splitQuery(query).size;
  const entries = Object.values(chains || {});
  for (const e of entries) {
    if (e.baseMatch === undefined) e.baseMatch = e.match;
    e.match = e.baseMatch;
    e.size = e.product ? productSize(e.product) : null;
    e.unitPrice = e.product ? unitPriceOf(e.product, e.size) : null;
    e.sizeNote = null;
    e.sizeDiff = false;
  }
  // entries that may set the baseline: products of the kind asked for (not an unrelated 'different' one)
  const kin = entries.filter((e) => e.size && (e.baseMatch === 'identical' || e.baseMatch === 'similar'));
  const differs = (a, b) => a.unit === b.unit && !sameSize(a, b, SIZE_DIFF_TOL);
  const agree = (a, b) => a.unit === b.unit && sameSize(a, b, SIZE_DIFF_TOL);
  let base = null;
  if (qs && kin.some((e) => e.size.unit === qs.unit)) base = qs;
  const refSize = reference ? productSize(reference) : null;
  if (!base && refSize && kin.some((e) => e.size.unit === refSize.unit)) base = refSize;
  if (!base && kin.length) {
    const groups = kin.map((e) => kin.filter((o) => agree(e.size, o.size)).length);
    const top = Math.max(...groups);
    const at = groups.map((g, i) => (g === top ? i : -1)).filter((i) => i >= 0);
    if (top >= 2 && at.every((i) => agree(kin[i].size, kin[at[0]].size))) base = kin[at[0]].size;
  }
  for (const e of entries) {
    if (!e.size || !e.product || e.baseMatch === 'identical') continue;
    const others = base ? [base] : kin.filter((o) => o !== e).map((o) => o.size);
    const off = others.filter((o) => differs(e.size, o));
    if (!off.length) continue;
    e.sizeNote = `גודל שונה: ${formatSize(e.size)} מול ${[...new Set(off.map(formatSize))].join(' / ')}`;
    if (e.baseMatch === 'similar') {
      e.match = 'different';
      e.sizeDiff = true;
    }
  }
  return chains;
}

// parsedLine: {raw, query, qty}; resultsByChain: {chain: Product[]}; profile: buildProfile() output.
// -> { qty, reference: Product|null, chains: {chain: {match, product, qty, lineTotal,
//      promoApplied, promoSaving, reasons, alternatives, missingReason}} }
export function matchLine(parsedLine, resultsByChain, profile) {
  // 1. reference = profile favourite among all chains' results (highest orderCount, needs >= 1)
  //    ...but only a favourite that does not contradict the line: it must carry every number the user wrote
  //    ("5%", "12"). Otherwise "קוטג' 5%" became the usual 9% cottage and the real 5% elsewhere was badged
  //    "different" (seen live, 2026-11-21). A plain "חלב" still means the usual milk.
  //    A size the user wrote ("חלב 2 ליטר") counts the same way: a favourite of another size is not the reference.
  const nums = queryNumbers(parsedLine.query);
  const { size: qs, rest } = splitQuery(parsedLine.query);
  const restNums = queryNumbers(rest);
  const fitsQuery = (c) => {
    const s = qs ? parseSize(c.name) : null;
    if (s && s.unit === qs.unit) return sameSize(qs, s) && hasAllNumbers(c.name, restNums);
    return hasAllNumbers(c.name, nums);
  };
  let reference = null;
  let refCount = 0;
  for (const results of Object.values(resultsByChain)) {
    for (const c of results || []) {
      const p = profile.products[productKey(c)];
      if (p && p.orderCount > refCount && fitsQuery(c)) {
        reference = c;
        refCount = p.orderCount;
      }
    }
  }
  // 3. quantity identical across chains
  const refProfile = reference ? profile.products[productKey(reference)] : null;
  const qty = parsedLine.qty || (refProfile ? refProfile.typicalQty : 1);
  const line = { ...parsedLine, qty };

  const chains = {};
  for (const [chain, results] of Object.entries(resultsByChain)) {
    const stock = (results || []).filter((c) => c.inStock !== false);
    let entry;
    const same = reference && reference.barcode
      ? stock.find((c) => c.barcode && String(c.barcode) === String(reference.barcode))
      : null;
    if (same) {
      entry = { match: 'identical', product: same, reasons: [], alternatives: [], missingReason: null };
    } else {
      const ch = chooseForLine(line, results, profile);
      if (ch.status === 'missing') {
        entry = { match: 'missing', product: null, reasons: ch.reasons, alternatives: [], missingReason: ch.missingReason };
      } else {
        // A product that lacks one of the user's words is 'different' even with no reference: "תבניות ביצים" (egg trays)
        // matched aluminium baking trays at two chains, badged "דומה" (seen live, 2026-11-21).
        // Names are worded differently at each chain ("חלב בקרטון 3% שומן" vs "חלב טרי קרטון 3% מהדרין"): the same size as
        // the reference also counts as close, as long as every word of the line is in the name (checked below).
        const refSize = reference ? productSize(reference) : null;
        const close = !reference || similarity(ch.product.name, reference.name) >= 0.5
          || (refSize !== null && sameSize(refSize, productSize(ch.product), 0.05));
        const match = close && coversQueryWords(splitQuery(parsedLine.query).rest, ch.product.name) ? 'similar' : 'different';
        entry = { match, product: ch.product, reasons: ch.reasons, alternatives: ch.alternatives, missingReason: null };
      }
    }
    if (entry.product) {
      const cost = lineCost(entry.product, qty);
      Object.assign(entry, { qty, lineTotal: cost.total, promoApplied: cost.promoApplied, promoSaving: cost.promoSaving });
    } else {
      Object.assign(entry, { qty, lineTotal: 0, promoApplied: false, promoSaving: 0 });
    }
    chains[chain] = entry;
  }
  annotateSizes(parsedLine.query, reference, chains);
  return { qty, reference, chains };
}

// discounts: already filtered to one chain. -> { discountTotal, afterDiscount, applied: [{label, amount}] }
export function applyDiscounts(itemsTotal, discounts) {
  const applied = [];
  let sum = 0;
  for (const d of discounts || []) {
    if (!d || d.enabled === false) continue;
    if (itemsTotal < (d.minBasket || 0)) continue;
    let amount = 0;
    if (d.type === 'percent') {
      amount = itemsTotal * d.value / 100;
      if (isNum(d.cap)) amount = Math.min(amount, d.cap);
    } else if (d.type === 'fixed') {
      amount = d.value;
    }
    if (!(amount > 0)) continue;
    applied.push({ label: d.label, amount: r2(amount) });
    sum += amount;
  }
  const discountTotal = r2(Math.min(sum, Math.max(itemsTotal, 0)));
  return { discountTotal, afterDiscount: r2(Math.max(itemsTotal - discountTotal, 0)), applied };
}

// Why a chain's line is 'missing' when the reason is not the search itself.
export const REASON_REMOVED = 'הוסר על ידך'; // the user chose "לא לקנות כאן" for this chain
export const REASON_UNAVAILABLE = 'אזל במלאי באתר'; // in the cart, but the site says it cannot supply it

// One plan entry of one chain after filling -> chainRuns line.
//   query: line label; entry: plan.lines[i].chains[chain] {product, match, qty, lineTotal, excluded?, missingReason};
//   item: the fill item for that line {actualQty, existingQty, share} or null;
//   rawCart: the re-read CartView or null.
// CartView = { lines: [{ id, name, qty, lineTotal, available? }], itemsTotal, deliveryFee|null, grandTotal|null,
//              minOrder|null }; `available: false` only when the site says it cannot supply the line (else absent).
// -> { line, match, product, qty, lineTotal, missingReason, name? (product name, only when unavailable) }
export function runLine(query, entry, item, rawCart) {
  const miss = (missingReason) => ({ line: query, match: 'missing', product: null, qty: entry.qty, lineTotal: 0, missingReason });
  if (entry.excluded) return miss(REASON_REMOVED);
  if (!entry.product) return miss(entry.missingReason || null);
  const lines = rawCart && Array.isArray(rawCart.lines) ? rawCart.lines : null;
  const cl = lines ? lines.find((x) => String(x.id) === String(entry.product.id)) : null;
  // Out of stock at the site first: Rami Levy keeps such a line in the stored cart but prices it at 0 units, so the
  // "none of our units" test below would hide why it is missing (verified 2026-11-21).
  if (cl && cl.available === false) return { ...miss(REASON_UNAVAILABLE), name: cl.name || entry.product.name };
  // missing = not in the re-read cart, or none of our units were added
  if (!item || (lines && !cl) || item.actualQty - item.existingQty <= 0) return miss(null);
  // Our share of the price the site itself charges for this line (after its own promotions).
  const out = {
    line: query, match: entry.match, product: entry.product, qty: entry.qty,
    lineTotal: item.share ?? entry.lineTotal, missingReason: null,
  };
  if (entry.sizeNote) out.sizeNote = entry.sizeNote;
  if (entry.sizeDiff) out.sizeDiff = true;
  return out;
}

// chainRuns: {chain: {status, lines:[{line, match, product, qty, lineTotal, missingReason?}], cart: CartView|null}}
// profile: user Profile {discounts, deliveryOverrides}
export function summarize(chainRuns, profile) {
  const prof = profile || {};
  const names = Object.keys(chainRuns);
  const okChains = names.filter((c) => chainRuns[c].status === 'ok');
  const chains = {};
  const lineCount = Math.max(0, ...okChains.map((c) => (chainRuns[c].lines || []).length));
  const lineAt = (c, i) => (chainRuns[c].lines || [])[i] || null;

  for (const c of names) {
    const run = chainRuns[c];
    if (run.status !== 'ok') {
      chains[c] = { status: run.status };
      continue;
    }
    const lines = run.lines || [];
    const cart = run.cart || null;
    const estimate = r2(lines.filter((l) => l.match !== 'missing').reduce((s, l) => s + (l.lineTotal || 0), 0));
    const fromSite = cart && isNum(cart.itemsTotal);
    const itemsTotal = fromSite ? r2(cart.itemsTotal) : estimate;
    const over = (prof.deliveryOverrides && prof.deliveryOverrides[c]) || {};
    const deliveryFee = cart && isNum(cart.deliveryFee) ? cart.deliveryFee : isNum(over.fee) ? over.fee : null;
    const minOrder = cart && isNum(cart.minOrder) ? cart.minOrder : isNum(over.minOrder) ? over.minOrder : null;
    const disc = applyDiscounts(itemsTotal, (prof.discounts || []).filter((d) => d.chain === c));
    chains[c] = {
      status: 'ok',
      itemsTotal,
      itemsSource: fromSite ? 'site' : 'estimate',
      deliveryFee,
      deliveryFeeUnknown: deliveryFee == null,
      discountTotal: disc.discountTotal,
      appliedDiscounts: disc.applied,
      final: r2(itemsTotal - disc.discountTotal + (deliveryFee ?? 0)),
      minOrder,
      belowMinimum: minOrder != null && itemsTotal < minOrder,
      missingCount: lines.filter((l) => l.match === 'missing').length,
      removedCount: lines.filter((l) => l.match === 'missing' && l.missingReason === REASON_REMOVED).length,
      // in the cart but the site cannot supply them; the site's itemsTotal is NOT reduced (we cannot know
      // whether the site counts them) - they are only excluded from the line-by-line comparison
      unavailable: lines.filter((l) => l.match === 'missing' && l.missingReason === REASON_UNAVAILABLE).map((l) => ({ line: l.line, name: l.name || l.line })),
      differentCount: lines.filter((l) => l.match === 'different').length,
      comparableTotal: 0,
    };
  }

  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    const per = {};
    let label = null;
    for (const c of okChains) {
      const l = lineAt(c, i);
      if (l && label == null) label = l.line;
      const size = l && l.product ? productSize(l.product) : null;
      per[c] = l
        ? {
          match: l.match, product: l.product || null, qty: l.qty, lineTotal: l.lineTotal || 0, missingReason: l.missingReason || null,
          size, unitPrice: l.product ? unitPriceOf(l.product, size) : null, sizeNote: l.sizeNote || null, sizeDiff: !!l.sizeDiff,
        }
        : { match: 'missing', product: null, qty: 0, lineTotal: 0, missingReason: null, size: null, unitPrice: null, sizeNote: null, sizeDiff: false };
    }
    lines.push({ line: label, chains: per });
  }

  // like-for-like total: lines identical|similar in EVERY participating chain
  for (const l of lines) {
    if (!okChains.length || !okChains.every((c) => COMPARABLE.has(l.chains[c].match))) continue;
    for (const c of okChains) chains[c].comparableTotal = r2(chains[c].comparableTotal + l.chains[c].lineTotal);
  }

  // Cheapest per line. A 'different' product is not the same item - never "cheapest" - with one exception:
  // sizeDiff entries (the kind of product asked for by name, only the package size differs, e.g. 1 vs 2 ליטר
  // milk). For those the line total says nothing (more milk costs more) but the price per litre / kg / item does,
  // so they compete by unit price - and only when EVERY competitor has one, all in the same unit. Comparable
  // products whose sizes are not equal (within 1%) are also compared by unit price when all have one. Otherwise:
  // line total, among identical|similar only (sizeDiff entries left out).
  // Adds lines[i].cheapest (chains tied at the best value), lines[i].cheapestBy ('unit'|'total'|null), competitors.
  const perLineCheapest = [];
  for (const l of lines) {
    l.cheapest = [];
    l.cheapestBy = null;
    l.competitors = 0;
    const comp = okChains.filter((c) => COMPARABLE.has(l.chains[c].match));
    const kin = okChains.filter((c) => COMPARABLE.has(l.chains[c].match) || l.chains[c].sizeDiff);
    const eff = Object.fromEntries(kin.map((c) => [c, effectiveUnitPrice(l.chains[c])]));
    const sameUnit = kin.every((c) => eff[c]) && new Set(kin.map((c) => eff[c].unit)).size === 1;
    const sizes = kin.map((c) => l.chains[c].size);
    const unequal = kin.some((c) => l.chains[c].sizeDiff) ||
      (sizes.every(Boolean) && sizes.some((s) => !sameSize(s, sizes[0], 0.01)));
    const by = kin.length > 1 && sameUnit && unequal ? 'unit' : 'total';
    const pool = by === 'unit' ? kin : comp;
    if (!pool.length) continue;
    const val = (c) => (by === 'unit' ? eff[c].value : l.chains[c].lineTotal);
    let best = null;
    for (const c of pool) if (best == null || val(c) < val(best)) best = c;
    const row = { line: l.line, chain: best, price: l.chains[best].lineTotal };
    if (by === 'unit') Object.assign(row, { by, unitPrice: r2(eff[best].value), unitLabel: eff[best].label });
    perLineCheapest.push(row);
    l.cheapest = pool.filter((c) => Math.abs(val(c) - val(best)) < 0.005);
    l.cheapestBy = by;
    l.competitors = pool.length;
  }
  return { chains, lines, perLineCheapest };
}

// What one unit (1 kg / 1 litre / 1 item) of a line actually costs, after promotions and the site's own line
// price: lineTotal / (qty x size). Without a size in the name: the product's unit price scaled the same way.
// -> {value, unit, label} | null
export function effectiveUnitPrice(e) {
  if (!e || !e.product || !(e.lineTotal > 0) || !(e.qty > 0)) return null;
  const size = e.size !== undefined ? e.size : productSize(e.product);
  const up = e.unitPrice !== undefined ? e.unitPrice : unitPriceOf(e.product, size);
  if (size) {
    const label = up && up.unit === size.unit ? up.label : ({ g: 'לק"ג', ml: 'לליטר', unit: 'ליחידה' })[size.unit];
    return { value: e.lineTotal / (e.qty * size.amount / BASE[size.unit]), unit: size.unit, label };
  }
  if (up && e.product.price > 0) return { value: up.value * e.lineTotal / (e.product.price * e.qty), unit: up.unit, label: up.label };
  return null;
}

// -> { best: chain|null, ranking: [{chain, final, adjustedFinal, reasons}], perLineCheapest }
export function recommend(summary) {
  const okChains = Object.keys(summary.chains).filter((c) => summary.chains[c].status === 'ok');
  const rows = okChains.map((c) => {
    const s = summary.chains[c];
    // missing lines are priced at the cheapest OTHER chain's line total
    let fill = 0;
    for (const l of summary.lines) {
      if (l.chains[c].match !== 'missing') continue;
      const others = okChains.filter((o) => o !== c && l.chains[o].match !== 'missing').map((o) => l.chains[o].lineTotal);
      if (others.length) fill += Math.min(...others);
    }
    return { chain: c, s, final: s.final, adjustedFinal: r2(s.final + fill) };
  });
  // A cart you cannot actually order must not win: empty carts and carts below the site's minimum order
  // are ranked after every orderable cart.
  for (const r of rows) r.orderable = r.s.itemsTotal > 0 && !r.s.belowMinimum;
  rows.sort((a, b) => (b.orderable - a.orderable) || a.adjustedFinal - b.adjustedFinal || a.final - b.final);
  const ranking = rows.map((r, i) => {
    const s = r.s;
    const reasons = [];
    if (i === 0 && r.orderable) reasons.push(rows.length > 1 ? 'הסל הזול ביותר כולל משלוח' : 'הרשת היחידה שהעגלה שלה הושלמה');
    if (s.itemsTotal <= 0) reasons.push('העגלה ריקה — אף מוצר לא נמצא');
    if (s.missingCount === 1) reasons.push('חסר מוצר אחד — הושלם במחיר מהרשת הזולה לצורך ההשוואה');
    else if (s.missingCount > 1) reasons.push(`חסרים ${s.missingCount} מוצרים — הושלמו במחיר מהרשת הזולה לצורך ההשוואה`);
    if (s.unavailable && s.unavailable.length) reasons.push('ייתכן שהסכום באתר כולל מוצרים שאזלו');
    if (s.differentCount > 0) reasons.push(`${s.differentCount} מוצרים שונים ממה שרגילים לקנות`);
    if (s.belowMinimum) reasons.push('מתחת למינימום הזמנה');
    if (s.deliveryFeeUnknown) reasons.push('דמי משלוח לא ידועים — לא נכללו בסכום');
    if (s.itemsSource === 'estimate') reasons.push('הסכום הוא הערכה — העגלה לא אומתה באתר');
    if (s.discountTotal > 0) reasons.push('כולל הנחות אישיות');
    return { chain: r.chain, final: r.final, adjustedFinal: r.adjustedFinal, orderable: r.orderable, reasons };
  });
  const best = ranking.length && ranking[0].orderable ? ranking[0].chain : null;
  return { best, ranking, perLineCheapest: summary.perLineCheapest || [] };
}
