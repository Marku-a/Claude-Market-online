// End-to-end: the real extension in Chromium against mocked versions of the three sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launch, createState, tid, money, RL_TOKEN } from './harness.mjs';

const BARCODE_MILK = 7290000000012;

// A small, promo-free catalogue so expected totals are easy to verify by hand.
function simpleState() {
  const s = createState();
  s.ramilevy.catalog = [
    { id: 1001, barcode: BARCODE_MILK, name: 'חלב תנובה 3% 1 ליטר', price: { price: 7 }, prop: {}, multiplication: 1,
      department: { name: 'מוצרי חלב' }, gs: { BrandName: 'תנובה' }, available_in: [331], sale: [] },
    { id: 1002, barcode: 7290000000029, name: 'לחם אחיד פרוס', price: { price: 10 }, prop: {}, multiplication: 1,
      department: { name: 'לחם' }, gs: { BrandName: 'אנג\'ל' }, available_in: [331], sale: [] },
    { id: 1003, barcode: 7290000000999, name: 'שמפו ישן', price: { price: 20 }, prop: {}, multiplication: 1,
      department: { name: 'טיפוח' }, gs: {}, available_in: [331], sale: [] },
  ];
  s.shufersal.catalog = [
    { code: 'P_7290000000012', name: 'חלב תנובה 3% 1 ליטר', brandName: 'תנובה', price: { value: 6 }, sellingMethod: { code: 'BY_UNIT' }, stock: 'inStock' },
    { code: 'P_7290000000029', name: 'לחם אחיד פרוס', brandName: 'אנג\'ל', price: { value: 9 }, sellingMethod: { code: 'BY_UNIT' }, stock: 'inStock' },
  ];
  s.hazihinam.catalog = [
    { Id: 2001, BarKod: BARCODE_MILK, Name: 'חלב תנובה 3% 1 ליטר', ManufacturerName: 'תנובה', IsShakil: false,
      Price_NET: 6.5, Price_Regular: 6.5, PricePerUnit: 6.5, PricePerUnitDesc: 'ליטר', IsInStock: true, Mivza: null },
    { Id: 2002, BarKod: 7290000000029, Name: 'לחם אחיד פרוס', ManufacturerName: 'אנג\'ל', IsShakil: false,
      Price_NET: 8, Price_Regular: 8, PricePerUnit: 8, PricePerUnitDesc: 'יחידה', IsInStock: true, Mivza: null },
  ];
  s.hazihinam.minOrder = 10;
  // delivery: RL 29.9, Shufersal 19.9, Hatzi Hinam 25 (mock defaults)
  return s;
}
// 2 milk + 1 bread → RL 24, Shufersal 21, Hatzi Hinam 21; with delivery: 53.9 / 40.9 / 46
const LIST = '2 חלב תנובה\nלחם אחיד';

async function toConnect(h) {
  const { app } = h;
  await tid(app, 'btn-save-settings').click();
  await tid(app, 'btn-continue').waitFor({ timeout: 60000 });
  await settled(app);
}
// wait until every chain finished its connection check
function settled(app) {
  return app.waitForFunction(() => {
    const chips = [...document.querySelectorAll('[data-testid^="chain-status-"]')];
    return chips.length === 3 && chips.every((c) => !c.textContent.includes('בודקים'));
  }, null, { timeout: 60000 });
}
async function runList(h, list = LIST) {
  const { app } = h;
  await app.waitForFunction(() => !document.querySelector('[data-testid="btn-continue"]').disabled, null, { timeout: 60000 });
  await tid(app, 'btn-continue').click();
  await tid(app, 'list-input').fill(list);
  await tid(app, 'btn-build').click();
  await tid(app, 'btn-fill').waitFor({ timeout: 90000 });
}
async function fill(h) {
  await tid(h.app, 'btn-fill').click();
  await tid(h.app, 'btn-new').waitFor({ timeout: 90000 });
}
const text = (h, id) => tid(h.app, id).first().innerText();

