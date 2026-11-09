// Orchestrator: pure logic that drives the adapters through `rpc` and the engine. No DOM, no chrome.*.
import { normalize, similarity, parseListLine, productKey } from '../engine/text.js';
import { buildProfile, coPurchases, maybeForgot, goesWith } from '../engine/profile.js';
import { lineCost, dealSuggestion, priceChange } from '../engine/choose.js';
import { matchLine, summarize, recommend } from '../engine/compare.js';

const HISTORY_LIMIT = 10;
const FAVOURITE_MIN_SIM = 0.5;
const PIN_NAME_SIM = 0.8;
const MAX_RUNS = 10;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r2 = (x) => Math.round((x + Math.sign(x) * 1e-9) * 100) / 100;
const codeOf = (e) => (e && e.code) || 'NETWORK';

function mergeUniqueById(a, b) {
  const seen = new Set(a.map((p) => String(p.id)));
  const out = [...a];
  for (const p of b) {
    if (!seen.has(String(p.id))) {
      seen.add(String(p.id));
      out.push(p);
    }
  }
  return out;
}

function matchFor(product, reference) {
  if (reference && reference.barcode && product.barcode && String(reference.barcode) === String(product.barcode)) {
    return 'identical';
  }
  return !reference || similarity(product.name, reference.name) >= 0.5 ? 'similar' : 'different';
}

function applyChoice(line, chain, product) {
  const entry = line.chains[chain];
  const cost = lineCost(product, entry.qty);
  Object.assign(entry, {
    product, match: matchFor(product, line.reference), lineTotal: cost.total,
    promoApplied: cost.promoApplied, promoSaving: cost.promoSaving, reasons: [], missingReason: null,
  });
}

// Estimated total per chain over enabled lines. -> {[chain]: number}
export function estimateTotals(plan, chainIds) {
  const out = {};
  const ids = chainIds || Object.keys(plan.lines[0] ? plan.lines[0].chains : {});
  for (const c of ids) {
    out[c] = r2(plan.lines.filter((l) => l.enabled !== false)
      .reduce((s, l) => s + (l.chains[c] && l.chains[c].product ? l.chains[c].lineTotal || 0 : 0), 0));
  }
  return out;
}

