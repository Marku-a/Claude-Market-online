// E2E harness: loads the REAL extension in Chromium and maps the three real site hostnames to a
// local mock server (HTTPS, self-signed). Every other hostname fails to resolve, so any request to
// an unexpected origin is both impossible and visible in `outside`.
import { createRequire } from 'node:module';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMockSites, createState, HOSTS, RL_TOKEN } from './mocks/server.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension');
const ALLOWED_HOSTS = new Set(Object.values(HOSTS));

export { createState, RL_TOKEN };

export async function launch({ state = createState() } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sal-e2e-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${tmp}/k.pem`,
    '-out', `${tmp}/c.pem`, '-days', '2', '-subj', '/CN=mock'], { stdio: 'ignore' });
  const handle = createMockSites(state);
  const server = https.createServer({ key: fs.readFileSync(`${tmp}/k.pem`), cert: fs.readFileSync(`${tmp}/c.pem`) }, handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const rules = [...ALLOWED_HOSTS].map((h) => `MAP ${h}:443 127.0.0.1:${port}`).concat(['MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1']).join(', ');
  const ctx = await chromium.launchPersistentContext(`${tmp}/profile`, {
    channel: 'chromium', headless: true, locale: 'he-IL',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-proxy-server',
      '--ignore-certificate-errors', `--host-resolver-rules=${rules}`],
  });
  // Rami Levy keeps its login state in localStorage; mirror the mock's state there like the real site does.
  await ctx.addInitScript(({ user }) => {
    if (location.hostname === 'www.rami-levy.co.il') {
      localStorage.setItem('ramilevy', JSON.stringify({ authuser: { user } }));
    }
  }, { user: state.ramilevy.loggedIn ? state.ramilevy.user : null });

  const outside = []; // requests to hosts that are not one of the three chains
  const pageUrls = []; // every document the browser navigated to
  ctx.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && !ALLOWED_HOSTS.has(u.hostname)) outside.push(r.url());
    if (r.isNavigationRequest()) pageUrls.push(r.url());
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = sw.url().split('/')[2];
  const app = await ctx.newPage();
  const consoleErrors = [];
  app.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  app.on('pageerror', (e) => consoleErrors.push(String(e)));
  await app.goto(`chrome-extension://${extId}/app/index.html`);
  return {
    ctx, app, sw, extId, state, outside, pageUrls, consoleErrors,
    async storage() { return sw.evaluate(() => chrome.storage.local.get(null)); },
    async close() { await ctx.close(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}

export const tid = (page, id) => page.locator(`[data-testid="${id}"]`);
export const money = (s) => Number(String(s).replace(/[^\d.]/g, ''));
