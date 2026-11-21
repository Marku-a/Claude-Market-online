// Full-tab UI. All user/site text is inserted as text nodes only.
import { CHAINS } from '../sites/registry.js';
import { createRunner, estimateTotals } from './orchestrator.js';
import { REASON_REMOVED } from '../engine/compare.js';
import { store } from './store.js';
import { rpc, openSite, closeWorkers } from './rpc.js';

const IDS = Object.keys(CHAINS);
const runner = createRunner({ rpc, store, today: new Date().toISOString().slice(0, 10), chains: CHAINS });
const STEPS = ['הגדרות', 'חיבור', 'רשימה', 'בדיקה', 'תוצאה'];
const STEP_KEYS = ['settings', 'connect', 'list', 'review', 'result'];

const ERRORS = {
  NOT_LOGGED_IN: 'צריך להתחבר לאתר',
  BLOCKED: 'האתר מבקש אימות — פתחו את האתר, אשרו שאינכם רובוט ונסו שוב',
  SHAPE_CHANGED: 'האתר השתנה — הריצו אבחון ושלחו את הדוח',
  NETWORK: 'בעיית תקשורת — נסו שוב',
  UNSUPPORTED: 'פעולה זו עדיין לא נתמכת באתר הזה',
  REDIRECT: 'האתר הפנה לדף אחר — ייתכן שצריך להתחבר מחדש באתר',
  FORBIDDEN: 'הפעולה נחסמה כדי לא להתקרב לדף תשלום',
};
const errText = (code) => ERRORS[code] || ERRORS.NETWORK;
const MATCH_TEXT = { identical: 'זהה', similar: 'דומה', different: 'שונה', missing: 'חסר' };
const REMOVED_TEXT = REASON_REMOVED; // "הוסר על ידך"

const S = {
  step: 'settings',
  profile: null,
  conn: {},
  listText: '',
  plan: null,
  carts: {},
  policy: {},
  progress: {},
  fillResults: null,
  final: null,
  reached: 0, // furthest step index the user may click back/forward to without redoing anything
  busy: false, // a site action is running: no navigation until it ends
  planKey: null, // list text + chains the current plan was built for
};

const $ = (id) => document.getElementById(id);
const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? '₪' + n.toFixed(2) : 'לא ידוע');

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
// Element.append() renders null as the text "null"; put() skips empty children.
const put = (el, ...kids) => { el.append(...kids.flat().filter((k) => k != null && k !== false)); return el; };
const num = (n) => h('span', { class: 'num', text: money(n) });
const btn = (text, onclick, extra) => h('button', { type: 'button', onclick, ...extra }, text);
const primary = (text, onclick, extra) => btn(text, onclick, { class: 'primary', ...extra });
const live = (text) => { $('live').textContent = text; };

function defaultProfile() {
  return { address: { city: '', street: '', number: '' }, discounts: [], deliveryOverrides: {}, existingCartPolicy: 'ask' };
}

// Steps bar: every step already reached is a real button (keyboard reachable); the active one has aria-current.
// Navigating never starts a site action by itself - the views below reuse what they already have.
function drawSteps() {
  const cur = STEP_KEYS.indexOf(S.step);
  $('steps').replaceChildren(...STEPS.map((t, i) => {
    const label = `${i + 1}. ${t}`;
    const current = i === cur ? 'step' : null;
    if (i > S.reached) return h('li', null, h('span', { class: 'step', 'aria-current': current }, label));
    return h('li', null, btn(label, () => go(STEP_KEYS[i]), {
      class: 'step', 'aria-current': current, 'data-testid': 'nav-' + STEP_KEYS[i], disabled: S.busy,
    }));
  }));
  $('btn-settings').disabled = S.busy;
  const back = $('btn-back');
  if (back) back.disabled = S.busy;
}

function setBusy(b) {
  S.busy = b;
  drawSteps();
}

// The result shown no longer matches the plan (or the plan was rebuilt): the user must fill again to see it.
function invalidateFrom(step) {
  S.reached = Math.min(S.reached, STEP_KEYS.indexOf(step) - 1);
  drawSteps();
}