test('happy path: three real carts, site totals, cheapest wins, cart links, nothing leaks', async () => {
  const h = await launch({ state: simpleState() });
  try {
    await toConnect(h);
    for (const c of ['hazihinam', 'ramilevy', 'shufersal']) assert.match(await text(h, `chain-status-${c}`), /מחובר/);
    await runList(h);
    await fill(h);

    // the carts on the "sites" really contain the items
    assert.deepEqual(h.state.ramilevy.cart, { 1001: '2.00', 1002: '1.00' });
    assert.deepEqual(h.state.hazihinam.cart, { 2001: 2, 2002: 1 });
    assert.deepEqual(h.state.shufersal.cart.map((l) => [l.code, Number(l.qty)]).sort(), [['P_7290000000012', 2], ['P_7290000000029', 1]]);

    assert.equal(money(await text(h, 'total-ramilevy')), 24);
    assert.equal(money(await text(h, 'total-shufersal')), 21);
    assert.equal(money(await text(h, 'total-hazihinam')), 21);
    assert.equal(money(await text(h, 'final-ramilevy')), 53.9);
    assert.equal(money(await text(h, 'final-shufersal')), 40.9);
    assert.equal(money(await text(h, 'final-hazihinam')), 46);
    assert.equal(await h.app.locator('[data-testid="chain-card-shufersal"] [data-testid="winner"]').count(), 1);
    assert.equal(await tid(h.app, 'winner').count(), 1);
    assert.ok(!(await h.app.innerText('body')).includes('null'), 'no "null" text in the UI');

    // "go to cart" opens the site's own cart page
    const [cartTab] = await Promise.all([h.ctx.waitForEvent('page'), tid(h.app, 'btn-cart-shufersal').click()]);
    await cartTab.waitForLoadState('domcontentloaded');
    assert.equal(cartTab.url(), 'https://www.shufersal.co.il/online/he/cart/cartsummary');

    // security
    assert.deepEqual(h.outside, [], 'no request to any host outside the three chains');
    assert.deepEqual(h.state.forbiddenHits, [], 'no checkout/payment URL was touched');
    const stored = JSON.stringify(await h.storage());
    assert.ok(!stored.includes(RL_TOKEN), 'site token is never stored');
    assert.ok(!/csrf|password|token/i.test(stored), 'no credential-like keys in storage');
    assert.deepEqual(h.consoleErrors, []);
  } finally { await h.close(); }
});

test('a logged-out chain is skipped; the others still complete', async () => {
  const state = simpleState();
  state.shufersal.loggedIn = false;
  const h = await launch({ state });
  try {
    await toConnect(h);
    assert.match(await text(h, 'chain-status-shufersal'), /לא מחובר/);
    await runList(h);
    await fill(h);
    assert.deepEqual(state.shufersal.cart, []);
    assert.equal(money(await text(h, 'final-hazihinam')), 46);
    assert.equal(await h.app.locator('[data-testid="chain-card-hazihinam"] [data-testid="winner"]').count(), 1);
    assert.deepEqual(h.state.forbiddenHits, []);
  } finally { await h.close(); }
});

test('a site that changed its response shape is reported; the others still complete', async () => {
  const state = simpleState();
  state.hazihinam.variant = 'shape-changed';
  const h = await launch({ state });
  try {
    await toConnect(h);
    await runList(h);
    assert.match(await text(h, 'error-hazihinam'), /האתר השתנה/);
    await fill(h);
    assert.deepEqual(state.hazihinam.cart, {});
    assert.equal(money(await text(h, 'final-shufersal')), 40.9);
    assert.equal(await h.app.locator('[data-testid="chain-card-shufersal"] [data-testid="winner"]').count(), 1);
  } finally { await h.close(); }
});

test('existing cart: "keep" leaves old items and excludes them from the comparison; "empty" removes them', async () => {
  for (const policy of ['keep', 'empty']) {
    const state = simpleState();
    state.ramilevy.cart = { 1003: '1.00' }; // an old shampoo already in the cart
    const h = await launch({ state });
    try {
      await toConnect(h);
      await runList(h);
      await tid(h.app, `policy-ramilevy-${policy}`).check();
      await fill(h);
      if (policy === 'keep') assert.deepEqual(state.ramilevy.cart, { 1003: '1.00', 1001: '2.00', 1002: '1.00' });
      else assert.deepEqual(state.ramilevy.cart, { 1001: '2.00', 1002: '1.00' });
      assert.equal(money(await text(h, 'total-ramilevy')), 24, `policy ${policy}: only our items are compared`);
    } finally { await h.close(); }
  }
});

