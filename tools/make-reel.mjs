// Builds the vertical (9:16) Hebrew promo "Reel" for סל חכם.
//
//   PLAYWRIGHT_BROWSERS_PATH=~/.sal-pw-browsers node tools/make-reel.mjs [--skip-shots] [--no-record]
//
// 1. Drives the REAL extension against the e2e mock sites (tests/e2e/harness.mjs — fictional products and
//    prices, no personal data) and saves UI screenshots + element boxes to promo/shots/.
// 2. Serves the repo on 127.0.0.1, opens promo/reel.html (the canvas animation) in Chromium and records it
//    with MediaRecorder (H.264 MP4, 1080x1920, 30 fps, no audio) to promo/sal-hacham-reel.mp4.
// 3. Writes the poster frame promo/reel-poster.png and verification frames promo/frames/frame-XX.png
//    (decoded from the MP4 itself; falls back to rendering the canvas if the MP4 cannot be decoded).
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMO = path.join(ROOT, 'promo');
const SHOTS = path.join(PROMO, 'shots');
const FRAMES = path.join(PROMO, 'frames');
const OUT = path.join(PROMO, 'sal-hacham-reel.mp4');
const args = new Set(process.argv.slice(2));
const { chromium } = createRequire(import.meta.url)('playwright');

const FRAME_TIMES = [3.2, 11.0, 15.8, 21.0, 25.4, 29.6, 33.6, 38.6];
const POSTER_TIME = 3.2;
const BITRATE = 2_600_000; // ~2.6 Mbit/s → ~13 MB for 39 s

// ---------------------------------------------------------------- 1. screenshots of the real UI
function demoState(createState) {
  const s = createState();
  const MILK = 7290000000012, BREAD = 7290000000029, MILK1 = 7290000000036;
  s.ramilevy.catalog = [
    { id: 1001, barcode: MILK, name: 'חלב תנובה 3% 1 ליטר', price: { price: 7 }, prop: {}, multiplication: 1,
      department: { name: 'מוצרי חלב' }, gs: { BrandName: 'תנובה' }, available_in: [331], sale: [] },
    { id: 1004, barcode: MILK1, name: 'חלב תנובה 1% 1 ליטר', price: { price: 7.5 }, prop: {}, multiplication: 1,
      department: { name: 'מוצרי חלב' }, gs: { BrandName: 'תנובה' }, available_in: [331], sale: [] },
    { id: 1002, barcode: BREAD, name: 'לחם אחיד פרוס', price: { price: 10 }, prop: {}, multiplication: 1,
      department: { name: 'לחם' }, gs: { BrandName: 'אנג\'ל' }, available_in: [331], sale: [] },
  ];
  s.shufersal.catalog = [
    { code: 'P_7290000000012', name: 'חלב תנובה 3% 1 ליטר', brandName: 'תנובה', price: { value: 6 }, sellingMethod: { code: 'BY_UNIT' }, stock: 'inStock' },
    { code: 'P_7290000000036', name: 'חלב תנובה 1% 1 ליטר', brandName: 'תנובה', price: { value: 6.5 }, sellingMethod: { code: 'BY_UNIT' }, stock: 'inStock' },
    { code: 'P_7290000000029', name: 'לחם אחיד פרוס', brandName: 'אנג\'ל', price: { value: 9 }, sellingMethod: { code: 'BY_UNIT' }, stock: 'inStock' },
  ];
  s.hazihinam.catalog = [
    { Id: 2001, BarKod: MILK, Name: 'חלב תנובה 3% 1 ליטר', ManufacturerName: 'תנובה', IsShakil: false,
      Price_NET: 6.5, Price_Regular: 6.5, PricePerUnit: 6.5, PricePerUnitDesc: 'ליטר', IsInStock: true, Mivza: null },
    { Id: 2003, BarKod: MILK1, Name: 'חלב תנובה 1% 1 ליטר', ManufacturerName: 'תנובה', IsShakil: false,
      Price_NET: 6.9, Price_Regular: 6.9, PricePerUnit: 6.9, PricePerUnitDesc: 'ליטר', IsInStock: true, Mivza: null },
    { Id: 2002, BarKod: BREAD, Name: 'לחם אחיד פרוס', ManufacturerName: 'אנג\'ל', IsShakil: false,
      Price_NET: 8, Price_Regular: 8, PricePerUnit: 8, PricePerUnitDesc: 'יחידה', IsInStock: true, Mivza: null },
  ];
  s.hazihinam.minOrder = 10;
  return s;
}
const LIST = '2 חלב תנובה\nלחם אחיד';

