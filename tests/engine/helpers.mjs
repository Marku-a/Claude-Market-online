// Shared fixtures + a small "plan" driver mirroring planner.plan for parity tests.
import { normalize, parseListLine, productKey } from '../../extension/engine/text.js';
import { buildProfile, coPurchases, maybeForgot, goesWith } from '../../extension/engine/profile.js';
import { chooseForLine, lineCost, dealSuggestion, swapSuggestion, priceChange } from '../../extension/engine/choose.js';

export const TODAY = '2026-11-09';

// item tuple: [barcode, name, brand, category, qty, price]
export function order(id, date, ...items) {
  return {
    chain: 'hazihinam', id, date,
    items: items.map((i) => ({ id: i[0], barcode: i[0], name: i[1], brand: i[2], category: i[3], qty: i[4], price: i[5] })),
  };
}

export function cand(id, name, price, kw = {}) {
  return {
    chain: 'hazihinam', id, barcode: id, name, brand: null, category: null, price,
    unitPrice: null, unitLabel: null, inStock: true, promo: null, soldBy: 'unit', ...kw,
  };
}

export const MILK = ['1', 'חלב תנובה 3% 1 ליטר', 'תנובה', 'חלב'];
export const BREAD = ['2', 'לחם אחיד', 'אנגל', 'מאפים'];
export const EGGS = ['3', 'ביצים L', 'תנובה', 'ביצים'];

const r2 = (x) => Math.round((x + Math.sign(x) * 1e-9) * 100) / 100;

export function runPlan(orders, lines, searches, watch = []) {
  const profile = buildProfile(orders, TODAY);
  const parsed = lines.map(parseListLine);
  const byRaw = new Map();
  const byNorm = new Map();
  for (const s of searches) {
    if (!byRaw.has(s.line)) byRaw.set(s.line, s.results);
    const n = normalize(s.line);
    if (!byNorm.has(n)) byNorm.set(n, s.results);
  }
  const allKeys = new Set(searches.flatMap((s) => s.results.map(productKey)));
  const items = [];
  const missing = [];
  const deals = [];
  const swaps = [];
  const chosenKeys = new Set();
  const chosen = [];
  for (const ln of parsed) {
    const results = byRaw.get(ln.raw) ?? byNorm.get(normalize(ln.raw)) ?? [];
    const ch = chooseForLine(ln, results, profile);
    if (ch.status === 'missing') {
      missing.push({ line: ln.raw, reason: ch.missingReason });
      items.push({ line: ln.raw, status: 'missing', product: null, lineTotal: 0, reasons: ch.reasons });
      continue;
    }
    const cost = lineCost(ch.product, ch.qty);
    const deal = dealSuggestion(ch.product, ch.qty, profile);
    if (deal) deals.push(deal);
    const swap = swapSuggestion(ch.product, ch.qty, ch.ranked.slice(1));
    if (swap) swaps.push(swap);
    chosenKeys.add(productKey(ch.product));
    chosen.push(ch.product);
    items.push({
      line: ln.raw, status: 'ok', product: ch.product, qty: ch.qty, lineTotal: cost.total,
      promoApplied: cost.promoApplied, promoSaving: cost.promoSaving, reasons: ch.reasons,
      alternatives: ch.alternatives,
    });
  }
  const seen = new Set();
  const changes = [];
  for (const p of [...chosen, ...watch]) {
    const k = productKey(p);
    if (seen.has(k)) continue;
    const c = priceChange(p, profile);
    if (c) { seen.add(k); changes.push(c); }
  }
  changes.sort((a, b) => b.pct - a.pct);
  const searched = new Set([...allKeys, ...watch.filter((w) => w.inStock === false).map(productKey)]);
  const forgot = maybeForgot(profile, chosenKeys, searched, parsed.map((l) => l.query));
  const pairs = coPurchases(orders);
  const goes = goesWith(profile, pairs, chosenKeys,
    new Set([...forgot.map((f) => f.key), ...searched]));
  return {
    items, missing, deals, swaps, changes, forgot, goes,
    estimatedTotal: r2(items.filter((i) => i.status === 'ok').reduce((s, i) => s + i.lineTotal, 0)),
  };
}
