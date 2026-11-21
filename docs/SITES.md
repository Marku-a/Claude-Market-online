# Site endpoints (front-end APIs) — what is known and how sure we are

Calibrated against the live sites on the user's computer on 2026-11-20 (logged-in account, real carts; nothing
was ordered). Earlier entries came from open-source projects and their recorded captures (Jul–Nov 2026).

**[V 2026-11-20]** verified by us against the live site on that date · **[V]** seen in someone else's working code
or capture, not re-run by us · **[S]** read in the site's own front-end JavaScript, not executed by us ·
**[P]** prose only · **[?]** unknown / inference.

## Rami Levy — `https://www.rami-levy.co.il` (+ API host `https://www-api.rami-levy.co.il`)

- Auth state: `localStorage["ramilevy"]` (persisted Vuex JSON). `authuser.user` null = logged out; logged in it has
  `token`, `id`, `store_id` (string), `first_name` [V 2026-11-20]. Bearer = `authuser.user.token`; the `ecomtoken`
  header carries **the same value** — a cart written with `ecomtoken: user.token` persists and shows in the site's
  own cart panel after reload [V 2026-11-20].
- **CORS**: `www-api` rejects credentialed requests (`credentials: 'include'` → "Failed to fetch"); it authorises by
  header only, so requests there go with `credentials: 'omit'` [V 2026-11-20].
- Customer: `GET https://www-api.rami-levy.co.il/api/v2/site/clubs/customer/{user.id}` (headers `authorization`,
  `ecomtoken`, `locale: he`) → `{user, deliveryTimesCustomer, orderTokens, order, cart, shopLists}` [V 2026-11-20].
  `cart` is **null** until the first item is added, then `{uid, updated_at, last_update, items:{"<id>": <number>}}`
  (after the last item is removed `items` becomes `[]`). `deliveryTimesCustomer` is **null** until the user picks a
  delivery slot (we never do). Store = `deliveryTimesCustomer.store_id` ?? `user.store_id` ?? 331.
- Search: `POST https://www.rami-levy.co.il/api/catalog` `{"q":"<text>","aggs":1,"store":<store>}`, headers
  `locale: he`, `authorization`, `ecomtoken` → `{status,total,data:[item]}` [V 2026-11-20]. Item:
  `{id, barcode, name, price:{price}, gs:{BrandName}, prop:{by_kilo, sw_shakil, unit}, multiplication,
  available_in:[storeIds], department:{name}, sale:[…]}`. In stock = store ∈ `available_in`.
- Cart write (replace semantics — `items` is the WHOLE cart): `POST https://www.rami-levy.co.il/api/v2/cart`
  `{"store":<store>,"isClub":0,"supplyAt":"<ISO now>","items":{"<id>":"1.00"},"meta":null}` — the site sends
  quantities as `"1.00"` strings [V 2026-11-20]. Response `{sales, items:[{id,name,price,quantity,FormatedTotalPrice,
  is_delivery,…}], price, …}`; the delivery fee is a line with `is_delivery:true` (id 164854, ₪35.90 on that date)
  and is present **only when the cart is non-empty**; top-level `price` excludes it [V 2026-11-20].
  **Without `ecomtoken` it only prices** — the stored cart is untouched [V 2026-11-20]; reads use that.
- Orders: `GET https://www-api.rami-levy.co.il/api/v3/site/orders?page=1&activeFilter=0` →
  `{success, data:{data:{current_page, data:[{id, final_price, supply_at:"YYYY-MM-DD hh:mm:ss", created_at,
  items:[<item id>…], …}]}}}` [V 2026-11-20]. Order lines: `GET …/api/v3/site/orders/{id}` →
  `data.lines:[{item_id, name, price:"<string>", quantity:<number>, total_price:"<string>", …}]`, plus
  `delivery_price`, `delivery_item_id` [V 2026-11-20]. Barcodes for ids: `POST https://www.rami-levy.co.il/api/items`
  `{"ids":"1,2,3","type":"id"}` → `{status,total,data:[catalog item]}` [V 2026-11-20].