function go(step, opts = {}) {
  if (S.busy) return;
  S.step = step;
  S.reached = Math.max(S.reached, STEP_KEYS.indexOf(step));
  const main = $('main');
  main.replaceChildren(h('div', { 'data-testid': 'step-' + step }));
  const box = main.firstChild;
  const idx = STEP_KEYS.indexOf(step);
  if (idx > 0) put(box, btn('→ חזרה', () => go(STEP_KEYS[idx - 1]), { class: 'back', id: 'btn-back', 'data-testid': 'btn-back' }));
  drawSteps();
  ({ settings: viewSettings, connect: viewConnect, list: viewList, review: viewReview, result: viewResult })[step](box, opts);
  main.focus();
}

function errorBox(chain, code, withAction) {
  const box = h('div', { class: 'error', role: 'alert', 'data-testid': 'error-' + chain }, `${CHAINS[chain].name}: ${errText(code)}`);
  if (withAction && (code === 'NOT_LOGGED_IN' || code === 'BLOCKED')) {
    put(box, ' ', btn('פתח את האתר', () => openSite(chain, code === 'BLOCKED' ? 'home' : 'login')));
  }
  return box;
}

/* ---------- 1. settings ---------- */
function viewSettings(box) {
  const p = S.profile || defaultProfile();
  const draft = JSON.parse(JSON.stringify(p));
  put(box, h('h2', { text: 'הגדרות' }), h('p', { class: 'lead', text: 'כל המידע נשמר רק במחשב הזה.' }));

  const field = (label, value, onInput, type) => {
    const id = 'f' + Math.random().toString(36).slice(2);
    const input = h('input', { type: type || 'text', id, value: value ?? '' });
    input.addEventListener('input', () => onInput(input.value));
    return h('div', null, h('label', { for: id, text: label }), input);
  };

  put(box, h('fieldset', null,
    h('legend', { text: 'כתובת למשלוח' }),
    h('div', { class: 'row' },
      field('עיר', draft.address.city, (v) => { draft.address.city = v; }),
      field('רחוב', draft.address.street, (v) => { draft.address.street = v; }),
      field('מספר', draft.address.number, (v) => { draft.address.number = v; })),
    h('p', { class: 'note', text: 'ודאו שזו הכתובת שמוגדרת בכל אתר.' })));

  const pid = 'policy';
  const sel = h('select', { id: pid },
    ...[['ask', 'לשאול אותי'], ['empty', 'לרוקן את העגלה הקיימת'], ['keep', 'להשאיר ולהוסיף']]
      .map(([v, t]) => h('option', { value: v, selected: draft.existingCartPolicy === v }, t)));
  sel.addEventListener('change', () => { draft.existingCartPolicy = sel.value; });
  put(box, h('fieldset', null, h('legend', { text: 'עגלה קיימת באתר' }), h('label', { for: pid, text: 'מה לעשות אם כבר יש מוצרים בעגלה' }), sel));

  for (const c of IDS) {
    const fs = h('fieldset', { 'data-testid': 'settings-' + c }, h('legend', { text: CHAINS[c].name }));
    const list = h('div');
    const draw = () => {
      list.replaceChildren();
      draft.discounts.forEach((d, i) => {
        if (d.chain !== c) return;
        const typeId = 't' + c + i;
        const type = h('select', { id: typeId },
          h('option', { value: 'percent', selected: d.type === 'percent' }, 'אחוז'),
          h('option', { value: 'fixed', selected: d.type === 'fixed' }, 'סכום קבוע'));
        type.addEventListener('change', () => { d.type = type.value; });
        const enId = 'e' + c + i;
        const en = h('input', { type: 'checkbox', id: enId, checked: d.enabled !== false });
        en.addEventListener('change', () => { d.enabled = en.checked; });
        put(list, h('div', { class: 'row' },
          field('שם ההנחה (למשל מועדון, כרטיס אשראי)', d.label, (v) => { d.label = v; }),
          h('div', null, h('label', { for: typeId, text: 'סוג' }), type),
          field('ערך', d.value, (v) => { d.value = Number(v) || 0; }, 'number'),
          field('מינימום סל', d.minBasket, (v) => { d.minBasket = Number(v) || 0; }, 'number'),
          field('תקרה', d.cap, (v) => { d.cap = v === '' ? null : Number(v) || 0; }, 'number'),
          h('div', null, h('label', { for: enId, text: 'פעיל' }), en),
          btn('הסר', () => { draft.discounts.splice(i, 1); draw(); })));
      });
    };
    draw();
    const ov = (draft.deliveryOverrides[c] ||= { fee: null, minOrder: null });
    const toNum = (v) => (v === '' ? null : Number(v));
    put(fs, h('h3', { text: 'הנחות אישיות' }), list,
      btn('הוסף הנחה', () => { draft.discounts.push({ chain: c, label: '', type: 'percent', value: 0, minBasket: 0, cap: null, enabled: true }); draw(); }),
      h('h3', { text: 'דמי משלוח ומינימום הזמנה ידניים (אם האתר לא מציג)' }),
      h('div', { class: 'row' },
        field('דמי משלוח', ov.fee, (v) => { ov.fee = toNum(v); }, 'number'),
        field('מינימום הזמנה', ov.minOrder, (v) => { ov.minOrder = toNum(v); }, 'number')));
    put(box, fs);
  }

  put(box, h('div', { class: 'actions' },
    primary('שמור והמשך', async () => {
      for (const [c, o] of Object.entries(draft.deliveryOverrides)) if (o.fee == null && o.minOrder == null) delete draft.deliveryOverrides[c];
      draft.discounts = draft.discounts.filter((d) => d.label || d.value);
      S.profile = draft;
      await store.set('profile', draft);
      go('connect');
    }, { 'data-testid': 'btn-save-settings' }),
    btn('מחק את כל הנתונים', async () => {
      if (!window.confirm('למחוק את כל הנתונים שנשמרו (כתובת, הנחות, היסטוריה)?')) return;
      await store.clearAll();
      S.profile = null;
      go('settings');
    }, { class: 'danger', 'data-testid': 'btn-clear' })));
}

