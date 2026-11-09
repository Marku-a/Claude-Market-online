# Data formats

All files UTF-8 JSON / text, kept in `~/.hatzi-hinam-shopper/`.

## history.json
```json
{"orders":[{"id":"1001","date":"2026-08-03","items":[
  {"product_id":"7290000042435","name":"חלב תנובה 3% 1 ליטר","brand":"תנובה","category":"מוצרי חלב","qty":2,"price":6.9}
]}]}
```
- `price` = unit price actually paid. `product_id` (barcode) optional — if missing, the normalized name is the key,
  so keep names exactly as the site shows them.
- `date` ISO `YYYY-MM-DD`. Keep orders appended; never rewrite old ones.

## list.txt
One item per line, free text. `#` comments and blank lines ignored.
Quantity: leading number (`2 חלב`) or `x2` / `×2` / `*2` at the end. `3%` is never a quantity.

## candidates.json
```json
{"searches":[{"line":"2 חלב 3%","results":[
  {"product_id":"7290000042435","name":"חלב תנובה 3% 1 ליטר","brand":"תנובה","category":"מוצרי חלב",
   "price":7.4,"unit_price":7.4,"unit_label":"לליטר","in_stock":true,
   "promo":{"description":"2 ב-12","min_qty":2,"total_price":12.0}}]}],
 "watch":[{"product_id":"7290000000001","name":"קפה עלית","price":29.9,"in_stock":true}]}
```
- `line` must equal the list line exactly.
- Optional: `brand`, `category`, `unit_price`, `unit_label`, `promo`; `in_stock` defaults to true.
- `watch`: current prices of the user's staples that are not on the list.

## plan.json (output)
`items`, `missing`, `deal_suggestions`, `swap_suggestions`, `price_changes`, `maybe_forgot`, `goes_with`,
`estimated_total`, `cart_actions` (`[{product_id, name, qty}]` — what to add to the cart).
