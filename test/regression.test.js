'use strict';
// Regression tests for the server.js bugfix audit. Each block names the bug
// it pins. HTTP-level tests run against an ephemeral listener; the simulator
// never starts under require (require.main !== module), so `payments`
// starts empty in this process.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const server = require('../server.js');
const {
  app, normalizePhone, maskPhone, parseTransactionDate, isToday,
  addPayment, clients, _tokenCache, getAccessToken,
} = server;

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

async function req(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { parsed = null; }
  return { status: res.status, body: parsed };
}
const post = (p, b) => req('POST', p, b);
const get = (p) => req('GET', p);
const getStats = async () => (await get('/api/stats')).body;
// Daraja TransactionDate is a Nairobi wall-clock stamp; build one for "now".
function nairobiStamp(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return parts.year + parts.month + parts.day + parts.hour + parts.minute + parts.second;
}
// Route only upstream Daraja traffic to a mock; local test HTTP must still
// reach the ephemeral server (both go through globalThis.fetch).
const darajaOnly = (impl) => async (url, opts) => {
  if (String(url).startsWith(base)) return realFetch(url, opts);
  return impl(url, opts);
};
async function pollUntil(fn, ms, step = 25) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() >= deadline) return fn();
    await new Promise((r) => setTimeout(r, step));
  }
  return true;
}
const realFetch = globalThis.fetch;
describe('maskPhone dead-branch fix (server.js maskPhone)', () => {
  it("treats 254.. and +254.. identically ('0712***678')", () => {
    assert.equal(maskPhone('254712345678'), '0712***678');
    assert.equal(maskPhone('+254712345678'), '0712***678');
    assert.equal(maskPhone('0712345678'), '0712***678');
  });
  it('passes short values through unmasked', () => {
    assert.equal(maskPhone('12345'), '12345');
  });
});

describe('normalizePhone allowlist fix (server.js normalizePhone)', () => {
  it('rejects letters even when the digit residue looks valid', () => {
    // Old code stripped non-digits then accepted: residue '0712345678'.
    assert.equal(normalizePhone('07a1b2c3d4e5f6g7h8'), null);
    assert.equal(normalizePhone('0712ABCD5678'), null);
  });
  it('still accepts benign separators', () => {
    assert.equal(normalizePhone('+254 712 345 678'), '254712345678');
    assert.equal(normalizePhone('(0712) 345-678'), '254712345678');
    assert.equal(normalizePhone('0712345678'), '254712345678');
  });
});

describe('parseTransactionDate EAT + range fix (server.js parseTransactionDate)', () => {
  it('interprets Daraja stamps as Africa/Nairobi wall-clock', () => {
    // 19:30:00 EAT == 16:30:00Z. Old code used server-local tz (UTC here).
    assert.equal(parseTransactionDate('20241025193000'), '2024-10-25T16:30:00.000Z');
  });
  it('falls back to now on out-of-range components instead of rolling over', () => {
    const before = Date.now();
    // Month 13: old code normalized into January of the next year.
    const m13 = parseTransactionDate('20241325193000');
    const rolled13 = new Date(2024, 12, 25, 19, 30, 0).toISOString();
    assert.ok(Math.abs(new Date(m13).getTime() - before) < 120_000, `got ${m13}`);
    assert.notEqual(m13, rolled13);
    // Feb 30: old code normalized into March.
    const f30 = parseTransactionDate('20240230193000');
    const rolled30 = new Date(2024, 1, 30, 19, 30, 0).toISOString();
    assert.ok(Math.abs(new Date(f30).getTime() - before) < 120_000, `got ${f30}`);
    assert.notEqual(f30, rolled30);
  });
  it('passes ISO input and null through the old paths', () => {
    assert.equal(parseTransactionDate('2024-01-02T03:04:05.000Z'), '2024-01-02T03:04:05.000Z');
    assert.ok(Math.abs(new Date(parseTransactionDate(null)).getTime() - Date.now()) < 120_000);
  });
});

describe('isToday Nairobi-day fix (server.js isToday)', () => {
  it('matches the current instant and rejects garbage/epoch', () => {
    assert.equal(isToday(new Date().toISOString()), true);
    assert.equal(isToday('not-a-date'), false);
    assert.equal(isToday('1970-01-01T00:00:00.000Z'), false);
  });
});