/* ---------- 2. connect ---------- */
const STATE_TEXT = (c) => {
  const r = S.conn[c];
  if (!r) return 'בודקים…';
  if (r.state === 'ok') return r.userLabel ? `מחובר כ-${r.userLabel}` : 'מחובר';
  return { logged_out: 'לא מחובר', blocked: 'נדרש אימות באתר', error: 'שגיאה' }[r.state];
};

async function runConnect() {
  const before = connected().join(',');
  S.conn = {};
  drawConnect();
  S.conn = await runner.connect({ onProgress: () => {} });
  // other chains connected now: the plan must be rebuilt, so the later steps are not reachable directly
  if (S.plan && connected().join(',') !== before) invalidateFrom('review');
  drawConnect();
}

function viewConnect(box) {
  put(box, h('h2', { text: 'חיבור לאתרים' }),
    h('p', { class: 'lead', text: 'מתחברים באתר עצמו. התוסף לא רואה ולא שומר את הסיסמה.' }),
    h('div', { id: 'connect-body' }));
  // Coming back here shows the last check; "בדוק שוב" checks again.
  if (IDS.every((c) => S.conn[c])) drawConnect();
  else runConnect();
}

function drawConnect() {
  const body = $('connect-body');
  if (!body || S.step !== 'connect') return;
  const okIds = IDS.filter((c) => S.conn[c] && S.conn[c].state === 'ok');
  const skipped = IDS.filter((c) => !okIds.includes(c));
  const cards = h('div', { class: 'cards' }, IDS.map((c) => {
    const r = S.conn[c];
    const card = h('section', { class: 'card', 'data-testid': 'chain-card-' + c },
      h('h3', { text: CHAINS[c].name }),
      h('p', null, h('span', { class: 'badge ' + (r && r.state === 'ok' ? 'ok' : 'bad'), 'data-testid': 'chain-status-' + c, text: STATE_TEXT(c) })));
    if (r && r.message && r.state === 'error') put(card, h('p', { class: 'lead', text: errText(r.code) }));
    put(card, h('div', { class: 'actions' },
      btn('פתח את האתר להתחברות', () => openSite(c, 'login')),
      btn('בדוק שוב', runConnect)));
    return card;
  }));
  body.replaceChildren(cards);
  if (S.conn && Object.keys(S.conn).length === IDS.length && skipped.length) {
    put(body, h('p', { class: 'note', text: 'האתרים הבאים לא ייכללו בהשוואה: ' + skipped.map((c) => CHAINS[c].name).join(', ') }));
  }
  put(body, h('div', { class: 'actions' },
    primary('המשך', () => go('list'), { 'data-testid': 'btn-continue', disabled: okIds.length === 0 })));
}

