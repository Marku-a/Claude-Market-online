// Purchase profile built from the merged order history of all chains.
import { similarity, productKey } from './text.js';

const DAY_MS = 86400000;

function dayNum(d) {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
  const [y, m, dd] = s.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, dd) / DAY_MS);
}

function r2(x) {
  return Math.round((x + Math.sign(x) * 1e-9) * 100) / 100;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const asSet = (x) => (x instanceof Set ? x : new Set(x || []));

// orders: flat Order[] (all chains). today: 'YYYY-MM-DD'
export function buildProfile(orders, today) {
  const sorted = [...(orders || [])].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const stats = new Map();
  const brandCounts = {};
  for (const o of sorted) {
    const per = new Map();
    for (const it of o.items || []) {
      const k = productKey(it);
      const e = per.get(k) || { qty: 0, it };
      e.qty += it.qty || 1;
      e.it = it;
      per.set(k, e);
    }
    for (const [k, e] of per) {
      const it = e.it;
      let st = stats.get(k);
      if (!st) stats.set(k, (st = { qtys: [], dates: [] }));
      st.qtys.push(e.qty);
      st.dates.push(o.date);
      st.name = it.name || '';
      st.brand = it.brand ?? null;
      st.category = it.category ?? null;
      st.lastPrice = it.price;
      if (it.category && it.brand) {
        const bc = (brandCounts[it.category] ||= {});
        bc[it.brand] = (bc[it.brand] || 0) + 1;
      }
    }
  }
  const t = dayNum(today);
  const products = {};
  for (const [k, st] of stats) {
    const days = [...new Set(st.dates.map(dayNum))].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push(days[i] - days[i - 1]);
    const last = days[days.length - 1];
    const lastDate = st.dates.reduce((a, b) => (b > a ? b : a));
    products[k] = {
      name: st.name,
      brand: st.brand,
      category: st.category,
      orderCount: st.qtys.length,
      totalQty: st.qtys.reduce((a, b) => a + b, 0),
      typicalQty: Math.max(1, Math.floor(median(st.qtys) + 0.5)),
      lastDate,
      lastPrice: st.lastPrice,
      avgIntervalDays: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
      daysSinceLast: t - last,
    };
  }
  return { products, brandCounts, meta: { orders: sorted.length } };
}

// -> [{a, b, support, confidence}] sorted by confidence, support, a, b
export function coPurchases(orders, minSupport = 3) {
  const count = new Map();
  const pairs = new Map();
  for (const o of orders || []) {
    const keys = [...new Set((o.items || []).map(productKey))].sort();
    for (const k of keys) count.set(k, (count.get(k) || 0) + 1);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const pk = keys[i] + '\u0000' + keys[j];
        pairs.set(pk, (pairs.get(pk) || 0) + 1);
      }
    }
  }
  const out = [];
  for (const [pk, sup] of pairs) {
    if (sup < minSupport) continue;
    const [a, b] = pk.split('\u0000');
    out.push({ a, b, support: sup, confidence: sup / count.get(a) });
    out.push({ a: b, b: a, support: sup, confidence: sup / count.get(b) });
  }
  out.sort((x, y) =>
    y.confidence - x.confidence || y.support - x.support || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) ||
    (x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return out;
}

// Staples that are due but not on the list. chosenKeys / searchedKeys: Set (or array) of product keys.
// -> [{key, name, reason}] (max 8, most overdue first)
export function maybeForgot(profile, chosenKeys, searchedKeys, queries) {
  const chosen = asSet(chosenKeys);
  const searched = asSet(searchedKeys);
  const out = [];
  for (const [k, p] of Object.entries(profile.products)) {
    const iv = p.avgIntervalDays;
    if (p.orderCount < 3 || iv == null || chosen.has(k) || searched.has(k)) continue;
    if (p.daysSinceLast < 0.9 * iv) continue;
    if ((queries || []).some((q) => similarity(q, p.name) >= 0.5)) continue;
    const ratio = iv ? p.daysSinceLast / iv : Infinity;
    out.push({
      ratio,
      key: k,
      name: p.name,
      reason: `בדרך כלל קונה כל ~${Math.round(iv)} ימים, עברו ${p.daysSinceLast} ימים`,
    });
  }
  out.sort((x, y) => y.ratio - x.ratio);
  return out.slice(0, 8).map(({ key, name, reason }) => ({ key, name, reason }));
}

// Items usually bought together with something already chosen.
// pairs: result of coPurchases(). excludeKeys: keys already suggested/searched/etc.
// -> [{with, key, name, confidence}] (confidence >= 0.6, max 6)
export function goesWith(profile, pairs, chosenKeys, excludeKeys) {
  const chosen = asSet(chosenKeys);
  const exclude = asSet(excludeKeys);
  const seen = new Set();
  const out = [];
  for (const r of pairs || []) {
    if (r.confidence < 0.6 || !chosen.has(r.a)) continue;
    const b = r.b;
    if (chosen.has(b) || exclude.has(b) || seen.has(b)) continue;
    const pa = profile.products[r.a];
    const pb = profile.products[b];
    if (!pa || !pb) continue;
    seen.add(b);
    out.push({ with: pa.name, key: b, name: pb.name, confidence: r2(r.confidence) });
    if (out.length >= 6) break;
  }
  return out;
}
