// Audio for the promo reel (used by reel.html and tools/make-reel.mjs):
//  - loadClips: decode the voice-over clips (promo/audio/vo-XX.mp3) and measure them
//  - composeMusic: an ORIGINAL background track, composed procedurally with an OfflineAudioContext
//    (drums, bass, pads and plucks in D major, 116 BPM). Nothing is sampled, so there is no licence to clear.
//  - wav: 16-bit PCM WAV export
//  - analyzeMix: measure the audio of the finished MP4 (levels, peaks, voice onsets)
'use strict';
(() => {
  const SR = 48000;
  const dB = (x) => 20 * Math.log10(Math.max(x, 1e-9));
  const A = { SR, clips: [], music: null, blobs: {} };

  async function fetchBytes(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('cannot load ' + url + ' (' + r.status + ')');
    return r.arrayBuffer();
  }
  const decode = (bytes) => new OfflineAudioContext(2, 1, SR).decodeAudioData(bytes);

  // RMS envelope of the channel average, one value per `hop` seconds
  function envelope(buf, hop = 0.005, gain = 1) {
    const n = Math.floor(buf.length / (hop * buf.sampleRate));
    const step = Math.round(hop * buf.sampleRate);
    const chans = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * step; j < (i + 1) * step; j++) {
        let v = 0; for (const ch of chans) v += ch[j]; v /= chans.length;
        s += v * v;
      }
      env[i] = Math.sqrt(s / step) * gain;
    }
    return env;
  }
  function peakOf(buf) {
    let p = 0;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; } }
    return p;
  }
  const rmsRange = (env, hop, a, b) => {
    const i0 = Math.max(0, Math.floor(a / hop)), i1 = Math.min(env.length, Math.ceil(b / hop));
    let s = 0; for (let i = i0; i < i1; i++) s += env[i] * env[i];
    return i1 > i0 ? Math.sqrt(s / (i1 - i0)) : 0;
  };

  // ------------------------------------------------------------ voice clips
  async function loadClips(urls) {
    A.clips = await Promise.all(urls.map(async (u) => decode(await fetchBytes(u))));
    return A.clips.map((b) => {
      const hop = 0.005, env = envelope(b, hop), top = Math.max(...env), th = top * Math.pow(10, -32 / 20);
      let first = env.findIndex((v) => v > th), last = env.length - 1;
      while (last > 0 && env[last] <= th) last--;
      if (first < 0) first = 0;
      return { duration: b.duration, onset: first * hop, end: (last + 1) * hop, peak: peakOf(b), peakDb: dB(peakOf(b)) };
    });
  }

  // ------------------------------------------------------------ music
  function rng(seed) { // mulberry32: same "random" noise on every render
    return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  async function composeMusic(duration, { bpm = 116, peakDb = -9 } = {}) {
    const ac = new OfflineAudioContext(2, Math.ceil(duration * SR), SR);
    const beat = 60 / bpm, bar = 4 * beat, rand = rng(20261121);
    const bus = (v, to = master) => { const g = ac.createGain(); g.gain.value = v; g.connect(to); return g; };
    const master = ac.createGain(); master.connect(ac.destination);
    master.gain.setValueAtTime(0, 0);
    master.gain.linearRampToValueAtTime(1, 1.8); // gentle fade in
    master.gain.setValueAtTime(1, Math.max(1.8, duration - 1.2));
    master.gain.linearRampToValueAtTime(0, duration); // fade out
    const drums = bus(1), bassBus = bus(0.9), padBus = bus(0.8);
    // plucks get a soft dotted-eighth echo
    const pluckBus = bus(0.9), delay = ac.createDelay(1), fb = ac.createGain(), wet = bus(0.28);
    delay.delayTime.value = beat * 0.75; fb.gain.value = 0.3;
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
    pluckBus.connect(delay); delay.connect(lp); lp.connect(fb); fb.connect(delay); lp.connect(wet);
    const noise = ac.createBuffer(1, SR * 2, SR); { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1; }
    const pan = (p, to) => { const s = ac.createStereoPanner(); s.pan.value = p; s.connect(to); return s; };
    const env = (g, t, a, peak, dec, sus = 0.0001) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(Math.max(sus, 0.0001), t + a + dec); };

    function kick(t, v) {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.12);
      env(g, t, 0.004, v, 0.32); o.connect(g); g.connect(drums); o.start(t); o.stop(t + 0.4);
    }
    function noiseHit(t, v, type, f, q, dec, p = 0) {
      const s = ac.createBufferSource(), fl = ac.createBiquadFilter(), g = ac.createGain();
      s.buffer = noise; fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      env(g, t, 0.002, v, dec); s.connect(fl); fl.connect(g); g.connect(pan(p, drums));
      s.start(t, rand() * 1.5, dec + 0.05);
    }
    function snare(t, v) {
      noiseHit(t, v, 'bandpass', 1900, 0.7, 0.17);
      const o = ac.createOscillator(), g = ac.createGain(); o.type = 'triangle'; o.frequency.value = 190;
      env(g, t, 0.002, v * 0.5, 0.08); o.connect(g); g.connect(drums); o.start(t); o.stop(t + 0.15);
    }
    const hat = (t, v) => noiseHit(t, v, 'highpass', 7500, 0.6, 0.045, 0.25);
    function bass(t, m, len, v) {
      const o = ac.createOscillator(), s = ac.createOscillator(), f = ac.createBiquadFilter(), g = ac.createGain();
      o.type = 'triangle'; o.frequency.value = mtof(m); s.frequency.value = mtof(m);
      f.type = 'lowpass'; f.frequency.value = 700;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.01);
      g.gain.exponentialRampToValueAtTime(v * 0.5, t + len * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(f); s.connect(f); f.connect(g); g.connect(bassBus);
      o.start(t); s.start(t); o.stop(t + len + 0.02); s.stop(t + len + 0.02);
    }
    function pad(t, notes, len, v, rel = 0.6) {
      const f = ac.createBiquadFilter(), g = ac.createGain();
      f.type = 'lowpass'; f.frequency.value = 1300; f.Q.value = 0.3;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.35);
      g.gain.setValueAtTime(v, t + len); g.gain.exponentialRampToValueAtTime(0.0001, t + len + rel);
      f.connect(g); g.connect(padBus);
      notes.forEach((m) => [-7, 7].forEach((cents, k) => {
        const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = cents;
        o.connect(pan(k ? 0.45 : -0.45, f)); o.start(t); o.stop(t + len + rel + 0.05);
      }));
    }
    function pluck(t, m, v, p) {
      const o = ac.createOscillator(), o2 = ac.createOscillator(), g = ac.createGain();
      o.type = 'triangle'; o.frequency.value = mtof(m); o2.frequency.value = mtof(m + 12);
      const g2 = ac.createGain(); g2.gain.value = 0.3;
      env(g, t, 0.004, v, 0.38); o.connect(g); o2.connect(g2); g2.connect(g); g.connect(pan(p, pluckBus));
      o.start(t); o2.start(t); o.stop(t + 0.45); o2.stop(t + 0.45);
    }

    // I - V - vi - IV in D major, voice-led
    const PROG = [
      { root: 38, pad: [62, 66, 69], arp: [74, 78, 81, 78] },
      { root: 45, pad: [61, 64, 69], arp: [73, 76, 81, 76] },
      { root: 47, pad: [62, 66, 71], arp: [74, 78, 83, 78] },
      { root: 43, pad: [62, 67, 71], arp: [74, 79, 83, 79] },
    ];
    const nBars = Math.max(1, Math.floor((duration - 2.6) / bar)); // the last bar lands on a final chord
    for (let b = 0; b < nBars; b++) {
      const t0 = b * bar, ch = PROG[b % 4], intro = b < 2;
      pad(t0, ch.pad, bar - 0.05, 0.24, 0.35);
      for (let i = 0; i < 8; i++) {
        const t = t0 + i * beat / 2;
        if (b === 0 && i % 2) continue; // first bar: quarter-note plucks only
        pluck(t, ch.arp[i % 4], i % 2 ? 0.13 : 0.18, i % 2 ? 0.3 : -0.3);
      }
      if (b === 0) continue;
      // bass in eighths: R . R R8 R . R R5
      [[0, 0], [2, 0], [3, 12], [4, 0], [6, 0], [7, 7]].forEach(([s, iv]) => bass(t0 + s * beat / 2, ch.root + iv, beat * 0.45, intro ? 0.2 : 0.3));
      if (intro) continue;
      kick(t0, 0.42); kick(t0 + 2 * beat, 0.38);
      if (b % 2) kick(t0 + 2.5 * beat, 0.3);
      snare(t0 + beat, 0.22); snare(t0 + 3 * beat, 0.22);
      if (b % 4 === 3) { snare(t0 + 3.5 * beat, 0.14); snare(t0 + 3.75 * beat, 0.18); }
      for (let i = 0; i < 8; i++) hat(t0 + i * beat / 2, i % 2 ? 0.1 : 0.05);
    }
    // ending: one ringing tonic chord on the downbeat after the last bar
    const tEnd = nBars * bar, ringLen = Math.max(0.5, duration - tEnd - 1.0);
    kick(tEnd, 0.5);
    noiseHit(tEnd, 0.06, 'highpass', 5000, 0.4, 1.4, 0);
    pad(tEnd, [62, 66, 69, 74], ringLen, 0.2, 1.0);
    bass(tEnd, 38, Math.min(1.6, ringLen), 0.26);
    [74, 78, 81, 86].forEach((m, i) => pluck(tEnd + i * 0.03, m, 0.16, (i - 1.5) * 0.25));

    const buf = await ac.startRendering();
    const p = peakOf(buf), k = Math.pow(10, peakDb / 20) / p;
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= k; }
    A.music = buf;
    const e = envelope(buf, 0.05);
    A.blobs.music = wav(buf);
    return { duration: buf.duration, bpm, bars: nBars, finalChordAt: tEnd, peakDb: dB(peakOf(buf)), rmsDb: dB(rmsRange(e, 0.05, 3, tEnd)), wavSize: A.blobs.music.size };
  }

  function wav(buf) {
    const ch = buf.numberOfChannels, n = buf.length, out = new DataView(new ArrayBuffer(44 + n * ch * 2));
    const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, buf.sampleRate, true);
    out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
    str(36, 'data'); out.setUint32(40, n * ch * 2, true);
    const data = [...Array(ch).keys()].map((c) => buf.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, data[c][i])); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  // ------------------------------------------------------------ analysis of the finished file
  // voice: [{ clip, at, gain, on, off }] (times in the reel's timeline). For each clip the measured
  // onset is found by cross-correlating the clip's envelope with the mix envelope (±0.4 s).
  async function analyzeMix(url, { voice, duration, musicEnd }) {
    const buf = await decode(await fetchBytes(url));
    const hop = 0.005, env = envelope(buf, hop);
    const timeline = [];
    for (let t = 0; t < buf.duration; t += 1) timeline.push(Math.round(dB(rmsRange(env, hop, t, t + 1)) * 10) / 10);
    const clipsOut = voice.map((v) => {
      const ce = envelope(A.clips[v.clip], hop, v.gain), start = Math.round(v.at / hop);
      let best = { lag: 0, r: -2 };
      for (let L = -80; L <= 80; L++) {
        let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
        for (let i = 0; i < ce.length; i++) {
          const j = start + L + i; if (j < 0 || j >= env.length) continue;
          const x = ce[i], y = env[j]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
        }
        const r = (n * sxy - sx * sy) / Math.sqrt(Math.max(1e-12, (n * sxx - sx * sx) * (n * syy - sy * sy)));
        if (r > best.r) best = { lag: L * hop, r };
      }
      return { clip: v.clip, expectedOnset: v.on, measuredOnset: v.on + best.lag, offset: best.lag, corr: best.r,
        voiceRmsDb: dB(rmsRange(env, hop, v.on + best.lag, v.off + best.lag)) };
    });
    // music-only windows: before the first clip, between clips, after the last clip
    const gaps = [];
    const edges = [[0.4, voice[0].on - 0.25]];
    for (let i = 0; i + 1 < voice.length; i++) edges.push([voice[i].off + 0.2, voice[i + 1].on - 0.2]);
    edges.push([voice[voice.length - 1].off + 0.25, musicEnd]);
    for (const [a, b] of edges) if (b - a >= 0.15) gaps.push({ from: a, to: b, rmsDb: dB(rmsRange(env, hop, a, b)) });
    return {
      duration: buf.duration, channels: buf.numberOfChannels, sampleRate: buf.sampleRate,
      peakDb: dB(peakOf(buf)), timeline, clips: clipsOut, gaps, reelDuration: duration,
    };
  }

  Object.assign(A, { loadClips, composeMusic, analyzeMix, wav, envelope, dB });
  window.REEL_AUDIO = A;
})();
