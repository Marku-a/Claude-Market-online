// Shufersal adapter (runs inside a www.shufersal.co.il tab; SAP Hybris, cookie session). Endpoints: docs/SITES.md.
// Never calls /checkout, payment or /cart/cartFromOrder URLs.
import {
  AdapterError, createHttp, need, num, checkId, assertPageSafe, runDiagnose, lazyEnv,
} from './http.js';
import { CHAINS } from './registry.js';

const ORIGIN = 'https://www.shufersal.co.il';
const BASE = `${ORIGIN}/online/he`;
const CODE_RE = /^[A-Za-z0-9_]+$/;
const ORDER_CODE_RE = /^[A-Za-z0-9_-]+$/;
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };
const ADD_FAILED = 'הוספת הפריט נכשלה';

export const meta = {
  id: 'shufersal',
  name: 'שופרסל',
  origin: ORIGIN,
  apiOrigins: [],
  homeUrl: `${BASE}/`,
  cartUrl: `${BASE}/cart/cartsummary`,
  loginUrl: `${BASE}/`,
  forbidden: CHAINS.shufersal.forbidden, // single source of truth: registry.js
  cartHint: 'לחצו על סמל העגלה בראש האתר, או על "מעבר לעגלה" – נפתח עמוד סיכום העגלה',
};

// ---------- pure parsing ----------

