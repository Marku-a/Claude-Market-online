// Rami Levy adapter (runs inside a www.rami-levy.co.il tab). Endpoints: docs/SITES.md.
// Auth token comes from the site's own localStorage and is used only as a request header.
import {
  AdapterError, createHttp, need, num, checkId, assertPageSafe, runDiagnose, lazyEnv,
} from './http.js';
import { CHAINS } from './registry.js';

const ORIGIN = 'https://www.rami-levy.co.il';
const API = 'https://www-api.rami-levy.co.il';
const DEFAULT_STORE = 331;
const CTX_TTL_MS = 60000;
const ID_RE = /^\d+$/;

export const meta = {
  id: 'ramilevy',
  name: 'רמי לוי',
  origin: ORIGIN,
  apiOrigins: [API],
  homeUrl: `${ORIGIN}/he`,
  cartUrl: `${ORIGIN}/he`, // no /cart page: the cart is a side panel on the home page
  loginUrl: `${ORIGIN}/he`,
  forbidden: CHAINS.ramilevy.forbidden, // single source of truth: registry.js
  cartHint: 'לחצו על סמל סל הקניות בראש האתר – העגלה נפתחת בחלונית בצד',
};

// ---------- pure parsing ----------

// ctx: { store }
export function parseSearch(json, ctx = {}) {
  const data = need(json, 'data', 'array');
  const store = Number(ctx.store ?? DEFAULT_STORE);
  const out = [];
  for (const it of data) {
    if (!it || typeof it !== 'object' || it.id == null) continue;
    const price = it.price ? num(it.price.price) : null;
    if (price === null || !it.name) continue;
    const prop = it.prop || {};
    const sale = (Array.isArray(it.sale) ? it.sale : []).find((s) => s && num(s.cmt) >= 1 && num(s.scm) > 0);
    out.push({
      chain: meta.id,
      id: String(it.id),
      barcode: it.barcode != null && it.barcode !== '' ? String(it.barcode) : null,
      name: String(it.name),
      brand: (it.gs && it.gs.BrandName) || null,
      category: (it.department && it.department.name) || null,
      price,
      unitPrice: null,
      unitLabel: null,
      inStock: Array.isArray(it.available_in) ? it.available_in.map(Number).includes(store) : true,
      promo: sale
        ? {
            description: sale.title || sale.name || 'מבצע',
            minQty: num(sale.cmt),
            totalPrice: num(sale.scm),
            clubOnly: !!sale.is_club,
          }
        : null,
      soldBy: prop.by_kilo || prop.sw_shakil ? 'kg' : 'unit',
    });
    if (out.length >= 10) break;
  }
  return out;
}

// Customer endpoint -> { items: {id: qty}, deliveryFee, storeId }
export function parseCustomer(json) {
  need(json, 'user', 'object');
  // Real site (verified 2026-11-20): `cart` is null until the first item is added; then {uid, items:{id:qty}, ...}.
  if (!('cart' in json)) throw new AdapterError('SHAPE_CHANGED', 'missing field: cart');
  const cart = json.cart === null ? { items: {} } : need(json, 'cart', 'object');
  let items = cart.items;
  if (items == null || (Array.isArray(items) && items.length === 0)) items = {};
  if (typeof items !== 'object' || Array.isArray(items)) {
    throw new AdapterError('SHAPE_CHANGED', 'unexpected type at: cart.items');
  }
  const dt = json.deliveryTimesCustomer;
  return {
    items: { ...items },
    deliveryFee: dt && num(dt.price) !== null ? num(dt.price) : null,
    storeId: dt && dt.store_id != null ? dt.store_id : json.user.store_id ?? null,
  };
}

// Priced cart response -> CartView. fallbackFee: customer.deliveryTimesCustomer.price
export function parseCart(json, fallbackFee = null) {
  const items = need(json, 'items', 'array');
  const itemsTotal = need(json, 'price', 'number');
  const lines = [];
  let fee = null;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const total = num(it.FormatedTotalPrice) ?? (num(it.price) ?? 0) * (num(it.quantity) ?? 0);
    if (it.is_delivery) {
      fee = total;
      continue;
    }
    lines.push({ id: String(it.id), name: String(it.name ?? ''), qty: num(it.quantity) ?? 0, lineTotal: total });
  }
  const deliveryFee = fee ?? fallbackFee ?? null;
  return { lines, itemsTotal, deliveryFee, grandTotal: itemsTotal + (deliveryFee || 0), minOrder: null };
}