describe('callback tolerance fix (POST /callback non-array Item)', () => {
  it('records a zero-amount success when CallbackMetadata.Item is an object, not an array', async () => {
    const before = await getStats();
    const r = await post('/callback', {
      Body: { stkCallback: { ResultCode: 0, CheckoutRequestID: 'ws_CO_obj', CallbackMetadata: { Item: { Name: 'Amount', Value: 250 } } } },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ResultCode: 0, ResultDesc: 'Accepted' });
    const after = await getStats();
    // Old code threw on `for..of` over a non-array and recorded nothing.
    assert.equal(after.count - before.count, 1);
  });
  it('accepts a callback with no metadata as a zero-amount failure', async () => {
    const before = await getStats();
    const r = await post('/callback', { Body: { stkCallback: { ResultCode: 1032, CheckoutRequestID: 'ws_CO_nometa' } } });
    assert.equal(r.status, 200);
    const after = await getStats();
    assert.equal(after.failed - before.failed, 1);
  });
  it('still accepts garbage bodies without recording anything', async () => {
    const before = await getStats();
    assert.equal((await post('/callback', {})).status, 200);
    assert.equal((await post('/callback', { Body: {} })).status, 200);
    const after = await getStats();
    assert.equal(after.count, before.count);
    assert.equal(after.failed, before.failed);
  });
  it('counts a Nairobi-stamped success in today stats', async () => {
    const before = await getStats();
    await post('/callback', {
      Body: {
        stkCallback: {
          ResultCode: 0, CheckoutRequestID: 'ws_CO_nbo',
          CallbackMetadata: { Item: [{ Name: 'Amount', Value: 250 }, { Name: 'MpesaReceiptNumber', Value: 'QHXNBO1' }, { Name: 'PhoneNumber', Value: 254712345678 }, { Name: 'TransactionDate', Value: nairobiStamp() }] },
        },
      },
    });
    const after = await getStats();
    assert.equal(after.count - before.count, 1);
    assert.equal(after.sum - before.sum, 250);
  });
});

describe('query input validation fix (GET /api/payments limit, /api/pay/:id)', () => {
  it('parses limits strictly and caps them', async () => {
    assert.equal((await get('/api/payments?limit=5')).status, 200);
    assert.equal((await get('/api/payments?limit=abc')).status, 200);
    assert.equal((await get('/api/payments?limit=-5')).status, 200);
    assert.equal((await get('/api/payments?limit=20abc')).status, 200);
    const huge = await get('/api/payments?limit=999999999');
    assert.equal(huge.status, 200);
    assert.ok(huge.body.length <= 100);
  });
  it('rejects absurd checkoutRequestIDs without proxying upstream', async () => {
    process.env.MPESA_CONSUMER_KEY = 'k';
    process.env.MPESA_CONSUMER_SECRET = 's';
    process.env.MPESA_SHORTCODE = '174379';
    process.env.MPESA_PASSKEY = 'p';
    try {
      const r = await get('/api/pay/' + 'x'.repeat(201));
      assert.equal(r.status, 400);
      assert.deepEqual(r.body, { error: 'invalid-checkoutRequestID' });
    } finally {
      delete process.env.MPESA_CONSUMER_KEY;
      delete process.env.MPESA_CONSUMER_SECRET;
      delete process.env.MPESA_SHORTCODE;
      delete process.env.MPESA_PASSKEY;
    }
  });
});

