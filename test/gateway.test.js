'use strict';
// Gateway-backed charges: the app must call Lago REST, never Daraja directly,
// and must report Lago's invoice settlement to the dashboard.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server.js');

let srv;
let base;
const realFetch = globalThis.fetch;
const calls = [];

function lagoResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

before(async () => {
  process.env.PAYMENT_BACKEND = 'gateway';
  process.env.LAGO_API_KEY = 'test-key';
  process.env.LAGO_URL = 'https://lago.example.test';
  calls.length = 0;
  // Only the in-process test server uses real fetch; everything else is mocked.
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith(base)) return realFetch(url, opts);
    calls.push({ url: u, opts });
    if (u.endsWith('/api/v1/customers') && (!opts || opts.method !== 'POST')) {
      return lagoResp({ customer: { external_id: 'confetti-254712345678' } });
    }
    if (u.endsWith('/api/v1/customers')) {
      const sent = JSON.parse(opts.body).customer;
      return lagoResp({ customer: { lago_id: 'c1', external_id: sent.external_id } });
    }
    if (u.endsWith('/api/v1/add_ons')) return lagoResp({ add_on: { code: 'confetti-payment' } });
    if (u.endsWith('/api/v1/invoices') && (!opts || opts.method !== 'POST')) {
      return lagoResp({ invoice: { lago_id: 'inv-1' } });
    }
    if (u.endsWith('/api/v1/invoices')) return lagoResp({ invoice: { lago_id: 'inv-1' } });
    if (u.includes('/payment_url')) {
      return lagoResp({ invoice_payment_details: { payment_url: 'https://checkout.example/x' } });
    }
    if (u.includes('/api/v1/invoices/')) {
      return lagoResp({ invoice: { lago_id: 'inv-1', payment_status: 'succeeded' } });
    }
    return lagoResp({});
  };
  srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((r) => srv.close(r));
  delete process.env.PAYMENT_BACKEND;
  delete process.env.LAGO_API_KEY;
  delete process.env.LAGO_URL;
});

describe('gateway-backed charges', () => {
  it('creates a Lago customer, add-on and invoice; never calls Daraja', async () => {
    calls.length = 0;
    const r = await fetch(base + '/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '0712345678', amount: 1500 }),
    });
    const b = await r.json();
    assert.equal(r.status, 200);
    assert.equal(b.checkoutRequestID, 'inv-1');
    assert.match(b.customerMessage, /Lago gateway/);
    const urls = calls.map((c) => c.url);
    assert.ok(urls.some((u) => u.endsWith('/api/v1/customers')));
    assert.ok(urls.some((u) => u.endsWith('/api/v1/add_ons')));
    assert.ok(urls.some((u) => u.endsWith('/api/v1/invoices')));
    assert.ok(urls.some((u) => u.includes('/payment_url')));
    assert.ok(!urls.some((u) => u.includes('safaricom.co.ke')), 'must not call Daraja');
    const invoiceCall = calls.find((c) => c.url.endsWith('/api/v1/invoices') && c.opts && c.opts.method === 'POST');
    const fee = JSON.parse(invoiceCall.opts.body).invoice.fees[0];
    assert.equal(fee.unit_amount_cents, 150000, 'whole KES converted to minor units');
  });

  it('reports Lago invoice settlement as confirmed and echoes a matching transaction id', async () => {
    const r = await fetch(base + '/api/pay/inv-1');
    const b = await r.json();
    assert.equal(r.status, 200);
    assert.equal(b.status, 'confirmed');
    assert.equal(b.transactionId, 'inv-1');
  });

  it('validates input before touching the gateway', async () => {
    calls.length = 0;
    const r = await fetch(base + '/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '123', amount: 100 }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid-phone');
    assert.equal(calls.length, 0, 'no gateway calls on invalid input');
  });

  it('card rail creates a Paystack customer and returns a checkout URL', async () => {
    calls.length = 0;
    const r = await fetch(base + '/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'card', email: 'Buyer@Example.com', amount: 500 }),
    });
    const b = await r.json();
    assert.equal(r.status, 200);
    assert.equal(b.method, 'card');
    assert.match(b.paymentUrl, /checkout\.example/);
    const cust = calls.find((c) => c.url.endsWith('/api/v1/customers') && c.opts.method === 'POST');
    const body = JSON.parse(cust.opts.body).customer;
    assert.equal(body.billing_configuration.payment_provider, 'paystack');
    assert.equal(body.email, 'buyer@example.com');
    assert.match(body.external_id, /^confetti-card-[a-f0-9]{16}$/);
  });

  it('card rail rejects a bad email without calling the gateway', async () => {
    calls.length = 0;
    const r = await fetch(base + '/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'card', email: 'nope', amount: 100 }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid-email');
    assert.equal(calls.length, 0);
  });

  it('rejects an unknown method', async () => {
    const r = await fetch(base + '/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'crypto', amount: 100 }),
    });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'invalid-method');
  });
});
