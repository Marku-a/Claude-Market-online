// Builds the vertical (9:16) Hebrew promo "Reel" for סל חכם.
//
//   PLAYWRIGHT_BROWSERS_PATH=~/.sal-pw-browsers node tools/make-reel.mjs [--skip-shots] [--no-record]
//                                                     [--voice=he-IL-AvriNeural] [--rate=+5%]
//
// 1. Drives the REAL extension against the e2e mock sites (tests/e2e/harness.mjs — fictional products and
//    prices, no personal data) and saves UI screenshots + element boxes to promo/shots/.
// 2. Voice-over: one clip per scene from promo/voiceover.he.txt via Microsoft's online neural TTS (edge-tts,
//    Python) into promo/audio/vo-XX.mp3. Only the script text is sent; unchanged lines are not sent again.
// 3. Serves the repo on 127.0.0.1, opens promo/reel.html in Chromium, measures the clips (WebAudio) and
//    lengthens scenes so each clip fits (promo/audio/timing.js), composes the original music
//    (promo/reel-audio.js → promo/audio/music.wav), and records canvas + mixed audio with MediaRecorder
//    (H.264 + AAC MP4, 1080x1920, 30 fps) to promo/sal-hacham-reel.mp4.
// 4. Writes the poster frame promo/reel-poster.png and verification frames promo/frames/frame-XX.png
//    (decoded from the MP4 itself; falls back to rendering the canvas if the MP4 cannot be decoded), and
//    prints audio measurements of the MP4 (levels, peaks, voice onsets vs. scene timing).
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROMO = path.join(ROOT, 'promo');
const SHOTS = path.join(PROMO, 'shots');
const FRAMES = path.join(PROMO, 'frames');
const AUDIO = path.join(PROMO, 'audio');
const VO_SCRIPT = path.join(PROMO, 'voiceover.he.txt');
const OUT = path.join(PROMO, 'sal-hacham-reel.mp4');
const argv = process.argv.slice(2);
const args = new Set(argv);
const opt = (name, def) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : def; };
const { chromium } = createRequire(import.meta.url)('playwright');

// voice: he-IL-HilaNeural (female, default) or he-IL-AvriNeural (male)
const VOICE = opt('voice', 'he-IL-HilaNeural');
const RATE = opt('rate', '+8%');
const PYTHON = process.env.PYTHON || 'python';
const VO_LEAD = { default: 0.25, hook: 0.5, cta: 0.35 }; // voice starts this long after its scene starts
const BREATH = 0.3;         // silence after a clip before the scene ends
const OUTRO = 1.5;          // after the last clip: music resolves
const VOICE_PEAK_DB = -3;   // each clip is normalised to this peak
const DUCK_DB = -11;        // music under the voice (music peaks -9 dBFS → about -20 dBFS under the voice)
const MAX_FRAME_GAP = 0.1;  // s; a longer frame in the MP4 means the encoder dropped frames → record again

// [scene index, seconds into the scene]: frames are taken relative to the (fitted) scene starts
const FRAME_AT = [[0, 3.2], [2, 3.0], [3, 3.2], [4, 3.8], [5, 3.4], [6, 2.8], [7, 2.8], [8, 3.6]];
const POSTER_AT = [0, 3.2];
const BITRATE = 2_600_000; // ~2.6 Mbit/s video + 128 kbit/s AAC → ~15 MB for 45 s

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
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json' };
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

async function saveBlob(page, name, file) {
  const size = await page.evaluate((n) => window.REEL.blobSize(n), name);
  const CH = 1 << 20;
  const fd = fs.openSync(file, 'w');
  for (let off = 0; off < size; off += CH) {
    const b64 = await page.evaluate(([o, n, nm]) => window.REEL.chunk(o, n, nm), [off, CH, name]);
    fs.writeSync(fd, Buffer.from(b64, 'base64'));
  }
  fs.closeSync(fd);
  return size;
}