describe('token cache ttl + error-path fix (server.js getAccessToken)', () => {
  const realFetch = globalThis.fetch;
  const savedCache = { token: _tokenCache.token, expiresAt: _tokenCache.expiresAt };
  const savedEnv = {
    MPESA_CONSUMER_KEY: process.env.MPESA_CONSUMER_KEY,
    MPESA_CONSUMER_SECRET: process.env.MPESA_CONSUMER_SECRET,
    MPESA_SHORTCODE: process.env.MPESA_SHORTCODE,
    MPESA_PASSKEY: process.env.MPESA_PASSKEY,
  };
  after(() => {
    globalThis.fetch = realFetch;
    _tokenCache.token = savedCache.token;
    _tokenCache.expiresAt = savedCache.expiresAt;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it(' Caches the token and defaults zero/garbage ttls to ~3599s', async () => {
    process.env.MPESA_CONSUMER_KEY = 'k';
    process.env.MPESA_CONSUMER_SECRET = 's';
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-a', expires_in: 3600 }) };
    };
    _tokenCache.token = null; _tokenCache.expiresAt = 0;
    assert.equal(await getAccessToken(), 'tok-a');
    assert.equal(await getAccessToken(), 'tok-a');
    assert.equal(calls, 1);

    // expires_in 0: old code cached an already-expired entry (fetch thrash).
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'tok-b', expires_in: 0 }) });
    _tokenCache.token = null; _tokenCache.expiresAt = 0;
    assert.equal(await getAccessToken(), 'tok-b');
    const skew = _tokenCache.expiresAt - Date.now();
    assert.ok(skew > 3_500_000 && skew <= 3_599_000, `ttl skew ${skew}`);
    // Cached: no refetch needed within the window.
    assert.equal(await getAccessToken(), 'tok-b');
  });
  it('throws with status and leaves the cache empty on token failure', async () => {
    process.env.MPESA_CONSUMER_KEY = 'k';
    process.env.MPESA_CONSUMER_SECRET = 's';
    globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error_description: 'bad client' }) });
    _tokenCache.token = null; _tokenCache.expiresAt = 0;
    await assert.rejects(getAccessToken(), (e) => {
      assert.equal(e.status, 401);
      assert.deepEqual(e.daraja, { error_description: 'bad client' });
      return true;
    });
    assert.equal(_tokenCache.token, null);
  });
  it('fails closed without network when credentials are missing', async () => {
    delete process.env.MPESA_CONSUMER_KEY;
    delete process.env.MPESA_CONSUMER_SECRET;
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; throw new Error('must not dial'); };
    _tokenCache.token = null; _tokenCache.expiresAt = 0;
    await assert.rejects(getAccessToken(), (e) => e.daraja && e.daraja.errorMessage === 'not-configured');
    assert.equal(calls, 0);
  });
  it('surfaces OAuth error_description through /api/pay query errors', async () => {
    process.env.MPESA_CONSUMER_KEY = 'k';
    process.env.MPESA_CONSUMER_SECRET = 's';
    process.env.MPESA_SHORTCODE = '174379';
    process.env.MPESA_PASSKEY = 'p';
    globalThis.fetch = darajaOnly(async () => ({ ok: false, status: 400, json: async () => ({ error_description: 'Invalid grant' }) }));
    _tokenCache.token = null; _tokenCache.expiresAt = 0;
    // Old code dropped error_description and returned 'token request failed'.
    const r = await get('/api/pay/ws_CO_desc');
    assert.equal(r.status, 502);
    assert.equal(r.body.errorMessage, 'Invalid grant');
  });
});

describe('/api/pay validation + query passthrough (configured paths)', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  it('returns 501 unconfigured, 400 on bad phone/amount when configured', async () => {
    delete process.env.MPESA_CONSUMER_KEY;
    assert.deepEqual((await post('/api/pay', { phone: '0712345678', amount: 100 })).body, { error: 'not-configured', hint: 'set Daraja env vars' });
    process.env.MPESA_CONSUMER_KEY = 'k';
    process.env.MPESA_CONSUMER_SECRET = 's';
    process.env.MPESA_SHORTCODE = '174379';
    process.env.MPESA_PASSKEY = 'p';
    try {
      assert.deepEqual((await post('/api/pay', { phone: '123', amount: 100 })).body, { error: 'invalid-phone' });
      assert.deepEqual((await post('/api/pay', { phone: '0712345678', amount: 0 })).body, { error: 'invalid-amount' });
      assert.deepEqual((await post('/api/pay', { phone: '0712345678', amount: 1.5 })).body, { error: 'invalid-amount' });
      // Letters must not verify even though the digit residue is dialable.
      assert.deepEqual((await post('/api/pay', { phone: '07a1b2c3d4e5f6g7h8', amount: 100 })).body, { error: 'invalid-phone' });
    } finally {
      delete process.env.MPESA_CONSUMER_KEY;
      delete process.env.MPESA_CONSUMER_SECRET;
      delete process.env.MPESA_SHORTCODE;
      delete process.env.MPESA_PASSKEY;
    }
  });
  it('proxies a query and maps ResultCode 1032 to pending', async () => {
    process.env.MPESA_CONSUMER_KEY = 'k';
    process.env.MPESA_CONSUMER_SECRET = 's';
    process.env.MPESA_SHORTCODE = '174379';
    process.env.MPESA_PASSKEY = 'p';
    let seenId = null;
    globalThis.fetch = darajaOnly(async (url, opts) => {
      if (String(url).includes('/oauth/')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok-q', expires_in: 3600 }) };
      seenId = JSON.parse(opts.body).CheckoutRequestID;
      return { ok: true, status: 200, json: async () => ({ ResponseCode: '0', ResultCode: '1032', ResultDesc: 'cancelled' }) };
    });
    _tokenCache.token = null; _tokenCache.expiresAt = 0;
    try {
      const r = await get('/api/pay/ws_CO_abc123');
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'pending');
      assert.equal(seenId, 'ws_CO_abc123');
    } finally {
      globalThis.fetch = realFetch;
      _tokenCache.token = null; _tokenCache.expiresAt = 0;
      delete process.env.MPESA_CONSUMER_KEY;
      delete process.env.MPESA_CONSUMER_SECRET;
      delete process.env.MPESA_SHORTCODE;
      delete process.env.MPESA_PASSKEY;
    }
  });
});

