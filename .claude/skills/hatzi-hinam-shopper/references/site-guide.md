# Hatzi Hinam site guide (shop.hazi-hinam.co.il)

> Status: written before the site could be mapped (the site's Cloudflare check blocks server-side access).
> The first real run should **verify and update this file** with the actual menu names, URLs and selectors.
> Treat everything below as "where to look first", not as fact.

## Access
- Site: `https://shop.hazi-hinam.co.il/` (Hebrew, RTL).
- A Cloudflare "רק רגע..." / "ביצוע אימות אבטחה" page may appear. Do **not** try to bypass it: let the user's
  browser pass it, or ask the user to click the checkbox.
- Login: the user does it. Typical entry: a "התחברות" / person icon at the top. Wait until their name appears.

## Order history
- Look in the personal area (user icon → "ההזמנות שלי" / "היסטוריית הזמנות" / "הזמנות קודמות").
- Each past order usually lists products with quantity and price; some sites offer "הוסף את כל ההזמנה לסל" — do
  **not** use it (it bypasses the user's list).
- Prefer structured data: modern shop front-ends load orders as JSON. If the browser tool can read network
  responses or run JavaScript in the page, read the JSON the page itself already fetched instead of scraping text.
  Never replay requests with your own credentials or tokens outside the page.

## Search
- Search box at the top ("חיפוש מוצרים"). Results show name, price, unit price (₪ ל-100 גרם / לליטר / לק"ג),
  promo badges ("מבצע", "2 ב-₪12", "השני ב-50%") and "אזל מהמלאי".
- Promo conversion for `candidates.json`:
  - "2 ב-12₪" → `min_qty: 2, total_price: 12`
  - "השני ב-50%" on ₪10 → `min_qty: 2, total_price: 15`
  - "3 ב-20" → `min_qty: 3, total_price: 20`
  - Club-only promos (מועדון) → include, and put "מועדון" in `description`.
  - Promos with a minimum basket ("בקנייה מעל 200₪") → description only, `min_qty: 1, total_price: price`
    (the engine ignores it) and mention it in the report yourself.

## Cart
- Add with "הוסף לסל" / "+"; quantity stepper on the product card or in the cart.
- Weighed products (פירות וירקות, בשר): quantity may be in kg or units — check the unit toggle.
- After filling, open the cart page and compare against `plan.json`.
- Stop there. Payment, delivery slot and checkout are the user's.

## To fill in after the first real run
- [ ] Exact URL / menu path to order history
- [ ] Whether product ids (barcodes) are visible and where
- [ ] Search URL pattern (e.g. `/search?q=...`) to skip typing
- [ ] Cart URL
