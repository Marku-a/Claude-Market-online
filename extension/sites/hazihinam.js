// Hatzi Hinam adapter (runs inside a shop.hazi-hinam.co.il tab; Angular, API /proxy/api, cookie session).
// Endpoints: docs/SITES.md. Remove/decrease/empty/orders are unknown there -> UNSUPPORTED, never guessed.
import {
  AdapterError, createHttp, need, num, checkId, assertPageSafe, runDiagnose, lazyEnv,
} from './http.js';
import { CHAINS } from './registry.js';

const ORIGIN = 'https://shop.hazi-hinam.co.il';
const API = `${ORIGIN}/proxy/api`;
const ID_RE = /^\d+$/;
const AUTH_RE = /auth|login|log in|unauthori[sz]ed|session|forbidden|401|403|התחבר|הזד/i;
export const UNSUPPORTED_MSG = 'הסרה/הפחתה בחצי חינם עדיין לא נתמכת';

export const meta = {
  id: 'hazihinam',
  name: 'חצי חינם',
  origin: ORIGIN,
  apiOrigins: [],
  homeUrl: `${ORIGIN}/`,
  cartUrl: `${ORIGIN}/`, // cart page route is unknown (SITES.md): the home page has the cart icon
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
  const items = need(itemsJson, 'Results.CartItems.Items', 'array');
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

export function parseSummary(summaryJson) {
  const s = need(summaryJson, 'Results.CartSummary', 'object');
  return {
    itemsTotal: need(s, 'Price_NET_TOTAL', 'number'),
    deliveryFee: num(s.Price_Shipping),
    grandTotal: num(s.Price_Order_Total),
    minOrder: num(s.Minimum_Cart_Price_NET),
  };
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
      const first = typeof info.FirstName === 'string' ? info.FirstName.trim().split(/\s+/)[0] : '';
      return first ? { loggedIn: true, userLabel: first } : { loggedIn: true };
    },

    async getDeliveryContext() {
      assertPageSafe(meta, env);
      const s = parseSummary(await get('/order/cartSummary'));
      return { addressLabel: null, storeLabel: null, deliveryFee: s.deliveryFee, minOrder: s.minOrder };
    },

    async getOrders() {
      assertPageSafe(meta, env);
      throw new AdapterError('UNSUPPORTED', 'היסטוריית הזמנות בחצי חינם עדיין לא נתמכת');
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

    // Absolute quantity is impossible to guarantee: repeat adds may increment (unknown), and there is no
    // known decrease/remove endpoint. We only ever raise, then re-read and report the real quantity.
    async setItem(productId, qty, product) {
      assertPageSafe(meta, env);
      const id = checkId(productId, ID_RE, 'product id');
      const q = Number(qty);
      if (!Number.isFinite(q) || q < 0) throw new AdapterError('UNSUPPORTED', 'invalid quantity');
      const find = (lines) => lines.find((l) => l.id === id);
      const before = find(await readLines());
      const current = before ? before.qty : 0;
      if (q === current) return { ok: true, qty: current };
      if (q < current) throw new AdapterError('UNSUPPORTED', UNSUPPORTED_MSG);
      await post('/item/addItemToCart', {
        Object: { ItemId: Number(id), Quantity: q, Type: product && product.soldBy === 'kg' ? 2 : 1, IsCalculateCart: false },
      });
      const after = find(await readLines());
      const actual = after ? after.qty : 0;
      if (actual === q) return { ok: true, qty: actual };
      if (actual > q) return { ok: false, qty: actual, code: 'UNSUPPORTED' }; // site incremented; cannot decrease
      return { ok: false, qty: actual };
    },

    async emptyCart() {
      assertPageSafe(meta, env);
      throw new AdapterError('UNSUPPORTED', UNSUPPORTED_MSG);
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
