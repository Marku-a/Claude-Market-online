// Rami Levy adapter (runs inside a www.rami-levy.co.il tab). Endpoints: docs/SITES.md.
// Auth token comes from the site's own localStorage and is used only as a request header.
import {
  AdapterError, createHttp, need, num, checkId, assertPageSafe, runDiagnose, lazyEnv,
} from './http.js';

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
  forbidden: [/\/dashboard\/checkout/i],
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
  const cart = need(json, 'cart', 'object');
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

  async function priceCart(u, store, items) {
    return http.postJson(`${ORIGIN}/api/v2/cart`, {
      store: Number(store), isClub: 0, supplyAt: now().toISOString(), items, meta: null,
    }, { headers: headers(u) });
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
      const c = await customer(requireAuth());
      return { addressLabel: null, storeLabel: String(c.store), deliveryFee: c.deliveryFee, minOrder: null };
    },

    async getOrders() {
      assertPageSafe(meta, env);
      const u = requireAuth();
      const json = await http.getJson(`${API}/api/v3/site/orders?page=1&activeFilter=`, { headers: headers(u) });
      need(json, 'data.data.data', 'array');
      // Order lines endpoint is unknown (SITES.md) - headers only, never guessed.
      adapter.lastNote = 'ORDER_LINES_UNKNOWN';
      return [];
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
      return parseCart(await priceCart(u, c.store, c.items), c.deliveryFee);
    },

    // Replace semantics: POST the whole map so other items are preserved.
    async setItem(productId, qty) {
      assertPageSafe(meta, env);
      const id = checkId(productId, ID_RE, 'product id');
      const q = Number(qty);
      if (!Number.isFinite(q) || q < 0) throw new AdapterError('UNSUPPORTED', 'invalid quantity');
      const u = requireAuth();
      const c = await customer(u);
      const items = { ...c.items };
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
