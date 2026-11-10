// Service worker: owns the "worker tabs" (one per chain) and runs adapter methods inside them.
// It never makes network requests itself (CSP connect-src 'none'); all site traffic happens
// same-origin inside a tab of that site.
import { CHAINS, chainForUrl } from './sites/registry.js';
import { isForbiddenUrl, GENERIC } from './sites/guard.js';

const LOAD_TIMEOUT_MS = 45000;
// Hard cap for one adapter call. When hit, the worker tab is closed so nothing can keep mutating a cart.
const CALL_CAP_MS = 240000;
const SETTLE_MS = 5000;
const ADAPTER_METHODS = new Set([
  'checkLogin', 'getDeliveryContext', 'getOrders', 'search', 'getCart', 'setItem', 'emptyCart', 'diagnose',
]);
const registry = CHAINS;

chrome.action.onClicked.addListener(() => openApp());

function openApp() {
  const url = chrome.runtime.getURL('app/index.html');
  chrome.tabs.query({ url }).then((tabs) => {
    if (tabs.length) chrome.tabs.update(tabs[0].id, { active: true });
    else chrome.tabs.create({ url });
  });
}

function fail(code, message) {
  return { ok: false, code, message };
}

// One storage key per chain, so parallel chains never overwrite each other's tab id.
const tabKey = (chainId) => 'tab_' + chainId;

async function workerTab(chainId) {
  const got = await chrome.storage.session.get(tabKey(chainId));
  return got[tabKey(chainId)] ?? null;
}

async function rememberTab(chainId, tabId) {
  if (tabId == null) await chrome.storage.session.remove(tabKey(chainId));
  else await chrome.storage.session.set({ [tabKey(chainId)]: tabId });
}

// Calls to one chain run strictly one after another: a single worker tab per site, one request
// flow at a time (also keeps us gentle on the site). Different chains still run in parallel.
const queues = Object.create(null);
function inQueue(chainId, job) {
  const run = (queues[chainId] || Promise.resolve()).then(job, job);
  queues[chainId] = run.catch(() => {});
  return run;
}

// Resolves when the tab has finished loading a real page. A freshly created tab can briefly report
// "complete" while still blank (before its navigation starts), so the URL is checked as well.
async function waitForLoad(tabId) {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('closed');
    const url = tab.url || '';
    if (tab.status === 'complete' && !tab.pendingUrl && /^https?:/.test(url)) return;
    if (Date.now() > deadline) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 150));
  }
}

// A tab is usable only if it sits on the chain's own origin and not on a payment/checkout page.
function tabIsSafe(tab, chain) {
  if (!tab || !tab.url) return false;
  const c = chainForUrl(tab.url);
  return !!c && c.id === chain.id && !isForbiddenUrl(tab.url, registry);
}

async function ensureTab(chain) {
  const known = await workerTab(chain.id);
  let tab = null;
  if (known != null) tab = await chrome.tabs.get(known).catch(() => null);
  if (tab && !tabIsSafe(tab, chain)) {
    // The user (or the site) moved our tab somewhere else — never follow it; start a clean one.
    await rememberTab(chain.id, null);
    tab = null;
  }
  if (!tab) {
    tab = await chrome.tabs.create({ url: chain.homeUrl, active: false });
    await rememberTab(chain.id, tab.id);
  }
  await waitForLoad(tab.id);
  tab = await chrome.tabs.get(tab.id);
  if (!tabIsSafe(tab, chain)) throw Object.assign(new Error('unsafe tab url'), { code: 'FORBIDDEN' });
  return tab;
}

// Runs inside the site tab (isolated world). Must be self-contained.
async function injected(moduleUrl, method, args, patterns) {
  try {
    // Never run inside a payment/checkout page (checked on path + hash, before importing anything).
    const here = location.pathname + location.hash;
    let dec = here;
    try { dec = decodeURIComponent(decodeURIComponent(here)); } catch { /* keep raw */ }
    for (const [src, flags] of patterns || []) {
      const re = new RegExp(src, flags);
      if (re.test(here) || re.test(dec)) return { ok: false, code: 'FORBIDDEN', message: 'payment page' };
    }
    const title = document.title || '';
    if (/just a moment|רק רגע|attention required|access denied/i.test(title)) {
      return { ok: false, code: 'BLOCKED', message: title };
    }
    const mod = await import(moduleUrl);
    const adapter = mod.default;
    if (!adapter || typeof adapter[method] !== 'function') {
      return { ok: false, code: 'SHAPE_CHANGED', message: 'no method ' + method };
    }
    const value = await adapter[method](...args);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'NETWORK', message: String((e && e.message) || e).slice(0, 300) };
  }
}

const sourceOf = (re) => [re.source, re.flags.replace(/[gy]/g, '')];

async function callAdapter(chainId, method, args) {
  if (!Object.hasOwn(CHAINS, chainId)) return fail('FORBIDDEN', 'unknown chain');
  const chain = CHAINS[chainId];
  if (!ADAPTER_METHODS.has(method)) return fail('FORBIDDEN', 'unknown method');
  let tab;
  try {
    tab = await ensureTab(chain);
  } catch (e) {
    return fail(e.code || 'NETWORK', 'האתר לא נטען: ' + e.message);
  }
  const moduleUrl = chrome.runtime.getURL(`sites/${chain.id}.js`);
  const patterns = [GENERIC, ...(chain.forbidden || [])].map(sourceOf);
  // Always wait for the injected call to settle before returning (the queue must not move on while
  // it may still be mutating a cart).
  const run = chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injected,
    args: [moduleUrl, method, args || [], patterns],
  }).then((v) => ({ v }), (e) => ({ e }));
  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(() => resolve(null), CALL_CAP_MS); });
  const first = await Promise.race([run, cap]);
  clearTimeout(timer);
  if (first === null) {
    // Hard cap: close the worker tab (stops the injected call) and forget it.
    await chrome.tabs.remove(tab.id).catch(() => {});
    await rememberTab(chain.id, null);
    await Promise.race([run, new Promise((r) => setTimeout(r, SETTLE_MS))]);
    return fail('NETWORK', 'timeout');
  }
  if (first.e) return fail('NETWORK', String((first.e && first.e.message) || first.e));
  const res = first.v && first.v[0];
  return res && res.result ? res.result : fail('NETWORK', 'no result');
}

async function openForUser(chainId, which) {
  if (!Object.hasOwn(CHAINS, chainId)) return fail('FORBIDDEN', 'unknown chain');
  const chain = CHAINS[chainId];
  const url = which === 'cart' ? chain.cartUrl : which === 'login' ? chain.loginUrl : chain.homeUrl;
  if (isForbiddenUrl(url, registry)) return fail('FORBIDDEN', 'forbidden url');
  await chrome.tabs.create({ url, active: true });
  return { ok: true };
}

async function closeWorkers() {
  for (const id of Object.keys(CHAINS)) {
    const tabId = await workerTab(id);
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
    await rememberTab(id, null);
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages may drive the adapters.
  if (sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith(chrome.runtime.getURL(''))) {
    sendResponse(fail('FORBIDDEN', 'bad sender'));
    return false;
  }
  let p;
  if (msg && msg.t === 'call') p = inQueue(String(msg.chain), () => callAdapter(msg.chain, msg.method, msg.args));
  else if (msg && msg.t === 'open') p = openForUser(msg.chain, msg.which);
  else if (msg && msg.t === 'closeWorkers') p = closeWorkers();
  else p = Promise.resolve(fail('FORBIDDEN', 'unknown message'));
  p.then(sendResponse, (e) => sendResponse(fail('NETWORK', String(e))));
  return true;
});