export function createRunner({ rpc, store, today, chains }) {
  const loadArr = async (key) => {
    const v = await store.get(key);
    return Array.isArray(v) ? v : [];
  };

  async function loadProfile() {
    const orders = await loadArr('orders');
    const own = await loadArr('ownHistory');
    return { orders, all: [...orders, ...own], profile: buildProfile([...orders, ...own], today) };
  }

  async function connect({ onProgress } = {}) {
    const out = {};
    await Promise.all(Object.keys(chains).map(async (chain) => {
      onProgress && onProgress({ chain, phase: 'connect', done: 0, total: 1, message: '' });
      let res;
      try {
        const login = await rpc(chain, 'checkLogin', []);
        if (!login || !login.loggedIn) {
          res = { state: 'logged_out', userLabel: null, delivery: null, message: '' };
        } else {
          res = { state: 'ok', userLabel: login.userLabel || null, delivery: null, message: '' };
          try {
            const d = await rpc(chain, 'getDeliveryContext', []);
            res.delivery = {
              deliveryFee: d && isNum(d.deliveryFee) ? d.deliveryFee : null,
              minOrder: d && isNum(d.minOrder) ? d.minOrder : null,
              addressLabel: (d && d.addressLabel) || null,
              storeLabel: (d && d.storeLabel) || null,
            };
          } catch { /* delivery context is optional */ }
        }
      } catch (e) {
        const code = codeOf(e);
        res = {
          state: code === 'NOT_LOGGED_IN' ? 'logged_out' : code === 'BLOCKED' ? 'blocked' : 'error',
          userLabel: null, delivery: null, message: e.message || '', code,
        };
      }
      out[chain] = res;
      onProgress && onProgress({ chain, phase: 'connect', done: 1, total: 1, message: res.state });
    }));
    return out;
  }

  async function refreshHistory(chainIds, { onProgress } = {}) {
    const stored = await loadArr('orders');
    const seen = new Set(stored.map((o) => `${o.chain}|${o.id}`));
    const merged = [...stored];
    const out = {};
    await Promise.all(chainIds.map(async (chain) => {
      onProgress && onProgress({ chain, phase: 'history', done: 0, total: 1, message: '' });
      let added = 0;
      let note = '';
      try {
        const orders = await rpc(chain, 'getOrders', [HISTORY_LIMIT]);
        if (!Array.isArray(orders) || !orders.length) note = 'לא נמצאו הזמנות קודמות';
        for (const o of orders || []) {
          const k = `${o.chain || chain}|${o.id}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push({ ...o, chain: o.chain || chain });
          added++;
        }
      } catch (e) {
        note = codeOf(e) === 'UNSUPPORTED' ? 'היסטוריית הזמנות עדיין לא נתמכת באתר הזה' : 'לא הצלחנו לקרוא היסטוריה (' + codeOf(e) + ')';
      }
      out[chain] = { added, note };
      onProgress && onProgress({ chain, phase: 'history', done: 1, total: 1, message: note });
    }));
    await store.set('orders', merged);
    return out;
  }

  async function suggestForgot(listText) {
    const { profile } = await loadProfile();
    const queries = String(listText || '').split('\n').map(parseListLine).filter(Boolean).map((l) => l.query);
    return maybeForgot(profile, new Set(), new Set(), queries);
  }

  async function buildPlan(listText, chainIds, { onProgress } = {}) {
    const parsed = String(listText || '').split('\n').map(parseListLine).filter(Boolean);
    const { all, profile } = await loadProfile();
    const pins = (await store.get('pins')) || {};
    const favouriteFor = (query) => {
      let best = null;
      for (const p of Object.values(profile.products)) {
        if (p.orderCount >= 2 && similarity(query, p.name) >= FAVOURITE_MIN_SIM && (!best || p.orderCount > best.orderCount)) best = p;
      }
      return best;
    };
    const chainErrors = {};
    const resultsByChain = {};
    await Promise.all(chainIds.map(async (chain) => {
      const per = [];
      try {
        for (let i = 0; i < parsed.length; i++) {
          onProgress && onProgress({ chain, phase: 'search', done: i, total: parsed.length, message: parsed[i].query });
          let results = (await rpc(chain, 'search', [parsed[i].query])) || [];
          const fav = favouriteFor(parsed[i].query);
          if (fav && fav.name) {
            try {
              results = mergeUniqueById(results, (await rpc(chain, 'search', [fav.name])) || []);
            } catch { /* favourite search failures are ignored */ }
          }
          per.push(results);
        }
        resultsByChain[chain] = per;
        onProgress && onProgress({ chain, phase: 'search', done: parsed.length, total: parsed.length, message: '' });
      } catch (e) {
        chainErrors[chain] = { code: codeOf(e), message: e.message || '' };
        onProgress && onProgress({ chain, phase: 'error', done: 0, total: parsed.length, message: codeOf(e) });
      }
    }));
    const okChains = chainIds.filter((c) => resultsByChain[c]);

    const lines = parsed.map((pl, i) => {
      const byChain = {};
      for (const c of okChains) byChain[c] = resultsByChain[c][i];
      const m = matchLine(pl, byChain, profile);
      const line = { raw: pl.raw, query: pl.query, qty: m.qty, reference: m.reference, enabled: true, chains: {} };
      for (const c of okChains) line.chains[c] = { ...m.chains[c], results: byChain[c] };
      const pin = pins[normalize(pl.query)];
      if (pin) {
        for (const c of okChains) {
          const hit = byChain[c].find((p) => p.inStock !== false && (
            (pin.barcode && p.barcode && String(p.barcode) === String(pin.barcode)) || similarity(p.name, pin.name) >= PIN_NAME_SIM));
          if (hit) applyChoice(line, c, hit);
        }
      }
      return line;
    });

    const chosenKeys = new Set();
    const deals = [];
    const priceChanges = [];
    for (const l of lines) {
      for (const c of okChains) {
        const e = l.chains[c];
        if (!e.product) continue;
        chosenKeys.add(productKey(e.product));
        const d = dealSuggestion(e.product, e.qty, profile);
        if (d) deals.push({ chain: c, line: l.query, ...d });
        const pc = priceChange(e.product, profile);
        if (pc) priceChanges.push({ chain: c, line: l.query, ...pc });
      }
    }
    const queries = parsed.map((p) => p.query);
    const suggestions = {
      maybeForgot: maybeForgot(profile, chosenKeys, new Set(), queries),
      goesWith: goesWith(profile, coPurchases(all), chosenKeys, new Set()),
      deals,
      priceChanges,
    };
    return { listText: String(listText || ''), lines, chainErrors, suggestions };
  }

  async function setChoice(plan, lineIdx, chain, productId) {
    const line = plan.lines[lineIdx];
    const entry = line && line.chains[chain];
    const product = entry && entry.results.find((p) => String(p.id) === String(productId));
    if (!product) return plan;
    applyChoice(line, chain, product);
    const pins = (await store.get('pins')) || {};
    pins[normalize(line.query)] = { barcode: product.barcode || null, name: product.name };
    await store.set('pins', pins);
    return plan;
  }

  function setQty(plan, lineIdx, qty) {
    const line = plan.lines[lineIdx];
    const q = Math.max(1, Math.min(99, Math.round(Number(qty)) || 1));
    line.qty = q;
    for (const e of Object.values(line.chains)) {
      e.qty = q;
      if (e.product) {
        const cost = lineCost(e.product, q);
        Object.assign(e, { lineTotal: cost.total, promoApplied: cost.promoApplied, promoSaving: cost.promoSaving });
      }
    }
    return plan;
  }

  function toggleLine(plan, lineIdx, enabled) {
    plan.lines[lineIdx].enabled = !!enabled;
    return plan;
  }

  async function inspectCarts(chainIds) {
    const out = {};
    await Promise.all(chainIds.map(async (chain) => {
      try {
        const cart = await rpc(chain, 'getCart', []);
        out[chain] = { lines: cart.lines || [], itemsTotal: isNum(cart.itemsTotal) ? cart.itemsTotal : null };
      } catch {
        out[chain] = null;
      }
    }));
    return out;
  }

  async function fill(plan, chainIds, policyByChain, { onProgress } = {}) {
    const out = {};
    await Promise.all(chainIds.map(async (chain) => {
      const jobs = plan.lines.map((l, idx) => ({ l, idx })).filter(({ l }) => l.enabled !== false && l.chains[chain] && l.chains[chain].product);
      const res = { items: [], cart: null, rawCart: null, extra: null, couldNotEmpty: false, error: null };
      out[chain] = res;
      let step = 0;
      const total = jobs.length + 2;
      const prog = (message) => onProgress && onProgress({ chain, phase: 'fill', done: step, total, message });
      try {
        if ((policyByChain && policyByChain[chain]) === 'empty') {
          prog('מרוקנים עגלה');
          try {
            await rpc(chain, 'emptyCart', []);
          } catch (e) {
            if (codeOf(e) !== 'UNSUPPORTED') throw e;
            res.couldNotEmpty = true;
          }
        }
        step++;
        for (const { l, idx } of jobs) {
          const e = l.chains[chain];
          prog(l.query);
          const item = { line: idx, wantedQty: e.qty, actualQty: 0, ok: false, code: null };
          try {
            const r = await rpc(chain, 'setItem', [e.product.id, e.qty, e.product]);
            item.ok = !!(r && r.ok) && (!isNum(r.qty) || r.qty === e.qty);
            item.actualQty = r && isNum(r.qty) ? r.qty : r && r.ok ? e.qty : 0;
            if (!r || !r.ok) item.code = 'SHAPE_CHANGED';
          } catch (err) {
            item.code = codeOf(err);
          }
          res.items.push(item);
          step++;
        }
        prog('בודקים את העגלה');
        try {
          const cart = await rpc(chain, 'getCart', []);
          res.rawCart = cart;
          const ours = new Set(jobs.map(({ l }) => String(l.chains[chain].product.id)));
          const mine = (cart.lines || []).filter((x) => ours.has(String(x.id)));
          const others = (cart.lines || []).filter((x) => !ours.has(String(x.id)));
          if (others.length) {
            const ourTotal = r2(mine.reduce((s, x) => s + (x.lineTotal || 0), 0));
            res.extra = { count: others.length, total: r2(others.reduce((s, x) => s + (x.lineTotal || 0), 0)) };
            res.cart = { ...cart, itemsTotal: ourTotal, grandTotal: null };
          } else {
            res.cart = cart;
          }
        } catch {
          res.cart = null;
        }
        step++;
        prog('');
      } catch (e) {
        res.error = { code: codeOf(e), message: e.message || '' };
        prog('error');
      }
    }));
    return out;
  }

  async function finish(plan, fillResults, userProfile) {
    const chainRuns = {};
    for (const [chain, e] of Object.entries(plan.chainErrors || {})) chainRuns[chain] = { status: 'error', code: e.code };
    for (const chain of Object.keys(fillResults)) {
      const fr = fillResults[chain];
      if (fr.error) {
        chainRuns[chain] = { status: 'error', code: fr.error.code };
        continue;
      }
      const failed = new Set(fr.items.filter((i) => !i.ok && i.actualQty === 0).map((i) => i.line));
      const lines = [];
      plan.lines.forEach((l, idx) => {
        if (l.enabled === false || !l.chains[chain]) return;
        const e = l.chains[chain];
        const miss = !e.product || failed.has(idx);
        lines.push({
          line: l.query, match: miss ? 'missing' : e.match, product: miss ? null : e.product,
          qty: e.qty, lineTotal: miss ? 0 : e.lineTotal,
        });
      });
      chainRuns[chain] = { status: 'ok', lines, cart: fr.cart };
    }
    const summary = summarize(chainRuns, userProfile || {});
    const recommendation = recommend(summary);

    const best = recommendation.best;
    const totals = {};
    for (const [c, s] of Object.entries(summary.chains)) if (s.status === 'ok') totals[c] = s.final;
    const runs = await loadArr('runs');
    runs.push({ date: today, list: plan.listText, totals, best });
    await store.set('runs', runs.slice(-MAX_RUNS));

    const items = [];
    for (const l of plan.lines) {
      if (l.enabled === false) continue;
      const src = (best && l.chains[best] && l.chains[best].product) ||
        l.reference || Object.values(l.chains).map((e) => e.product).find(Boolean);
      if (!src) continue;
      items.push({
        id: src.id, barcode: src.barcode || null, name: src.name, brand: src.brand || null,
        category: src.category || null, qty: l.qty, price: src.price,
      });
    }
    if (items.length) {
      const own = await loadArr('ownHistory');
      own.push({ chain: 'app', id: String(Date.now()), date: today, items });
      await store.set('ownHistory', own);
    }
    await store.set('lastList', plan.listText);
    return { summary, recommendation, fillResults };
  }

  return { connect, refreshHistory, suggestForgot, buildPlan, setChoice, setQty, toggleLine, inspectCarts, fill, finish };
}