async function captureShots() {
  const { launch, createState, tid } = await import(pathToFileURL(path.join(ROOT, 'tests/e2e/harness.mjs')).href);
  fs.mkdirSync(SHOTS, { recursive: true });
  const h = await launch({ state: demoState(createState) });
  const meta = {};
  const { app } = h;
  const viewport = async (width) => {
    await app.setViewportSize({ width, height: 2400 });
    const cdp = await app.context().newCDPSession(app);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 2400, deviceScaleFactor: 2, mobile: false });
  };
  // screenshot one element; record its CSS size and the boxes of interesting children relative to it
  const shot = async (name, selector, boxes) => {
    await app.evaluate(() => document.activeElement && document.activeElement.blur());
    const el = app.locator(selector).first();
    await el.screenshot({ path: path.join(SHOTS, name + '.png') });
    meta[name] = await el.evaluate((root, boxes) => {
      const r = root.getBoundingClientRect();
      const out = { cssW: r.width, cssH: r.height, boxes: {} };
      for (const [k, sel] of Object.entries(boxes)) {
        const e = root.querySelector(sel);
        if (!e) continue;
        const b = e.getBoundingClientRect();
        out.boxes[k] = { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height };
      }
      return out;
    }, boxes);
  };
  try {
    await viewport(480);
    await tid(app, 'btn-save-settings').click();
    await tid(app, 'btn-continue').waitFor({ timeout: 60000 });
    await app.waitForFunction(() => !document.querySelector('[data-testid="btn-continue"]').disabled, null, { timeout: 60000 });
    await tid(app, 'btn-continue').click();
    await tid(app, 'list-input').fill(LIST);
    await shot('list', '[data-testid="step-list"]', { input: '[data-testid="list-input"]', build: '[data-testid="btn-build"]' });

    await viewport(1100);
    await tid(app, 'btn-build').click();
    await tid(app, 'btn-fill').waitFor({ timeout: 90000 });
    await shot('review', '[data-testid="step-review"]', {
      table: '.table-wrap', select: '[data-testid="cell-0-hazihinam"] select', fill: '[data-testid="btn-fill"]',
    });
    // what was chosen per line (used for the illustrations, so they match the screenshots)
    meta.review.lines = await app.evaluate(() => [...document.querySelectorAll('[data-testid="step-review"] tbody tr')].map((tr, i) => ({
      query: tr.querySelector('th label').textContent.trim(),
      qty: Number(tr.querySelector('.stepper span').textContent),
      chains: Object.fromEntries(['hazihinam', 'ramilevy', 'shufersal'].map((c) => {
        const n = tr.querySelector(`[data-testid="cell-${i}-${c}"] .product-name`);
        return [c, n ? n.textContent.trim() : null];
      })),
    })));
    // the exclude box: checkbox + its label
    meta.review.boxes.exclude = await app.evaluate(() => {
      const root = document.querySelector('[data-testid="step-review"]').getBoundingClientRect();
      const b = document.querySelector('[data-testid="exclude-0-hazihinam"]').parentElement.getBoundingClientRect();
      return { x: b.left - root.left, y: b.top - root.top, w: b.width, h: b.height };
    });

    await viewport(520);
    await tid(app, 'btn-fill').click();
    await tid(app, 'btn-new').waitFor({ timeout: 90000 });
    const best = await app.evaluate(() => document.querySelector('[data-testid="winner"]').closest('[data-testid^="chain-card-"]').dataset.testid.slice(11));
    await shot('result', '[data-testid="step-result"]', {
      winner: `[data-testid="chain-card-${best}"]`, cartBtn: `[data-testid="btn-cart-${best}"]`,
      winnerFinal: `[data-testid="final-${best}"]`,
    });
    meta.result.best = best;
    meta.result.cart = h.state[best].cart; // what really landed in the (mock) site cart
    if (h.outside.length) throw new Error('unexpected outside requests: ' + h.outside.join(', '));
  } finally { await h.close(); }
  fs.writeFileSync(path.join(SHOTS, 'meta.js'), '// generated by tools/make-reel.mjs\nwindow.SHOTS_META = ' + JSON.stringify(meta, null, 1) + ';\n');
  console.log('screenshots →', path.relative(ROOT, SHOTS), '(winner:', meta.result.best + ')');
}

