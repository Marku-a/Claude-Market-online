# סל חכם — SPEC (Chrome extension, MV3)

Compare one shopping list across **Hatzi Hinam, Rami Levy, Shufersal** (exactly these three) by building a
*real cart on each site* in the user's own logged-in browser, then recommend the cheapest and link to each cart.
Never touches payment. No server. No passwords.

## 1. Layout

```
extension/
  manifest.json
  background.js            service worker: tab management + adapter RPC
  app/index.html|app.js|app.css   full-tab UI (Hebrew, RTL)
  engine/text.js           normalize, similarity, parseListLine
  engine/profile.js        buildProfile, coPurchases (merged history of all chains)
  engine/choose.js         chooseForLine (per chain), promo math
  engine/compare.js        cross-chain matching, totals, discounts, recommendation
  sites/registry.js        chain metadata (id, name, origin, cartUrl, forbidden URL patterns)
  sites/ramilevy.js  sites/shufersal.js  sites/hazihinam.js   adapters (run inside the site tab)
  sites/guard.js           payment-page guard shared by all adapters
  diag/…                   diagnostics page (section 8)
tests/engine/*.test.mjs    node --test (no deps)
tests/e2e/*.spec.mjs       Playwright: real extension + mocked sites
tests/e2e/mocks/           mock servers for the three chains
```
Plain ES modules, no build step, no third-party runtime code. Node ≥ 20 for tests only.

## 2. Security model (hard requirements — tests must cover each)

S1. `host_permissions`: only `https://www.rami-levy.co.il/*`, `https://www.shufersal.co.il/*`,
    `https://shop.hazi-hinam.co.il/*`. Permissions: `storage`, `tabs`, `scripting`. Nothing else.
S2. Extension pages CSP: `default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`.
    The UI and the service worker can make **no** network requests. All site traffic happens inside a tab of that
    site, same-origin.
S3. No static `content_scripts`. Code is injected only by `chrome.scripting.executeScript` into a tab the
    extension itself opened, after `guard.isForbiddenUrl(tab.url)` returned false.
S4. `guard.isForbiddenUrl(url)`: true for any URL whose path or hash (raw or decoded; not the query string) matches
    `/(checkout|payment|pay\b|credit|billing|tashlum|order-confirm|secure)/i` or the per-chain patterns in the
    registry, and for any origin not in the registry. Adapters call `guard.assertSafe(location.href)` before
    every action and never navigate to, fetch, or read forbidden URLs. `fetch` wrappers in adapters go through
    `guard.safeFetch(url, init)`, which rejects cross-origin and forbidden URLs.
S5. Adapters never read `input`/`form` values, never touch `autocomplete=cc-*` fields, never read
    `document.cookie`. Auth tokens the site itself keeps (e.g. in localStorage) may be read **only inside the
    site tab** to authorise same-origin requests and must never be returned to the extension, stored or logged.
S6. Stored data (`chrome.storage.local` only, never `sync`): profile (address text, discounts), order history,
    last runs. No credentials, no tokens, no card data. A "מחק את כל הנתונים" button clears everything.
S7. The extension never submits an order: no adapter method for it exists.

## 3. Data shapes

```js
Product   { chain, id, barcode|null, name, brand|null, category|null, price, unitPrice|null, unitLabel|null,
            inStock, promo|null /* {description, minQty, totalPrice, clubOnly} */, soldBy: 'unit'|'kg' }
Order     { chain, id, date /*YYYY-MM-DD*/, items: [{ id, barcode|null, name, brand|null, category|null, qty, price }] }
CartView  { lines: [{ id, name, qty, lineTotal }], itemsTotal, deliveryFee|null, grandTotal|null, minOrder|null }
Profile   { address: {city, street, number}, discounts: [Discount], deliveryOverrides: {chain: {fee, minOrder}} ,
            existingCartPolicy: 'ask'|'empty'|'keep' }
Discount  { chain, label, type: 'percent'|'fixed', value, minBasket|0, cap|null, enabled }
```
Product key for matching = barcode if present else `normalize(name)`.

## 4. Adapter interface (each `sites/<chain>.js` exports one object; every method runs inside the site tab)

```js
{ id, name, origin, homeUrl, cartUrl, loginUrl, forbidden: [RegExp],
  async checkLogin()            -> { loggedIn: boolean, userLabel?: string }   // label = first name only
  async getDeliveryContext()    -> { addressLabel|null, storeLabel|null, deliveryFee|null, minOrder|null }
  async getOrders(limit)        -> Order[]
  async search(query)           -> Product[]   (max 10)
  async getCart()               -> CartView
  async setItem(productId, qty, product) -> { ok, qty }     // absolute quantity; 0 removes
  async emptyCart()             -> { ok }
}
```
Rules: throw `AdapterError(code, message)` with codes `NOT_LOGGED_IN | BLOCKED | SHAPE_CHANGED | NETWORK | FORBIDDEN | UNSUPPORTED | REDIRECT` (redirects are never followed: `redirect: 'manual'`).
`SHAPE_CHANGED` when a response lacks expected fields — never guess. All parsing goes through small pure
functions (`parseSearchResponse(json)`, `parseCart(json)`, `parseOrders(json)`) exported for unit tests.

