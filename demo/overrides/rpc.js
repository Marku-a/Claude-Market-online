// DEMO build only: replaces app/rpc.js with three simulated supermarket sites that live in the page.
// Same contract as the real adapters (docs/SPEC.md section 4). Prices and products are invented.
import { normalize } from '../engine/text.js';
import { CHAINS } from '../sites/registry.js';

const IDS = ['hazihinam', 'ramilevy', 'shufersal'];
// [key, barcode, name, brand, category, [hazihinam, ramilevy, shufersal] price (null = not sold), soldBy]
const ROWS = [
  ['milk-tnuva', '7290000042435', 'חלב תנובה 3% 1 ליטר', 'תנובה', 'מוצרי חלב', [6.9, 7.1, 7.4], 'unit'],
  ['milk-tara', '7290000055510', 'חלב טרה 3% 1 ליטר', 'טרה', 'מוצרי חלב', [6.5, 6.4, 6.9], 'unit'],
  ['bread', '7290000200012', 'לחם אחיד פרוס 750 גרם', 'אנג\'ל', 'לחם', [7.1, 7.1, 7.5], 'unit'],
  ['bread-whole', '7290000200029', 'לחם מלא פרוס 750 גרם', 'ברמן', 'לחם', [12.9, 13.5, 13.9], 'unit'],
  ['eggs', '7290000100011', 'ביצים L תבנית 12 יחידות', 'תנובה', 'ביצים', [13.2, 13.2, 13.9], 'unit'],
  ['cottage', '7290000300013', 'קוטג\' 5% 250 גרם', 'תנובה', 'מוצרי חלב', [5.9, 5.7, 6.2], 'unit'],
  ['tomato', null, 'עגבניות', null, 'ירקות', [6.9, 5.9, 7.9], 'kg'],
  ['cucumber', null, 'מלפפונים', null, 'ירקות', [5.9, 4.9, 6.9], 'kg'],
  ['pasta-osem', '7290000400014', 'פסטה פנה 500 גרם', 'אסם', 'מזווה', [6.2, 6.9, 7.2], 'unit'],
  ['pasta-barilla', '8076800195057', 'פסטה ספגטי 500 גרם', 'ברילה', 'מזווה', [7.9, 8.4, 8.9], 'unit'],
  ['coffee', '7290000500015', 'קפה נמס 200 גרם', 'עלית', 'מזווה', [21.9, 22.9, 24.9], 'unit'],
  ['bamba', '7290000600016', 'במבה 80 גרם', 'אסם', 'חטיפים', [4.5, 4.2, null], 'unit'],
  ['tp', '7290000700017', 'נייר טואלט 24 גלילים', 'לילי', 'ניקיון', [34.9, 32.9, 36.9], 'unit'],
  ['yogurt', '7290000800018', 'יוגורט פרו 200 גרם', 'דנונה', 'מוצרי חלב', [5.5, 5.9, 5.7], 'unit'],
];
// promotions the simulated sites apply in their own cart totals
const PROMOS = {
  hazihinam: { cottage: { description: '2 ב-10', minQty: 2, totalPrice: 10 } },
  ramilevy: { bamba: { description: '3 ב-10', minQty: 3, totalPrice: 10 } },
  shufersal: { 'milk-tnuva': { description: '2 ב-13 (מועדון)', minQty: 2, totalPrice: 13, clubOnly: true } },
};
const DELIVERY = { hazihinam: { fee: 25, min: 100 }, ramilevy: { fee: 29.9, min: null }, shufersal: { fee: 30, min: null } };
const r2 = (n) => Math.round(n * 100) / 100;

const catalog = {};
IDS.forEach((chain, ci) => {
  catalog[chain] = ROWS.filter((r) => r[5][ci] != null).map((r) => ({
    chain, id: `${chain.slice(0, 2)}-${r[0]}`, key: r[0], barcode: r[1], name: r[2], brand: r[3], category: r[4],
    price: r[5][ci], unitPrice: null, unitLabel: null, inStock: true, soldBy: r[6],
    promo: (PROMOS[chain] || {})[r[0]] ? { clubOnly: false, ...PROMOS[chain][r[0]] } : null,
  }));
});
const carts = { hazihinam: new Map(), ramilevy: new Map(), shufersal: new Map() };

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}
// A purchase history on one chain, so the engine has habits to learn from.
function orders() {
  const p = (key) => catalog.shufersal.find((x) => x.key === key);
  const item = (key, qty) => { const x = p(key); return { id: x.id, barcode: x.barcode, name: x.name, brand: x.brand, category: x.category, qty, price: r2(x.price * 0.95) }; };
  const basket = [['milk-tnuva', 2], ['bread', 1], ['eggs', 1], ['cottage', 2], ['pasta-osem', 1]];
  return [49, 35, 21, 7].map((days, i) => ({
    chain: 'shufersal', id: `demo-${days}`, date: isoDaysAgo(days),
    items: [...basket.map(([k, q]) => item(k, q)), ...(i < 3 ? [item('tp', 1)] : []), ...(i % 2 === 0 ? [item('coffee', 1)] : [item('yogurt', 4)])],
  }));
}