// "12.90 ₪" -> 12.9 ; "1,234.50" -> 1234.5 ; no number -> null
export function parsePrice(text) {
  const m = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  if (!m) return null;
  return Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`);
}

const round2 = (n) => Math.round(n * 100) / 100;
const barcodeOf = (code) => {
  const d = String(code).replace(/\D/g, '');
  return d.length >= 12 ? d : null;
};

export function parseSearch(json) {
  const results = need(json, 'results', 'array');
  const out = [];
  for (const it of results) {
    if (!it || typeof it !== 'object' || !it.code || !it.name) continue;
    const price = it.price ? num(it.price.value) : null;
    if (price === null) continue;
    const sm = it.sellingMethod && typeof it.sellingMethod === 'object' ? it.sellingMethod.code : it.sellingMethod;
    const stock = it.stock && it.stock.stockLevelStatus && it.stock.stockLevelStatus.code;
    const eff = num(it.effectivePrice);
    const minQty = num(it.effectiveMinQuantity) || 1;
    out.push({
      chain: meta.id,
      id: String(it.code),
      barcode: barcodeOf(it.code),
      name: String(it.name),
      brand: it.brandName || null,
      category: null,
      price,
      unitPrice: it.pricePerUnit ? num(it.pricePerUnit.value) : null,
      unitLabel: typeof it.unitForComparison === 'string' && it.unitForComparison ? it.unitForComparison : null,
      inStock: stock ? stock === 'inStock' : true,
      promo: eff !== null && eff < price
        ? { description: 'מבצע', minQty, totalPrice: round2(eff * minQty), clubOnly: false }
        : null,
      soldBy: sm === 'BY_WEIGHT' ? 'kg' : 'unit',
    });
    if (out.length >= 10) break;
  }
  return out;
}

const text = (el) => (el && el.textContent ? el.textContent.trim() : '');

// Parsed cart HTML document -> [{id, name, qty, lineTotal, entryNumber}]
export function parseCartDoc(doc) {
  const lines = [];
  for (const el of Array.from(doc.querySelectorAll('article[data-product-code]'))) {
    const id = el.getAttribute('data-product-code');
    const entryNumber = num(el.getAttribute('data-entry-number'));
    const qty = num(el.getAttribute('data-entry-qty'));
    if (!id || entryNumber === null || qty === null) {
      throw new AdapterError('SHAPE_CHANGED', 'cart entry lacks data-product-code/data-entry-number/data-entry-qty');
    }
    lines.push({
      id,
      name: text(el.querySelector('.miglog-prod-name')),
      qty,
      lineTotal: parsePrice(text(el.querySelector('.miglog-prod-totalPrize'))) ?? 0,
      entryNumber,
    });
  }
  return lines;
}

// cartsummary document -> number|null
export function parseSummaryTotal(doc) {
  return parsePrice(text(doc.querySelector('.miglog-cart-summary-totalprice')));
}

// Recursively find objects with price.value numeric; return the minimum or null.
export function parseDeliveryFee(json) {
  const found = [];
  const walk = (v, depth) => {
    if (depth > 6 || v === null || typeof v !== 'object') return;
    if (!Array.isArray(v) && v.price && typeof v.price === 'object' && num(v.price.value) !== null) {
      found.push(num(v.price.value));
    }
    for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(json, 0);
  return found.length ? Math.min(...found) : null;
}

export function toIsoDate(s) {
  const str = String(s ?? '');
  let m = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(str);
  let y; let mo; let d;
  if (m) [, d, mo, y] = m;
  else if ((m = /(\d{4})-(\d{2})-(\d{2})/.exec(str))) [, y, mo, d] = m;
  else return null;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return dt.toISOString().slice(0, 10);
}

// -> [{code, date}] (orders with unparsable dates are skipped)
export function parseOrderList(json) {
  const closed = need(json, 'closedOrders', 'array');
  const active = Array.isArray(json.activeOrders) ? json.activeOrders : [];
  const out = [];
  for (const o of [...active, ...closed]) {
    if (!o || !o.code) continue;
    const date = toIsoDate(o.createdString);
    if (date) out.push({ code: String(o.code), date });
  }
  return out;
}

export function parseOrderDetail(json, code, date) {
  const entries = need(json, 'entries', 'array');
  const items = [];
  for (const e of entries) {
    const p = e && e.product;
    if (!p || p.deliveryItem || !p.code) continue;
    items.push({
      id: String(p.code),
      barcode: barcodeOf(p.code),
      name: String(p.name ?? ''),
      brand: p.brandName || null,
      category: null,
      qty: num(e.quantity) ?? 0,
      price: e.basePrice ? num(e.basePrice.value) ?? 0 : 0,
    });
  }
  return { chain: meta.id, id: String(code), date, items };
}

// ---------- adapter ----------

export function createAdapter(env) {
  const http = createHttp(meta, (...a) => env.fetch(...a));
  let csrfToken = null;

  const parseHtml = (html) => {
    if (!env.DOMParser) throw new AdapterError('UNSUPPORTED', 'DOMParser unavailable');
    return new env.DOMParser().parseFromString(html, 'text/html');
  };
  const metaToken = (doc) => {
    const m = doc && doc.querySelector && doc.querySelector('meta[name="_csrf"]');
    return (m && m.getAttribute('content')) || null;
  };

  async function csrf() {
    if (csrfToken) return csrfToken;
    let t = metaToken(env.document);
    if (!t) t = metaToken(parseHtml(await http.getText(meta.homeUrl, { headers: XHR })));
    if (!t) throw new AdapterError('SHAPE_CHANGED', 'missing field: meta[name=_csrf]');
    csrfToken = t;
    return t;
  }

  // Must precede any cart write (else add -> 400). Entry numbers renumber, so always re-read.
  async function loadCart() {
    const html = await http.getText(`${BASE}/cart/load?restoreCart=true`, { headers: XHR });
    return parseCartDoc(parseHtml(html));
  }

  async function deliveryFee() {
    try {
      const json = await http.getJson(`${BASE}/timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false`,
        { headers: XHR });
      return parseDeliveryFee(json);
    } catch {
      return null;
    }
  }

  async function removeEntry(line, token) {
    const q = `entryNumber=${encodeURIComponent(line.entryNumber)}&qty=0&sellingMethod=BY_UNIT&comment=`
      + '&cartContext[openFrom]=CART&cartContext[recommendationType]=REGULAR&cartContext[action]=remove';
    await http.postForm(`${BASE}/cart/update?${q}`, { quantity: '0', CSRFToken: token },
      { headers: { ...XHR, CSRFToken: token } });
  }

  const adapter = {
    ...meta,

    async checkLogin() {
      assertPageSafe(meta, env);
      const json = await http.getJson(`${BASE}/authentication/get-status-includes-otp`, { headers: XHR });
      if (typeof json !== 'boolean') throw new AdapterError('SHAPE_CHANGED', 'login status is not a boolean');
      return { loggedIn: json };
    },

    async getDeliveryContext() {
      assertPageSafe(meta, env);
      return { addressLabel: null, storeLabel: null, deliveryFee: await deliveryFee(), minOrder: null };
    },

    async getOrders(limit = 10) {
      assertPageSafe(meta, env);
      const list = parseOrderList(await http.getJson(`${BASE}/my-account/orders`, { headers: XHR }));
      list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      const orders = [];
      for (const o of list.slice(0, Math.max(0, limit))) {
        if (!ORDER_CODE_RE.test(o.code)) continue; // never build URLs from odd codes
        const json = await http.getJson(`${BASE}/my-account/orders/${encodeURIComponent(o.code)}`, { headers: XHR });
        orders.push(parseOrderDetail(json, o.code, o.date));
      }
      return orders;
    },

    async search(query) {
      assertPageSafe(meta, env);
      const json = await http.getJson(`${BASE}/search/results?q=${encodeURIComponent(String(query))}:relevance&limit=10`,
        { headers: XHR });
      return parseSearch(json);
    },

    async getCart() {
      assertPageSafe(meta, env);
      const fee = await deliveryFee();
      const lines = await loadCart();
      let total = null;
      try {
        total = parseSummaryTotal(parseHtml(await http.getText(`${BASE}/cart/cartsummary`, { headers: XHR })));
      } catch (e) {
        if (!(e instanceof AdapterError) || (e.code !== 'NOT_LOGGED_IN' && e.code !== 'REDIRECT')) throw e;
      }
      const view = lines.map(({ id, name, qty, lineTotal, entryNumber }) => ({ id, name, qty, lineTotal, entryNumber }));
      if (total === null) {
        const sum = round2(view.reduce((s, l) => s + l.lineTotal, 0));
        return { lines: view, itemsTotal: sum, deliveryFee: fee, grandTotal: null, minOrder: null };
      }
      return { lines: view, itemsTotal: total, deliveryFee: fee, grandTotal: round2(total + (fee || 0)), minOrder: null };
    },

    async setItem(productId, qty, product) {
      assertPageSafe(meta, env);
      const code = checkId(productId, CODE_RE, 'product code');
      const q = Number(qty);
      if (!Number.isFinite(q) || q < 0) throw new AdapterError('UNSUPPORTED', 'invalid quantity');
      const token = await csrf();
      const kg = !!product && product.soldBy === 'kg';
      const sellingMethod = kg ? 'BY_WEIGHT' : 'BY_UNIT';
      const fmt = q === 0 ? '0' : kg ? q.toFixed(2) : String(q);
      const lines = await loadCart();
      const existing = lines.find((l) => l.id === code);
      if (existing) {
        const qs = `entryNumber=${encodeURIComponent(existing.entryNumber)}&qty=${fmt}&sellingMethod=${sellingMethod}&comment=`
          + `&cartContext[openFrom]=CART&cartContext[recommendationType]=REGULAR${q === 0 ? '&cartContext[action]=remove' : ''}`;
        await http.postForm(`${BASE}/cart/update?${qs}`, { quantity: fmt, CSRFToken: token },
          { headers: { ...XHR, CSRFToken: token } });
      } else if (q > 0) {
        const body = {
          productCodePost: code,
          productCode: code,
          sellingMethod,
          qty: kg ? fmt : q,
          frontQuantity: kg ? fmt : q,
          comment: '',
          affiliateCode: '',
        };
        const res = await http.postJsonText(
          `${BASE}/cart/add?cartContext[openFrom]=CATALOG&cartContext[recommendationType]=REGULAR`, body,
          { headers: { ...XHR, CSRFToken: token } });
        if (res.includes(ADD_FAILED)) throw new AdapterError('NETWORK', 'add failed');
      }
      const after = (await loadCart()).find((l) => l.id === code);
      const got = after ? after.qty : 0;
      return { ok: Math.abs(got - q) < 1e-9, qty: got };
    },

    async emptyCart() {
      assertPageSafe(meta, env);
      const token = await csrf();
      for (let i = 0; i < 200; i++) {
        const lines = await loadCart();
        if (!lines.length) return { ok: true };
        await removeEntry(lines[0], token);
      }
      return { ok: (await loadCart()).length === 0 };
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
