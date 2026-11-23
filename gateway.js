'use strict';

// Thin REST client for the Lago + M-Pesa payment gateway.
// All Lago secrets stay server-side; the browser never sees the API key.

const LAGO_URL = (process.env.LAGO_URL || 'https://lago-pay.spidmax.win').replace(/\/+$/, '');
const API_KEY = process.env.LAGO_API_KEY || '';
const ADD_ON_CODE = process.env.LAGO_ADD_ON_CODE || 'confetti-payment';

function configured() {
  return Boolean(API_KEY);
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(LAGO_URL + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + API_KEY,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (e) {
    const err = new Error('gateway unreachable: ' + (e && e.message ? e.message : e));
    err.gateway = { errorMessage: err.message };
    throw err;
  }
  let body = {};
  try { body = await res.json(); } catch (e) { body = {}; }
  if (!res.ok) {
    const err = new Error(body.error || body.message || ('gateway HTTP ' + res.status));
    err.gateway = {
      status: res.status,
      code: body.code,
      errorMessage: err.message,
      details: body.error_details,
    };
    throw err;
  }
  return body;
}

// Idempotent customer creation keyed by phone. Lago returns 422 with
// value_already_exist when the external_id is taken; fetch it instead.
async function ensureCustomer(phone) {
  const externalId = 'confetti-' + phone;
  try {
    const r = await api('/api/v1/customers', {
      method: 'POST',
      body: JSON.stringify({
        customer: {
          external_id: externalId,
          name: 'M-Pesa ' + phone,
          phone,
          currency: 'KES',
          billing_configuration: {
            payment_provider: 'mpesa',
            payment_provider_code: 'mpesa',
            provider_customer_id: phone,
            sync_with_provider: true,
          },
        },
      }),
    });
    return r.customer;
  } catch (e) {
    const g = e.gateway || {};
    const exists = g.status === 422 &&
      JSON.stringify(g.details || {}).includes('value_already_exist');
    if (!exists) throw e;
    const r = await api('/api/v1/customers/' + encodeURIComponent(externalId));
    return r.customer;
  }
}

// One shared add-on; the invoice fee overrides the unit amount per charge.
async function ensureAddOn() {
  try {
    const r = await api('/api/v1/add_ons', {
      method: 'POST',
      body: JSON.stringify({
        add_on: {
          name: 'Confetti Payment',
          code: ADD_ON_CODE,
          amount_cents: 100,
          amount_currency: 'KES',
        },
      }),
    });
    return r.add_on;
  } catch (e) {
    const g = e.gateway || {};
    if (g.status !== 422) throw e;
    return { code: ADD_ON_CODE };
  }
}

async function createInvoice(externalId, amountCents) {
  const r = await api('/api/v1/invoices', {
    method: 'POST',
    body: JSON.stringify({
      invoice: {
        external_customer_id: externalId,
        currency: 'KES',
        fees: [{ add_on_code: ADD_ON_CODE, quantity: 1, unit_amount_cents: amountCents }],
      },
    }),
  });
  return r.invoice;
}

// Triggers the STK push inside Lago. Returns the payment URL plus the invoice id,
// which the frontend polls as an opaque charge id.
async function requestPayment(invoiceId) {
  const r = await api('/api/v1/invoices/' + encodeURIComponent(invoiceId) + '/payment_url', {
    method: 'POST',
    body: '{}',
  });
  return r.invoice_payment_details || {};
}

async function getInvoice(invoiceId) {
  const r = await api('/api/v1/invoices/' + encodeURIComponent(invoiceId));
  return r.invoice;
}

module.exports = {
  configured,
  ensureCustomer,
  ensureAddOn,
  createInvoice,
  requestPayment,
  getInvoice,
  ADD_ON_CODE,
};