test('personal discounts change the totals and the winner', async () => {
  const h = await launch({ state: simpleState() });
  try {
    // Rami Levy: fixed ₪20 off (e.g. credit-card benefit) → 24 − 20 + 29.9 = 33.9 < Shufersal 40.9
    await h.sw.evaluate(() => chrome.storage.local.set({ profile: {
      address: { city: 'חיפה', street: 'הנשיא', number: '1' }, deliveryOverrides: {}, existingCartPolicy: 'ask',
      discounts: [{ chain: 'ramilevy', label: 'כרטיס אשראי', type: 'fixed', value: 20, minBasket: 0, cap: null, enabled: true }],
    } }));
    await h.app.reload();
    if (await tid(h.app, 'btn-save-settings').count()) await tid(h.app, 'btn-save-settings').click();
    await tid(h.app, 'btn-continue').waitFor({ timeout: 60000 });
    await settled(h.app);
    await runList(h);
    await fill(h);
    assert.equal(money(await text(h, 'final-ramilevy')), 33.9);
    assert.equal(await h.app.locator('[data-testid="chain-card-ramilevy"] [data-testid="winner"]').count(), 1);
  } finally { await h.close(); }
});

test('security: the extension never works inside a checkout page', async () => {
  const state = simpleState();
  const h = await launch({ state });
  try {
    await toConnect(h);
    // The user (or the site) moves the extension's Rami Levy tab to the checkout page.
    const rlTab = h.ctx.pages().find((p) => p.url().startsWith('https://www.rami-levy.co.il'));
    await rlTab.goto('https://www.rami-levy.co.il/he/dashboard/checkout').catch(() => {});
    const before = state.forbiddenHits.length; // our own navigation above
    const marker = await rlTab.evaluate(() => { window.__probe = 1; return location.pathname; });
    assert.match(marker, /checkout/);
    const res = await h.app.evaluate(() => chrome.runtime.sendMessage({ t: 'call', chain: 'ramilevy', method: 'search', args: ['חלב'] }));
    assert.equal(res.ok, true, 'the call still works — from a fresh, safe tab');
    assert.equal(state.forbiddenHits.length, before, 'no further request touched a checkout URL');
    assert.ok(rlTab.url().includes('checkout'), 'the checkout tab was left alone');
    assert.equal(h.ctx.pages().filter((p) => p.url() === 'https://www.rami-levy.co.il/he').length, 1);
    // An adapter can never be asked to open a forbidden page either.
    const bad = await h.app.evaluate(() => chrome.runtime.sendMessage({ t: 'call', chain: 'ramilevy', method: 'pay', args: [] }));
    assert.equal(bad.code, 'FORBIDDEN');
    assert.deepEqual(h.outside, []);
  } finally { await h.close(); }
});

test('diagnostics report contains structure only', async () => {
  const h = await launch({ state: simpleState() });
  try {
    const page = await h.ctx.newPage();
    await page.goto(`chrome-extension://${h.extId}/diag/index.html`);
    await tid(page, 'btn-diag').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="diag-report"]');
      return el && el.textContent.includes('shufersal') && el.textContent.includes('ramilevy') && el.textContent.includes('hazihinam');
    }, null, { timeout: 90000 });
    const report = await tid(page, 'diag-report').innerText();
    assert.ok(report.includes('<string:'), 'values are replaced by type markers');
    for (const secret of [RL_TOKEN, 'חלב תנובה', 'דנה', 'test-csrf', '7290000000012']) {
      assert.ok(!report.includes(secret), `report must not contain ${secret}`);
    }
    assert.deepEqual(h.state.forbiddenHits, []);
  } finally { await h.close(); }
});
