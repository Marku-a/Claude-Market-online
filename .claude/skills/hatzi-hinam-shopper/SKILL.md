---
name: hatzi-hinam-shopper
description: Builds a ready-to-pay shopping cart on the Hatzi Hinam (חצי חינם) online supermarket from the user's shopping list, using their past orders to pick the products they like, and reports what's missing, worthwhile deals, cheaper swaps, price increases and items they may have forgotten. Use when the user asks to do their Hatzi Hinam / חצי חינם shopping, fill the cart, "תעשה לי קניות", "תכין לי עגלה", or gives a grocery list for an Israeli online supermarket. Never pays — stops at a full cart.
---

# Hatzi Hinam Shopper — מכין עגלה מוכנה לתשלום

The user gives a shopping list. You read their order history on shop.hazi-hinam.co.il,
choose the products they actually buy, fill the cart in **their own logged-in browser**,
and hand back a Hebrew report. The user pays by themselves.

## Hard rules (never break)

1. **Never pay.** Do not open checkout/payment, do not choose a delivery slot unless asked, do not
   click "לתשלום" / "סיום הזמנה" / "המשך לתשלום". Stop at a full cart.
2. **Never handle credentials.** The user logs in themselves in the browser. Do not type,
   store, or ask for a password, OTP or card details. If you see a login wall, ask the user to log in and wait.
3. **Never remove items the user already had in the cart** without asking. Report them instead.
4. **Ask before applying** a swap or a deal that changes brand or increases quantity. Default = keep the
   user's usual product at the quantity they asked for.
5. Personal data (order history) stays local in `~/.hatzi-hinam-shopper/` — never commit it or send it elsewhere.

## Why a real browser

The site is behind a Cloudflare bot check, so plain HTTP/scripts from a server are blocked.
This skill must run where the user's own browser is available:
- **Claude in Chrome** (tools `mcp__claude-in-chrome__*`) — read the `chrome-browser` skill first, or
- the **Claude desktop app's built-in browser** (`mcp__Claude_Browser__*`) — read the `built-in-browser` skill first.
If neither browser toolset is available, say so and offer the **manual mode** (bottom of this file).

## Workflow

Working dir for data: `~/.hatzi-hinam-shopper/` (create it). Files:
`history.json`, `list.txt`, `candidates.json`, `plan.json`, `report.md`.
Engine: `scripts/planner.py` (stdlib Python 3, no install). Formats: `references/data-formats.md`.
Site navigation tips: `references/site-guide.md` — read it before touching the site.

### 1. Get the list
Take the list from the user's message (or a file they point to). Write it to `list.txt`, one item per line,
exactly as written ("2 חלב 3%", "לחם אחיד", "ביצים L ×2"). Don't "fix" it.

### 2. Open the site and confirm login
Open `https://shop.hazi-hinam.co.il/`. If not logged in → ask the user to log in in that browser window, then continue.
Note anything already in the cart (name + qty) — it is reported, never deleted.

### 3. Refresh order history (incremental)
Load `history.json` if it exists. Go to the personal area → **ההזמנות שלי / היסטוריית הזמנות**.
For each order not yet in `history.json` (by order id), open it and record every line: product name, brand
(if shown), category (if shown), quantity, unit price paid, and the product id/barcode if visible in the
page/links/network data. Default: last 10 orders on first run. Save after every order (so a crash loses nothing).
Then run:
```bash
python3 <skill>/scripts/planner.py profile --history ~/.hatzi-hinam-shopper/history.json
```
to see favourites, typical quantities and purchase rhythm.

### 4. Search each list item
For every list line, search the site with the item's words (drop quantity words). If the profile has a clear
favourite for this item (high similarity to a product they buy), also search its exact name.
Record up to 8 results per line into `candidates.json`: id, name, brand, price, unit price + label
(e.g. ₪ ל-100 גרם), in-stock, and promo (`description`, `min_qty`, `total_price` — e.g. "2 ב-12₪" → 2, 12).
Also add a `watch` entry with the current price of each product the user bought in ≥3 orders that isn't on the
list (use the site search; cap ~15) — this powers "price went up" and "maybe you forgot".

### 5. Run the planner
```bash
python3 <skill>/scripts/planner.py plan \
  --history ~/.hatzi-hinam-shopper/history.json \
  --list ~/.hatzi-hinam-shopper/list.txt \
  --candidates ~/.hatzi-hinam-shopper/candidates.json \
  --out ~/.hatzi-hinam-shopper/plan.json --report ~/.hatzi-hinam-shopper/report.md
```
Read the report. Use your judgement on top of it: if the engine picked something odd (e.g. "חלב" matched
chocolate milk), override it and say why.

### 6. Show the plan, ask once
Present the report in Hebrew (cart table, missing, deals, swaps, price changes, maybe-forgot, goes-with).
Then ask **one** question listing all the decisions: which swaps/deals to apply and which "maybe forgot"
items to add. If the user says "go"/"תמשיך" with no changes, keep the defaults.

### 7. Fill the cart
Add each `cart_actions` item (after the user's decisions) with its quantity. After all adds, open the cart
and verify: every item is present with the right quantity, and the site's cart total is close to the plan's
estimated total. Fix mismatches (wrong product, qty). Products whose weight is sold per kg: set the weight the user
asked for, or their typical one.

### 8. Hand off
Final message (Hebrew): what's in the cart, total as the site shows it, what's missing and what you replaced,
deals applied, price increases, and: **"העגלה מוכנה — נשאר רק להיכנס לעגלה ולשלם."** Do not proceed to payment.

## Manual mode (no browser tools)
Ask the user to paste their recent orders (copy from "ההזמנות שלי" or the order confirmation emails) and, for
each list item, the search results they see. Build `history.json` / `candidates.json` from that, run the
planner, and return the report plus a clean list they can add to the cart themselves.