function lineTotal(prod, qty) {
  if (prod.promo && prod.soldBy !== 'kg' && qty >= prod.promo.minQty) {
    return r2(Math.floor(qty / prod.promo.minQty) * prod.promo.totalPrice + (qty % prod.promo.minQty) * prod.price);
  }
  return r2(prod.price * qty);
}
function cartView(chain) {
  const lines = [...carts[chain]].map(([id, qty]) => {
    const prod = catalog[chain].find((x) => x.id === id);
    return { id, name: prod.name, qty, lineTotal: lineTotal(prod, qty) };
  });
  const itemsTotal = r2(lines.reduce((t, l) => t + l.lineTotal, 0));
  const d = DELIVERY[chain];
  return { lines, itemsTotal, deliveryFee: d.fee, grandTotal: r2(itemsTotal + d.fee), minOrder: d.min };
}
const fail = (code) => Object.assign(new Error(code), { code });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = ({ key, ...rest }) => rest;

const METHODS = {
  checkLogin: () => ({ loggedIn: true, userLabel: 'דנה (הדגמה)' }),
  getDeliveryContext: (chain) => ({ addressLabel: 'הנשיא 12, חיפה', storeLabel: null, deliveryFee: DELIVERY[chain].fee, minOrder: DELIVERY[chain].min }),
  getOrders: (chain) => (chain === 'shufersal' ? orders() : []),
  search: (chain, query) => {
    const words = normalize(query).split(' ').filter(Boolean);
    return catalog[chain].filter((x) => { const n = normalize(x.name); return words.every((w) => n.includes(w)); }).map(strip);
  },
  getCart: (chain) => cartView(chain),
  setItem: (chain, id, qty) => {
    if (!catalog[chain].some((x) => x.id === id)) throw fail('NETWORK');
    if (qty > 0) carts[chain].set(id, qty); else carts[chain].delete(id);
    return { ok: true, qty: qty > 0 ? qty : 0 };
  },
  emptyCart: (chain) => { carts[chain].clear(); return { ok: true }; },
};

export async function rpc(chain, method, args) {
  if (!IDS.includes(chain) || !METHODS[method]) throw fail('FORBIDDEN');
  await pause(method === 'search' || method === 'setItem' ? 140 : 60);
  return METHODS[method](chain, ...(args || []));
}

// In the real extension this opens the site in a new tab. In the demo it shows what would be there.
export async function openSite(chain, which) {
  const dlg = document.getElementById('demo-dialog');
  const title = dlg.querySelector('h2');
  const body = dlg.querySelector('.demo-body');
  body.replaceChildren();
  const add = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; body.append(el); return el; };
  if (which === 'cart') {
    const v = cartView(chain);
    title.textContent = `העגלה ב${CHAINS[chain].name} (הדגמה)`;
    add('p', 'בתוסף האמיתי הכפתור הזה פותח את דף העגלה באתר עצמו, שם משלמים. כאן מוצג מה שהיה מחכה שם:', 'lead');
    const ul = document.createElement('ul'); ul.className = 'clean';
    for (const l of v.lines) { const li = document.createElement('li'); li.textContent = `${l.name} × ${l.qty} — ₪${l.lineTotal.toFixed(2)}`; ul.append(li); }
    if (!v.lines.length) { const li = document.createElement('li'); li.textContent = 'העגלה ריקה'; ul.append(li); }
    body.append(ul);
    add('p', `סה"כ מוצרים ₪${v.itemsTotal.toFixed(2)} · משלוח ₪${v.deliveryFee.toFixed(2)}`);
  } else {
    title.textContent = `${CHAINS[chain].name} (הדגמה)`;
    add('p', 'בתוסף האמיתי הכפתור הזה פותח את האתר, ושם מתחברים עם המשתמש והסיסמה שלכם. התוסף לא רואה את הסיסמה. בהדגמה כל שלוש הרשתות כבר "מחוברות".', 'lead');
  }
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

export async function closeWorkers() {
  for (const c of IDS) carts[c].clear();
}
