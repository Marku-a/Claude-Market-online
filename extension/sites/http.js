// Shared HTTP helper for the site adapters. Every request goes through guard.makeSafeFetch.
// Runs inside the site tab; never reads cookies. Pure ES module (no DOM at import time).
import { makeSafeFetch, assertSafe } from './guard.js';
import { CHAINS } from './registry.js';
import { redactShape } from '../diag/redact.js';

export class AdapterError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'AdapterError';
    this.code = code; // NOT_LOGGED_IN|BLOCKED|SHAPE_CHANGED|NETWORK|FORBIDDEN|UNSUPPORTED
  }
}

const CF_RE = /just a moment|cf-chl|cf-browser-verification|attention required|enable javascript and cookies|challenge-platform/i;
export const looksBlocked = (text) => CF_RE.test(String(text || '').slice(0, 20000));

// need(obj, 'data.results', 'array') -> value, or throws SHAPE_CHANGED naming the path.
// type: 'array' | 'object' | 'string' | 'number' | 'boolean' | undefined (any non-null)
export function need(obj, path, type) {
  let cur = obj;
  for (const k of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) {
      throw new AdapterError('SHAPE_CHANGED', `missing field: ${path}`);
    }
    cur = cur[k];
  }
  let ok = cur !== null && cur !== undefined;
  if (ok && type === 'array') ok = Array.isArray(cur);
  else if (ok && type === 'object') ok = typeof cur === 'object' && !Array.isArray(cur);
  else if (ok && type === 'number') ok = typeof cur === 'number' && Number.isFinite(cur);
  else if (ok && type) ok = typeof cur === type; // eslint-disable-line valid-typeof
  if (!ok) throw new AdapterError('SHAPE_CHANGED', `unexpected type at: ${path}${type ? ` (expected ${type})` : ''}`);
  return cur;
}

// Product/entry ids are interpolated into URLs: validate, then encode.
export function checkId(id, re, what = 'id') {
  const s = String(id);
  if (!re.test(s)) throw new AdapterError('FORBIDDEN', `invalid ${what}`);
  return s;
}

export function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

// Registry used by the guard: the shared one plus this chain's own metadata (its forbidden patterns).
export function registryFor(chain) {
  return { ...CHAINS, [chain.id]: { ...(CHAINS[chain.id] || {}), ...chain } };
}

// Called at the start of every adapter method (only when a page location exists).
export function assertPageSafe(chain, env) {
  const href = env && ((env.document && env.document.location && env.document.location.href) ||
    (env.location && env.location.href));
  if (href) assertSafe(href, registryFor(chain));
}

// Structure-only summary of an HTML response for diagnostics (no text content).
export function htmlShape(text) {
  const s = String(text);
  const count = (re) => (s.match(re) || []).length;
  return {
    html: `<string:${s.length}>`,
    selectorsFound: {
      'article[data-product-code]': count(/<article\b[^>]*\bdata-product-code=/gi),
      '.miglog-prod-name': count(/class="[^"]*\bmiglog-prod-name\b/gi),
      '.miglog-prod-totalPrize': count(/class="[^"]*\bmiglog-prod-totalPrize\b/gi),
      '.miglog-cart-summary-totalprice': count(/class="[^"]*\bmiglog-cart-summary-totalprice\b/gi),
      'meta[name=_csrf]': count(/<meta\b[^>]*name=["']_csrf["']/gi),
    },
  };
}

export function createHttp(chain, fetchImpl = (...a) => globalThis.fetch(...a)) {
  const safeFetch = makeSafeFetch(chain.origin, registryFor(chain), fetchImpl, chain.apiOrigins || []);
  const state = { lastRaw: undefined };

  async function request(method, url, { headers, body } = {}) {
    let res;
    let text;
    try {
      res = await safeFetch(url, { method, headers, body, credentials: 'include', redirect: 'follow' });
      text = await res.text();
    } catch (e) {
      if (e && (e.code === 'FORBIDDEN' || e instanceof AdapterError)) throw e;
      throw new AdapterError('NETWORK', `request failed: ${e && e.message ? e.message : e}`);
    }
    const status = res.status;
    if (status === 401 || status === 403) {
      if (looksBlocked(text)) throw new AdapterError('BLOCKED', `blocked by the site (HTTP ${status})`);
      throw new AdapterError('NOT_LOGGED_IN', `not logged in (HTTP ${status})`);
    }
    if (!(status >= 200 && status < 300)) throw new AdapterError('NETWORK', `HTTP ${status}`);
    return { status, text, url: res.url || url };
  }

  function parseJson(text) {
    try {
      const j = JSON.parse(text);
      state.lastRaw = j;
      return j;
    } catch {
      state.lastRaw = text;
      if (looksBlocked(text)) throw new AdapterError('BLOCKED', 'blocked by the site (challenge page)');
      throw new AdapterError('SHAPE_CHANGED', 'response is not JSON');
    }
  }

  const textResult = (r) => {
    state.lastRaw = r.text;
    return r.text;
  };
  const jsonHeaders = (h) => ({ accept: 'application/json, text/plain, */*', ...h });

  return {
    get lastRaw() { return state.lastRaw; },
    resetRaw() { state.lastRaw = undefined; },
    async getJson(url, { headers } = {}) {
      return parseJson((await request('GET', url, { headers: jsonHeaders(headers) })).text);
    },
    async postJson(url, body, { headers } = {}) {
      return parseJson((await request('POST', url, {
        headers: jsonHeaders({ 'content-type': 'application/json;charset=UTF-8', ...headers }),
        body: JSON.stringify(body),
      })).text);
    },
    async getText(url, { headers } = {}) {
      return textResult(await request('GET', url, { headers }));
    },
    // fields: object -> application/x-www-form-urlencoded
    async postForm(url, fields, { headers } = {}) {
      return textResult(await request('POST', url, {
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', ...headers },
        body: new URLSearchParams(fields).toString(),
      }));
    },
    // JSON request body, text (HTML) response
    async postJsonText(url, body, { headers } = {}) {
      return textResult(await request('POST', url, {
        headers: { 'content-type': 'application/json;charset=UTF-8', ...headers },
        body: JSON.stringify(body),
      }));
    },
  };
}

// Diagnostics: runs each [name, fn] step, returns [{step, ok, code?, message?, shape}] where shape is the
// redacted structure of the LAST raw response of that step (no values).
export async function runDiagnose(http, steps) {
  const out = [];
  for (const [step, fn] of steps) {
    http.resetRaw();
    const row = { step, ok: true };
    try {
      await fn();
    } catch (e) {
      row.ok = false;
      row.code = (e && e.code) || 'NETWORK';
      row.message = String((e && e.message) || e).slice(0, 200);
    }
    const raw = http.lastRaw;
    row.shape = raw === undefined ? null : typeof raw === 'string' ? htmlShape(raw) : redactShape(raw);
    out.push(row);
  }
  return out;
}

// Lazy globals: nothing is touched at import time (Node has no document/localStorage).
export const lazyEnv = () => ({
  fetch: (...a) => globalThis.fetch(...a),
  get localStorage() { return globalThis.localStorage; },
  get document() { return globalThis.document; },
  get DOMParser() { return globalThis.DOMParser; },
  now: () => new Date(),
});
