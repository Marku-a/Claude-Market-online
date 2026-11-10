// Full-tab UI. All user/site text is inserted as text nodes only.
import { CHAINS } from '../sites/registry.js';
import { createRunner, estimateTotals } from './orchestrator.js';
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

function go(step) {
  S.step = step;
  const ol = $('steps');
  ol.replaceChildren(...STEPS.map((t, i) => h('li', { 'aria-current': STEP_KEYS[i] === step ? 'step' : null }, `${i + 1}. ${t}`)));
  const main = $('main');
  main.replaceChildren(h('div', { 'data-testid': 'step-' + step }));
  const box = main.firstChild;
  ({ settings: viewSettings, connect: viewConnect, list: viewList, review: viewReview, result: viewResult })[step](box);
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
  S.conn = {};
  drawConnect();
  S.conn = await runner.connect({ onProgress: () => {} });
  drawConnect();
}

function viewConnect(box) {
  put(box, h('h2', { text: 'חיבור לאתרים' }),
    h('p', { class: 'lead', text: 'מתחברים באתר עצמו. התוסף לא רואה ולא שומר את הסיסמה.' }),
    h('div', { id: 'connect-body' }));
  runConnect();
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
  area.addEventListener('input', () => { S.listText = area.value; clearTimeout(timer); timer = setTimeout(refreshChips, 400); });
  put(box, h('h2', { text: 'מה לקנות?' }),
    h('p', { class: 'lead', text: 'מוצר בכל שורה. אפשר לכתוב כמות בהתחלה, למשל "2 חלב".' }),
    h('label', { for: 'list-input', text: 'רשימת קניות' }), area,
    h('div', { class: 'actions' },
      btn('השתמש ברשימה האחרונה', () => { if (last) { area.value = last; refreshChips(); } }, { disabled: !last }),
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

async function viewReview(box) {
  const ids = connected();
  const lead = h('p', { class: 'lead', text: 'מחפשים כל מוצר בכל אתר…' });
  put(box, h('h2', { text: 'בדיקת הסל' }), lead);
  const prog = h('div');
  const body = h('div');
  put(box, prog, body);
  S.progress = {};
  const onProgress = (p) => {
    S.progress[p.chain] = p;
    drawProgress(prog, ids);
    live(`${CHAINS[p.chain].name}: ${p.phase} ${p.done}/${p.total}`);
  };
  try {
    await runner.refreshHistory(ids, { onProgress });
    S.plan = await runner.buildPlan(S.listText, ids, { onProgress });
    S.carts = await runner.inspectCarts(ids.filter((c) => !S.plan.chainErrors[c]));
  } catch (e) {
    prog.replaceChildren(h('div', { class: 'error', role: 'alert', text: errText(e.code) }));
    return;
  }
  prog.replaceChildren();
  lead.textContent = 'זה מה שנבחר בכל אתר. אפשר להחליף מוצר, לשנות כמות או להוריד שורה, ואז למלא את העגלות.';
  live('החיפוש הסתיים');
  drawReview(body);
}

function planChains() {
  return connected().filter((c) => !S.plan.chainErrors[c]);
}

function drawReview(body) {
  const plan = S.plan;
  const chains = planChains();
  body.replaceChildren();
  for (const [c, e] of Object.entries(plan.chainErrors)) put(body, errorBox(c, e.code, true));
  if (!chains.length) {
    put(body, h('p', { class: 'error', text: 'לא הצלחנו לחפש באף אתר.' }), btn('חזרה לחיבור', () => go('connect')));
    return;
  }
  const head = h('tr', null, h('th', { scope: 'col', text: 'מוצר ברשימה' }), chains.map((c) => h('th', { scope: 'col', text: CHAINS[c].name })));
  const rows = plan.lines.map((l, i) => {
    const incl = h('input', { type: 'checkbox', id: 'inc' + i, checked: l.enabled !== false, 'aria-label': 'כלול: ' + l.query });
    incl.addEventListener('change', () => { runner.toggleLine(plan, i, incl.checked); drawReview(body); });
    const qtyId = 'qty' + i;
    const stepper = h('span', { class: 'stepper' },
      btn('−', () => { runner.setQty(plan, i, l.qty - 1); drawReview(body); }, { 'aria-label': 'פחות: ' + l.query }),
      h('span', { id: qtyId, 'aria-label': 'כמות', text: String(l.qty) }),
      btn('+', () => { runner.setQty(plan, i, l.qty + 1); drawReview(body); }, { 'aria-label': 'עוד: ' + l.query }));
    const first = h('th', { scope: 'row' }, h('label', null, incl, ' ', l.query), h('div', null, stepper));
    const cells = chains.map((c) => {
      const e = l.chains[c];
      const td = h('td');
      if (!e) return td;
      if (e.product) {
        put(td, h('div', { text: e.product.name }),
          h('div', null, num(e.lineTotal), e.promoApplied ? ' · ' + (e.product.promo.description || 'מבצע') : ''));
      } else put(td, h('div', { text: e.searchError ? 'החיפוש נכשל' : (e.missingReason || 'לא נמצא') }));
      put(td, h('span', { class: 'badge ' + (e.match === 'identical' || e.match === 'similar' ? 'ok' : 'bad'), text: MATCH_TEXT[e.match] }));
      if (e.results.length > 1 || (e.results.length && !e.product)) {
        const sid = `sel${i}-${c}`;
        const sel = h('select', { id: sid, 'aria-label': `בחירת מוצר ב${CHAINS[c].name} עבור ${l.query}` },
          ...(e.product ? [] : [h('option', { value: '' }, 'בחרו מוצר')]),
          ...e.results.map((r) => h('option', { value: r.id, selected: e.product && e.product.id === r.id }, `${r.name} — ${money(r.price)}`)));
        sel.addEventListener('change', async () => { if (sel.value) { await runner.setChoice(plan, i, c, sel.value); drawReview(body); } });
        put(td, h('div', null, sel));
      }
      return td;
    });
    return h('tr', null, first, cells);
  });
  const totals = estimateTotals(plan, chains);
  const foot = h('tr', null, h('th', { scope: 'row', text: 'הערכה לסל' }),
    chains.map((c) => h('td', { 'data-testid': 'total-' + c }, num(totals[c]))));
  put(body, h('div', { class: 'table-wrap' }, h('table', null, h('thead', null, head), h('tbody', null, rows), h('tfoot', null, foot))));

  const withCart = chains.filter((c) => S.carts[c] && S.carts[c].lines.length);
  if (withCart.length) {
    put(body, h('h3', { text: 'יש כבר מוצרים בעגלה' }));
    for (const c of withCart) {
      const def = S.profile && S.profile.existingCartPolicy === 'empty' ? 'empty' : 'keep';
      S.policy[c] ||= def;
      const unsupported = c === 'hazihinam';
      const radio = (val, text) => {
        const id = `pol-${c}-${val}`;
        const r = h('input', { type: 'radio', name: 'pol-' + c, id, value: val, checked: S.policy[c] === val, 'data-testid': `policy-${c}-${val}` });
        r.addEventListener('change', () => { S.policy[c] = val; });
        return h('div', null, r, ' ', h('label', { for: id, class: 'inline', text }));
      };
      put(body, h('fieldset', null, h('legend', { text: `${CHAINS[c].name}: ${S.carts[c].lines.length} מוצרים בעגלה` }),
        radio('empty', 'לרוקן את העגלה הקיימת'), radio('keep', 'להשאיר ולהוסיף'),
        unsupported ? h('p', { class: 'note', text: 'ריקון עגלה עדיין לא נתמך בחצי חינם. אם בחרתם לרוקן, יש לעשות זאת באתר עצמו.' }) : null));
    }
  }
  put(body, h('div', { class: 'actions' },
    primary('מלא את העגלות', () => go('result'), { 'data-testid': 'btn-fill', disabled: !plan.lines.some((l) => l.enabled !== false) })));
}

/* ---------- 5. result ---------- */
async function viewResult(box) {
  const chains = planChains();
  put(box, h('h2', { text: 'ממלאים את העגלות…' }));
  const prog = h('div');
  const body = h('div');
  put(box, prog, body);
  S.progress = {};
  const onProgress = (p) => {
    S.progress[p.chain] = p;
    drawProgress(prog, chains);
    live(`${CHAINS[p.chain].name}: ${p.message || ''}`);
  };
  try {
    const policy = {};
    for (const c of chains) policy[c] = S.policy[c] || (S.profile && S.profile.existingCartPolicy === 'empty' ? 'empty' : 'keep');
    S.fillResults = await runner.fill(S.plan, chains, policy, { onProgress });
    S.final = await runner.finish(S.plan, S.fillResults, S.profile || defaultProfile());
  } catch (e) {
    prog.replaceChildren(h('div', { class: 'error', role: 'alert', text: errText(e.code) }));
    return;
  }
  box.firstChild.textContent = 'התוצאה';
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
    const prices = okIds.filter((c) => l.chains[c].match !== 'missing').map((c) => l.chains[c].lineTotal);
    const min = prices.length ? Math.min(...prices) : null;
    return h('tr', null, h('th', { scope: 'row', text: l.line }), okIds.map((c) => {
      const e = l.chains[c];
      const td = h('td');
      if (e.product) put(td, h('div', { text: e.product.name }), h('div', null, num(e.lineTotal)));
      put(td, h('span', { class: 'badge ' + (e.match === 'identical' || e.match === 'similar' ? 'ok' : 'bad'), text: MATCH_TEXT[e.match] }));
      if (e.match !== 'missing' && e.lineTotal === min && okIds.length > 1) put(td, ' ', h('span', { class: 'cheapest', text: 'הזול ביותר' }));
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
    S.plan = null; S.fillResults = null; S.final = null; S.policy = {}; S.listText = '';
    go('list');
  }, { 'data-testid': 'btn-new' })));
}

/* ---------- boot ---------- */
$('btn-settings').addEventListener('click', () => go('settings'));
(async () => {
  S.profile = (await store.get('profile')) || null;
  go(S.profile ? 'connect' : 'settings');
})();
