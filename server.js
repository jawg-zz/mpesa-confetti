const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4100;

// body-parser (express.json) decodes gzip/deflate but rejects Brotli with a
// 415. Decode `br` up front when the body-parser version in use does not, so
// compressed callbacks do not fail or spew a stack trace into the logs.
const zlib = require('zlib');
app.use((req, res, next) => {
  if (String(req.headers['content-encoding'] || '').toLowerCase() !== 'br') return next();
  // body-parser >= 2 handles br natively; don't double-decode.
  let major = 0;
  try { major = Number(require('body-parser/package.json').version.split('.')[0]); } catch (e) { /* unknown */ }
  if (major >= 2) return next();
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try {
      const raw = zlib.brotliDecompressSync(Buffer.concat(chunks)).toString('utf8');
      req.body = raw.length ? JSON.parse(raw) : {};
      req._body = true; // tell body-parser this body is already consumed+parsed
      next();
    } catch (e) {
      res.status(400).json({ error: 'invalid-brotli-body' });
    }
  });
  req.on('error', () => { if (!res.headersSent) res.status(400).json({ error: 'invalid-brotli-body' }); });
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const payments = [];
const clients = new Set();

function maskPhone(raw) {
  // NOTE: non-digits are stripped first, so a '+254' prefix can never survive
  // to this point (the old else-if for it was dead code). '254…' → '0…'.
  let s = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (s.startsWith('254')) s = '0' + s.slice(3);
  if (s.length < 7) return s;
  return s.slice(0, 4) + '***' + s.slice(-3);
}

function parseTransactionDate(v) {
  if (v == null || v === '') return new Date().toISOString();
  const s = String(v).replace(/\D/g, '');
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) {
    const d = new Date(String(v));
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  }
  const Y = Number(m[1]), Mo = Number(m[2]), D = Number(m[3]);
  const H = Number(m[4]), Mi = Number(m[5]), S = Number(m[6]);
  // Daraja stamps are Africa/Nairobi wall-clock (UTC+3, no DST). Reject
  // out-of-range components instead of letting Date normalize the rollover
  // (e.g. month 13 silently becoming January of the next year).
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || H > 23 || Mi > 59 || S > 59) {
    return new Date().toISOString();
  }
  const ms = Date.UTC(Y, Mo - 1, D, H, Mi, S) - 3 * 3600 * 1000;
  // Round-trip in EAT terms to catch invalid day-of-month (e.g. Feb 30).
  const e = new Date(ms + 3 * 3600 * 1000);
  if (e.getUTCFullYear() !== Y || e.getUTCMonth() !== Mo - 1 || e.getUTCDate() !== D ||
    e.getUTCHours() !== H || e.getUTCMinutes() !== Mi || e.getUTCSeconds() !== S) {
    return new Date().toISOString();
  }
  return new Date(ms).toISOString();
}

function addPayment(p) {
  payments.push(p);
  if (payments.length > 100) payments.splice(0, payments.length - 100);
  const data = JSON.stringify(p);
  // Dead clients must be dropped here: a 'close' event can race a broadcast,
  // and an async socket error after res.write would otherwise throw
  // unhandled (ERR_UNHANDLED_ERROR) and leak the entry forever.
  for (const client of [...clients]) {
    if (client.destroyed || client.writableEnded) {
      clients.delete(client);
      continue;
    }
    try {
      client.write(`event: payment\ndata: ${data}\n\n`);
    } catch (e) {
      clients.delete(client);
    }
  }
  return p;
}

app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { /* ignore */ }
  }, 25000);
  const cleanup = () => {
    clearInterval(keepalive);
    clients.delete(res);
  };
  // 'error' must be observed: without a listener a post-close socket failure
  // crashes the process instead of just ending this stream.
  res.on('error', cleanup);
  req.on('close', cleanup);
});

