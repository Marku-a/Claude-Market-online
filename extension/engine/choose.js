// Per-chain product choice, promo math, suggestions. Pure, browser-compatible.
import { similarity, productKey } from './text.js';

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const hasUnit = (c) => isNum(c.unitPrice) && c.unitPrice > 0;
const r2 = (x) => Math.round((x + Math.sign(x) * 1e-9) * 100) / 100;

// A promo counts only when it beats the regular price by >= 5% per unit. Ignored for kg items.
export function promoWorth(product) {
  const p = product && product.promo;
  if (!p || product.soldBy === 'kg' || !(product.price > 0)) return false;
  if (!(p.minQty >= 1) || !(p.totalPrice > 0)) return false;
  return p.totalPrice / p.minQty <= product.price * 0.95;
}

function rawCost(product, qty) {
  const gross = product.price * qty;
  let saving = 0;
  let applied = false;
  if (promoWorth(product) && qty >= product.promo.minQty) {
    const mq = product.promo.minQty;
    saving = gross - (Math.floor(qty / mq) * product.promo.totalPrice + (qty % mq) * product.price);
    applied = true;
  }
  return { total: gross - saving, applied, saving };
}

// -> { total, promoApplied, promoSaving }  (qty may be fractional for kg items)
export function lineCost(product, qty) {
  const c = rawCost(product, qty);
  return { total: r2(c.total), promoApplied: c.applied, promoSaving: r2(c.saving) };
}

function topBrand(profile, category) {
  const bc = category && profile.brandCounts && profile.brandCounts[category];
  if (!bc) return null;
  const e = Object.entries(bc);
  if (!e.length) return null;
  e.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  return e[0][0];
}

// parsedLine: {raw, query, qty}; results: Product[] of ONE chain; profile: buildProfile() output.
// -> { status, product, qty, reasons, alternatives, missingReason, ranked }
// (ranked = all in-stock products, best first; feed ranked.slice(1) to swapSuggestion)
export function chooseForLine(parsedLine, results, profile) {
  const all = results || [];
  const stock = all.filter((c) => c.inStock !== false);
  if (!stock.length) {
    const missingReason = all.length ? 'אזל מהמלאי' : 'לא נמצא באתר';
    return {
      status: 'missing', product: null, qty: parsedLine.qty ?? null, reasons: [missingReason],
      alternatives: [], missingReason, ranked: [],
    };
  }
  const useUnit = stock.every(hasUnit);
  const cmpOf = (c) => (useUnit ? c.unitPrice : c.price);
  const cmpVals = stock.map(cmpOf);
  const scored = stock.map((c) => {
    const p = profile.products[productKey(c)];
    const top = topBrand(profile, c.category || (p && p.category));
    const rank = cmpVals.filter((v) => v < cmpOf(c)).length;
    let sc = 0;
    const why = [];
    if (p) {
      sc += Math.min(10 * p.orderCount, 60);
      why.push(`קנית את המוצר הזה ב-${p.orderCount} הזמנות`);
    }
    if (top && c.brand === top) {
      sc += 8;
      why.push('המותג המועדף עליך בקטגוריה');
    }
    sc += similarity(parsedLine.query, c.name) * 20;
    if (promoWorth(c)) {
      sc += 5;
      why.push('במבצע');
    }
    sc -= rank * 2;
    if (rank === 0 && stock.length > 1) why.push('הזול ביותר מבין התוצאות');
    return { sc, c, p, why };
  });
  scored.sort((a, b) => b.sc - a.sc || a.c.price - b.c.price);
  const best = scored[0];
  const qty = parsedLine.qty || (best.p ? best.p.typicalQty : 1);
  return {
    status: 'ok', product: best.c, qty, reasons: best.why,
    alternatives: scored.slice(1, 4).map((s) => s.c), missingReason: null,
    ranked: scored.map((s) => s.c),
  };
}

// Suggest buying up to the promo quantity. -> {id,name,currentQty,suggestedQty,extraCost,savingPerUnit,description} | null
export function dealSuggestion(product, qty, profile) {
  if (!promoWorth(product)) return null;
  const mq = product.promo.minQty;
  if (qty >= mq || mq - qty > 2) return null;
  const p = profile.products[productKey(product)];
  if (!p || p.orderCount < 3) return null;
  return {
    id: product.id, name: product.name, currentQty: qty, suggestedQty: mq,
    extraCost: r2(product.promo.totalPrice - product.price * qty),
    savingPerUnit: r2(product.price - product.promo.totalPrice / mq),
    description: product.promo.description || '',
  };
}

// Cheaper similar product (>= 10% less effective cost at the same qty, promos included).
// others: in-stock candidates other than `chosen`, best-scored first.
// -> {from, to, savingPerUnit, savingTotal, reason} | null
export function swapSuggestion(chosen, qty, others) {
  const price = chosen.price;
  const chTotal = rawCost(chosen, qty).total;
  let best = null;
  for (const alt of others || []) {
    if (alt === chosen || alt.inStock === false) continue;
    const near = similarity(chosen.name, alt.name) >= 0.4 ||
      (chosen.category && alt.category && chosen.category === alt.category);
    if (!near || price <= 0 || chTotal <= 0) continue;
    if (hasUnit(chosen) !== hasUnit(alt)) continue; // pack sizes not comparable
    const altTotal = rawCost(alt, qty).total;
    let chEff;
    let altEff;
    if (hasUnit(chosen) && hasUnit(alt)) {
      chEff = chosen.unitPrice * chTotal / (price * qty);
      altEff = alt.unitPrice * (alt.price > 0 ? altTotal / (alt.price * qty) : 1);
    } else {
      chEff = chTotal;
      altEff = altTotal;
    }
    if (chEff <= 0 || altEff > 0.9 * chEff) continue;
    let tot = chTotal - altTotal;
    if (tot <= 0) tot = chTotal * (1 - altEff / chEff);
    if (!best || tot > best.tot) best = { tot, alt };
  }
  if (!best) return null;
  return {
    from: { id: chosen.id, name: chosen.name, price },
    to: { id: best.alt.id, name: best.alt.name, price: best.alt.price },
    savingPerUnit: r2(best.tot / qty), savingTotal: r2(best.tot),
    reason: 'מוצר דומה זול יותר ב-10% לפחות',
  };
}

// Change vs last paid price. -> {id,name,old,new,pct} | null (|pct| >= 3)
export function priceChange(product, profile) {
  const p = profile.products[productKey(product)];
  if (!p || !isNum(p.lastPrice) || p.lastPrice <= 0) return null;
  const pct = r2((product.price - p.lastPrice) / p.lastPrice * 100);
  if (Math.abs(pct) < 3) return null;
  return { id: product.id, name: product.name, old: p.lastPrice, new: product.price, pct };
}
