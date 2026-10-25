'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const server = require('../server.js');
const { normalizePhone, buildStkPassword } = server;

describe('daraja helpers export contract', () => {
  it('exports normalizePhone and buildStkPassword functions', () => {
    assert.equal(typeof normalizePhone, 'function');
    assert.equal(typeof buildStkPassword, 'function');
  });
});

describe('normalizePhone', () => {
  it('maps 07.. local format to 254', () => {
    assert.equal(normalizePhone('0712345678'), '254712345678');
  });
  it('maps 01.. local format to 254', () => {
    assert.equal(normalizePhone('0112345678'), '254112345678');
  });
  it('passes through full 254.. form', () => {
    assert.equal(normalizePhone('254712345678'), '254712345678');
  });
  it('prefixes bare 9-digit 7.. form', () => {
    assert.equal(normalizePhone('712345678'), '254712345678');
  });
  it('strips leading + from +254.. form', () => {
    assert.equal(normalizePhone('+254712345678'), '254712345678');
  });
  it('returns null for invalid input', () => {
    assert.equal(normalizePhone('123'), null);
    assert.equal(normalizePhone('0251234567'), null);
    assert.equal(normalizePhone('07123'), null);
    assert.equal(normalizePhone(''), null);
  });
});

describe('buildStkPassword', () => {
  it('base64-encodes shortcode + passkey + timestamp', () => {
    const got = buildStkPassword('174379', 'abc', '20241025193000');
    const want = Buffer.from('174379abc20241025193000', 'utf8').toString('base64');
    assert.equal(got, want);
    assert.equal(Buffer.from(got, 'base64').toString('utf8'), '174379abc20241025193000');
  });
  it('validates optional timestamp helper shape when exported', () => {
    const stamp = server.buildStkTimestamp || server.stkTimestamp || server.formatTimestamp || null;
    if (stamp == null) return;
    assert.match(stamp(), /^[0-9]{14}$/);
  });
});
