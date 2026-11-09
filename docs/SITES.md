# Site endpoints (front-end APIs) — what is known and how sure we are

None of the three sites is reachable from cloud servers (Cloudflare / Israel-only geo-block), so nothing here was
re-tested by us. Sources: open-source projects and their recorded captures (Jul–Nov 2026).
**[V]** seen in working source code or a recorded capture · **[P]** prose only · **[?]** unknown / inference.
Everything marked [P]/[?] must be confirmed with the extension's diagnostics page on a real machine.

## Rami Levy — `https://www.rami-levy.co.il` (+ API host `https://www-api.rami-levy.co.il`)

- Auth state: `localStorage["ramilevy"]` (persisted Vuex JSON). `authuser.user` null = logged out; logged in it has
  `token`, `id`, `store_id`, `first_name`(?) [V]. Bearer = `authuser.user.token` [V]. Cart writes that persist need
  header `ecomtoken: <JWT>` [V]; where it is stored is unknown — **assumption: same value as `user.token`** [?].
- Customer: `GET https://www-api.rami-levy.co.il/api/v2/site/clubs/customer/{user.id}` (headers `authorization`,
  `ecomtoken`, `locale: he`) → `{user, deliveryTimesCustomer:{store_id, price}, cart:{items:{id:qty}}, ...}` [V].
  `store` for all calls = `deliveryTimesCustomer.store_id` ?? `user.store_id` ?? 331. Delivery fee =
  `deliveryTimesCustomer.price` [P]. Minimum order: not exposed [?].
- Search: `POST /api/catalog` `{"q":"<text>","aggs":1,"store":"<store>"}`, headers `locale: he`,
  `content-type: application/json;charset=UTF-8` → `{status,total,data:[item]}` [V]. Item:
  `{id, barcode, name, price:{price}, gs:{BrandName}, prop:{by_kilo, sw_shakil}, multiplication, available_in:[storeIds],
  department:{name}, sale:[{title,name,cmt /*qty*/,scm /*total price*/,is_club}]}`. In stock = store ∈ `available_in`.
- Cart write (replace semantics — `items` is the WHOLE cart): `POST /api/v2/cart`
  `{"store":"<store>","isClub":0,"supplyAt":"<ISO now>","items":{"<id>":"1.00"},"meta":null}` [V].
  Response `{items:[{id,name,price,quantity,FormatedTotalPrice,is_delivery}], price, discount, status}`; the delivery
  fee is a line with `is_delivery:true`; top-level `price` excludes it [V]. Without `ecomtoken` it only prices [V].
- Orders: `GET https://www-api.rami-levy.co.il/api/v3/site/orders?page=1&activeFilter=` → `data.data.data:[{id,
  final_price,supply_at,created_at}]` [V]. **Order lines endpoint unknown** [?].
- Cart UI: side panel on `https://www.rami-levy.co.il/he` (no `/cart` page) [V]. Checkout:
  `/he/dashboard/checkout` — forbidden.

## Shufersal — `https://www.shufersal.co.il/online/he` (SAP Hybris, cookie session)

- All XHR: header `X-Requested-With: XMLHttpRequest`. CSRF: `<meta name="_csrf" content="...">` [V]; JSON POST →
  header `CSRFToken`; form POST → field `CSRFToken`.
- Logged in: `GET /authentication/get-status-includes-otp` → JSON `true|false` [V].
- Search: `GET /search/results?q=<text>:relevance&limit=10`, `accept: application/json` →
  `{results:[item]}` [V]. Item: `{code:"P_…", name, brandName, price:{value}, sellingMethod:{code:BY_UNIT|BY_WEIGHT|BY_PACKAGE},
  pricePerUnit:{value}?, unitForComparison, stock:{stockLevelStatus:{code:"inStock"}}, effectivePrice, effectiveMinQuantity,
  promotionCodes:[]}`. Barcode = digits of `code` when ≥ 12 digits; shorter codes are the chain's own (prefix
  `729000` stripped) [V/P].
- Before cart writes: `GET /cart/load?restoreCart=true` (else add → 400) [P]. It returns cart **HTML**:
  `<article data-product-code="P_…" data-entry-number="3" data-entry-qty="2.0">` with `.miglog-prod-name`,
  `.miglog-prod-totalPrize` [V].