// ---------------------------------------------------------------- 3. voice-over clips (edge-tts)
function readVoiceover(ids) {
  const lines = fs.readFileSync(VO_SCRIPT, 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const map = new Map(lines.map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  return ids.map((id) => {
    const text = map.get(id);
    if (!text) throw new Error(`promo/voiceover.he.txt: no line for scene "${id}"`);
    return { id, text };
  });
}
// one clip per scene: promo/audio/vo-XX.mp3. Skipped when voice + rate + text are unchanged (manifest.json).
function ensureClips(vo) {
  fs.mkdirSync(AUDIO, { recursive: true });
  const manFile = path.join(AUDIO, 'manifest.json');
  const man = fs.existsSync(manFile) ? JSON.parse(fs.readFileSync(manFile, 'utf8')) : {};
  const out = vo.map(({ id, text }, i) => {
    const file = `vo-${String(i + 1).padStart(2, '0')}.mp3`, full = path.join(AUDIO, file);
    const hash = crypto.createHash('sha256').update([VOICE, RATE, text].join('\n')).digest('hex').slice(0, 16);
    if (man[file] && man[file].hash === hash && fs.existsSync(full)) return { id, file, hash, cached: true };
    // only the script text is sent to the TTS service
    const r = spawnSync(PYTHON, ['-m', 'edge_tts', '--voice', VOICE, `--rate=${RATE}`, '--text', text, '--write-media', full],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    if (r.status !== 0 || !fs.existsSync(full)) throw new Error(`edge-tts failed for ${file}: ${r.error || r.stderr}`);
    man[file] = { id, voice: VOICE, rate: RATE, hash, text };
    return { id, file, hash, cached: false };
  });
  fs.writeFileSync(manFile, JSON.stringify(man, null, 1) + '\n');
  const fresh = out.filter((c) => !c.cached).length;
  console.log(`voice-over (${VOICE}, rate ${RATE}): ${fresh} clip(s) generated, ${out.length - fresh} unchanged`);
  return out;
}

// scene durations: each clip fits its scene with breathing room; scenes never get shorter than the animation needs
function planTiming(base, ids, clips) {
  const durations = [], voice = [];
  let start = 0;
  clips.forEach((c, i) => {
    const lead = VO_LEAD[ids[i]] ?? VO_LEAD.default;
    const speech = c.end - c.onset;
    const tail = i === clips.length - 1 ? OUTRO : BREATH;
    const d = Math.ceil(Math.max(base[i], lead + speech + tail) * 10) / 10;
    durations.push(d);
    voice.push({ clip: i, id: ids[i], at: +(start + lead - c.onset).toFixed(3), on: +(start + lead).toFixed(3),
      off: +(start + lead + speech).toFixed(3), gain: +(Math.pow(10, VOICE_PEAK_DB / 20) / c.peak).toFixed(4) });
    start += d;
  });
  // ducking windows (merged when the music would not have time to come back up)
  const duck = [];
  for (const v of voice) {
    const last = duck[duck.length - 1];
    if (last && v.on - last[1] < 0.45) last[1] = v.off; else duck.push([v.on, v.off]);
  }
  return { durations, voice, duck };
}

// longest video frame in a (fragmented) MediaRecorder MP4: moov/trak (hdlr, mdhd, tkhd) + moof/traf/trun
function videoFrameGaps(file) {
  const b = fs.readFileSync(file);
  const tracks = {}; let tk = null, cur = null, t = 0, max = 0, at = 0, frames = 0;
  const walk = (off, end) => {
    while (off + 8 <= end) {
      let size = b.readUInt32BE(off), hdr = 8;
      const type = b.toString('latin1', off + 4, off + 8);
      if (size === 1) { size = Number(b.readBigUInt64BE(off + 8)); hdr = 16; } else if (size === 0) size = end - off;
      const p = off + hdr;
      if (type === 'tkhd') { tk = b[p] ? b.readUInt32BE(p + 20) : b.readUInt32BE(p + 12); tracks[tk] = {}; }
      else if (type === 'mdhd') tracks[tk].scale = b[p] ? b.readUInt32BE(p + 20) : b.readUInt32BE(p + 12);
      else if (type === 'hdlr') tracks[tk].kind = b.toString('latin1', p + 8, p + 12);
      else if (type === 'tfhd') {
        const fl = b.readUInt32BE(p) & 0xffffff; let q = p + 8;
        cur = { id: b.readUInt32BE(p + 4) };
        if (fl & 1) q += 8; if (fl & 2) q += 4; if (fl & 8) cur.def = b.readUInt32BE(q);
      } else if (type === 'tfdt') { if (tracks[cur.id] && tracks[cur.id].kind === 'vide') t = (b[p] ? Number(b.readBigUInt64BE(p + 4)) : b.readUInt32BE(p + 4)) / tracks[cur.id].scale; }
      else if (type === 'trun' && tracks[cur.id] && tracks[cur.id].kind === 'vide') {
        const fl = b.readUInt32BE(p) & 0xffffff, n = b.readUInt32BE(p + 4); let q = p + 8;
        if (fl & 1) q += 4; if (fl & 4) q += 4;
        for (let i = 0; i < n; i++) {
          let d = cur.def || 0;
          if (fl & 0x100) { d = b.readUInt32BE(q); q += 4; }
          if (fl & 0x200) q += 4; if (fl & 0x400) q += 4; if (fl & 0x800) q += 4;
          d /= tracks[cur.id].scale;
          if (d > max) { max = d; at = t; }
          t += d; frames++;
        }
      }
      if (['moov', 'trak', 'mdia', 'minf', 'moof', 'traf'].includes(type)) walk(p, off + size);
      off += size;
    }
  };
  walk(0, b.length);
  return { max, at, frames };
}

// ---------------------------------------------------------------- 4. record, poster, frames, verify
async function main() {
  if (!args.has('--skip-shots') || !fs.existsSync(path.join(SHOTS, 'meta.js'))) await captureShots();
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // audio/timing.js is missing on the very first run; that is fine
    page.on('console', (m) => { if (m.type() === 'error' && !/timing\.js/.test(m.location().url || '')) errors.push(m.text()); });
    await page.goto(`${base}/promo/reel.html?mode=record`);
    await page.waitForFunction(() => window.REEL && window.REEL.isReady === true, null, { timeout: 30000 });

    // voice-over → measure the clips → scene durations → music
    const { ids, baseDur } = await page.evaluate(() => ({ ids: window.REEL.SCENE_IDS, baseDur: window.REEL.BASE_DURATIONS }));
    const clipFiles = ensureClips(readVoiceover(ids));
    const clipUrls = clipFiles.map((c) => `/promo/audio/${c.file}?h=${c.hash}`);
    const clips = await page.evaluate((urls) => window.REEL_AUDIO.loadClips(urls), clipUrls);
    const plan = planTiming(baseDur, ids, clips);
    const timing = await page.evaluate((d) => window.REEL.setTiming(d), plan.durations);
    const duration = timing.duration;
    fs.writeFileSync(path.join(AUDIO, 'timing.js'), '// generated by tools/make-reel.mjs: scene durations fitted to the voice-over\nwindow.REEL_TIMING = '
      + JSON.stringify({ voice: VOICE, durations: timing.durations, starts: timing.starts.map((s) => +s.toFixed(3)), clips: plan.voice, duck: plan.duck }, null, 1) + ';\n');
    console.log('scenes (s):', ids.map((id, i) => `${id} ${timing.durations[i]}`).join(', '), `→ total ${duration.toFixed(1)} s`);
    clips.forEach((c, i) => console.log(`  vo-${String(i + 1).padStart(2, '0')}  ${(c.end - c.onset).toFixed(2)} s speech (file ${c.duration.toFixed(2)} s, onset ${c.onset.toFixed(3)} s, peak ${c.peakDb.toFixed(1)} dBFS)`));
    if (duration > 60) console.log('WARNING: longer than 60 s');
    const music = await page.evaluate((d) => window.REEL_AUDIO.composeMusic(d), duration);
    await saveBlob(page, 'music', path.join(AUDIO, 'music.wav'));
    console.log(`music → promo/audio/music.wav  ${music.duration.toFixed(2)} s, ${music.bpm} BPM, ${music.bars} bars + final chord at ${music.finalChordAt.toFixed(2)} s, peak ${music.peakDb.toFixed(1)} dBFS, RMS ${music.rmsDb.toFixed(1)} dBFS`);

    const at = ([scene, lt]) => timing.starts[scene] + lt;
    writeDataUrl(path.join(PROMO, 'reel-poster.png'), await page.evaluate((t) => window.REEL.renderPNG(t), at(POSTER_AT)));
    console.log('poster → promo/reel-poster.png');

    const frameTimes = FRAME_AT.map(at).map((t) => +t.toFixed(2));
    fs.rmSync(FRAMES, { recursive: true, force: true });
    fs.mkdirSync(FRAMES, { recursive: true });
    let frameSource = 'canvas';
    if (!args.has('--no-record')) {
      console.log(`recording ${duration.toFixed(1)} s in real time…`);
      // the H.264 encoder sometimes drops a second of frames near the start (CPU contention); the picture then
      // freezes while the sound goes on. Check the frame durations in the file and record again if that happened.
      let rec, gap;
      for (let attempt = 1; ; attempt++) {
        rec = await page.evaluate((o) => window.REEL.record(o), { bps: BITRATE, voice: plan.voice, duck: plan.duck, duckDb: DUCK_DB });
        await saveBlob(page, 'video', OUT);
        gap = videoFrameGaps(OUT);
        console.log(`video → promo/sal-hacham-reel.mp4  ${(rec.size / 1048576).toFixed(2)} MB, recorded in ${rec.wall.toFixed(1)} s wall time, ${gap.frames} frames in the file (${rec.frames} drawn, ${rec.slowFrames} slots missed), longest frame ${(gap.max * 1000).toFixed(0)} ms at ${gap.at.toFixed(2)} s, audio clock stall ${rec.clockStall.ms} ms, mime ${rec.mime}`);
        if (gap.max <= MAX_FRAME_GAP) break;
        if (attempt >= 4) throw new Error('the encoder keeps dropping frames; try again on an idle machine');
        console.log('  dropped frames, recording again…');
      }

      // verify: decode the MP4 itself (audio levels, voice onsets, frames, picture timing)
      const vp = await browser.newPage();
      await vp.goto(`${base}/promo/reel.html?mode=record`);
      await vp.waitForFunction(() => window.REEL && window.REEL.isReady === true, null, { timeout: 30000 });
      await vp.evaluate((d) => window.REEL.setTiming(d), timing.durations);
      await vp.evaluate((urls) => window.REEL_AUDIO.loadClips(urls), clipUrls);
      try {
        const audio = await vp.evaluate((o) => window.REEL_AUDIO.analyzeMix('/promo/sal-hacham-reel.mp4', o),
          { voice: plan.voice, duration, musicEnd: duration - 1.3 });
        const probes = timing.starts.map((s) => [0.4, 0.6, 0.8, 1.0, 1.2].map((d) => s + d));
        const res = await vp.evaluate(async ({ times, probes }) => {
          const v = document.createElement('video');
          v.muted = true; v.preload = 'auto'; v.src = '/promo/sal-hacham-reel.mp4';
          document.body.append(v);
          await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('video error ' + (v.error && v.error.code))); });
          let duration = v.duration;
          if (!Number.isFinite(duration)) { // MediaRecorder files may not carry a duration
            await new Promise((ok) => { v.ondurationchange = () => Number.isFinite(v.duration) && ok(); v.currentTime = 1e6; setTimeout(ok, 5000); });
            duration = v.duration;
          }
          // resolves with the timestamp of the frame actually presented after the seek
          const seek = (t) => new Promise((ok) => {
            let done = false;
            const fin = (mt) => { if (!done) { done = true; ok(mt); } };
            v.requestVideoFrameCallback((now, meta) => fin(meta.mediaTime));
            v.onseeked = () => setTimeout(() => fin(null), 1000);
            v.currentTime = t;
          });
          const c = document.createElement('canvas'); c.width = 1080; c.height = 1920;
          const x = c.getContext('2d');
          const frames = [];
          for (const t of times) { await seek(t); x.drawImage(v, 0, 0, 1080, 1920); frames.push(c.toDataURL('image/png')); }
          // picture timing: compare the decoded frame with the canvas rendered at t + d
          const sw = 90, sh = 160, sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
          const sx = sc.getContext('2d', { willReadFrequently: true });
          const gray = (src) => { sx.drawImage(src, 0, 0, sw, sh); const d = sx.getImageData(0, 0, sw, sh).data, g = new Float32Array(sw * sh); for (let i = 0; i < g.length; i++) g[i] = d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]; return g; };
          const canvas = document.getElementById('c');
          const video = [];
          for (const ts of probes) {
            const offs = [];
            for (const ts0 of ts) {
              const mt = await seek(ts0);
              const t = mt == null ? ts0 : mt;
              const f = gray(v);
              let best = { d: 0, e: Infinity };
              const tryAt = (d) => {
                window.REEL.draw(Math.max(0, t + d));
                const g = gray(canvas);
                let e = 0; for (let i = 0; i < g.length; i++) e += Math.abs(g[i] - f[i]);
                if (e < best.e) best = { d, e };
              };
              for (let d = -1.5; d <= 1.5001; d += 1 / 15) tryAt(d); // coarse, then fine around the best
              const c0 = best.d;
              for (let d = c0 - 0.07; d <= c0 + 0.0701; d += 1 / 120) tryAt(d);
              offs.push(-best.d); // > 0: the picture shows an earlier moment than planned (picture is late)
            }
            offs.sort((a, b) => a - b);
            video.push({ probes: ts, offsets: offs, offset: offs[2] });
          }
          return { duration, w: v.videoWidth, h: v.videoHeight, frames, video };
        }, { times: frameTimes, probes });
        res.frames.forEach((d, i) => writeDataUrl(path.join(FRAMES, `frame-${String(i + 1).padStart(2, '0')}.png`), d));
        frameSource = 'mp4';
        report({ res, audio, plan, timing, ids });
      } catch (e) {
        console.log('could not decode the MP4 in Chromium (' + e.message + ') — frames rendered from the canvas instead');
      }
      await vp.close();
    }
    if (frameSource === 'canvas') {
      for (const [i, t] of frameTimes.entries()) {
        writeDataUrl(path.join(FRAMES, `frame-${String(i + 1).padStart(2, '0')}.png`), await page.evaluate((tt) => window.REEL.renderPNG(tt), t));
      }
    }
    console.log(`frames (${frameSource}) → promo/frames/ at t = ${frameTimes.join(', ')} s`);
    if (errors.length) throw new Error('page errors:\n' + errors.join('\n'));
  } finally {
    await browser.close();
    server.close();
  }
}