## 5. Flow (app.js state machine)

1. **פרופיל** (first run): address, discounts per chain (club / credit card), optional delivery fee + minimum
   override per chain, cart policy.
2. **חיבור**: per chain status chip (מחובר / לא מחובר / חסום). "פתח את האתר להתחברות" opens the chain's own
   login page in a normal tab; the user logs in there. Chains not logged in are skipped with a clear note
   (search prices still shown if the site allows anonymous search).
3. **רשימה**: textarea (one item per line) + "השתמש ברשימה האחרונה" + suggestions "אולי שכחת".
4. **הרצה** per chain, sequential per chain, chains in parallel:
   refresh history (incremental, by order id) → search each line (+ favourite's exact name) → choose →
   show **review** table → on confirm: handle existing cart per policy → `setItem` each → `getCart` → verify.
5. **תוצאה**: comparison table, recommendation, per-chain "עבור לעגלה" button (opens `cartUrl` in a new tab),
   missing items, deals, swaps, price changes. Nothing after the cart.

## 6. Engine

Port `.claude/skills/hatzi-hinam-shopper/scripts/planner.py` semantics to JS (same thresholds, same Hebrew
reason strings, same tests translated), then add:

**Merged profile**: history from all chains merged by product key. `orderCount` counts orders across chains.

**Cross-chain matching** (`compare.matchLine(line, resultsByChain, profile)`):
1. Reference product = the profile favourite among all chains' results (highest orderCount; needs ≥1), else none.
2. Per chain choice: if a result has the reference barcode → choose it (`match: 'identical'`). Otherwise
   `chooseForLine` (planner scoring) → `match: 'similar'` if similarity(name, reference.name) ≥ 0.5 or no
   reference exists, else `match: 'different'`. No in-stock result → `match: 'missing'`.
3. Quantity identical across chains for a line (parsed qty, else favourite's typical qty, else 1).

**Totals** (`compare.summarize(chainRuns, profile)`), per chain:
- `itemsTotal` = site cart `itemsTotal` when the cart was filled and verified (source `'site'`), else engine
  estimate (source `'estimate'`, flagged in UI).
- `deliveryFee` = site value, else profile override, else `null` (shown as "לא ידוע", excluded and flagged).
- personal discounts: enabled discounts for the chain whose `minBasket` ≤ itemsTotal; percent applies to
  itemsTotal (capped by `cap`); fixed subtracts `value`; discounts stack additively, never below 0.
- `final = itemsTotal − discounts + (deliveryFee ?? 0)`; `belowMinimum` if `minOrder` known and itemsTotal < minOrder.
- `missingCount`, `differentCount`.
- `comparableTotal` = sum of line totals over lines that are `identical|similar` in **every** participating chain
  (fair like-for-like figure).

**Recommendation**: among chains with a filled cart: fewest missing lines first is *not* automatic — rank by
`final`, but a chain missing ≥1 line gets its missing lines priced at the cheapest other chain's line total
(`adjustedFinal`) so an incomplete cheap cart doesn't win unfairly. Output `{ best, ranking:[{chain, final,
adjustedFinal, reasons:[he strings]}], perLineCheapest:[{line, chain, price}] }`.

## 7. UI requirements

Hebrew RTL, usable by a non-technical person: big primary button per step, progress per chain, plain-language
errors with one suggested action. Result page: three cards (chain, סה"כ מוצרים, משלוח, הנחות, **סה"כ לתשלום**,
חסרים), winner highlighted with the reason, line-by-line table (product chosen per chain, price, match badge:
זהה / דומה / שונה / חסר), buttons "עבור לעגלה בחצי חינם" etc. Persistent footer: "התוסף לא משלם ולא רואה פרטי אשראי".
Accessible: labelled inputs, keyboard navigable, visible focus, no colour-only signalling.

## 8. Diagnostics page (`diag/index.html`)

Because the real sites cannot be reached from CI, adapters are calibrated on the user's machine. The page runs,
per chain: checkLogin → search("חלב") → getCart → getOrders(1) → getDeliveryContext, and shows pass/fail, the
error code, and a **redacted shape** of each raw response (keys and value *types* only, arrays truncated to one
element, strings replaced by `"<string:len>"`). "העתק דוח" copies this JSON. No values, tokens, names,
addresses or prices leave the page.

## 9. Tests

- `node --test tests/engine/` — engine parity with the Python tests + compare/summarize/recommend cases,
  guard patterns, adapter parse functions against fixture JSON, redaction.
- `tests/e2e/` (Playwright, bundled Chromium, `--load-extension`): all three origins are served by local mocks
  via `context.route`. Cases: full happy path (3 carts filled, winner correct, cart links correct);
  one chain logged out; one chain returns a changed shape (→ SHAPE_CHANGED shown, others continue);
  existing cart with policy keep/empty; **security**: navigation to a `/checkout` URL is never injected into;
  no request leaves to any origin outside the three (assert on `context.on('request')`); storage contains no
  token-like values.