const connected = () => IDS.filter((c) => S.conn[c] && S.conn[c].state === 'ok');

/* ---------- 3. list ---------- */
async function viewList(box) {
  const last = await store.get('lastList');
  const area = h('textarea', { id: 'list-input', 'data-testid': 'list-input', placeholder: '2 חלב 3%\nלחם אחיד\nביצים L\nעגבניות x3' });
  area.value = S.listText;
  const chipsBox = h('div', { class: 'chips', 'aria-label': 'אולי שכחת' });
  let timer = null;
  const refreshChips = async () => {
    S.listText = area.value;
    const sug = await runner.suggestForgot(area.value);
    chipsBox.replaceChildren(...sug.map((s) => btn('+ ' + s.name, () => {
      area.value = (area.value.trimEnd() ? area.value.trimEnd() + '\n' : '') + s.name + '\n';
      refreshChips();
    }, { title: s.reason })));
  };
  area.addEventListener('input', () => {
    S.listText = area.value;
    // a different list needs a new search: the review/result of the old list are no longer reachable directly
    if (S.plan && planKey() !== S.planKey && S.reached > STEP_KEYS.indexOf('list')) invalidateFrom('review');
    clearTimeout(timer); timer = setTimeout(refreshChips, 400);
  });
  put(box, h('h2', { text: 'מה לקנות?' }),
    h('p', { class: 'lead', text: 'מוצר בכל שורה. אפשר לכתוב כמות בהתחלה, למשל "2 חלב".' }),
    h('label', { for: 'list-input', text: 'רשימת קניות' }), area,
    h('div', { class: 'actions' },
      btn('השתמש ברשימה האחרונה', () => {
        if (!last) return;
        area.value = last;
        area.dispatchEvent(new Event('input'));
      }, { disabled: !last }),
      primary('בנה והשווה', () => {
        S.listText = area.value;
        if (!area.value.trim()) { live('הרשימה ריקה'); area.focus(); return; }
        go('review');
      }, { 'data-testid': 'btn-build' })),
    h('h3', { text: 'אולי שכחת' }), chipsBox);
  refreshChips();
}

/* ---------- 4. review ---------- */
function progressRow(chain, p) {
  const label = `${CHAINS[chain].name}: ${p.message || ''}`;
  return h('div', { class: 'card' }, h('div', { text: label }),
    h('progress', { max: p.total || 1, value: p.done || 0, 'aria-label': CHAINS[chain].name }));
}

function drawProgress(el, ids) {
  el.replaceChildren(...ids.filter((c) => S.progress[c]).map((c) => progressRow(c, S.progress[c])));
}

const planKey = () => JSON.stringify([S.listText, connected()]);
const REVIEW_LEAD = 'זה מה שנבחר בכל אתר. אפשר להחליף מוצר, לשנות כמות, להוריד שורה או לא לקנות מוצר באתר מסוים, ואז למלא את העגלות.';

async function viewReview(box) {
  const ids = connected();
  const lead = h('p', { class: 'lead', text: 'מחפשים כל מוצר בכל אתר…' });
  put(box, h('h2', { text: 'בדיקת הסל' }), lead);
  const prog = h('div');
  const body = h('div');
  put(box, prog, body);
  // Same list and chains as the plan we have: show it as the user left it (choices, quantities, exclusions).
  if (S.plan && S.planKey === planKey()) {
    lead.textContent = REVIEW_LEAD;
    drawReview(body);
    return;
  }
  S.progress = {};
  const onProgress = (p) => {
    S.progress[p.chain] = p;
    drawProgress(prog, ids);
    live(`${CHAINS[p.chain].name}: ${p.phase} ${p.done}/${p.total}`);
  };
  invalidateFrom('result');
  setBusy(true);
  try {
    await runner.refreshHistory(ids, { onProgress });
    const key = planKey();
    S.plan = await runner.buildPlan(S.listText, ids, { onProgress });
    S.carts = await runner.inspectCarts(ids.filter((c) => !S.plan.chainErrors[c]));
    S.planKey = key;
    S.policy = {};
  } catch (e) {
    prog.replaceChildren(h('div', { class: 'error', role: 'alert', text: errText(e.code) }));
    return;
  } finally {
    setBusy(false);
  }
  prog.replaceChildren();
  lead.textContent = REVIEW_LEAD;
  live('החיפוש הסתיים');
  drawReview(body);
}

