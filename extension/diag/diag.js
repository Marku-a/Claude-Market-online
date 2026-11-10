// Diagnostics page: runs the adapters' `diagnose` per chain and shows the already-redacted shape report.
import { CHAINS } from '../sites/registry.js';
import { safeDetail } from '../sites/http.js';

function call(chain) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ t: 'call', chain, method: 'diagnose', args: [] }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, code: 'NETWORK' });
      resolve(res || { ok: false, code: 'NETWORK' });
    });
  });
}

// Rows are rebuilt from known keys only; `detail` is re-checked against the fixed whitelist (no free text).
function cleanRows(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map((s) => {
    const row = { step: String(s.step ?? ''), ok: !!s.ok };
    if (s.code) row.code = String(s.code);
    const detail = safeDetail(s.detail);
    if (detail) row.detail = detail;
    row.shape = s.shape === undefined ? null : s.shape;
    return row;
  });
}

function stepsOf(value) {
  const list = Array.isArray(value) ? value : value && Array.isArray(value.steps) ? value.steps : [];
  return list.map((s) => ({
    name: String(s.step ?? s.name ?? ''),
    ok: s.ok !== undefined ? !!s.ok : !s.code && !s.error,
    code: s.code ? String(s.code) : s.error && s.error.code ? String(s.error.code) : '',
  }));
}

function cell(tag, text, cls) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

const reportEl = document.getElementById('report');
const rowsEl = document.getElementById('rows');
const liveEl = document.getElementById('live');
const runBtn = document.getElementById('btn-diag');

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  rowsEl.replaceChildren();
  reportEl.textContent = '';
  const report = {};
  for (const id of Object.keys(CHAINS)) {
    liveEl.textContent = `בודקים: ${CHAINS[id].name}…`;
    const res = await call(id);
    report[id] = res.ok ? cleanRows(res.value) : { ok: false, code: String(res.code || 'NETWORK') };
    const failDetail = res.ok ? undefined : safeDetail(res.message);
    if (failDetail) report[id].detail = failDetail;
    const h2 = cell('h2', CHAINS[id].name);
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const t of ['שלב', 'תוצאה', 'קוד']) { const th = cell('th', t); th.scope = 'col'; head.append(th); }
    const thead = document.createElement('thead');
    thead.append(head);
    const tbody = document.createElement('tbody');
    const steps = res.ok ? stepsOf(report[id]) : [{ name: 'diagnose', ok: false, code: res.code || 'NETWORK' }];
    for (const s of steps) {
      const tr = document.createElement('tr');
      tr.append(cell('th', s.name), cell('td', s.ok ? 'תקין' : 'נכשל', s.ok ? '' : 'fail'), cell('td', s.code));
      tr.firstChild.scope = 'row';
      tbody.append(tr);
    }
    table.append(thead, tbody);
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.append(table);
    rowsEl.append(h2, wrap);
  }
  reportEl.textContent = JSON.stringify(report, null, 2);
  liveEl.textContent = 'האבחון הסתיים';
  runBtn.disabled = false;
});

document.getElementById('btn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(reportEl.textContent);
    liveEl.textContent = 'הדוח הועתק';
  } catch {
    liveEl.textContent = 'ההעתקה נכשלה — סמנו את הטקסט והעתיקו ידנית';
  }
});
