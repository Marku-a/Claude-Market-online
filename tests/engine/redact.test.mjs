import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactShape } from '../../extension/diag/redact.js';

describe('redactShape', () => {
  test('primitives and nesting', () => {
    assert.deepEqual(redactShape({ a: 'hello', b: 12.5, c: true, d: null, e: { f: 'xy' } }),
      { a: '<string:5>', b: '<number>', c: '<boolean>', d: null, e: { f: '<string:2>' } });
  });
  test('arrays keep first element and a marker', () => {
    assert.deepEqual(redactShape({ items: [{ n: 'a' }, { n: 'b' }, { n: 'c' }] }),
      { items: [{ n: '<string:1>' }, '<+2 more>'] });
    assert.deepEqual(redactShape({ x: [1] }), { x: ['<number>'] });
    assert.deepEqual(redactShape({ x: [] }), { x: [] });
  });
  test('sensitive keys redacted regardless of type', () => {
    const r = redactShape({ accessToken: 'abc', Cookie: 1, user: { email: 'a@b.c', phone: 5, address: { city: 'x' }, ok: true },
      password: null, cardNumber: [1, 2], sessionId: { a: 1 } });
    assert.equal(r.accessToken, '<redacted>');
    assert.equal(r.Cookie, '<redacted>');
    assert.equal(r.user.email, '<redacted>');
    assert.equal(r.user.phone, '<redacted>');
    assert.equal(r.user.address, '<redacted>');
    assert.equal(r.user.ok, '<boolean>');
    assert.equal(r.password, '<redacted>');
    assert.equal(r.cardNumber, '<redacted>');
    assert.equal(r.sessionId, '<redacted>');
  });
  test('depth limited', () => {
    assert.deepEqual(redactShape({ a: { b: { c: { d: 1 } } } }, 3), { a: { b: { c: '<…>' } } });
    assert.deepEqual(redactShape({ a: [[1]] }, 2), { a: ['<…>'] });
  });
  test('no original string value survives', () => {
    const secrets = ['s3cr3t-token-value', 'Dizengoff 99', 'דנה כהן', 'milk-brand-xyz', '0501234567'];
    const out = JSON.stringify(redactShape({
      auth: { token: secrets[0] }, addr: { street: secrets[1] }, name: secrets[2],
      list: [{ brand: secrets[3] }, { brand: 'other-secret' }], contact: { phone: secrets[4] },
      deep: { a: { b: { c: { d: { e: { f: { g: 'deep-secret' } } } } } } },
    }));
    for (const s of [...secrets, 'other-secret', 'deep-secret']) assert.ok(!out.includes(s), s);
  });
  test('does not mutate input', () => {
    const v = { a: [1, 2], token: 'x' };
    redactShape(v);
    assert.deepEqual(v, { a: [1, 2], token: 'x' });
  });
});

import { test as _t } from 'node:test';
import _a from 'node:assert/strict';
import { redactShape as _r } from '../../extension/diag/redact.js';
_t('redactShape hides data used as object keys', () => {
  const out = JSON.stringify(_r({ items: { 7290000042435: '2.00', 425127: '1.00', 'dana@example.com': 1 } }));
  _a.ok(!out.includes('7290000042435') && !out.includes('425127') && !out.includes('dana@'));
  _a.ok(out.includes('<key>'));
});
