// Cross-chain matching, totals, personal discounts, recommendation (SPEC section 6).
import { similarity, productKey } from './text.js';
import { chooseForLine, lineCost } from './choose.js';

const r2 = (x) => Math.round((x + Math.sign(x) * 1e-9) * 100) / 100;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const COMPARABLE = new Set(['identical', 'similar']);

// parsedLine: {raw, query, qty}; resultsByChain: {chain: Product[]}; profile: buildProfile() output.
// -> { qty, reference: Product|null, chains: {chain: {match, product, qty, lineTotal,
//      promoApplied, promoSaving, reasons, alternatives, missingReason}} }
export function matchLine(parsedLine, resultsByChain, profile) {
  // 1. reference = profile favourite among all chains' results (highest orderCount, needs >= 1)
  let reference = null;
  let refCount = 0;
  for (const results of Object.values(resultsByChain)) {
    for (const c of results || []) {
      const p = profile.products[productKey(c)];
      if (p && p.orderCount > refCount) {
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
        const match = !reference || similarity(ch.product.name, reference.name) >= 0.5 ? 'similar' : 'different';
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

// chainRuns: {chain: {status, lines:[{line, match, product, qty, lineTotal}], cart: CartView|null}}
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
      per[c] = l
        ? { match: l.match, product: l.product || null, qty: l.qty, lineTotal: l.lineTotal || 0 }
        : { match: 'missing', product: null, qty: 0, lineTotal: 0 };
    }
    lines.push({ line: label, chains: per });
  }

  // like-for-like total: lines identical|similar in EVERY participating chain
  for (const l of lines) {
    if (!okChains.length || !okChains.every((c) => COMPARABLE.has(l.chains[c].match))) continue;
    for (const c of okChains) chains[c].comparableTotal = r2(chains[c].comparableTotal + l.chains[c].lineTotal);
  }

  const perLineCheapest = [];
  for (const l of lines) {
    let best = null;
    for (const c of okChains) {
      const e = l.chains[c];
      if (e.match === 'missing') continue;
      if (!best || e.lineTotal < best.price) best = { line: l.line, chain: c, price: e.lineTotal };
    }
    if (best) perLineCheapest.push(best);
  }
  return { chains, lines, perLineCheapest };
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
  rows.sort((a, b) => a.adjustedFinal - b.adjustedFinal || a.final - b.final);
  const ranking = rows.map((r, i) => {
    const s = r.s;
    const reasons = [];
    if (i === 0) reasons.push(rows.length > 1 ? 'הסל הזול ביותר כולל משלוח' : 'הרשת היחידה שהעגלה שלה הושלמה');
    if (s.missingCount === 1) reasons.push('חסר מוצר אחד — הושלם במחיר מהרשת הזולה לצורך ההשוואה');
    else if (s.missingCount > 1) reasons.push(`חסרים ${s.missingCount} מוצרים — הושלמו במחיר מהרשת הזולה לצורך ההשוואה`);
    if (s.differentCount > 0) reasons.push(`${s.differentCount} מוצרים שונים ממה שרגילים לקנות`);
    if (s.belowMinimum) reasons.push('מתחת למינימום הזמנה');
    if (s.deliveryFeeUnknown) reasons.push('דמי משלוח לא ידועים — לא נכללו בסכום');
    if (s.itemsSource === 'estimate') reasons.push('הסכום הוא הערכה — העגלה לא אומתה באתר');
    if (s.discountTotal > 0) reasons.push('כולל הנחות אישיות');
    return { chain: r.chain, final: r.final, adjustedFinal: r.adjustedFinal, reasons };
  });
  return { best: ranking.length ? ranking[0].chain : null, ranking, perLineCheapest: summary.perLineCheapest || [] };
}