- Add: `POST /cart/add?cartContext[openFrom]=CATALOG&cartContext[recommendationType]=REGULAR` JSON
  `{"productCodePost":code,"productCode":code,"sellingMethod":"BY_UNIT","qty":1,"frontQuantity":1,"comment":"","affiliateCode":""}`
  → mini-cart HTML; failure contains `הוספת הפריט נכשלה` [V].
- Update/remove: `POST /cart/update?entryNumber=N&qty=Q&sellingMethod=BY_UNIT&comment=&cartContext[openFrom]=CART&cartContext[recommendationType]=REGULAR`
  (+ `&cartContext[action]=remove` when Q=0). Body conflict between sources: form `quantity=Q&CSRFToken=…` vs JSON
  `{quantity}` + header [V both]. We send the form variant **and** the CSRF header. Entry numbers renumber after a
  removal — always re-read the cart first [P].
- Totals: `GET /cart/cartsummary` HTML: `.miglog-cart-summary-totalprice`, `#cartTotalItems` [P].
- Delivery fee: `GET /timeSlot/preselection/getHomeDeliverySlots?amount=1.0&prescription=false` → slots with
  `price.value|formattedValue` [V]. No minimum order [P]. Without a delivery address bound in the account every
  product shows out of stock [P] — the user sets the address on the site.
- Orders: `GET /my-account/orders` → `{activeOrders,closedOrders:[{code,createdString,totalPrice:{value}}]}`;
  `GET /my-account/orders/<code>` → `entries:[{quantity,basePrice:{value},product:{code,name,deliveryItem}}]` [V].
- Cart page: `https://www.shufersal.co.il/online/he/cart/cartsummary` [V]. Forbidden: `/online/he/checkout*`,
  `/cart/checkout`, `/payment`, `/j_spring_security_check`, `/otp`, `/cart/cartFromOrder` (edits a past order).

## Hatzi Hinam — `https://shop.hazi-hinam.co.il` (Angular; API `/proxy/api`, cookie session, no CSRF)

Only one source, guest sessions only.
- Envelope on every call: `{IsOK, Results, ErrorResponse:{ErrorCode,ErrorDescription}}` [V].
- Logged in: `GET /proxy/api/user/info` → `Results.UserInfo` non-null **(inference)** [?].
- Search: `POST /proxy/api/item/getItemsBySearch`
  `{"Paging":{"Page":1,"PageSize":20},"Object":{"SearchPhrase":"<text|barcode>","SearchPhrases":null,"ItemGroupping":null}}`
  → `Results.Items:[{Id,BarKod,Name,ManufacturerName,IsShakil,Price_NET,Price_Regular,PricePerUnit,PricePerUnitDesc,
  IsInStock,Mivza:{MivzaDesc,MivzaText,MivzaQuantityCount},ItemQuantityTypes:{Types:[{Type,Interval}]},Cart}]` [V].
  `Price_NET` < `Price_Regular` looks like an already-applied promo price [?].
- Add: `POST /proxy/api/item/addItemToCart` `{"Object":{"ItemId":7357,"Quantity":2,"Type":1,"IsCalculateCart":false}}`
  (Type 1 units, 2 kg) → `Results:{CartItemsCount,...}` [V]. **Set vs increment on repeat: unknown** [?].
- Cart: `GET /proxy/api/item/getItemsInCart?SortBy=0&IsDescending=false` → `Results.CartItems.Items[]` (item shape +
  `Calculated_Price_NET`, `Cart:{Quantity}`) [V]. Summary: `GET /proxy/api/order/cartSummary` →
  `Results.CartSummary:{Price_NET_TOTAL,Price_Shipping,Price_Savings,Price_Order_Total,Minimum_Cart_Price_NET}` [V].
- **Unknown** [?]: remove line / set quantity / empty cart, order history, cart page route. Checkout path
  `/checkout` [P] — forbidden.

## Consequences for the adapters
1. Totals shown to the user always come from a cart re-read after writing, never from our own arithmetic.
2. Every `setItem` verifies by re-reading the cart and reports the real quantity.
3. Hatzi Hinam: `emptyCart`, quantity decrease and `getOrders` report `UNSUPPORTED` until captured from a live
   logged-in session (diagnostics page → recorder).
4. Rami Levy: `getOrders` returns order headers only (no lines) → no purchase-history signal from this chain yet.
