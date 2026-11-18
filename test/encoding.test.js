'use strict';
// Content-encoding handling: a `br` (Brotli) body must be decoded like gzip,
// and genuinely unsupported encodings must fail with a clean JSON 415 rather
// than an HTML stack trace in the logs.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { app } = require('../server.js');

let srv;
let base;
before(async () => {
  srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(async () => {
  await new Promise((resolve) => srv.close(resolve));
});

describe('content-encoding handling', () => {
  it('accepts a Brotli-compressed JSON callback', async () => {
    const payload = { Body: { stkCallback: { ResultCode: 1, CheckoutRequestID: 'br-test-1' } } };
    const body = zlib.brotliCompressSync(Buffer.from(JSON.stringify(payload)));
    const res = await fetch(base + '/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ResultCode: 0, ResultDesc: 'Accepted' });
  });

  it('still accepts gzip and deflate', async () => {
    const payload = { Body: { stkCallback: { ResultCode: 1, CheckoutRequestID: 'gz-test' } } };
    for (const [enc, compress] of [
      ['gzip', zlib.gzipSync],
      ['deflate', zlib.deflateSync],
    ]) {
      const body = compress(Buffer.from(JSON.stringify(payload)));
      const res = await fetch(base + '/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': enc },
        body,
      });
      assert.equal(res.status, 200, enc);
    }
  });

  it('returns a clean JSON 415 for an encoding we cannot decode', async () => {
    const res = await fetch(base + '/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'zstd' },
      body: Buffer.from('{}'),
    });
    assert.equal(res.status, 415);
    const text = await res.text();
    assert.ok(!text.includes('<html'), 'must not return an HTML error page');
    assert.ok(!text.includes('body-parser'), 'must not leak a stack trace');
    const j = JSON.parse(text);
    assert.equal(j.error, 'unsupported-content-encoding');
  });
});

describe('Daraja callback URL construction', () => {
  it('appends /callback to a bare PUBLIC_URL base', async () => {
    // Set a bare base URL (as the README instructs) and capture the STK body.
    process.env.PUBLIC_URL = 'https://confetti.spidmax.win';
    process.env.MPESA_CONSUMER_KEY = 'k';
    process.env.MPESA_CONSUMER_SECRET = 's';
    process.env.MPESA_SHORTCODE = '174379';
    process.env.MPESA_PASSKEY = 'p';
    const orig = globalThis.fetch;
    let sentBody;
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('processrequest')) {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ ResponseCode: '0', CheckoutRequestID: 'cburl-test', CustomerMessage: 'ok' }) };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
    };
    try {
      // Use the ORIGINAL fetch for the local request; the stub is only for
      // the server's outbound Daraja calls.
      const res = await orig(base + '/api/pay', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '0712345678', amount: 100 }),
      });
      assert.equal(res.status, 200);
      assert.equal(sentBody.CallBackURL, 'https://confetti.spidmax.win/callback',
        'Daraja must POST to /callback, not the site root');
    } finally {
      globalThis.fetch = orig;
      delete process.env.PUBLIC_URL;
      delete process.env.MPESA_CONSUMER_KEY;
      delete process.env.MPESA_CONSUMER_SECRET;
      delete process.env.MPESA_SHORTCODE;
      delete process.env.MPESA_PASSKEY;
    }
  });
});