app.post('/callback', (req, res) => {
  try {
    const cb = req.body && req.body.Body && req.body.Body.stkCallback;
    if (cb) {
      const success = Number(cb.ResultCode) === 0;
      const rawItems = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
      const items = Array.isArray(rawItems) ? rawItems : [];
      const meta = {};
      for (const it of items) {
        if (it && it.Name != null) meta[it.Name] = it.Value;
      }
      const amount = meta.Amount != null ? Number(meta.Amount) : 0;
      const transactionId = meta.MpesaReceiptNumber != null
        ? String(meta.MpesaReceiptNumber)
        : String(cb.CheckoutRequestID || cb.MerchantRequestID || Date.now());
      const phoneRaw = meta.PhoneNumber != null ? String(meta.PhoneNumber) : '';
      const masked = maskPhone(phoneRaw);
      addPayment({
        payer: 'M-Pesa ' + masked,
        amount: isNaN(amount) ? 0 : amount,
        phone: masked,
        time: parseTransactionDate(meta.TransactionDate),
        transactionId,
        success,
      });
    }
  } catch (e) { /* ignore malformed callbacks */ }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

function nairobiDayKey(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function isToday(iso) {
  // M-Pesa money moves on Nairobi wall-clock days. Comparing server-local
  // calendar days misattributes payments whenever TZ != Africa/Nairobi.
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  return nairobiDayKey(d) === nairobiDayKey(new Date());
}

app.get('/api/stats', (req, res) => {
  const today = payments.filter((p) => isToday(p.time));
  const ok = today.filter((p) => p.success);
  const failed = today.filter((p) => !p.success).length;
  const sum = ok.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  let biggest = null;
  for (const p of ok) {
    // Compare numerically: string amounts compare lexicographically
    // ('500' > '1000'), electing the wrong "biggest" payment.
    if (!biggest || Number(p.amount) > Number(biggest.amount)) {
      biggest = { amount: p.amount, payer: p.payer, transactionId: p.transactionId };
    }
  }
  res.json({ count: ok.length, sum, biggest, failed });
});

app.get('/api/payments', (req, res) => {
  const rawLimit = req.query.limit;
  // Strict Number(): parseInt('20abc') silently returned 20 and there was no
  // upper bound, so ?limit=9999999999 forced a maximal scan every request.
  let limit = (typeof rawLimit === 'string' || typeof rawLimit === 'number') ? Number(rawLimit) : NaN;
  if (!Number.isInteger(limit) || limit <= 0) limit = 20;
  limit = Math.min(limit, 100);
  res.json(payments.slice(-limit).reverse());
});

// Daraja (Safaricom) STK-push
function normalizePhone(raw) {
  const input = String(raw == null ? '' : raw);
  // Reject anything outside a plain phone shape instead of silently stripping
  // letters and accepting the residue (e.g. '07ab12cd5678' must not verify).
  if (/[^0-9+\s\-().]/.test(input)) return null;
  const s = input.replace(/\D/g, '');
  if (s.length === 10 && (s.startsWith('07') || s.startsWith('01'))) return '254' + s.slice(1);
  if (s.length === 12 && s.startsWith('254') && (s[3] === '7' || s[3] === '1')) return s;
  if (s.length === 9 && (s[0] === '7' || s[0] === '1')) return '254' + s;
  return null;
}

function buildStkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(String(shortcode) + String(passkey) + String(timestamp)).toString('base64');
}

function stampNow(d) {
  const t = d || new Date();
  const p = (n, l) => String(n).padStart(l || 2, '0');
  return t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

function darajaBaseUrl() {
  return process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function darajaConfigured() {
  return Boolean(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_SHORTCODE && process.env.MPESA_PASSKEY);
}

const _tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60000) return _tokenCache.token;
  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;
  if (!key || !secret) {
    const err = new Error('daraja token request failed');
    err.daraja = { errorMessage: 'not-configured' };
    throw err;
  }
  const creds = Buffer.from(key + ':' + secret).toString('base64');
  let res;
  try {
    res = await fetch(darajaBaseUrl() + '/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: 'Basic ' + creds },
    });
  } catch (e) {
    const err = new Error('daraja token request failed');
    err.daraja = { errorMessage: String((e && e.message) || e) };
    throw err;
  }
  let body = {};
  try { body = await res.json(); } catch (e) { body = {}; }
  if (!res.ok || !body.access_token) {
    const err = new Error('daraja token request failed');
    err.daraja = body;
    err.status = res.status;
    throw err;
  }
  // expires_in is authoritative. The old `isNaN(ttl) ? 3599 : Number(ttl)`
  // cached 0/negative/garbage ttls as already-expired entries (fetch thrash)
  // and cached Infinity forever (stale token reuse).
  const ttl = Number(body.expires_in);
  const ttlSafe = (Number.isFinite(ttl) && ttl > 0) ? ttl : 3599;
  _tokenCache.token = body.access_token;
  _tokenCache.expiresAt = Date.now() + ttlSafe * 1000;
  return _tokenCache.token;
}

function darajaErrorPayload(body, res) {
  const msg = (body && (body.errorMessage || body.ResponseDescription || body.error_description)) ||
    ('Daraja request failed' + (res ? ' (HTTP ' + res.status + ')' : ''));
  return { errorMessage: msg, detail: body };
}

app.post('/api/pay', async (req, res) => {
  if (!darajaConfigured()) {
    return res.status(501).json({ error: 'not-configured', hint: 'set Daraja env vars' });
  }
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'invalid-phone' });
  const amount = Number(req.body && req.body.amount);
  if (!Number.isInteger(amount) || amount < 1 || amount > 150000) {
    return res.status(400).json({ error: 'invalid-amount' });
  }
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const stamp = stampNow();
  const txType = process.env.MPESA_TYPE || 'CustomerPayBillOnline';
  const callBackURL = process.env.PUBLIC_URL || 'https://confetti.spidmax.win/callback';
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    const d = (e && e.daraja) || {};
    return res.status(502).json({ errorMessage: d.errorMessage || d.ResponseDescription || d.error_description || 'token request failed' });
  }
  let resp;
  try {
    resp = await fetch(darajaBaseUrl() + '/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: buildStkPassword(shortcode, passkey, stamp),
        Timestamp: stamp,
        TransactionType: txType,
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
        PhoneNumber: phone,
        CallBackURL: callBackURL,
        AccountReference: 'mpesa-confetti',
        TransactionDesc: 'payment',
      }),
    });
  } catch (e) {
    return res.status(502).json({ errorMessage: String((e && e.message) || e) });
  }
  let body = {};
  try { body = await resp.json(); } catch (e) { body = {}; }
  if (!resp.ok || String(body.ResponseCode) !== '0') {
    const p = darajaErrorPayload(body, resp);
    return res.status(502).json(p);
  }
  return res.json({ checkoutRequestID: body.CheckoutRequestID, customerMessage: body.CustomerMessage });
});

