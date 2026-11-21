// Orchestrator: pure logic that drives the adapters through `rpc` and the engine. No DOM, no chrome.*.
import { normalize, similarity, parseListLine, productKey } from '../engine/text.js';
import { buildProfile, coPurchases, maybeForgot, goesWith } from '../engine/profile.js';
import { lineCost, dealSuggestion, priceChange } from '../engine/choose.js';
import { matchLine, summarize, recommend, runLine, annotateSizes } from '../engine/compare.js';

const HISTORY_LIMIT = 10;
const FAVOURITE_MIN_SIM = 0.5;
const PIN_NAME_SIM = 0.8;
const MAX_RUNS = 10;
// A search failing with one of these means the whole chain is unusable (not just one line).
const CHAIN_FATAL = new Set(['SHAPE_CHANGED', 'NOT_LOGGED_IN', 'BLOCKED', 'REDIRECT']);

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
    product, match: matchFor(product, line.reference), baseMatch: undefined, lineTotal: cost.total,
    promoApplied: cost.promoApplied, promoSaving: cost.promoSaving, reasons: [], missingReason: null,
  });
  annotateSizes(line.query, line.reference, line.chains); // sizes of all chains may now agree or differ
}

// Estimated total per chain over enabled lines. -> {[chain]: number}
export function estimateTotals(plan, chainIds) {
  const out = {};
  const ids = chainIds || Object.keys(plan.lines[0] ? plan.lines[0].chains : {});
  for (const c of ids) {
    out[c] = r2(plan.lines.filter((l) => l.enabled !== false)
      .reduce((s, l) => s + (l.chains[c] && l.chains[c].product && !l.chains[c].excluded ? l.chains[c].lineTotal || 0 : 0), 0));
  }
  return out;
}

