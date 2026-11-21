// Stateful mock of the three supermarket sites, implementing exactly the endpoints in docs/SITES.md.
// Plain (http) handler factory: dispatches on the Host header. Use with http.createServer(handle) or call
// handle(req, res) directly with Node-style req/res objects.
//
//   const state = createState();               // or createMockSites(state)
//   state.ramilevy.loggedIn = false;           // log out
//   state.shufersal.variant = 'shape-changed'; // search returns {foo:1}
//   state.<chain>.redirectTo = '/some/path';   // the chain's cart-write endpoint answers 302 -> that path
//   state.hazihinam.errorMarker = 'X';         // /user/info answers an error whose description is X
//   state.forbiddenHits / state.requests       // recorded traffic

export const HOSTS = {
  ramilevy: 'www.rami-levy.co.il',
  ramilevyApi: 'www-api.rami-levy.co.il',
  shufersal: 'www.shufersal.co.il',
  hazihinam: 'shop.hazi-hinam.co.il',
};

export const RL_TOKEN = 'RL-SECRET-TOKEN-0123456789';
const SHUFERSAL_BASE = '/online/he';
const FORBIDDEN_RE = /checkout|payment/i;
const ADD_FAILED = 'הוספת הפריט נכשלה';

export function createState() {
  return {
    requests: [], // {host, method, path}
    forbiddenHits: [],
    ramilevy: {
      loggedIn: true,
      user: { id: 4242, token: RL_TOKEN, store_id: 331, first_name: 'דנה' },
      cart: {}, // id -> "qty"
      catalog: [
        {
          id: 425127, barcode: 7290119672066, name: 'תערובת חליטת צמחים בטעם קרמל מלוח רמי לוי', price: { price: 8.9 },
          prop: { unit: 0, sw_shakil: 0, by_kilo: 0 }, multiplication: 1, department: { name: 'משקאות ואלכוהול' },
          gs: { BrandName: 'רמי לוי' }, available_in: [82, 331], sale: [],
        },
        {
          id: 100001, barcode: 7290000000012, name: 'חלב טרי 3% בקבוק 1 ליטר', price: { price: 6.9 },
          prop: { unit: 0, sw_shakil: 0, by_kilo: 0 }, multiplication: 1, department: { name: 'מוצרי חלב' },
          gs: { BrandName: 'תנובה' }, available_in: [331],
          sale: [{ title: '2 ב-12 ש"ח', name: 'מבצע חלב', cmt: 2, scm: 12, is_club: 1 }],
        },
        {
          id: 100002, barcode: 2000000000017, name: 'עגבניות שרי', price: { price: 14.9 },
          prop: { unit: 0, sw_shakil: 1, by_kilo: 1 }, multiplication: 1, department: { name: 'ירקות' },
          gs: {}, available_in: [331], sale: [],
        },
        {
          id: 100003, barcode: 7290000000029, name: 'חלב סויה', price: { price: 9.9 },
          prop: { unit: 0, sw_shakil: 0, by_kilo: 0 }, multiplication: 1, department: { name: 'מוצרי חלב' },
          gs: { BrandName: 'אלפרו' }, available_in: [82], sale: [],
        },
      ],
      // list rows: real shape (verified 2026-11-20); lines are served by the detail endpoint
      orders: [{
        id: 9001, final_price: 210.5, status_api: 'delivered', supply_at: '2026-10-01 10:00:00',
        created_at: '2026-09-28T20:00:00.000000Z', items: [425127, 100001, 164854],
        lines: [
          { item_id: 425127, name: 'תערובת חליטת צמחים בטעם קרמל מלוח רמי לוי', price: '8.90', quantity: 1 },
          { item_id: 100001, name: 'חלב טרי 3% בקבוק 1 ליטר', price: '6.90', quantity: 2 },
          { item_id: 164854, name: 'מחיר משלוח', price: '29.90', quantity: 1 },
        ],
      }],
      deliveryItemId: 164854,
      deliveryFee: 29.9,
      minOrder: null,
      variant: null,
      redirectTo: null,
    },
    shufersal: {
      loggedIn: true,
      csrf: 'test-csrf',
      loaded: false, // set by /cart/load
      cart: [], // [{code, qty}] - entry number = index
      catalog: [
        { code: 'P_522319', name: 'חלב טרי מהגולן 3%', brandName: 'גולן', price: { value: 7.35 }, sellingMethod: { code: 'BY_UNIT' }, stock: 'inStock' },
        {
          code: 'P_7290000000999', name: 'חלב תנובה 3% 1 ליטר', brandName: 'תנובה', price: { value: 6.5 },
          sellingMethod: { code: 'BY_UNIT' }, stock: 'inStock', effectivePrice: 5.9, effectiveMinQuantity: 1,
        },
        {
          code: 'P_100200', name: 'בננות', brandName: null, price: { value: 9.9 }, sellingMethod: { code: 'BY_WEIGHT' },
          pricePerUnit: { value: 9.9 }, unitForComparison: 'ק"ג', stock: 'inStock',
        },
        { code: 'P_100300', name: 'חלב שקדים', brandName: 'אלפרו', price: { value: 12.5 }, sellingMethod: { code: 'BY_UNIT' }, stock: 'outOfStock' },
      ],
      orders: [
        {
          code: '70001', createdString: '15/09/2026', total: 150.2,
          entries: [
            { quantity: 2, price: 7.35, code: 'P_522319', name: 'חלב טרי מהגולן 3%' },
            { quantity: 1, price: 19.9, code: 'P_DELIVERY', name: 'דמי משלוח', deliveryItem: true },
          ],
        },
      ],
      deliveryFee: 19.9,
      minOrder: null,
      variant: null,
      redirectTo: null,
    },
    hazihinam: {
      loggedIn: true,
      cart: {}, // id -> qty
      catalog: [
        {
          Id: 7357, BarKod: 7290000000012, Name: 'חלב תנובה 3% 1 ליטר', ManufacturerName: 'תנובה', IsShakil: false,
          Price_NET: 6.2, Price_Regular: 6.9, PricePerUnit: 6.2, PricePerUnitDesc: 'ליטר', IsInStock: true,
          Mivza: { MivzaDesc: 'מבצע', MivzaText: 'מבצע מיוחד', MivzaQuantityCount: 1, IsTagmul: false },
        },
        {
          Id: 7358, BarKod: 2000000000024, Name: 'עגבניות שרי', ManufacturerName: null, IsShakil: true,
          Price_NET: 12.9, Price_Regular: 12.9, PricePerUnit: 12.9, PricePerUnitDesc: 'ק"ג', IsInStock: true, Mivza: null,
        },
        {
          Id: 7359, BarKod: 7290000000036, Name: 'חלב סויה', ManufacturerName: 'אלפרו', IsShakil: false,
          Price_NET: 9.9, Price_Regular: 9.9, PricePerUnit: 9.9, PricePerUnitDesc: 'ליטר', IsInStock: false, Mivza: null,
        },
      ],
      // order/history rows + their lines (real shapes, verified 2026-11-20); order lines carry no quantity
      orders: [
        { Id: 5101, ComaxId: 880101, Date: '03/09/2026', Total: 120.5, ClosingTotal: 118.4, IsDraftOrder: false, Order_Status: 5, itemIds: [7357, 7358] },
        { Id: 5102, ComaxId: 0, Date: '15/10/2026', Total: 40, ClosingTotal: 0, IsDraftOrder: true, Order_Status: 0, itemIds: [7357] },
        { Id: 5103, ComaxId: 880103, Date: '21/10/2026', Total: 75, ClosingTotal: 74, IsDraftOrder: false, Order_Status: 5, itemIds: [7357] },
      ],
      deliveryFee: 25,
      minOrder: 150,
      errorMarker: null,
      variant: null,
      redirectTo: null,
    },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

const round2 = (n) => Math.round(n * 100) / 100;
// like the real sites' search: every word of the query must appear in the name (any order)
const matches = (name, q) => {
  const n = String(name).toLowerCase();
  return String(q || '').toLowerCase().split(/\s+/).filter(Boolean).every((w) => n.includes(w));
};

export function createMockSites(state = createState()) {
  const base = createState();
  for (const k of Object.keys(base)) if (state[k] === undefined) state[k] = base[k];
  const S = state;

  function send(res, status, body, headers = {}) {
    const isObj = typeof body !== 'string' && body !== undefined;
    const payload = body === undefined ? '' : isObj ? JSON.stringify(body) : body;
    res.writeHead(status, {
      'content-type': isObj ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      ...headers,
    });
    res.end(payload);
  }
  const html = (res, status, body) => send(res, status, `<!doctype html><html><head><title>${body.title || 'Mock'}</title>${body.head || ''}</head><body>${body.body || ''}</body></html>`);

  // ---------------- Rami Levy ----------------
  function rlAuth(req) {
    const s = S.ramilevy;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    return s.loggedIn && bearer === s.user.token;
  }
  function rlPrice(items) {
    const s = S.ramilevy;
    const lines = [];
    let total = 0;
    for (const [id, q] of Object.entries(items)) {
      const p = s.catalog.find((c) => String(c.id) === String(id));
      if (!p) continue;
      const qty = Number(q);
      const t = round2(p.price.price * qty);
      total += t;
      lines.push({ id: p.id, name: p.name, price: p.price.price, quantity: qty, FormatedTotalPrice: t, is_delivery: false });
    }
    // real site: no delivery line for an empty cart (verified 2026-11-20)
    if (lines.length) lines.push({ id: 164854, name: 'מחיר משלוח', price: s.deliveryFee, quantity: 1, FormatedTotalPrice: s.deliveryFee, is_delivery: true });
    return { items: lines, price: round2(total), discount: 0, status: 200 };
  }
  async function rlHandle(req, res, u, host) {
    const s = S.ramilevy;
    const cors = host === HOSTS.ramilevyApi
      ? {
        'access-control-allow-origin': 'https://www.rami-levy.co.il',
        // no allow-credentials: the real www-api rejects credentialed CORS (verified 2026-11-20)
        'access-control-allow-headers': 'authorization, ecomtoken, locale, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      }
      : {};
    if (req.method === 'OPTIONS') return send(res, 204, undefined, cors);
    const p = u.pathname;
    if (host === HOSTS.ramilevy && (p === '/he' || p === '/')) {
      return html(res, 200, { title: 'רמי לוי - קניות אונליין', body: '<div id="app">home</div>' });
    }
    const body = req.method === 'POST' ? await readBody(req) : '';
    let json = {};
    try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
    if (p === '/api/catalog' && req.method === 'POST') {
      if (s.variant === 'shape-changed') return send(res, 200, { foo: 1 }, cors);
      const data = s.catalog.filter((c) => matches(c.name, json.q));
      return send(res, 200, { q: json.q ?? null, status: 200, total: data.length, data }, cors);
    }
    if (p === '/api/v2/cart' && req.method === 'POST') {
      if (s.redirectTo) return send(res, 302, '', { ...cors, location: s.redirectTo });
      const items = json.items && typeof json.items === 'object' ? json.items : {};
      const out = rlPrice(items);
      // Persist only with a valid bearer AND the ecomtoken header (SITES.md); otherwise it only prices.
      if (rlAuth(req) && req.headers.ecomtoken === s.user.token) s.cart = { ...items };
      return send(res, 200, out, cors);
    }
    if (!rlAuth(req)) return send(res, 401, { message: 'Unauthenticated.' }, cors);
    if (p === `/api/v2/site/clubs/customer/${s.user.id}` && req.method === 'GET') {
      return send(res, 200, {
        // Real shape (verified 2026-11-20): store_id is a string; deliveryTimesCustomer is null until a slot
        // is chosen (the fee then comes only from the cart's is_delivery line); cart is null when empty and
        // {uid, updated_at, last_update, items:{id: <number>}} otherwise.
        user: { id: s.user.id, store_id: String(s.user.store_id), first_name: s.user.first_name },
        deliveryTimesCustomer: null,
        cart: Object.keys(s.cart).length
          ? { uid: s.user.id, updated_at: '2026-11-20 12:00:00', last_update: 1795177960,
            items: Object.fromEntries(Object.entries(s.cart).map(([k, v]) => [k, Number(v)])) }
          : null,
      }, cors);
    }
    if (p === '/api/v3/site/orders' && req.method === 'GET') {
      const rows = s.orders.map(({ lines, ...o }) => ({
        site_id: 1, from_hour: '10:00', to_hour: '12:00', supply: { city: 'x' }, ...o,
      }));
      return send(res, 200, { success: true, data: { data: { current_page: 1, data: rows } } }, cors);
    }
    const om = /^\/api\/v3\/site\/orders\/([^/]+)$/.exec(p);
    if (om && req.method === 'GET') {
      const o = s.orders.find((x) => String(x.id) === decodeURIComponent(om[1]));
      if (!o) return send(res, 404, { message: 'not found' }, cors);
      const lines = (o.lines || []).map((l, i) => ({
        id: o.id * 100 + i, item_id: l.item_id, order_id: o.id, name: l.name, price: l.price, quantity: l.quantity,
        final_price: l.price, total_price: (Number(l.price) * l.quantity).toFixed(2), department_id: 1, discount: '0.00', coupon_code: null,
      }));
      return send(res, 200, {
        data: { id: o.id, final_price: o.final_price, delivery_price: s.deliveryFee, delivery_item_id: s.deliveryItemId, created_at: o.created_at, lines },
      }, cors);
    }
    if (p === '/api/items' && req.method === 'POST') {
      const want = String(json.ids ?? '').split(',').filter(Boolean);
      const data = s.catalog.filter((c) => want.includes(String(c.id)));
      return send(res, 200, { status: 200, total: data.length, data }, cors);
    }
    return send(res, 404, { message: 'not found' }, cors);
  }

  // ---------------- Shufersal ----------------
  const shCartTotal = () => {
    const s = S.shufersal;
    return round2(s.cart.reduce((t, l) => t + (s.catalog.find((c) => c.code === l.code)?.price.value || 0) * l.qty, 0));
  };
  function shCartHtml() {
    const s = S.shufersal;
    return `<div class="cart">${s.cart.map((l, i) => {
      const p = s.catalog.find((c) => c.code === l.code) || { name: l.code, price: { value: 0 } };
      return `<article data-product-code="${l.code}" data-entry-number="${i}" data-entry-qty="${Number(l.qty).toFixed(1)}">`
        + `<div class="miglog-prod-name">${p.name}</div>`
        + `<div class="miglog-prod-totalPrize">${(p.price.value * l.qty).toFixed(2)} ₪</div></article>`;
    }).join('')}</div>`;
  }
  async function shHandle(req, res, u) {
    const s = S.shufersal;
    let p = u.pathname;
    if (p === '/online/he') p += '/';
    if (p === `${SHUFERSAL_BASE}/`) {
      return html(res, 200, { title: 'שופרסל אונליין', head: `<meta name="_csrf" content="${s.csrf}">`, body: 'home' });
    }
    if (!p.startsWith(`${SHUFERSAL_BASE}/`)) return send(res, 404, 'not found');
    const route = p.slice(SHUFERSAL_BASE.length);
    // Real server (Tomcat) answers 400 with an empty body to raw `[` `]` in the request target — verified
    // 2026-11-20: `cartContext[openFrom]` must be sent as `cartContext%5BopenFrom%5D`.
    if (/[[\]]/.test(req.url || '')) return send(res, 400, '');
    const body = req.method === 'POST' ? await readBody(req) : '';
    const form = new URLSearchParams(body);
    const csrfOk = () => req.headers.csrftoken === s.csrf || form.get('CSRFToken') === s.csrf;

    if (route === '/authentication/get-status-includes-otp') return send(res, 200, s.loggedIn && !s.statusFalse); // statusFalse: real-site quirk
    if (route === '/search/results') {
      if (s.variant === 'shape-changed') return send(res, 200, { foo: 1 });
      const q = String(u.searchParams.get('q') || '').split(':')[0];
      const results = s.catalog.filter((c) => matches(c.name, q)).map((c) => {
        const { stock, ...rest } = c;
        return { ...rest, stock: { stockLevelStatus: { code: stock } } };
      });
      return send(res, 200, { results });
    }
    if (route === '/cart/load') {
      s.loaded = true;
      return send(res, 200, shCartHtml());
    }
    if (route === '/cart/cartsummary') {
      if (!s.loggedIn) return send(res, 401, 'login');
      return send(res, 200, `<div><span id="cartTotalItems">${s.cart.length}</span><span class="miglog-cart-summary-totalprice">${shCartTotal().toFixed(2)} ₪</span></div>`);
    }
    if (route === '/timeSlot/preselection/getHomeDeliverySlots') {
      return send(res, 200, [
        { id: 1, price: { value: s.deliveryFee + 10, formattedValue: `${s.deliveryFee + 10} ₪` } },
        { id: 2, price: { value: s.deliveryFee, formattedValue: `${s.deliveryFee} ₪` } },
      ]);
    }
    if ((route === '/cart/add' || route === '/cart/update') && req.method === 'POST' && s.redirectTo) {
      return send(res, 302, '', { location: s.redirectTo });
    }
    if (route === '/cart/add' && req.method === 'POST') {
      if (!csrfOk()) return send(res, 403, 'csrf');
      if (!s.loaded) return send(res, 400, 'cart not loaded');
      let j = {};
      try { j = JSON.parse(body); } catch { /* ignore */ }
      const prod = s.catalog.find((c) => c.code === j.productCode);
      if (!prod || prod.stock !== 'inStock') return send(res, 200, `<div>${ADD_FAILED}</div>`);
      const q = Number(j.qty);
      const ex = s.cart.find((l) => l.code === prod.code);
      if (ex) ex.qty += q; else s.cart.push({ code: prod.code, qty: q });
      return send(res, 200, '<div class="mini-cart">ok</div>');
    }
    if (route === '/cart/update' && req.method === 'POST') {
      if (!csrfOk()) return send(res, 403, 'csrf');
      if (!s.loaded) return send(res, 400, 'cart not loaded');
      const n = Number(u.searchParams.get('entryNumber'));
      const q = Number(u.searchParams.get('qty'));
      if (!Number.isInteger(n) || !s.cart[n]) return send(res, 400, 'bad entry');
      if (u.searchParams.get('cartContext[action]') === 'remove' || q === 0) s.cart.splice(n, 1);
      else s.cart[n].qty = q;
      return send(res, 200, '<div>updated</div>');
    }
    if (route === '/my-account/orders') {
      if (!s.loggedIn) return send(res, 401, 'login');
      return send(res, 200, {
        activeOrders: [],
        closedOrders: s.orders.map((o) => ({ code: o.code, createdString: o.createdString, totalPrice: { value: o.total } })),
      });
    }
    const om = /^\/my-account\/orders\/([^/]+)$/.exec(route);
    if (om) {
      const o = s.orders.find((x) => x.code === decodeURIComponent(om[1]));
      if (!o) return send(res, 404, { message: 'no such order' });
      return send(res, 200, {
        code: o.code,
        entries: o.entries.map((e) => ({
          quantity: e.quantity, basePrice: { value: e.price },
          product: { code: e.code, name: e.name, deliveryItem: !!e.deliveryItem },
        })),
      });
    }
    return send(res, 404, 'not found');
  }

  // ---------------- Hatzi Hinam ----------------
  const hzOk = (Results) => ({ IsOK: true, Results, ErrorResponse: null });
  const hzCartItems = () => {
    const s = S.hazihinam;
    return Object.entries(s.cart).map(([id, qty]) => {
      const p = s.catalog.find((c) => String(c.Id) === String(id));
      return { ...p, Calculated_Price_NET: round2(p.Price_NET * qty), Cart: { Quantity: qty } };
    });
  };
  async function hzHandle(req, res, u) {
    const s = S.hazihinam;
    const p = u.pathname;
    if (p === '/' || p === '') return html(res, 200, { title: 'חצי חינם', body: '<app-root>home</app-root>' });
    if (!p.startsWith('/proxy/api/')) return send(res, 404, 'not found');
    const route = p.slice('/proxy/api'.length);
    const body = req.method === 'POST' ? await readBody(req) : '';
    let json = {};
    try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }

    if (route === '/user/info' && s.errorMarker) {
      return send(res, 200, { IsOK: false, Results: null, ErrorResponse: { ErrorCode: 99, ErrorDescription: s.errorMarker } });
    }
    if (route === '/item/addItemToCart' && req.method === 'POST' && s.redirectTo) {
      return send(res, 302, '', { location: s.redirectTo });
    }
    if (route === '/user/info') return send(res, 200, hzOk({ UserInfo: s.loggedIn ? { FName: 'דנה' } : null }));
    if (route === '/item/getItemsBySearch' && req.method === 'POST') {
      if (s.variant === 'shape-changed') return send(res, 200, hzOk({ foo: 1 }));
      const phrase = json.Object && json.Object.SearchPhrase;
      const Items = s.catalog.filter((c) => matches(c.Name, phrase) || String(c.BarKod) === String(phrase))
        .map((c) => ({ ...c, Cart: null }));
      return send(res, 200, hzOk({ Items }));
    }
    if (route === '/item/addItemToCart' && req.method === 'POST') {
      const o = json.Object || {};
      const prod = s.catalog.find((c) => c.Id === Number(o.ItemId));
      if (!prod) return send(res, 200, { IsOK: false, Results: null, ErrorResponse: { ErrorCode: 'ITEM_NOT_FOUND', ErrorDescription: 'item not found' } });
      const q = Number(o.Quantity);
      if (q === 0) delete s.cart[prod.Id]; else s.cart[prod.Id] = q; // SET semantics, 0 removes
      return send(res, 200, hzOk({ CartItemsCount: Object.keys(s.cart).length }));
    }
    if (route === '/item/getItemsInCart') {
      const Items = hzCartItems();
      return send(res, 200, hzOk({ CartItems: { Items: Items.length ? Items : null }, CartItemsCount: Items.length }));
    }
    if (route === '/item/removeItemsInCart' && req.method === 'DELETE') {
      s.cart = {};
      return send(res, 200, hzOk({ CartItemsCount: 0 }));
    }
    if (route === '/order/history') {
      return send(res, 200, hzOk({
        Orders: s.orders.map(({ itemIds, ...o }) => o),
      }));
    }
    const hom = /^\/item\/getItemsByOrder\/(\d+)$/.exec(route);
    if (hom) {
      const o = s.orders.find((x) => String(x.Id) === hom[1]);
      if (!o) return send(res, 200, { IsOK: false, Results: null, ErrorResponse: { ErrorCode: 'ORDER_NOT_FOUND', ErrorDescription: 'order not found' } });
      const Items = o.itemIds.map((id) => s.catalog.find((c) => c.Id === id)).filter(Boolean)
        .map((c) => ({ ...c, CategoryName: 'כללי', Calculated_Price_NET: 0, Cart: null }));
      return send(res, 200, hzOk({
        OrderItems: { OrderId: o.Id, Date: o.Date, Categories: [{ Id: 1, Name: 'כללי', Items, ItemsCount: Items.length }] },
      }));
    }
    if (route === '/order/cartSummary') {
      const total = round2(hzCartItems().reduce((t, i) => t + i.Calculated_Price_NET, 0));
      return send(res, 200, hzOk({
        CartSummary: {
          Price_NET_TOTAL: total, Price_Shipping: s.deliveryFee, Price_Savings: 0,
          Price_Order_Total: round2(total + s.deliveryFee), Minimum_Cart_Price_NET: s.minOrder,
        },
      }));
    }
    return send(res, 404, 'not found');
  }

  // ---------------- dispatcher ----------------
  async function handle(req, res) {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    const url = req.url || '/';
    let u;
    try { u = new URL(url, `https://${host || 'localhost'}`); } catch { return send(res, 400, 'bad url'); }
    S.requests.push({ host, method: req.method, path: u.pathname, raw: url });
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch { /* keep raw */ }
    if (FORBIDDEN_RE.test(url) || FORBIDDEN_RE.test(decoded)) {
      S.forbiddenHits.push(`https://${host}${url}`);
      return send(res, 418, 'forbidden');
    }
    try {
      if (host === HOSTS.ramilevy || host === HOSTS.ramilevyApi) return await rlHandle(req, res, u, host);
      if (host === HOSTS.shufersal) return await shHandle(req, res, u);
      if (host === HOSTS.hazihinam) return await hzHandle(req, res, u);
    } catch (e) {
      return send(res, 500, `mock error: ${e && e.message}`);
    }
    return send(res, 404, 'unknown host');
  }
  handle.state = S;
  return handle;
}
