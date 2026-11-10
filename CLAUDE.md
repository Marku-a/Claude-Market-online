# Claude Market Online — project notes for Claude

Chrome MV3 extension **"סל חכם"** (`extension/`): takes a shopping list, fills a real cart on Hatzi Hinam, Rami Levy
and Shufersal (these three only) from the user's own logged-in browser, reads totals from the sites themselves,
applies delivery fees and personal discounts, recommends the cheapest, and links to each cart. It never pays.

Read before changing anything: `docs/SPEC.md` (design + security requirements S1–S7), `docs/SITES.md` (what is
known about each site's endpoints and how sure we are), `docs/SECURITY.md` (promises made to the user — keep
every sentence true).

## Current state (important)

- Built and tested **only against mock sites** (`tests/e2e/mocks/server.mjs`). All three real sites block cloud
  servers, so **no adapter has ever run against a real site**. Treat every endpoint in `docs/SITES.md` marked
  [P] or [?] as unverified, and even [V] ones as "seen in someone else's capture".
- Passing: `npm test` (182 unit tests), `npm run test:e2e` (11 Playwright tests, real extension in Chromium,
  site hostnames mapped to the local mock), `python3 -m unittest discover -s tests` (the older Claude-skill engine).
- The goal is not done until the extension has filled a real cart on each of the three real sites and the
  result page shows site totals and working cart links.

## Next task: calibrate against the real sites (must run on the user's computer)

Work one chain at a time: Shufersal (best documented) → Rami Levy → Hatzi Hinam (least documented).

1. Load `extension/` unpacked in the user's Chrome (`chrome://extensions` → Developer mode → Load unpacked).
   The user logs in to each site themselves. Never ask for, type, or read a password, OTP or card.
2. Open the extension → footer link **אבחון** → "הרץ אבחון". The report shows, per chain, each adapter step
   (checkLogin, search, getCart, getOrders, getDeliveryContext) with ok / error code / redacted response shape.
3. For every failing step, compare the redacted shape with what the adapter's parse function expects
   (`extension/sites/<chain>.js`), fix the adapter, **update the fixture and mock to the real shape**
   (`tests/adapters/fixtures/`, `tests/e2e/mocks/server.mjs`), add/adjust a test, re-run the diagnostics.
   If the shape isn't enough, look at the site's own network calls in DevTools (Network tab) for that action —
   read request URL/method/body shape only; do not copy cookies, tokens or personal data into files or chat.
4. Then run a real 2–3 item list end to end with policy "להשאיר ולהוסיף", and check on each site's own cart page
   that the items and quantities match and that the total on the result page equals the site's total.
5. Update `docs/SITES.md` confidence tags ([V] = verified by us, with date) and `docs/INSTALL.md` known limits.

Known unknowns to resolve (see `docs/SITES.md`):
- **Rami Levy**: where the `ecomtoken` value lives (adapter assumes it equals `authuser.user.token`); whether a
  cart written through `/api/v2/cart` shows up in the site's cart panel after reload; order-lines endpoint;
  whether catalog/cart live on `www` or `www-api`.
- **Shufersal**: `/cart/update` body format (form vs JSON); delivery-slot response shape; whether a delivery
  address must be selected before products show in stock.
- **Hatzi Hinam**: logged-in detection (`UserInfo`); whether `addItemToCart` sets or increments; endpoints for
  remove / set quantity / empty cart and for order history; the cart page URL.

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
```

## Layout

`extension/app` UI + orchestrator · `extension/engine` choice/compare logic · `extension/sites` adapters, guard,
registry, http · `extension/diag` diagnostics + redaction · `extension/background.js` worker tabs and RPC ·
`.claude/skills/hatzi-hinam-shopper` the earlier single-chain Claude skill.
