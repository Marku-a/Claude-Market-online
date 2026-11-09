// Text helpers: normalization, similarity, list-line parsing. Pure, browser-compatible.

// Hebrew punctuation (maqaf, paseq, sof pasuq, nun hafukha) separates words
const HEB_PUNCT = /[־׀׃׆]/g;
const NIQQUD = /[֑-ׇ]/g;
const NOT_WORD = /[^\p{L}\p{N}%\s]|_/gu;
const TRAIL_QTY = /^(.*?)\s*(?:(?<![A-Za-z])[xX]|[×*])\s*(\d+)\s*$/;
const LEAD_QTY = /^(\d+)\s+(.+)$/;

export function normalize(text) {
  let s = String(text ?? '');
  s = s.replace(HEB_PUNCT, ' ').replace(NIQQUD, '');
  s = s.replace(NOT_WORD, ' ').toLowerCase();
  return s.split(/\s+/).filter(Boolean).join(' ');
}

export function similarity(a, b) {
  const ta = new Set(normalize(a).split(' ').filter(Boolean));
  const tb = new Set(normalize(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// -> { raw, query, qty: number|null } or null for blank/comment lines
export function parseListLine(line) {
  const s = String(line ?? '').trim();
  if (!s || s.startsWith('#')) return null;
  let qty = null;
  let query = s;
  let m = LEAD_QTY.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 99) {
    qty = Number(m[1]);
    query = m[2].trim();
  } else {
    m = TRAIL_QTY.exec(s);
    if (m && m[1].trim() && Number(m[2]) >= 1 && Number(m[2]) <= 99) {
      qty = Number(m[2]);
      query = m[1].trim();
    }
  }
  return { raw: line, query, qty };
}

// Product key for matching: barcode if present, else normalized name.
export function productKey(p) {
  return p && p.barcode ? String(p.barcode) : normalize(p && p.name);
}
