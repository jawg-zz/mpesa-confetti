'use strict';
// Regression tests for the public/index.html fixes. The page script is
// executed in a vm sandbox with stubbed DOM/network globals:
//  - old connect() threw ReferenceError (`es` never created), so merely
//    loading the script pins the EventSource fix;
//  - old resolvePendingCharge confirmed the charge on ANY success payment,
//    so the stranger-payment step pins the false-confirm fix.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeEl() {
  const el = {
    textContent: '', innerHTML: '', className: '', value: '',
    disabled: false, offsetWidth: 0, style: {},
    children: [], firstChild: null, lastChild: null,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild() {},
  };
  return el;
}

describe('index.html charge panel (EventSource lifecycle + resolve guard)', () => {
  let els;
  let esInstances;
  let lastCharge;
  let timers;

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function emitPayment(p) {
    const es = esInstances[0];
    for (const fn of es.listeners.payment || []) fn({ data: JSON.stringify(p) });
  }
  function click(el) {
    for (const fn of el.listeners.click || []) fn();
  }

  before(async () => {
    els = {};
    esInstances = [];
    timers = [];
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const src = html.slice(html.indexOf('(function () {'), html.lastIndexOf('})();') + '}();'.length);

    class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = {};
        this.readyState = 0;
        esInstances.push(this);
      }
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    }
    FakeEventSource.CLOSED = 2;

    const jsonResp = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    const fakeFetch = async (url, opts = {}) => {
      if (url.startsWith('/api/stats')) return jsonResp({ count: 0, sum: 0, failed: 0, biggest: null });
      if (url.startsWith('/api/payments')) return jsonResp([]);
      if (url === '/api/pay' && opts.method === 'POST') {
        lastCharge = JSON.parse(opts.body);
        return jsonResp({ checkoutRequestID: 'ws_CO_test123', customerMessage: 'ok' });
      }
      if (url.startsWith('/api/pay/')) return jsonResp({ status: 'pending' });
      return jsonResp({}, 404);
    };

    const sandbox = {
      document: {
        getElementById: (id) => els[id] || (els[id] = makeEl()),
        createElement: () => makeEl(),
      },
      window: {},
      localStorage: { getItem: () => null, setItem() {} },
      EventSource: FakeEventSource,
      fetch: fakeFetch,
      setTimeout: (fn) => { timers.push(fn); return timers.length; },
      clearTimeout() {},
      requestAnimationFrame() {},
      console,
    };
    vm.createContext(sandbox);
    // Throws on the old code (ReferenceError: es is not defined).
    vm.runInContext(src, sandbox);
    await flush(); await flush();
  });

  it('creates exactly one EventSource on /events', () => {
    assert.equal(esInstances.length, 1);
    assert.equal(esInstances[0].url, '/events');
  });

  it('does not confirm the charge on a stranger success payment', async () => {
    els.chargePhone.value = '0712345678';
    els.chargeAmount.value = '100';
    click(els.chargeBtn);
    await flush(); await flush();
    assert.deepEqual(lastCharge, { phone: '0712345678', amount: 100 });
    assert.match(els.chargeStatus.textContent, /^Check /);
    assert.equal(els.chargeBtn.disabled, true);

    emitPayment({ success: true, transactionId: 'OTHER_RECEIPT', payer: 'Stranger', amount: 50, phone: 'p', time: new Date().toISOString() });
    await flush(); await flush();
    // Old behaviour confirmed here ("Payment confirmed") — false positive.
    assert.match(els.chargeStatus.textContent, /^Check /);
    assert.equal(els.chargeBtn.disabled, true);
  });

  it('confirms on the matching checkout and fails on its failure', async () => {
    emitPayment({ success: true, transactionId: 'ws_CO_test123', payer: 'Me', amount: 100, phone: 'p', time: new Date().toISOString() });
    await flush();
    assert.match(els.chargeStatus.textContent, /confirmed/);
    assert.equal(els.chargeBtn.disabled, false);

    click(els.chargeBtn);
    await flush(); await flush();
    assert.equal(els.chargeBtn.disabled, true);
    emitPayment({ success: false, transactionId: 'ws_CO_test123', resultDesc: 'cancelled', payer: 'Me', amount: 100, phone: 'p', time: new Date().toISOString() });
    await flush();
    assert.match(els.chargeStatus.textContent, /Payment failed: cancelled/);
    assert.equal(els.chargeBtn.disabled, false);
  });
});
