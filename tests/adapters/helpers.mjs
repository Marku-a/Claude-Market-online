// Test helpers: mock-site server on 127.0.0.1, a fetch that rewrites https://<site-host>/... to it,
// a tiny HTML/DOM stand-in for DOMParser (no deps), and env builders.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMockSites, createState } from '../e2e/mocks/server.mjs';

export const fixture = (name) => {
  const raw = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
  return name.endsWith('.json') ? JSON.parse(raw) : raw;
};

export async function startMock(state = createState()) {
  const handle = createMockSites(state);
  const server = http.createServer((req, res) => { handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  // Called by safeFetch with the ORIGINAL https URL; we rewrite it to the local server and keep Host.
  const fetchImpl = (url, init = {}) => new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { ...(init.headers || {}), host: u.host };
    const body = init.body === undefined ? undefined : String(init.body);
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const req = http.request({
      host: '127.0.0.1', port, method: init.method || 'GET', path: u.pathname + u.search, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, url, // original URL
          headers: { get: (k) => res.headers[String(k).toLowerCase()] ?? null },
          text: async () => text,
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  return { state, handle, fetchImpl, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

// ---- minimal DOM ----
const VOID = new Set(['meta', 'br', 'img', 'input', 'link', 'hr']);
class El {
  constructor(tag, attrs = {}, parent = null) {
    this.tag = tag; this.attrs = attrs; this.parent = parent; this.children = [];
  }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  get textContent() { return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); }
  querySelectorAll(sel) {
    const parts = sel.trim().split(/\s+/).map(parseCompound);
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (typeof c === 'string') continue;
        if (matchChain(c, parts, this)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function parseCompound(s) {
  const c = { tag: null, classes: [], id: null, attrs: [] };
  const re = /^([\w-]+)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:=["']?([^\]"']*)["']?)?\]/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    if (m[1]) c.tag = m[1]; else if (m[2]) c.classes.push(m[2]); else if (m[3]) c.id = m[3];
    else c.attrs.push([m[4], m[5]]);
  }
  return c;
}
function matchOne(el, c) {
  if (c.tag && el.tag !== c.tag) return false;
  if (c.id && el.attrs.id !== c.id) return false;
  const cls = (el.attrs.class || '').split(/\s+/);
  if (!c.classes.every((x) => cls.includes(x))) return false;
  return c.attrs.every(([k, v]) => (k in el.attrs) && (v === undefined || el.attrs[k] === v));
}
function matchChain(el, parts, scope) {
  if (!matchOne(el, parts[parts.length - 1])) return false;
  let cur = el.parent;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (cur && cur !== scope.parent && !matchOne(cur, parts[i])) cur = cur.parent;
    if (!cur || cur === scope.parent) return false;
    cur = cur.parent;
  }
  return true;
}
export function parseHtml(html) {
  const root = new El('#root');
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      let p = cur;
      while (p && p.tag !== m[1].toLowerCase()) p = p.parent;
      if (p && p.parent) cur = p.parent;
    } else if (m[2]) {
      const attrs = {};
      for (const a of m[3].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
      }
      const el = new El(m[2].toLowerCase(), attrs, cur);
      cur.children.push(el);
      if (!VOID.has(el.tag)) cur = el;
    } else if (m[4] !== undefined) cur.children.push(m[4]);
  }
  return root;
}
export class FakeDOMParser {
  parseFromString(html) { return parseHtml(html); }
}

export function fakeStorage(map = {}) {
  return { getItem: (k) => (k in map ? map[k] : null), setItem: (k, v) => { map[k] = String(v); } };
}

export function makeEnv(mock, extra = {}) {
  return {
    fetch: mock.fetchImpl,
    localStorage: fakeStorage(),
    document: undefined,
    DOMParser: FakeDOMParser,
    now: () => new Date('2026-11-09T10:00:00Z'),
    ...extra,
  };
}

export const ramyStorage = (state) => fakeStorage({
  ramilevy: JSON.stringify({ authuser: { user: state.ramilevy.user, guestToken: null } }),
});

// Collect helper: every string value in a structure must not contain `needle`.
export const leaks = (value, needle) => JSON.stringify(value).includes(needle);
