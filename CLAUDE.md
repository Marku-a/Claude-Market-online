# Claude Market Online — project notes for Claude

Chrome MV3 extension **"סל חכם"** (`extension/`): takes a shopping list, fills a real cart on Hatzi Hinam, Rami Levy
and Shufersal (these three only) from the user's own logged-in browser, reads totals from the sites themselves,
applies delivery fees and personal discounts, recommends the cheapest, and links to each cart. It never pays.

Read before changing anything: `docs/SPEC.md` (design + security requirements S1–S7), `docs/SITES.md` (what is
known about each site's endpoints and how sure we are), `docs/SECURITY.md` (promises made to the user — keep
every sentence true).

## Current state (important)

- **Calibrated against the three live sites on 2026-11-20/21** (user's Windows machine, logged-in account). All 15
  diagnostics steps pass. A 2-item and a 3-item list ran through the extension UI with policy "keep": each site's own
  cart showed exactly the written items, and the result page totals equal the sites' totals. Details and every
  verified endpoint: `docs/SITES.md` ([V 2026-11-20] tags).
- Passing: `npm test` (193), `npm run test:e2e` (11), mocks and fixtures follow the real response shapes.
- Not yet verified: the extension in the user's regular Chrome (only Playwright's Chromium so far); Hatzi Hinam
  `emptyCart` (DELETE taken from the site's JS, never executed live); Shufersal without a delivery address.
- Known product-matching weakness (engine, not adapters): with no barcode match, `chooseForLine` can pick an
  unrelated product by name (Rami Levy "אטריות ביצים" for "ביצים L 12"); it is badged "שונה" but still counted and can
  win "cheapest". Next engine task.

## Working with the live sites (on the user's computer)

- `SAL_CDP_PORT=9333 node tools/real-run.mjs` opens the window; `... diag` attaches to it; `... reload` reloads the
  extension from disk **without restarting the browser** (a restart logs Shufersal out — session cookie).
- On this Windows machine Playwright's Chromium only starts from outside `AppData\Local`: use
  `PLAYWRIGHT_BROWSERS_PATH=~/.sal-pw-browsers`.
- Never pick a delivery slot (Rami Levy opens a slot modal after the first UI add — close it), never open checkout.
- Before emptying a cart that holds the user's own items, ask.

## Rules that must never be broken

- No code path may navigate to, fetch, or inject into checkout / payment / login-credential URLs. All site
  requests go through `sites/guard.js` + `sites/http.js` (`redirect: 'manual'`). Don't bypass them.
- `manifest.json`: permissions stay `storage, tabs, scripting`; host permissions stay the three site origins;
  CSP keeps `connect-src 'none'`. `tests/engine/manifest.test.mjs` enforces this — don't weaken the test.
- Site tokens are used only inside the site tab as request headers; never returned, stored, logged or put in
  the diagnostics report.
- No third-party runtime code, no build step, no server.
- Exactly three chains. Don't add others.

## Commands

```bash
npm test                 # engine + adapters + orchestrator
npm run test:e2e         # real extension in Chromium vs mock sites (needs Playwright + Chromium)
python3 -m unittest discover -s tests
node tools/real-run.mjs        # real sites: visible Chromium + extension, profile in ~/.sal-hacham-profile (user's computer only)
node tools/real-run.mjs diag   # run the diagnostics page and print the redacted report
```

## Layout

`extension/app` UI + orchestrator · `extension/engine` choice/compare logic · `extension/sites` adapters, guard,
registry, http · `extension/diag` diagnostics + redaction · `extension/background.js` worker tabs and RPC ·
`.claude/skills/hatzi-hinam-shopper` the earlier single-chain Claude skill.