export function createRunner({ rpc, store, today, chains }) {
  // Units this extension itself put in each cart during this session (page lifetime, never stored):
  // {chain: {productId: {units, product}}}. A re-fill treats them as its own, so going back and filling
  // again does not double quantities, and a product dropped since is taken back out.
  const session = {};
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
    const searchErrors = {}; // chain -> {lineIndex: code} for non-fatal per-line failures
    await Promise.all(chainIds.map(async (chain) => {
      const per = [];
      const errs = {};
      let lastCode = null;
      try {
        for (let i = 0; i < parsed.length; i++) {
          onProgress && onProgress({ chain, phase: 'search', done: i, total: parsed.length, message: parsed[i].query });
          let results;
          try {
            results = (await rpc(chain, 'search', [parsed[i].query])) || [];
          } catch (e) {
            const code = codeOf(e);
            if (CHAIN_FATAL.has(code)) throw e; // the whole site is unusable right now
            errs[i] = code;
            lastCode = code;
            per.push([]);
            continue;
          }
          const fav = favouriteFor(parsed[i].query);
          if (fav && fav.name) {
            try {
              results = mergeUniqueById(results, (await rpc(chain, 'search', [fav.name])) || []);
            } catch { /* favourite search failures are ignored */ }
          }
          per.push(results);
        }
        if (parsed.length && Object.keys(errs).length === parsed.length) {
          const e = new Error('all searches failed');
          e.code = lastCode;
          throw e;
        }
        resultsByChain[chain] = per;
        searchErrors[chain] = errs;
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
      for (const c of okChains) {
        line.chains[c] = { ...m.chains[c], results: byChain[c] };
        if (searchErrors[c] && searchErrors[c][i]) line.chains[c].searchError = searchErrors[c][i];
      }
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

  // "לא לקנות כאן": drop one line at ONE chain only. The chosen product is kept so re-including restores it.
  function setExcluded(plan, lineIdx, chain, excluded) {
    const e = plan.lines[lineIdx] && plan.lines[lineIdx].chains[chain];
    if (e) e.excluded = !!excluded;
    return plan;
  }

  // Chains whose cart this session already filled.
  const filledChains = () => Object.keys(session);
  // "קנייה חדשה": units added for the previous list now count as the user's own (never taken back).
  const newSession = () => { for (const k of Object.keys(session)) delete session[k]; };

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

  const sameQty = (a, b) => Math.abs(a - b) < 1e-9;
  const q3 = (x) => Math.round(x * 1000) / 1000; // kg quantities: no float noise (1.3 + 0.4 = 1.7, not 1.7000000000000002)
  const NONE = 1e-6;

  async function fill(plan, chainIds, policyByChain, { onProgress } = {}) {
    const out = {};
    await Promise.all(chainIds.map(async (chain) => {
      const jobs = plan.lines.map((l, idx) => ({ l, idx }))
        .filter(({ l }) => l.enabled !== false && l.chains[chain] && l.chains[chain].product && !l.chains[chain].excluded);
      const res = { items: [], removed: [], cart: null, rawCart: null, extra: null, couldNotEmpty: false, error: null };
      out[chain] = res;
      let step = 0;
      let total = jobs.length + 2;
      const prog = (message) => onProgress && onProgress({ chain, phase: 'fill', done: step, total, message });
      try {
        // 'absolute': the cart was emptied, quantities are set as wanted.
        // 'keep': units that are not ours stay; every product of ours is set to (units not ours) + wanted.
        // Units not ours are never lowered - only units this session itself added earlier may be (re-fill).
        let mode = 'keep';
        if ((policyByChain && policyByChain[chain]) === 'empty') {
          prog('מרוקנים עגלה');
          try {
            const r = await rpc(chain, 'emptyCart', []);
            if (r && r.ok === false) res.couldNotEmpty = true;
            else mode = 'absolute';
          } catch (e) {
            if (codeOf(e) !== 'UNSUPPORTED') throw e;
            res.couldNotEmpty = true;
          }
        }
        // Per product: { units: ours, base: units not ours (seen before our first write), product }.
        const prev = mode === 'keep' ? session[chain] || {} : {}; // an emptied cart holds nothing of ours
        const mem = {}; // what is ours after this fill; kept up to date after every write
        const inCart = {};
        const existing = {}; // units that are not ours, per product
        if (mode === 'keep') {
          const before = await rpc(chain, 'getCart', []);
          for (const x of (before && before.lines) || []) inCart[String(x.id)] = (inCart[String(x.id)] || 0) + (isNum(x.qty) ? x.qty : 0);
          for (const [id, q] of Object.entries(inCart)) existing[id] = q3(q);
        }
        // Ours can only be what is above the units not ours: if the user removed some of our units on the site,
        // they come off our count first, never off the user's own.
        for (const [id, p] of Object.entries(prev)) {
          const have = existing[id] || 0;
          const pb = isNum(p.base) ? p.base : 0;
          const ours = q3(Math.min(p.units, Math.max(0, have - pb)));
          existing[id] = q3(have - ours);
          if (ours > NONE) mem[id] = { units: ours, base: existing[id], product: p.product };
        }
        session[chain] = mem;
        const base = { ...existing };
        const setOurs = (id, units, product) => {
          const u = q3(Math.max(0, units));
          if (u > NONE) mem[id] = { units: u, base: base[id] || 0, product };
          else delete mem[id];
        };
        // A write whose result is unknown may or may not have landed: record the smaller of the two possible states.
        const unknownOutcome = (id, target, product) => setOurs(id, Math.min((mem[id] && mem[id].units) || 0, target - (base[id] || 0)), product);
        // Products of ours from an earlier fill that are no longer wanted: back to the units that are not ours.
        const wantedIds = new Set(jobs.map(({ l }) => String(l.chains[chain].product.id)));
        const drop = Object.keys(mem).filter((id) => !wantedIds.has(id));
        total += drop.length;
        step++;
        for (const { l, idx } of jobs) {
          const e = l.chains[chain];
          const id = String(e.product.id);
          prog(l.query);
          const existingQty = q3(existing[id] || 0);
          const target = q3(existingQty + e.qty);
          const item = { line: idx, productId: id, existingQty, wantedQty: e.qty, actualQty: 0, ok: false, code: null, share: null };
          try {
            const r = await rpc(chain, 'setItem', [e.product.id, target, e.product]);
            item.actualQty = r && isNum(r.qty) ? r.qty : r && r.ok ? target : 0;
            item.ok = !!(r && r.ok) && sameQty(item.actualQty, target);
            if (!r || !r.ok) item.code = (r && r.code) || 'SHAPE_CHANGED';
            if (item.actualQty > 0) existing[id] = q3(item.actualQty);
            if (r && (r.ok || isNum(r.qty))) { // the cart quantity is known: record our units
              setOurs(id, item.actualQty - (base[id] || 0), e.product);
            } else unknownOutcome(id, target, e.product);
          } catch (err) {
            item.code = codeOf(err);
            unknownOutcome(id, target, e.product);
          }
          res.items.push(item);
          step++;
        }
        for (const id of drop) {
          const target = q3(base[id] || 0);
          const p = mem[id].product || null;
          prog(p && p.name ? p.name : '');
          const rm = { productId: id, productName: (p && p.name) || null, targetQty: target, ok: false, code: null };
          try {
            const r = await rpc(chain, 'setItem', [p ? p.id : id, target, p]);
            const got = r && isNum(r.qty) ? r.qty : r && r.ok ? target : null;
            rm.ok = !!(r && r.ok) && got != null && sameQty(got, target);
            if (!rm.ok) rm.code = (r && r.code) || 'SHAPE_CHANGED';
            if (got != null) setOurs(id, got - target, p);
            else delete mem[id]; // unknown outcome: the write may have landed, so claim nothing
          } catch (err) {
            rm.code = codeOf(err);
            delete mem[id]; // unknown outcome (the write may have landed): claim nothing, never lower the user's units later
          }
          res.removed.push(rm);
          step++;
        }
        prog('בודקים את העגלה');
        try {
          const cart = await rpc(chain, 'getCart', []);
          res.rawCart = cart;
          const lines = cart.lines || [];
          const ours = new Set(res.items.map((i) => i.productId));
          // Our share of each of our cart lines: only the units we added (not what was there before).
          let ourTotal = 0;
          let overlapRest = 0;
          let overlapCount = 0;
          for (const it of res.items) {
            const cl = lines.find((x) => String(x.id) === it.productId);
            if (!cl || !isNum(cl.lineTotal)) continue;
            const denom = isNum(cl.qty) && cl.qty > 0 ? cl.qty : it.actualQty;
            const added = Math.min(it.wantedQty, Math.max(it.actualQty - it.existingQty, 0));
            it.share = denom > 0 ? (cl.lineTotal * added) / denom : 0;
          }
          const seen = new Set();
          for (const it of res.items) {
            if (it.share == null) continue;
            ourTotal += it.share;
            if (seen.has(it.productId)) continue;
            seen.add(it.productId);
            const cl = lines.find((x) => String(x.id) === it.productId);
            const mineAll = res.items.filter((x) => x.productId === it.productId && x.share != null).reduce((t, x) => t + x.share, 0);
            const rest = cl.lineTotal - mineAll;
            if (rest > 1e-9) { overlapRest += rest; overlapCount++; }
          }
          const others = lines.filter((x) => !ours.has(String(x.id)));
          if (others.length || overlapCount) {
            res.extra = {
              count: others.length + overlapCount,
              total: r2(others.reduce((s, x) => s + (x.lineTotal || 0), 0) + overlapRest),
            };
            res.cart = { ...cart, itemsTotal: r2(ourTotal), grandTotal: null };
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
      const itemFor = new Map(fr.items.map((i) => [i.line, i]));
      const lines = [];
      plan.lines.forEach((l, idx) => {
        if (l.enabled === false || !l.chains[chain]) return;
        lines.push(runLine(l.query, l.chains[chain], itemFor.get(idx) || null, fr.rawCart));
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

  return {
    connect, refreshHistory, suggestForgot, buildPlan, setChoice, setQty, toggleLine, setExcluded, filledChains, newSession,
    inspectCarts, fill, finish,
  };
}