describe('SSE lifecycle fix (server.js addPayment broadcast + /events)', () => {
  it('streams a callback payment to an open /events client', async () => {
    const ctrl = new AbortController();
    const res = await fetch(base + '/events', { signal: ctrl.signal, headers: { Accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    // One continuous pump: breaking a for-await loop cancels the stream,
    // so observe via a shared buffer instead of two sequential loops.
    let buf = '';
    const pump = (async () => {
      try {
        for await (const chunk of res.body) buf += Buffer.from(chunk).toString();
      } catch { /* abort ends the pump */ }
    })();
    try {
      assert.ok(await pollUntil(() => buf.includes(': connected'), 5000), 'no SSE preamble');
      const id = 'QHXSSE' + Date.now();
      await post('/callback', {
        Body: {
          stkCallback: {
            ResultCode: 0, CheckoutRequestID: 'ws_CO_sse',
            CallbackMetadata: { Item: [{ Name: 'Amount', Value: 50 }, { Name: 'MpesaReceiptNumber', Value: id }, { Name: 'PhoneNumber', Value: '254712345678' }, { Name: 'TransactionDate', Value: nairobiStamp() }] },
          },
        },
      });
      assert.ok(await pollUntil(() => buf.includes('event: payment'), 5000), 'no payment event');
      assert.ok(buf.includes(id), `stream missing ${id}: ${buf.slice(0, 200)}`);
    } finally {
      ctrl.abort();
      await pump;
    }
    assert.ok(await pollUntil(() => clients.size === 0, 2000), 'SSE client leaked');
  });
  it('prunes dead clients instead of leaking them', () => {
    const dead = { destroyed: true, writableEnded: false, write() { throw new Error('must not be called'); } };
    const broken = { destroyed: false, writableEnded: false, write() { throw new Error('EPIPE'); } };
    clients.add(dead);
    clients.add(broken);
    addPayment({ payer: 't', amount: 7, phone: 'p', time: new Date().toISOString(), transactionId: 'QHXPRUNE', success: true });
    assert.ok(!clients.has(dead));
    assert.ok(!clients.has(broken));
    assert.equal(clients.size, 0);
  });
});

describe('stats aggregation fix (server.js /api/stats biggest + limit cap)', () => {
  it('compares biggest numerically, not lexicographically', async () => {
    // '500' > '1000' as strings; old code crowned the 500 payment.
    // Runs before the cap test fills the 100-entry store (else eviction
    // would swallow the count delta).
    const before = await getStats();
    addPayment({ payer: 's1', amount: '500', phone: 'p', time: new Date().toISOString(), transactionId: 'QHXS1', success: true });
    addPayment({ payer: 's2', amount: '1000', phone: 'p', time: new Date().toISOString(), transactionId: 'QHXS2', success: true });
    const after = await getStats();
    assert.equal(after.count - before.count, 2);
    assert.equal(after.sum - before.sum, 1500);
    assert.equal(Number(after.biggest.amount), 1000);
    assert.equal(after.biggest.transactionId, 'QHXS2');
  });
  it('caps stored and returned payments at 100', async () => {
    for (let i = 0; i < 110; i++) {
      addPayment({ payer: 'bulk', amount: 7, phone: 'p', time: new Date().toISOString(), transactionId: 'QHXB' + i, success: true });
    }
    const r = await get('/api/payments?limit=999999999');
    assert.equal(r.body.length, 100);
    assert.equal((await get('/api/payments?limit=5')).body.length, 5);
  });
});