app.get('/api/pay/:checkoutRequestID', async (req, res) => {
  if (!darajaConfigured()) {
    return res.status(501).json({ error: 'not-configured', hint: 'set Daraja env vars' });
  }
  // The ID is forwarded to Daraja verbatim; reject empty/absurd values here
  // instead of proxying junk (or a multi-MB path) upstream.
  const checkoutRequestID = String(req.params.checkoutRequestID || '');
  if (!checkoutRequestID || checkoutRequestID.length > 200) {
    return res.status(400).json({ error: 'invalid-checkoutRequestID' });
  }
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const stamp = stampNow();
  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    const d = (e && e.daraja) || {};
    return res.status(502).json({ errorMessage: d.errorMessage || d.ResponseDescription || d.error_description || 'token request failed' });
  }
  let resp;
  try {
    resp = await fetch(darajaBaseUrl() + '/mpesa/stkpushquery/v1/query', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        CheckoutRequestID: checkoutRequestID,
        Password: buildStkPassword(shortcode, passkey, stamp),
        Timestamp: stamp,
      }),
    });
  } catch (e) {
    return res.status(502).json({ errorMessage: String((e && e.message) || e) });
  }
  let body = {};
  try { body = await resp.json(); } catch (e) { body = {}; }
  if (!resp.ok || String(body.ResponseCode) !== '0') {
    const p = darajaErrorPayload(body, resp);
    return res.status(502).json(p);
  }
  const rc = Number(body.ResultCode);
  if (rc === 0) return res.json({ status: 'confirmed', resultCode: body.ResultCode, resultDesc: body.ResultDesc, raw: body });
  if (rc === 1032 || rc === 1 || rc === 1037) return res.json({ status: 'pending', resultCode: body.ResultCode, resultDesc: body.ResultDesc });
  return res.json({ status: 'failed', resultCode: body.ResultCode, resultDesc: body.ResultDesc });
});

// Simulator
const NAMES = ['Wanjiku', 'Otieno', 'Achieng', 'Kamau', 'Njeri', 'Omondi',
  'Chebet', 'Kiprop', 'Mutiso', 'Akinyi', 'Njoroge', 'Wambui'];
const AMOUNTS = [50, 100, 200, 500, 1000, 1500, 2000, 5000];
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randInt(n) {
  return Math.floor(Math.random() * n);
}

function randomTransactionId() {
  let s = 'QHX';
  for (let i = 0; i < 7; i++) s += ALNUM[randInt(ALNUM.length)];
  return s;
}

function randomPhone() {
  let s = '2547';
  for (let i = 0; i < 8; i++) s += String(randInt(10));
  return s;
}

function simulateOne() {
  const success = Math.random() < 0.9;
  const phoneRaw = randomPhone();
  const masked = maskPhone(phoneRaw);
  const name = NAMES[randInt(NAMES.length)];
  addPayment({
    payer: name + ' (' + masked + ')',
    amount: AMOUNTS[randInt(AMOUNTS.length)],
    phone: masked,
    time: new Date().toISOString(),
    transactionId: randomTransactionId(),
    success,
  });
}

// Keep malformed/unsupported request bodies from reaching Express's default
// HTML error page (which logs a full stack trace). Respond with a small JSON
// error and only log a one-line summary.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (res.headersSent) return next(err);
  const code = err && err.status >= 400 && err.status < 500 ? err.status : 400;
  if (err && err.type === 'encoding.unsupported') {
    return res.status(415).json({ error: 'unsupported-content-encoding' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid-json-body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body-too-large' });
  }
  console.error('request error:', (err && err.message) || 'unknown');
  return res.status(code).json({ error: 'bad-request' });
});

if (require.main === module || !module.parent) {
  if (process.env.SIMULATE !== 'false') {
    (function loop() {
      const delay = 6000 + Math.random() * 6000;
      setTimeout(() => {
        simulateOne();
        loop();
      }, delay);
    })();
  }

  app.listen(PORT, () => {
    console.log('mpesa-confetti listening on ' + PORT);
  });
}

module.exports = { app, normalizePhone, buildStkPassword, stampNow, darajaBaseUrl, getAccessToken, maskPhone, parseTransactionDate, isToday, addPayment, clients, _tokenCache };