- First add on the site's own UI opens a "בחירת מועד למשלוח" (delivery slot) modal. The extension never opens or
  answers it — slot choice stays with the user.
- Cart UI: side panel on `https://www.rami-levy.co.il/he` (no `/cart` page) [V 2026-11-20]. Checkout:
  `/he/dashboard/checkout` — forbidden.

## Shufersal — `https://www.shufersal.co.il/online/he` (SAP Hybris on Tomcat, cookie session)

- **Query strings must percent-encode `[` and `]`** (`cartContext%5BopenFrom%5D=…`): raw brackets get an empty
  HTTP 400 from the server [V 2026-11-20]. jQuery on the site encodes them; `fetch` does not.
- The login is a **session cookie**: restarting the browser logs the user out [V 2026-11-20].
- All XHR: header `X-Requested-With: XMLHttpRequest`. CSRF: `<meta name="_csrf" content="...">` (36 chars, same
  value as `ACC.config.CSRFToken`) [V 2026-11-20]; JSON POST → header `CSRFToken`; form POST → field `CSRFToken`.
- Logged in: `GET /authentication/get-status-includes-otp` → JSON `true|false` [V 2026-11-20].
- Search: `GET /search/results?q=<text>:relevance&limit=10`, `accept: application/json` → `{results:[item]}`
  [V 2026-11-20]. Item: `{code:"P_…", name, brandName, price:{value}, sellingMethod:{code:BY_UNIT|BY_WEIGHT|BY_PACKAGE},
  pricePerUnit:{value}?, unitForComparison, stock:{stockLevelStatus:{code:"inStock"}}, effectivePrice, effectiveMinQuantity,
  promotionCodes:[]}`. Barcode = digits of `code` when ≥ 12 digits; shorter codes are the chain's own [V/P].
- Before cart writes: `GET /cart/load?restoreCart=true` → cart **HTML**: `<article data-product-code="P_…"
  data-entry-number="3" data-entry-qty="2.0">` with `.miglog-prod-name`, `.miglog-prod-totalPrize` [V 2026-11-20].
- Add: `POST /cart/add?cartContext%5BopenFrom%5D=CATALOG&cartContext%5BrecommendationType%5D=REGULAR` JSON
  `{"productCodePost":code,"productCode":code,"sellingMethod":"BY_UNIT","qty":1,"frontQuantity":1,"comment":"","affiliateCode":""}`
  + headers `CSRFToken`, `X-Requested-With` → mini-cart HTML [V 2026-11-20]. The site itself sends `qty` as a string
  (`"1"`) and `openFrom=SEARCH`; numbers and `CATALOG` are accepted too [V 2026-11-20].
- Update/remove: `POST /cart/update?entryNumber=N&qty=Q&sellingMethod=BY_UNIT&comment=&cartContext%5BopenFrom%5D=CART&cartContext%5BrecommendationType%5D=REGULAR`
  (+ `&cartContext%5Baction%5D=remove` when Q=0), **form body** `quantity=Q&CSRFToken=…` plus the `CSRFToken`
  header — works for set, change and remove [V 2026-11-20]. Entry numbers renumber after a removal — always re-read.
- Totals: `GET /cart/cartsummary` HTML `.miglog-cart-summary-totalprice` equals the sum of the lines [V 2026-11-20].
- Out of stock in the cart: the cart `<article>` gets class `miglog-cart-prod-notInStock` (in stock: `miglog-cart-prod-`
  with an empty suffix); the site's CSS greys such a line and shows "חסר במלאי" [S 2026-11-21 — markup and CSS read
  live, no real out-of-stock line observed]. Guest (logged-out) sessions can add to a cart [V 2026-11-21].
- Delivery fee: `GET /timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false` → slots with
  `price.value`; the minimum (₪35.90 on that date) equals the "דמי שירות במשלוח" the site shows [V 2026-11-20].
  No minimum order [P]. Without any delivery address (logged-out guest session) search still returns products as
  `inStock` and they can be added to the cart [V 2026-11-21] — the old "everything shows out of stock" note was wrong
  for guests; a logged-in account without an address was not tested.