// A cart this session already filled holds our own units: emptying it again is only ever the user's explicit choice.
function defaultPolicy(c) {
  if (runner.filledChains().includes(c)) return 'keep';
  return S.profile && S.profile.existingCartPolicy === 'empty' ? 'empty' : 'keep';
}

function planChains() {
  return connected().filter((c) => !S.plan.chainErrors[c]);
}

function drawReview(body) {
  const plan = S.plan;
  const chains = planChains();
  // any change here makes the last result stale: it is reachable again only by filling
  const redraw = () => {
    const focused = document.activeElement && document.activeElement.id;
    invalidateFrom('result');
    drawReview(body);
    const again = focused && document.getElementById(focused);
    if (again) again.focus(); // keyboard users stay on the control they just used
  };
  body.replaceChildren();
  if (runner.filledChains().length) {
    put(body, h('p', { class: 'note', role: 'note', 'data-testid': 'refill-note', text: 'העגלות כבר מולאו. מילוי חוזר יעדכן את הכמויות לפי הרשימה הזאת.' }));
  }
  for (const [c, e] of Object.entries(plan.chainErrors)) put(body, errorBox(c, e.code, true));
  if (!chains.length) {
    put(body, h('p', { class: 'error', text: 'לא הצלחנו לחפש באף אתר.' }), btn('חזרה לחיבור', () => go('connect')));
    return;
  }
  const head = h('tr', null, h('th', { scope: 'col', text: 'מוצר ברשימה' }), chains.map((c) => h('th', { scope: 'col', text: CHAINS[c].name })));
  const rows = plan.lines.map((l, i) => {
    const incl = h('input', { type: 'checkbox', id: 'inc' + i, checked: l.enabled !== false, 'aria-label': 'כלול: ' + l.query });
    incl.addEventListener('change', () => { runner.toggleLine(plan, i, incl.checked); redraw(); });
    const qtyId = 'qty' + i;
    const stepper = h('span', { class: 'stepper' },
      btn('−', () => { runner.setQty(plan, i, l.qty - 1); redraw(); }, { 'aria-label': 'פחות: ' + l.query }),
      h('span', { id: qtyId, 'aria-label': 'כמות', text: String(l.qty) }),
      btn('+', () => { runner.setQty(plan, i, l.qty + 1); redraw(); }, { 'aria-label': 'עוד: ' + l.query }));
    const first = h('th', { scope: 'row' }, h('label', null, incl, ' ', l.query), h('div', null, stepper));
    const cells = chains.map((c) => {
      const e = l.chains[c];
      const td = h('td', { 'data-testid': `cell-${i}-${c}`, class: e && e.excluded ? 'excluded' : null });
      if (!e) return td;
      if (e.product) {
        put(td, h('div', { class: 'product-name', text: e.product.name }),
          e.excluded ? null : h('div', null, num(e.lineTotal), e.promoApplied ? ' · ' + (e.product.promo.description || 'מבצע') : ''));
      } else put(td, h('div', { text: e.searchError ? 'החיפוש נכשל' : (e.missingReason || 'לא נמצא') }));
      if (e.excluded) put(td, h('span', { class: 'badge bad', text: REMOVED_TEXT }));
      else put(td, h('span', { class: 'badge ' + (e.match === 'identical' || e.match === 'similar' ? 'ok' : 'bad'), text: MATCH_TEXT[e.match] }));
      if (!e.excluded && (e.results.length > 1 || (e.results.length && !e.product))) {
        const sid = `sel${i}-${c}`;
        const sel = h('select', { id: sid, 'aria-label': `בחירת מוצר ב${CHAINS[c].name} עבור ${l.query}` },
          ...(e.product ? [] : [h('option', { value: '' }, 'בחרו מוצר')]),
          ...e.results.map((r) => h('option', { value: r.id, selected: e.product && e.product.id === r.id }, `${r.name} — ${money(r.price)}`)));
        sel.addEventListener('change', async () => { if (sel.value) { await runner.setChoice(plan, i, c, sel.value); redraw(); } });
        put(td, h('div', null, sel));
      }
      if (e.product) {
        // drop this product at this chain only (e.g. a wrong match); the choice is kept for re-including
        const xid = `ex${i}-${c}`;
        const ex = h('input', { type: 'checkbox', id: xid, checked: !!e.excluded, 'data-testid': `exclude-${i}-${c}` });
        ex.addEventListener('change', () => { runner.setExcluded(plan, i, c, ex.checked); redraw(); });
        put(td, h('div', { class: 'exclude' }, ex,
          h('label', { for: xid, class: 'inline' }, 'לא לקנות כאן',
            h('span', { class: 'sr-only', text: ` (${l.query}, ${CHAINS[c].name})` }))));
      }
      return td;
    });
    return h('tr', null, first, cells);
  });
  const totals = estimateTotals(plan, chains);
  const foot = h('tr', null, h('th', { scope: 'row', text: 'הערכה לסל' }),
    chains.map((c) => h('td', { 'data-testid': 'total-' + c }, num(totals[c]))));
  put(body, h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), h('tbody', null, rows), h('tfoot', null, foot))));

  const filled = runner.filledChains();
  const withCart = chains.filter((c) => filled.includes(c) || (S.carts[c] && S.carts[c].lines.length));
  if (withCart.length) {
    put(body, h('h3', { text: 'יש כבר מוצרים בעגלה' }));
    for (const c of withCart) {
      S.policy[c] ||= defaultPolicy(c);
      const radio = (val, text) => {
        const id = `pol-${c}-${val}`;
        const r = h('input', { type: 'radio', name: 'pol-' + c, id, value: val, checked: S.policy[c] === val, 'data-testid': `policy-${c}-${val}` });
        r.addEventListener('change', () => { S.policy[c] = val; });
        return h('div', null, r, ' ', h('label', { for: id, class: 'inline', text }));
      };
      const count = S.carts[c] ? `${S.carts[c].lines.length} מוצרים בעגלה` : 'לא הצלחנו לקרוא את העגלה';
      put(body, h('fieldset', { 'data-testid': 'policy-' + c }, h('legend', { text: `${CHAINS[c].name}: ${count}` }),
        radio('empty', 'לרוקן את העגלה הקיימת'), radio('keep', 'להשאיר ולהוסיף')));
    }
  }
  put(body, h('div', { class: 'actions' },
    primary('מלא את העגלות', () => go('result', { fill: true }), { 'data-testid': 'btn-fill', disabled: !plan.lines.some((l) => l.enabled !== false) })));
}

