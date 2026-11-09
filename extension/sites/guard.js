// Payment-page guard (SPEC S4). Pure: no chrome.*, no DOM.

const GENERIC = /(checkout|payment|pay\b|credit|billing|tashlum|order-confirm|secure)/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function chainList(registry) {
  return Object.values(registry || {}).filter((c) => c && typeof c === 'object' && typeof c.origin === 'string');
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function forbiddenError(url) {
  const e = new Error(`FORBIDDEN: ${url}`);
  e.code = 'FORBIDDEN';
  return e;
}

// True for unparsable URLs, origins outside the registry, non-https (except opted-in localhost),
// and any path/query/hash matching the generic or per-chain forbidden patterns.
export function isForbiddenUrl(url, registry) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return true;
  }
  const chains = chainList(registry);
  const local = registry && registry.allowLocalhost === true &&
    u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  if (!local) {
    if (u.protocol !== 'https:') return true;
    if (!chains.some((c) => c.origin === u.origin || (c.apiOrigins || []).includes(u.origin))) return true;
  }
  const target = u.pathname + u.search + u.hash;
  const variants = [target, safeDecode(target)];
  if (variants.some((t) => GENERIC.test(t))) return true;
  for (const c of chains) {
    for (const re of c.forbidden || []) {
      if (variants.some((t) => new RegExp(re.source, re.flags.replace(/[gy]/g, '')).test(t))) return true;
    }
  }
  return false;
}

export function assertSafe(url, registry) {
  if (isForbiddenUrl(url, registry)) throw forbiddenError(url);
}

// Returns fetch(url, init) restricted to `origin`: rejects cross-origin and forbidden URLs
// (also checks the final response URL after redirects when available).
// `extraOrigins`: the chain's own API hosts (e.g. www-api.rami-levy.co.il), also https-only and guarded.
export function makeSafeFetch(origin, registry, fetchImpl, extraOrigins = []) {
  const allowed = new Set([new URL(origin).origin, ...extraOrigins.map((o) => new URL(o).origin)]);
  return async function safeFetch(url, init) {
    let u;
    try {
      u = new URL(String(url), origin);
    } catch {
      throw forbiddenError(url);
    }
    if (!allowed.has(u.origin)) throw forbiddenError(u.href);
    assertSafe(u.href, registry);
    const res = await fetchImpl(u.href, init);
    if (res && res.url) {
      const f = new URL(res.url, origin);
      if (!allowed.has(f.origin)) throw forbiddenError(f.href);
      assertSafe(f.href, registry);
    }
    return res;
  };
}
