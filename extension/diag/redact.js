// Redacts a raw response to its shape: keys kept, values replaced by type markers.
const SENSITIVE = /token|auth|pass|secret|session|cookie|card|cvv|phone|email|address|tz|id_number/i;

export function redactShape(value, depth = 6) {
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (depth <= 0) return '<…>';
    if (!value.length) return [];
    const out = [redactShape(value[0], depth - 1)];
    if (value.length > 1) out.push(`<+${value.length - 1} more>`);
    return out;
  }
  switch (typeof value) {
    case 'string': return `<string:${value.length}>`;
    case 'number': return '<number>';
    case 'boolean': return '<boolean>';
    case 'object': {
      if (depth <= 0) return '<…>';
      const out = {};
      // Keys can be data too (ids, barcodes, e-mails used as map keys): keep only identifier-like names.
      let dataKeys = 0;
      for (const [k, v] of Object.entries(value)) {
        if (!/^[A-Za-z_][A-Za-z0-9_\-]{0,39}$/.test(k)) {
          if (dataKeys++ === 0) out['<key>'] = redactShape(v, depth - 1);
          continue;
        }
        out[k] = SENSITIVE.test(k) ? '<redacted>' : redactShape(v, depth - 1);
      }
      if (dataKeys > 1) out['<+keys>'] = dataKeys - 1;
      return out;
    }
    default: return `<${typeof value}>`;
  }
}
