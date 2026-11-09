// Service worker: owns the "worker tabs" (one per chain) and runs adapter methods inside them.
// It never makes network requests itself (CSP connect-src 'none'); all site traffic happens
// same-origin inside a tab of that site.
import { CHAINS, chainForUrl } from './sites/registry.js';
import { isForbiddenUrl } from './sites/guard.js';

const LOAD_TIMEOUT_MS = 45000;
const CALL_TIMEOUT_MS = 60000;
const ADAPTER_METHODS = new Set([
  'checkLogin', 'getDeliveryContext', 'getOrders', 'search', 'getCart', 'setItem', 'emptyCart', 'diagnose',
]);
const registry = { chains: CHAINS };

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

async function workerTabs() {
  const { workerTabs = {} } = await chrome.storage.session.get('workerTabs');
  return workerTabs;
}

async function rememberTab(chainId, tabId) {
  const tabs = await workerTabs();
  if (tabId == null) delete tabs[chainId];
  else tabs[chainId] = tabId;
  await chrome.storage.session.set({ workerTabs: tabs });
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, LOAD_TIMEOUT_MS);
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') { cleanup(); resolve(); } };
    const onRemoved = (id) => { if (id === tabId) { cleanup(); reject(new Error('closed')); } };
    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') { cleanup(); resolve(); } }, () => {});
  });
}

// A tab is usable only if it sits on the chain's own origin and not on a payment/checkout page.
function tabIsSafe(tab, chain) {
  if (!tab || !tab.url) return false;
  const c = chainForUrl(tab.url);
  return !!c && c.id === chain.id && !isForbiddenUrl(tab.url, registry);
}

async function ensureTab(chain) {
  const tabs = await workerTabs();
  let tab = null;
  if (tabs[chain.id] != null) tab = await chrome.tabs.get(tabs[chain.id]).catch(() => null);
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
async function injected(moduleUrl, method, args) {
  try {
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

async function callAdapter(chainId, method, args) {
  const chain = CHAINS[chainId];
  if (!chain) return fail('FORBIDDEN', 'unknown chain');
  if (!ADAPTER_METHODS.has(method)) return fail('FORBIDDEN', 'unknown method');
  let tab;
  try {
    tab = await ensureTab(chain);
  } catch (e) {
    return fail(e.code || 'NETWORK', 'האתר לא נטען: ' + e.message);
  }
  const moduleUrl = chrome.runtime.getURL(`sites/${chain.id}.js`);
  const run = chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: injected,
    args: [moduleUrl, method, args || []],
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CALL_TIMEOUT_MS));
  try {
    const [res] = await Promise.race([run, timeout]);
    return res && res.result ? res.result : fail('NETWORK', 'no result');
  } catch (e) {
    return fail('NETWORK', String(e.message || e));
  }
}

async function openForUser(chainId, which) {
  const chain = CHAINS[chainId];
  if (!chain) return fail('FORBIDDEN', 'unknown chain');
  const url = which === 'cart' ? chain.cartUrl : which === 'login' ? chain.loginUrl : chain.homeUrl;
  if (isForbiddenUrl(url, registry)) return fail('FORBIDDEN', 'forbidden url');
  await chrome.tabs.create({ url, active: true });
  return { ok: true };
}

async function closeWorkers() {
  const tabs = await workerTabs();
  await Promise.all(Object.values(tabs).map((id) => chrome.tabs.remove(id).catch(() => {})));
  await chrome.storage.session.set({ workerTabs: {} });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only our own extension pages may drive the adapters.
  if (sender.id !== chrome.runtime.id || !sender.url || !sender.url.startsWith(chrome.runtime.getURL(''))) {
    sendResponse(fail('FORBIDDEN', 'bad sender'));
    return false;
  }
  let p;
  if (msg && msg.t === 'call') p = callAdapter(msg.chain, msg.method, msg.args);
  else if (msg && msg.t === 'open') p = openForUser(msg.chain, msg.which);
  else if (msg && msg.t === 'closeWorkers') p = closeWorkers();
  else p = Promise.resolve(fail('FORBIDDEN', 'unknown message'));
  p.then(sendResponse, (e) => sendResponse(fail('NETWORK', String(e))));
  return true;
});
