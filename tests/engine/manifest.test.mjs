import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = fileURLToPath(new URL('../../extension/', import.meta.url));
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const ORIGINS = ['https://shop.hazi-hinam.co.il/*', 'https://www.rami-levy.co.il/*', 'https://www.shufersal.co.il/*'];

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(EXT).filter((p) => /\.(js|html|css|json)$/.test(p));
const rel = (p) => relative(EXT, p);

test('manifest: exact permissions and host permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['scripting', 'storage', 'tabs']);
  assert.deepEqual([...manifest.host_permissions].sort(), ORIGINS);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
});

test('manifest: CSP', () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.equal(csp, "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
  assert.ok(csp.includes("connect-src 'none'"));
  assert.ok(csp.includes("script-src 'self'"));
  assert.ok(csp.includes("img-src 'self' data:"));
  assert.ok(!/https?:|\*|unsafe/.test(csp));
});

test('manifest: no static content scripts, no externally_connectable, narrow web_accessible_resources', () => {
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  const war = manifest.web_accessible_resources;
  assert.ok(Array.isArray(war) && war.length >= 1);
  for (const entry of war) {
    assert.deepEqual([...entry.matches].sort(), ORIGINS);
    assert.equal(entry.use_dynamic_url, undefined);
    for (const r of entry.resources) assert.ok(/^(sites\/(\*|[\w-]+)\.js|engine\/text\.js|diag\/redact\.js)$/.test(r), r);
  }
  const all = war.flatMap((e) => e.resources);
  for (const need of ['sites/*.js', 'engine/text.js', 'diag/redact.js']) assert.ok(all.includes(need), need);
});

test('static: no dangerous APIs anywhere in extension/', () => {
  const banned = ['document.cookie', 'innerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'autocomplete', 'chrome.storage.sync', 'XMLHttpRequest'];
  for (const f of files) {
    // the site's own required request header value is the only legitimate mention
    const src = readFileSync(f, 'utf8').replaceAll("'X-Requested-With': 'XMLHttpRequest'", '');
    for (const b of banned) assert.ok(!src.includes(b), `${rel(f)} contains ${b}`);
  }
});

test('static: UI pages and the service worker never call fetch(', () => {
  for (const f of files) {
    const r = rel(f);
    if (r.startsWith('app/') || r.startsWith('diag/') || r === 'background.js') {
      assert.ok(!readFileSync(f, 'utf8').includes('fetch('), `${r} contains fetch(`);
    }
  }
});

test('static: adapters only query the CSRF meta tag and cart/summary markup (never inputs)', () => {
  const allowed = new Set([
    'meta[name="_csrf"]', 'article[data-product-code]', '.miglog-prod-name', '.miglog-prod-totalPrize',
    '.miglog-cart-summary-totalprice',
  ]);
  let seen = 0;
  for (const f of files.filter((p) => rel(p).startsWith('sites/'))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/querySelector(?:All)?\(\s*(['"`])(.*?)\1/g)) {
      seen++;
      assert.ok(allowed.has(m[2]), `${rel(f)} queries ${m[2]}`);
    }
    assert.ok(!/querySelector(?:All)?\(\s*[^'"`\s]/.test(src), `${rel(f)} has a non-literal selector`);
    assert.ok(!/\b(input|textarea|select)\b[^\n]*\.value/.test(src), `${rel(f)} reads form values`);
  }
  assert.ok(seen >= 5);
});