- Orders: `GET /my-account/orders` → `{activeOrders,closedOrders:[{code,createdString,totalPrice:{value}}]}`;
  `GET /my-account/orders/<code>` → `entries:[{quantity,basePrice:{value},product:{code,name,deliveryItem}}]`
  [V 2026-11-20: parses without error in the diagnostics].
- Cart page: `https://www.shufersal.co.il/online/he/cart/cartsummary` — the "סיכום הזמנה" page listing the cart
  [V 2026-11-20]. Forbidden: `/online/he/checkout*`, `/cart/checkout`, `/payment`, `/j_spring_security_check`,
  `/otp`, `/cart/cartFromOrder` (edits a past order).

## Hatzi Hinam — `https://shop.hazi-hinam.co.il` (Angular; API `/proxy/api`, cookie session, no CSRF)

- Envelope on every call: `{IsOK, Results, ErrorResponse:{ErrorCode,ErrorDescription}}` [V 2026-11-20].
- Logged in: `GET /proxy/api/user/info` → `Results.UserInfo` non-null, first name in `FName` [V 2026-11-20].
  `Results` also has `CartItemsCount`, `NextDelivery`, `InventoryStores`.
- Search: `POST /proxy/api/item/getItemsBySearch`
  `{"Paging":{"Page":1,"PageSize":20},"Object":{"SearchPhrase":"<text|barcode>","SearchPhrases":null,"ItemGroupping":null}}`
  → `Results.Items:[{Id,BarKod,Name,ManufacturerName,IsShakil,Price_NET,Price_Regular,PricePerUnit,PricePerUnitDesc,
  IsInStock,Mivza,ItemQuantityTypes:{ConversionRate,Types:[{Type,Interval,MaxQuantity}]},Cart,…}]` [V 2026-11-20].
- Add / set / remove: `POST /proxy/api/item/addItemToCart` `{"Object":{"ItemId":<id>,"Quantity":<q>,"Type":1,
  "IsCalculateCart":false}}` **sets the absolute quantity** (1→3→1→0 each read back exactly); `Quantity: 0` removes
  the line [V 2026-11-20]. Type 1 = units, 2 = kg [V].
- Empty cart: `DELETE /proxy/api/item/removeItemsInCart` (no body) — empties the whole cart [V 2026-11-21, guest cart].
- Cart: `GET /proxy/api/item/getItemsInCart?SortBy=0&IsDescending=false` → `Results.CartItems.Items[]` (item shape +
  `Calculated_Price_NET`, `Cart:{Quantity}`); **`Items` is null when the cart is empty** [V 2026-11-20].
  Summary: `GET /proxy/api/order/cartSummary` → `Results.CartSummary:{Price_NET_TOTAL, Price_Shipping, Price_Savings,
  Price_Order_Total, Minimum_Cart_Price_NET, Price_NET_TOTAL_Without_Excluded_Items}` [V 2026-11-20]. The site's own
  check before checkout is `Price_Order_Total >= Minimum_Cart_Price_NET` — the minimum (₪499.90 on that date) is
  compared with the total **including** shipping [S].
- Orders: `GET /proxy/api/order/history` → `Results.Orders:[{Id, ComaxId, Date:"DD/MM/YYYY", Total, ClosingTotal,
  IsDraftOrder, Order_Status, …}]`; lines: `GET /proxy/api/item/getItemsByOrder/{Id}` →
  `Results.OrderItems.Categories[].Items[]` (search item shape) — **no ordered quantity** in the lines
  [V 2026-11-20].
- Cart page: `/checkout/cart` [S] — contains "checkout", so the guard blocks it by design; "עבור לעגלה" opens the
  home page, where "העגלה שלי" at the top opens the cart.

## Consequences for the adapters
1. Totals shown to the user always come from a cart re-read after writing, never from our own arithmetic.
2. Every `setItem` verifies by re-reading the cart and reports the real quantity.
3. Rami Levy reads (`getCart`, delivery fee) price the cart without `ecomtoken`, so a read never writes.
4. Hatzi Hinam order lines have no quantities; history items are reported with `qty: null` (counted as 1).
