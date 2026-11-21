// Hatzi Hinam adapter (runs inside a shop.hazi-hinam.co.il tab; Angular, API /proxy/api, cookie session).
// Endpoints: docs/SITES.md. Verified against the live site 2026-11-20: addItemToCart SETS the absolute quantity
// (0 removes the line); an empty cart has CartItems.Items === null; orders come from order/history +
// item/getItemsByOrder/{Id} (order lines carry no quantity -> qty null).
import {
  AdapterError, createHttp, need, num, checkId, assertPageSafe, runDiagnose, lazyEnv,
} from './http.js';
import { CHAINS } from './registry.js';

const ORIGIN = 'https://shop.hazi-hinam.co.il';
const API = `${ORIGIN}/proxy/api`;
const ID_RE = /^\d+$/;
const AUTH_RE = /auth|login|log in|unauthori[sz]ed|session|forbidden|401|403|התחבר|הזד/i;

export const meta = {
  id: 'hazihinam',
  name: 'חצי חינם',
  origin: ORIGIN,
  apiOrigins: [],
  homeUrl: `${ORIGIN}/`,
  // The real cart page is /checkout/cart, which the guard forbids by design, so we link the home page
  // (it has the cart icon) and never the checkout route. Do not change registry/guard for this.
  cartUrl: `${ORIGIN}/`,
  loginUrl: `${ORIGIN}/`,
  forbidden: CHAINS.hazihinam.forbidden, // single source of truth: registry.js
  cartHint: 'לחצו על סמל העגלה בראש האתר כדי לראות את העגלה',
};

// ---------- pure parsing ----------

// Envelope check -> Results. IsOK:false -> NOT_LOGGED_IN (auth-looking error) or NETWORK.
export function unwrap(json) {
  if (json === null || typeof json !== 'object' || typeof json.IsOK !== 'boolean') {
    throw new AdapterError('SHAPE_CHANGED', 'missing field: IsOK');
  }
  if (!json.IsOK) {
    const er = json.ErrorResponse || {};
    const code = String(er.ErrorCode ?? '');
    const desc = String(er.ErrorDescription ?? '');
    if (AUTH_RE.test(`${code} ${desc}`)) throw new AdapterError('NOT_LOGGED_IN', desc || code || 'not logged in');
    throw new AdapterError('NETWORK', desc || code || 'request failed');
  }
  return json.Results;
}

export function parseSearch(json) {
  const items = need(json, 'Results.Items', 'array');
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || it.Id == null) continue;
    const price = num(it.Price_NET);
    if (price === null || !it.Name) continue;
    const mz = it.Mivza && typeof it.Mivza === 'object' ? it.Mivza : null;
    const regular = num(it.Price_Regular);
    let promo = null;
    if (regular !== null && price < regular) {
      promo = {
        description: (mz && (mz.MivzaText || mz.MivzaDesc)) || 'מבצע',
        minQty: 1,
        totalPrice: price,
        clubOnly: !!(mz && mz.IsTagmul),
      };
    } else if (mz && mz.MivzaText) {
      promo = { description: mz.MivzaText, minQty: 1, totalPrice: price, clubOnly: !!mz.IsTagmul }; // informational
    }
    out.push({
      chain: meta.id,
      id: String(it.Id),
      barcode: it.BarKod != null && it.BarKod !== '' ? String(it.BarKod) : null,
      name: String(it.Name),
      brand: it.ManufacturerName || null,
      category: null,
      price,
      unitPrice: num(it.PricePerUnit),
      unitLabel: it.PricePerUnitDesc || null,
      inStock: !!it.IsInStock,
      promo,
      soldBy: it.IsShakil ? 'kg' : 'unit',
    });
    if (out.length >= 10) break;
  }
  return out;
}

// itemsJson: getItemsInCart envelope, summaryJson: cartSummary envelope
export function parseCartLines(itemsJson) {
  const ci = need(itemsJson, 'Results.CartItems', 'object');
  if (!('Items' in ci)) throw new AdapterError('SHAPE_CHANGED', 'missing field: Results.CartItems.Items');
  if (ci.Items !== null && !Array.isArray(ci.Items)) {
    throw new AdapterError('SHAPE_CHANGED', 'unexpected type at: Results.CartItems.Items (expected array)');
  }
  const items = ci.Items === null ? [] : ci.Items; // real site: empty cart has Items: null
  return items.map((it) => {
    const qty = it && it.Cart ? num(it.Cart.Quantity) : null;
    if (!it || it.Id == null || qty === null) throw new AdapterError('SHAPE_CHANGED', 'missing field: Cart.Quantity');
    const price = num(it.Price_NET) ?? 0;
    return {
      id: String(it.Id),
      name: String(it.Name ?? ''),
      qty,
      lineTotal: num(it.Calculated_Price_NET) ?? Math.round(price * qty * 100) / 100,
    };
  });
}