/* ---------- 5. result ---------- */
async function viewResult(box, { fill } = {}) {
  const chains = planChains();
  const title = h('h2', { text: 'ממלאים את העגלות…' });
  put(box, title);
  const prog = h('div');
  const body = h('div');
  put(box, prog, body);
  // Reached again through the steps bar: show the last result, never fill again by itself.
  if (!fill) {
    title.textContent = 'התוצאה';
    if (S.final) drawResult(body);
    else put(body, h('p', { class: 'note', text: 'העגלות עוד לא מולאו. חזרו לבדיקה ולחצו "מלא את העגלות".' }));
    return;
  }
  S.final = null;
  S.progress = {};
  const onProgress = (p) => {
    S.progress[p.chain] = p;
    drawProgress(prog, chains);
    live(`${CHAINS[p.chain].name}: ${p.message || ''}`);
  };
  setBusy(true);
  try {
    const policy = {};
    for (const c of chains) policy[c] = S.policy[c] || defaultPolicy(c);
    S.fillResults = await runner.fill(S.plan, chains, policy, { onProgress });
    // A re-fill starts from "keep" and shows what is in the cart NOW (the cart as it was before this fill is stale).
    const filled = runner.filledChains();
    for (const c of filled) delete S.policy[c];
    const unread = [];
    for (const c of filled) {
      const raw = S.fillResults[c] && S.fillResults[c].rawCart;
      if (raw) S.carts[c] = { lines: raw.lines || [], itemsTotal: typeof raw.itemsTotal === 'number' ? raw.itemsTotal : null };
      else unread.push(c);
    }
    if (unread.length) Object.assign(S.carts, await runner.inspectCarts(unread)); // read-only
    S.final = await runner.finish(S.plan, S.fillResults, S.profile || defaultProfile());
  } catch (e) {
    prog.replaceChildren(h('div', { class: 'error', role: 'alert', text: errText(e.code) }));
    return;
  } finally {
    setBusy(false);
  }
  title.textContent = 'התוצאה';
  prog.replaceChildren();
  live('העגלות מוכנות');
  drawResult(body);
}

