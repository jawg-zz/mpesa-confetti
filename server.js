const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4100;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const payments = [];
const clients = new Set();

function maskPhone(raw) {
  let s = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (s.startsWith('254')) s = '0' + s.slice(3);
  else if (s.startsWith('+254')) s = '0' + s.slice(4);
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
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6])
  );
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function addPayment(p) {
  payments.push(p);
  if (payments.length > 100) payments.splice(0, payments.length - 100);
  const data = JSON.stringify(p);
  for (const res of clients) {
    try {
      res.write(`event: payment\ndata: ${data}\n\n`);
    } catch (e) { /* ignore */ }
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
  req.on('close', () => {
    clearInterval(keepalive);
    clients.delete(res);
  });
});

app.post('/callback', (req, res) => {
  try {
    const cb = req.body && req.body.Body && req.body.Body.stkCallback;
    if (cb) {
      const success = Number(cb.ResultCode) === 0;
      const items = ((cb.CallbackMetadata && cb.CallbackMetadata.Item) || []);
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

function isToday(iso) {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

app.get('/api/stats', (req, res) => {
  const today = payments.filter((p) => isToday(p.time));
  const ok = today.filter((p) => p.success);
  const failed = today.filter((p) => !p.success).length;
  const sum = ok.reduce((a, p) => a + (Number(p.amount) || 0), 0);
  let biggest = null;
  for (const p of ok) {
    if (!biggest || p.amount > biggest.amount) {
      biggest = { amount: p.amount, payer: p.payer, transactionId: p.transactionId };
    }
  }
  res.json({ count: ok.length, sum, biggest, failed });
});

app.get('/api/payments', (req, res) => {
  let limit = parseInt(req.query.limit, 10);
  if (isNaN(limit) || limit <= 0) limit = 20;
  res.json(payments.slice(-limit).reverse());
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