// Order list -> [{ id, date }] newest first. Only id and date are kept (no personal fields).
// Real shape (verified 2026-11-20): data.data.data = [{id, supply_at 'YYYY-MM-DD hh:mm:ss', created_at ISO, items, ...}]
export function parseOrderList(json) {
  const rows = need(json, 'data.data.data', 'array');
  const out = [];
  for (const o of rows) {
    if (!o || typeof o !== 'object' || o.id == null) continue;
    let date = null;
    for (const v of [o.supply_at, o.created_at]) {
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { date = v.slice(0, 10); break; }
    }
    if (!date) continue;
    out.push({ id: o.id, date });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

// Catalog items (/api/items) -> Map item_id -> { barcode, brand, category }
export function parseItemsInfo(json) {
  const map = new Map();
  for (const it of need(json, 'data', 'array')) {
    if (!it || typeof it !== 'object' || it.id == null) continue;
    map.set(String(it.id), {
      barcode: it.barcode != null && it.barcode !== '' ? String(it.barcode) : null,
      brand: (it.gs && it.gs.BrandName) || null,
      category: (it.department && it.department.name) || null,
    });
  }
  return map;
}

// Order detail -> Order. barcodeMap: Map|object item_id -> {barcode, brand, category}. The delivery line is skipped.
export function parseOrderDetail(json, id, date, barcodeMap = null) {
  const lines = need(json, 'data.lines', 'array');
  const deliveryId = json.data.delivery_item_id;
  const info = (k) => (barcodeMap instanceof Map ? barcodeMap.get(k) : barcodeMap && barcodeMap[k]) || null;
  const items = [];
  for (const l of lines) {
    if (!l || typeof l !== 'object' || l.item_id == null) continue;
    if (deliveryId != null && String(l.item_id) === String(deliveryId)) continue;
    const k = String(l.item_id);
    const i = info(k);
    items.push({
      id: k,
      barcode: (i && i.barcode) || null,
      name: String(l.name ?? ''),
      brand: (i && i.brand) || null,
      category: (i && i.category) || null,
      qty: num(l.quantity) ?? 0,
      price: num(l.price) ?? 0,
    });
  }
  return { chain: meta.id, id: String(id), date, items };
}

// ---------- adapter ----------

let ctxCache = null; // { key, at, value } - module scope, 60s
export function _resetCache() {
  ctxCache = null;
}

export function createAdapter(env) {
  const http = createHttp(meta, (...a) => env.fetch(...a));
  const now = () => (env.now ? env.now() : new Date());

  function auth() {
    let raw;
    try {
      raw = env.localStorage && env.localStorage.getItem('ramilevy');
      const user = raw ? JSON.parse(raw).authuser.user : null;
      if (user && user.token) return user;
    } catch {
      // unreadable state = logged out
    }
    return null;
  }
  const requireAuth = () => {
    const u = auth();
    if (!u) throw new AdapterError('NOT_LOGGED_IN', 'not logged in');
    return u;
  };
  // tokens are only ever placed in request headers
  const headers = (u) => (u
    ? { authorization: `Bearer ${u.token}`, ecomtoken: u.token, locale: 'he' }
    : { locale: 'he' });

  async function customer(u) {
    const id = checkId(u.id, ID_RE, 'user id');
    const json = await http.getJson(`${API}/api/v2/site/clubs/customer/${encodeURIComponent(id)}`, { headers: headers(u) });
    const c = parseCustomer(json);
    const store = Number(c.storeId ?? u.store_id ?? DEFAULT_STORE);
    ctxCache = { key: `${u.token}|${id}`, at: now().getTime(), value: { store } };
    return { ...c, store };
  }
  // { token, uid, store } - the token never leaves this closure's callers
  async function ctx(u) {
    const key = `${u.token}|${u.id}`;
    if (ctxCache && ctxCache.key === key && now().getTime() - ctxCache.at < CTX_TTL_MS) {
      return { token: u.token, uid: u.id, store: ctxCache.value.store };
    }
    const c = await customer(u);
    return { token: u.token, uid: u.id, store: c.store };
  }

  // persist=false omits `ecomtoken`: the site then only prices the map and the stored cart is untouched
  // (verified 2026-11-20). Reads must never write.
  async function priceCart(u, store, items, { persist = true } = {}) {
    const h = headers(u);
    if (!persist) delete h.ecomtoken;
    return http.postJson(`${ORIGIN}/api/v2/cart`, {
      store: Number(store), isClub: 0, supplyAt: now().toISOString(), items, meta: null,
    }, { headers: h });
  }

  const adapter = {
    ...meta,
    lastNote: null,

    async checkLogin() {
      assertPageSafe(meta, env);
      const u = auth();
      if (!u) return { loggedIn: false };
      const first = typeof u.first_name === 'string' ? u.first_name.trim().split(/\s+/)[0] : '';
      return first ? { loggedIn: true, userLabel: first } : { loggedIn: true };
    },

    async getDeliveryContext() {
      assertPageSafe(meta, env);
      const u = requireAuth();
      const c = await customer(u);
      let fee = c.deliveryFee;
      // deliveryTimesCustomer is null until a slot is chosen; the fee then exists only as the cart's
      // is_delivery line, and only for a non-empty cart.
      if (fee === null && Object.keys(c.items).length) {
        fee = parseCart(await priceCart(u, c.store, c.items, { persist: false }), null).deliveryFee;
      }
      return { addressLabel: null, storeLabel: String(c.store), deliveryFee: fee, minOrder: null };
    },

    async getOrders(limit = 10) {
      assertPageSafe(meta, env);
      const u = requireAuth();
      const list = parseOrderList(await http.getJson(`${API}/api/v3/site/orders?page=1&activeFilter=0`, { headers: headers(u) }))
        .slice(0, Math.max(0, Number(limit) || 0));
      const out = [];
      for (const o of list) {
        const id = checkId(o.id, ID_RE, 'order id');
        const detail = await http.getJson(`${API}/api/v3/site/orders/${id}`, { headers: headers(u) });
        const order = parseOrderDetail(detail, id, o.date, null);
        const ids = [...new Set(order.items.map((i) => i.id))].filter((x) => ID_RE.test(x));
        let map = null;
        if (ids.length) {
          try {
            map = parseItemsInfo(await http.postJson(`${ORIGIN}/api/items`,
              { ids: ids.join(','), type: 'id' }, { headers: headers(u) }));
          } catch {
            map = null; // barcodes are optional: continue without them
          }
        }
        out.push(map ? parseOrderDetail(detail, id, o.date, map) : order);
      }
      return out;
    },

    async search(query) {
      assertPageSafe(meta, env);
      const u = auth();
      const { store } = u ? await ctx(u) : { store: DEFAULT_STORE };
      const json = await http.postJson(`${ORIGIN}/api/catalog`,
        { q: String(query), aggs: 1, store: Number(store) }, { headers: headers(u) });
      return parseSearch(json, { store });
    },

    async getCart() {
      assertPageSafe(meta, env);
      const c = await customer(requireAuth());
      const u = auth();
      if (!Object.keys(c.items).length) {
        return { lines: [], itemsTotal: 0, deliveryFee: c.deliveryFee, grandTotal: c.deliveryFee || 0, minOrder: null };
      }
      return parseCart(await priceCart(u, c.store, c.items, { persist: false }), c.deliveryFee);
    },

    // Replace semantics: POST the whole map so other items are preserved.
    async setItem(productId, qty) {
      assertPageSafe(meta, env);
      const id = checkId(productId, ID_RE, 'product id');
      const q = Number(qty);
      if (!Number.isFinite(q) || q < 0) throw new AdapterError('UNSUPPORTED', 'invalid quantity');
      const u = requireAuth();
      const c = await customer(u);
      // The server returns quantities as numbers; the site writes them back as "1.00" strings — do the same.
      const items = {};
      for (const [k, v] of Object.entries(c.items)) if (num(v) !== null) items[k] = num(v).toFixed(2);
      if (q > 0) items[id] = q.toFixed(2);
      else delete items[id];
      const res = await priceCart(u, c.store, items);
      const lines = need(res, 'items', 'array');
      const line = lines.find((l) => l && !l.is_delivery && String(l.id) === id);
      const got = line ? num(line.quantity) ?? 0 : 0;
      return { ok: Math.abs(got - q) < 1e-9, qty: got };
    },

    async emptyCart() {
      assertPageSafe(meta, env);
      const u = requireAuth();
      const c = await customer(u);
      const res = await priceCart(u, c.store, {});
      const lines = need(res, 'items', 'array');
      return { ok: !lines.some((l) => l && !l.is_delivery) };
    },

    async diagnose() {
      return runDiagnose(http, [
        ['checkLogin', () => adapter.checkLogin()],
        ['search', () => adapter.search('חלב')],
        ['getCart', () => adapter.getCart()],
        ['getOrders', () => adapter.getOrders(1)],
        ['getDeliveryContext', () => adapter.getDeliveryContext()],
      ]);
    },
  };
  return adapter;
}

export default createAdapter(lazyEnv());
