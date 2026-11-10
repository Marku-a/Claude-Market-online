#!/usr/bin/env node
// Real-site helper: launches Playwright's Chromium (visible) with a persistent profile OUTSIDE the
// repo and the extension loaded — no DNS mapping, no mock server. For calibration on the user's own
// computer; the three sites block cloud servers.
//
//   node tools/real-run.mjs            open the three sites + the extension, keep the window open
//   node tools/real-run.mjs diag       run the extension's diagnostics and print the (redacted) report
//
// Env: SAL_PROFILE  profile directory (default ~/.sal-hacham-profile)
//      SAL_HEADLESS=1  headless (smoke tests only; real sites need the visible window)
//
// This script never types into a site, never reads cookies/storage, and only opens the chains'
// home pages. Login is done by the user in the window.
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS } from '../extension/sites/registry.js';

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.error('Playwright is missing. Install it from npm:  npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const PROFILE = process.env.SAL_PROFILE || path.join(os.homedir(), '.sal-hacham-profile');
const mode = process.argv[2] || 'open';
if (!['open', 'diag'].includes(mode)) {
  console.error('usage: node tools/real-run.mjs [open|diag]');
  process.exit(2);
}
if (path.resolve(PROFILE).startsWith(path.resolve(EXT, '..') + path.sep)) {
  console.error('The profile directory must be outside the repository.');
  process.exit(2);
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium',
  headless: process.env.SAL_HEADLESS === '1',
  locale: 'he-IL',
  viewport: null,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const extId = sw.url().split('/')[2];
console.log(`extension id: ${extId}`);
console.log(`profile:      ${PROFILE}`);

if (mode === 'open') {
  for (const c of Object.values(CHAINS)) {
    const p = await ctx.newPage();
    p.goto(c.homeUrl, { waitUntil: 'domcontentloaded' }).catch((e) => console.error(`${c.name}: ${e.message.split('\n')[0]}`));
  }
  const app = await ctx.newPage();
  await app.goto(`chrome-extension://${extId}/app/index.html`);
  console.log('Log in to each site in the window and make sure a delivery address is set. Close the window to finish.');
  await new Promise((r) => ctx.on('close', r));
} else {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/diag/index.html`);
  await page.click('#btn-diag');
  await page.waitForFunction(() => document.getElementById('report').textContent.trim().length > 0, null, { timeout: 180000 });
  console.log(await page.textContent('#report'));
  await ctx.close();
}