function chainWarnings(c, s, fr) {
  const w = [];
  if (s.belowMinimum) w.push(`מתחת למינימום הזמנה (${money(s.minOrder)})`);
  const bad = fr.items.filter((i) => !i.ok);
  for (const i of bad) {
    const name = S.plan.lines[i.line].query;
    const added = i.actualQty - (i.existingQty || 0);
    w.push(added > 0 ? `${name}: נוספה כמות שונה (${added} במקום ${i.wantedQty})` : `${name}: לא נוסף לעגלה${i.code ? ' — ' + errText(i.code) : ''}`);
  }
  for (const r of fr.removed || []) {
    if (r.ok) continue;
    const name = r.productName || r.productId;
    w.push(`${name}: לא הצלחנו להוריד מהעגלה את מה שהוספנו קודם — הורידו באתר${r.code ? ' (' + errText(r.code) + ')' : ''}`);
  }
  if (fr.extra) w.push(`יש בעגלה ${fr.extra.count} מוצרים קודמים (${money(fr.extra.total)}) שלא נכללו בהשוואה`);
  if (fr.couldNotEmpty) w.push('לא ניתן לרוקן את העגלה אוטומטית — רוקנו אותה באתר');
  if (s.itemsSource === 'estimate') w.push('הסכום הוא הערכה — העגלה לא אומתה באתר');
  return w;
}