function report({ res, audio, plan, timing, ids }) {
  const f = (x, n = 1) => Number(x).toFixed(n);
  console.log('\n== verification (decoded from the MP4) ==');
  console.log(`video ${res.w}x${res.h}, duration ${f(res.duration, 2)} s; audio track: ${audio.channels} ch @ ${audio.sampleRate} Hz, ${f(audio.duration, 2)} s`);
  console.log(`max peak ${f(audio.peakDb)} dBFS ${audio.peakDb > -0.5 ? 'CLIPPING RISK' : '(ok, below -0.5)'}`);
  console.log(`RMS per second (dBFS): ${audio.timeline.join(' ')}`);
  console.log('scene      start  voice onset planned -> measured (delta)   voice RMS  picture delta  A/V delta');
  const avs = [];
  ids.forEach((id, i) => {
    const c = audio.clips[i], v = res.video[i], av = c.offset - v.offset;
    avs.push(av);
    console.log(`${id.padEnd(10)} ${f(timing.starts[i], 2).padStart(5)}  ${f(c.expectedOnset, 3)} -> ${f(c.measuredOnset, 3)} (${f(c.offset * 1000, 0)} ms, r=${f(c.corr, 2)})   ${f(c.voiceRmsDb)} dB   ${f(v.offset * 1000, 0).padStart(5)} ms [${v.offsets.map((o) => f(o * 1000, 0)).join('/')}]   ${f(av * 1000, 0).padStart(5)} ms`);
  });
  console.log('music-only windows (s: RMS dBFS): ' + audio.gaps.map((g) => `${f(g.from, 1)}-${f(g.to, 1)}: ${f(g.rmsDb)}`).join(', '));
  const worst = Math.max(...avs.map(Math.abs));
  console.log(`A/V sync: worst ${f(worst * 1000, 0)} ms ${worst <= 0.1 ? '(ok, within 100 ms)' : 'OUT OF TOLERANCE'}; ducking windows: ${plan.duck.length}`);
}

await main();