// The site's own minimum check is Price_Order_Total >= Minimum_Cart_Price_NET (total INCLUDING shipping).
export function parseSummary(summaryJson) {
  const s = need(summaryJson, 'Results.CartSummary', 'object');
  return {
    itemsTotal: need(s, 'Price_NET_TOTAL', 'number'),
    deliveryFee: num(s.Price_Shipping),
    grandTotal: num(s.Price_Order_Total),
    minOrder: num(s.Minimum_Cart_Price_NET),
  };
}

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
function toIsoDate(s) {
  const m = DATE_RE.exec(String(s ?? '').trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// order/history envelope -> [{id: string, date: 'YYYY-MM-DD'}], drafts and unparsable dates skipped, newest first.
export function parseOrderHistory(json) {
  const orders = need(json, 'Results.Orders', 'array');
  const out = [];
  for (const o of orders) {
    if (!o || typeof o !== 'object' || o.Id == null || o.IsDraftOrder) continue;
    const date = toIsoDate(o.Date);
    if (!date) continue;
    out.push({ id: String(o.Id), date });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

// getItemsByOrder envelope -> Order. The site gives no ordered quantity: qty is null (= unknown).
export function parseOrderLines(json, id, date) {
  const cats = need(json, 'Results.OrderItems.Categories', 'array');
  const items = [];
  for (const c of cats) {
    if (!c || !Array.isArray(c.Items)) continue;
    for (const it of c.Items) {
      if (!it || typeof it !== 'object' || it.Id == null || !it.Name) continue;
      items.push({
        id: String(it.Id),
        barcode: it.BarKod != null && it.BarKod !== '' ? String(it.BarKod) : null,
        name: String(it.Name),
        brand: it.ManufacturerName || null,
        category: it.CategoryName || null,
        qty: null,
        price: num(it.Price_NET),
      });
    }
  }
  return { chain: meta.id, id: String(id), date, items };
}

export function parseCart(itemsJson, summaryJson) {
  return { lines: parseCartLines(itemsJson), ...parseSummary(summaryJson) };
}

// ---------- adapter ----------

export function createAdapter(env) {
  const http = createHttp(meta, (...a) => env.fetch(...a));

  const get = async (path) => {
    const json = await http.getJson(`${API}${path}`);
    unwrap(json);
    return json;
  };
  const post = async (path, body) => {
    const json = await http.postJson(`${API}${path}`, body);
    unwrap(json);
    return json;
  };
  const del = async (path) => {
    const json = await http.deleteJson(`${API}${path}`);
    unwrap(json);
    return json;
  };
  const readLines = async () => parseCartLines(await get('/item/getItemsInCart?SortBy=0&IsDescending=false'));

  const adapter = {
    ...meta,

    async checkLogin() {
      assertPageSafe(meta, env);
      let json;
      try {
        json = await get('/user/info');
      } catch (e) {
        if (e instanceof AdapterError && e.code === 'NOT_LOGGED_IN') return { loggedIn: false };
        throw e;
      }
      const info = json.Results && json.Results.UserInfo;
      if (!info) return { loggedIn: false };
      const name = [info.FName, info.FirstName].find((v) => typeof v === 'string' && v.trim()) || '';
      const first = name.trim().split(/\s+/)[0] || '';
      return first ? { loggedIn: true, userLabel: first } : { loggedIn: true };
    },

    async getDeliveryContext() {
      assertPageSafe(meta, env);
      const s = parseSummary(await get('/order/cartSummary'));
      return { addressLabel: null, storeLabel: null, deliveryFee: s.deliveryFee, minOrder: s.minOrder };
    },

    async getOrders(limit = 10) {
      assertPageSafe(meta, env);
      const list = parseOrderHistory(await get('/order/history')).slice(0, Math.max(0, Number(limit) || 0));
      const out = [];
      for (const o of list) {
        const id = checkId(o.id, ID_RE, 'order id');
        out.push(parseOrderLines(await get(`/item/getItemsByOrder/${id}`), id, o.date));
      }
      return out;
    },

    async search(query) {
      assertPageSafe(meta, env);
      const json = await post('/item/getItemsBySearch', {
        Paging: { Page: 1, PageSize: 20 },
        Object: { SearchPhrase: String(query), SearchPhrases: null, ItemGroupping: null },
      });
      return parseSearch(json);
    },

    async getCart() {
      assertPageSafe(meta, env);
      const itemsJson = await get('/item/getItemsInCart?SortBy=0&IsDescending=false');
      const lines = parseCartLines(itemsJson);
      const summary = parseSummary(await get('/order/cartSummary'));
      return { lines, ...summary };
    },

    // addItemToCart SETS the absolute quantity and Quantity 0 removes the line (verified live 2026-11-20).
    async setItem(productId, qty, product) {
      assertPageSafe(meta, env);
      const id = checkId(productId, ID_RE, 'product id');
      const q = Number(qty);
      if (!Number.isFinite(q) || q < 0) throw new AdapterError('UNSUPPORTED', 'invalid quantity');
      const find = (lines) => lines.find((l) => l.id === id);
      const before = find(await readLines());
      const current = before ? before.qty : 0;
      if (q === current) return { ok: true, qty: current };
      await post('/item/addItemToCart', {
        Object: { ItemId: Number(id), Quantity: q, Type: product && product.soldBy === 'kg' ? 2 : 1, IsCalculateCart: false },
      });
      const after = find(await readLines());
      const actual = after ? after.qty : 0;
      return { ok: actual === q, qty: actual };
    },

    // Endpoint taken from the site's own JS; not executed against the live site yet.
    async emptyCart() {
      assertPageSafe(meta, env);
      await del('/item/removeItemsInCart');
      return { ok: (await readLines()).length === 0 };
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