function drawResult(body) {
  const { summary, recommendation } = S.final;
  const best = recommendation.best;
  const rank = Object.fromEntries(recommendation.ranking.map((r) => [r.chain, r]));
  if (!best) {
    put(body, h('p', { class: 'error', role: 'alert', 'data-testid': 'no-winner',
      text: 'אין כרגע עגלה שאפשר להזמין: העגלות ריקות או מתחת למינימום ההזמנה של האתר. הוסיפו מוצרים לרשימה ונסו שוב.' }));
  }
  const cards = h('div', { class: 'cards' });
  for (const c of Object.keys(summary.chains)) {
    const s = summary.chains[c];
    const card = h('section', { class: 'card' + (c === best ? ' winner' : ''), 'data-testid': 'chain-card-' + c }, h('h3', { text: CHAINS[c].name }));
    if (s.status !== 'ok') {
      const code = (S.plan.chainErrors[c] || (S.fillResults[c] && S.fillResults[c].error) || {}).code;
      put(card, errorBox(c, code, true));
      put(cards, card);
      continue;
    }
    const fr = S.fillResults[c];
    if (c === best) put(card, h('p', null, h('span', { class: 'badge win', 'data-testid': 'winner', text: 'המשתלם ביותר' })));
    const kv = (k, v) => h('div', { class: 'kv' }, h('span', { text: k }), v);
    put(card, 
      kv(`סה"כ מוצרים (${s.itemsSource === 'site' ? 'מהאתר' : 'הערכה'})`, h('span', { 'data-testid': 'total-' + c }, num(s.itemsTotal))),
      kv('משלוח', s.deliveryFee == null ? h('span', { text: 'לא ידוע' }) : num(s.deliveryFee)),
      s.discountTotal > 0 ? kv('הנחות אישיות', h('span', null, '−', num(s.discountTotal))) : null,
      s.appliedDiscounts.length ? h('div', { class: 'lead', text: s.appliedDiscounts.map((d) => d.label).join(', ') }) : null,
      h('div', { class: 'kv big' }, h('span', { text: 'סה"כ לתשלום' }), h('span', { 'data-testid': 'final-' + c }, num(s.final))),
      kv('חסרים', h('span', { text: String(s.missingCount) })));
    const reasons = (rank[c] && rank[c].reasons) || [];
    const warns = chainWarnings(c, s, fr);
    if (s.unavailable && s.unavailable.length) {
      put(card, h('div', { class: 'warn', role: 'alert', 'data-testid': 'unavailable-' + c },
        h('strong', { text: 'מוצרים שאזלו באתר — הסירו אותם מהעגלה באתר או החליפו' }),
        h('ul', { class: 'clean' }, s.unavailable.map((u) => h('li', { text: u.name })))));
    }
    if (reasons.length) put(card, h('ul', { class: 'clean' }, reasons.map((r) => h('li', { text: r }))));
    if (warns.length) put(card, h('div', { class: 'note', role: 'note' }, h('ul', { class: 'clean' }, warns.map((r) => h('li', { text: r })))));
    put(card, btn('עבור לעגלה ב' + CHAINS[c].name, () => openSite(c, 'cart'), { class: 'primary', 'data-testid': 'btn-cart-' + c }),
      h('p', { class: 'lead', text: CHAINS[c].cartHint }));
    put(cards, card);
  }
  put(body, cards);

  const okIds = Object.keys(summary.chains).filter((c) => summary.chains[c].status === 'ok');
  const head = h('tr', null, h('th', { scope: 'col', text: 'מוצר' }), okIds.map((c) => h('th', { scope: 'col', text: CHAINS[c].name })));
  const rows = summary.lines.map((l) => {
    const comparable = (m) => m === 'identical' || m === 'similar'; // 'different' never competes for cheapest
    const prices = okIds.filter((c) => comparable(l.chains[c].match)).map((c) => l.chains[c].lineTotal);
    const min = prices.length ? Math.min(...prices) : null;
    return h('tr', null, h('th', { scope: 'row', text: l.line }), okIds.map((c) => {
      const e = l.chains[c];
      const td = h('td');
      if (e.product) put(td, h('div', { text: e.product.name }), h('div', null, num(e.lineTotal)));
      put(td, h('span', { class: 'badge ' + (e.match === 'identical' || e.match === 'similar' ? 'ok' : 'bad'),
        text: e.match === 'missing' && e.missingReason ? e.missingReason : MATCH_TEXT[e.match] }));
      if (comparable(e.match) && e.lineTotal === min && prices.length > 1) put(td, ' ', h('span', { class: 'cheapest', text: 'הזול ביותר' }));
      return td;
    }));
  });
  put(body, h('h3', { text: 'השוואה שורה אחר שורה' }),
    h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), h('tbody', null, rows))));

  const sg = S.plan.suggestions;
  const section = (title, items) => items.length ? h('section', { class: 'card' }, h('h3', { text: title }), h('ul', { class: 'clean' }, items.map((t) => h('li', { text: t })))) : null;
  put(body, 
    section('מבצעים ששווה לשקול', sg.deals.map((d) => `${CHAINS[d.chain].name}: ${d.name} — כדאי לקחת ${d.suggestedQty} (תוספת ${money(d.extraCost)}). ${d.description}`)),
    section('מוצרים שהתייקרו', sg.priceChanges.map((p) => `${CHAINS[p.chain].name}: ${p.name} — מ-${money(p.old)} ל-${money(p.new)} (${p.pct > 0 ? '+' : ''}${p.pct}%)`)),
    section('אולי שכחת', [...sg.maybeForgot.map((m) => `${m.name} — ${m.reason}`),
      ...sg.goesWith.filter((g) => !sg.maybeForgot.some((m) => m.name === g.name)).map((g) => `${g.name} — בדרך כלל קונים עם ${g.with}`)]));
  put(body, h('div', { class: 'actions' }, primary('קנייה חדשה', async () => {
    try { await closeWorkers(); } catch { /* ignore */ }
    runner.newSession();
    S.plan = null; S.fillResults = null; S.final = null; S.policy = {}; S.listText = ''; S.planKey = null;
    S.reached = STEP_KEYS.indexOf('list');
    go('list');
  }, { 'data-testid': 'btn-new' })));
}

/* ---------- boot ---------- */
$('btn-settings').addEventListener('click', () => go('settings'));
(async () => {
  S.profile = (await store.get('profile')) || null;
  go(S.profile ? 'connect' : 'settings');
})();