// ---------------------------------------------------------------- 2. static server (with Range for <video>)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4', '.json': 'application/json' };
function serve() {
  const server = http.createServer((req, res) => {
    const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || !fs.statSync(p).isFile()) { res.writeHead(404).end(); return; }
    const size = fs.statSync(p).size;
    const type = TYPES[path.extname(p)] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const start = m[1] ? Number(m[1]) : 0, end = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(p, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(p).pipe(res);
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const writeDataUrl = (file, dataUrl) => fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));

// ---------------------------------------------------------------- 3. record, poster, frames
async function main() {
  if (!args.has('--skip-shots') || !fs.existsSync(path.join(SHOTS, 'meta.js'))) await captureShots();
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/promo/reel.html?mode=record`);
    await page.waitForFunction(() => window.REEL && window.REEL.isReady === true, null, { timeout: 30000 });
    const duration = await page.evaluate(() => window.REEL.DURATION);

    writeDataUrl(path.join(PROMO, 'reel-poster.png'), await page.evaluate((t) => window.REEL.renderPNG(t), POSTER_TIME));
    console.log('poster → promo/reel-poster.png');

    fs.rmSync(FRAMES, { recursive: true, force: true });
    fs.mkdirSync(FRAMES, { recursive: true });
    let frameSource = 'canvas';
    if (!args.has('--no-record')) {
      console.log(`recording ${duration.toFixed(1)} s in real time…`);
      const rec = await page.evaluate((bps) => window.REEL.record({ bps }), BITRATE);
      const CH = 1 << 20;
      const fd = fs.openSync(OUT, 'w');
      for (let off = 0; off < rec.size; off += CH) {
        const b64 = await page.evaluate(([o, n]) => window.REEL.chunk(o, n), [off, CH]);
        fs.writeSync(fd, Buffer.from(b64, 'base64'));
      }
      fs.closeSync(fd);
      console.log(`video → promo/sal-hacham-reel.mp4  ${(rec.size / 1048576).toFixed(2)} MB, recorded in ${rec.wall.toFixed(1)} s wall time, ${rec.slowFrames} late frames, mime ${rec.mime}`);

      // verification frames decoded from the MP4 itself
      const vp = await browser.newPage();
      await vp.goto(`${base}/promo/reel.html?mode=blank`);
      try {
        const res = await vp.evaluate(async (times) => {
          const v = document.createElement('video');
          v.muted = true; v.preload = 'auto'; v.src = '/promo/sal-hacham-reel.mp4';
          document.body.append(v);
          await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('video error ' + (v.error && v.error.code))); });
          let duration = v.duration;
          if (!Number.isFinite(duration)) { // MediaRecorder files may not carry a duration
            await new Promise((ok) => { v.ondurationchange = () => Number.isFinite(v.duration) && ok(); v.currentTime = 1e6; setTimeout(ok, 5000); });
            duration = v.duration;
          }
          const c = document.createElement('canvas'); c.width = 1080; c.height = 1920;
          const x = c.getContext('2d');
          const frames = [];
          for (const t of times) {
            await new Promise((ok) => { v.onseeked = ok; v.currentTime = t; });
            x.drawImage(v, 0, 0, 1080, 1920);
            frames.push(c.toDataURL('image/png'));
          }
          return { duration, w: v.videoWidth, h: v.videoHeight, frames };
        }, FRAME_TIMES);
        res.frames.forEach((d, i) => writeDataUrl(path.join(FRAMES, `frame-${String(i + 1).padStart(2, '0')}.png`), d));
        frameSource = 'mp4';
        console.log(`decoded MP4: ${res.w}x${res.h}, duration ${Number(res.duration).toFixed(2)} s`);
      } catch (e) {
        console.log('could not decode the MP4 in Chromium (' + e.message + ') — frames rendered from the canvas instead');
      }
      await vp.close();
    }
    if (frameSource === 'canvas') {
      for (const [i, t] of FRAME_TIMES.entries()) {
        writeDataUrl(path.join(FRAMES, `frame-${String(i + 1).padStart(2, '0')}.png`), await page.evaluate((tt) => window.REEL.renderPNG(tt), t));
      }
    }
    console.log(`frames (${frameSource}) → promo/frames/ at t = ${FRAME_TIMES.join(', ')} s`);
    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  } finally {
    await browser.close();
    server.close();
  }
}

await main();
