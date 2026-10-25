# mpesa-confetti 🎉
Merchant dashboard that visualizes M-Pesa payments: confetti explosion per payment, payer name, amount, time, transaction ID. Live feed via SSE + Daraja-compatible webhook.

## Quickstart

```bash
npm install
PORT=4100 npm start
# open http://localhost:4100
```

Set `PORT` to change the listen port (defaults to `4100` if unset).

## Daraja wiring notes

- STK push uses your BusinessShortCode + Lipa Na M-Pesa passkey to initiate payment.
- Register the callback URL as `https://<host>/callback` (must be publicly reachable HTTPS in production).
- `ResultCode 0` means success; anything else (e.g. `1032` cancelled by user) is a failure — the dashboard records it under failed payments without confetti.
- `TransactionDate` arrives as `YYYYMMDDHHmmss` (e.g. `20241025193000`).
- The callback carries no payer name, so the dashboard shows `M-Pesa <masked phone>` (e.g. `M-Pesa 0712***456`).

## Examples

Success callback:

```bash
curl -X POST http://localhost:4100/callback \
  -H 'Content-Type: application/json' \
  -d '{"Body":{"stkCallback":{"MerchantRequestID":"29115-34620561-1","CheckoutRequestID":"ws_CO_191220191020363925","ResultCode":0,"ResultDesc":"The service request is processed successfully.","CallbackMetadata":{"Item":[{"Name":"Amount","Value":100},{"Name":"MpesaReceiptNumber","Value":"NLJ7RT61SV"},{"Name":"TransactionDate","Value":20241025193000},{"Name":"PhoneNumber","Value":254712345678}]}}}}'
```

Failure callback (cancelled by user):

```bash
curl -X POST http://localhost:4100/callback \
  -H 'Content-Type: application/json' \
  -d '{"Body":{"stkCallback":{"MerchantRequestID":"29115-34620561-1","CheckoutRequestID":"ws_CO_191220191020363925","ResultCode":1032,"ResultDesc":"Request cancelled by user"}}}'
```

Live payment stream (SSE):

```bash
curl -N http://localhost:4100/events
```

Each `payment` event is JSON: `{payer, amount, phone (masked 0712***456), time (ISO), transactionId, success}`.

## Demo mode

The server simulates payments on a timer unless disabled:

```bash
SIMULATE=false npm start
```

## Project structure

```text
server.js   # Express app: static frontend, /callback webhook, /events SSE, /api/stats, /api/payments
public/     # static frontend (index.html)
package.json
README.md
```

## Endpoints

| Method | Path | Description |
| ------ | ---- | ----------- |
| GET | `/` | Dashboard frontend |
| POST | `/callback` | Daraja STK callback webhook |
| GET | `/events` | SSE live payment feed (`payment` events) |
| GET | `/api/stats` | `{count, sum, biggest {amount, payer, transactionId} \| null, failed}` |
| GET | `/api/payments?limit=20` | Newest-first payment array |

## Real payments via Daraja (STK push)

Set Daraja credentials to send real STK pushes from the dashboard Charge panel. Without them the simulator keeps working; `/api/pay` returns `501 not-configured`.

Base URLs: sandbox `https://sandbox.safaricom.co.ke` (default), production `https://api.safaricom.co.ke` (via `MPESA_ENV=production`).

Register the callback URL as `PUBLIC_URL + /callback` (fallback `https://confetti.spidmax.win/callback`). It must be public HTTPS in production so Daraja can reach it.

| Var | Default / notes |
| --- | --------------- |
| `MPESA_ENV` | `sandbox`; set `production` for live |
| `MPESA_CONSUMER_KEY` | Daraja app key (required for real payments) |
| `MPESA_CONSUMER_SECRET` | Daraja app secret (required for real payments) |
| `MPESA_SHORTCODE` | Business shortcode (required for real payments) |
| `MPESA_PASSKEY` | Lipa Na M-Pesa passkey (required for real payments) |
| `MPESA_TYPE` | `CustomerPayBillOnline` (or `CustomerBuyGoodsOnline`) |
| `PUBLIC_URL` | Callback base; fallback `https://confetti.spidmax.win/callback` |

```bash
MPESA_ENV=sandbox \
MPESA_CONSUMER_KEY=xxx MPESA_CONSUMER_SECRET=yyy \
MPESA_SHORTCODE=174379 MPESA_PASSKEY=zzz \
PUBLIC_URL=https://confetti.spidmax.win \
npm start
```

Charge a phone:

```bash
curl -X POST http://localhost:4100/api/pay \
  -H 'Content-Type: application/json' \
  -d '{"phone":"0712345678","amount":100}'
```

`501 {error:'not-configured'}` means Daraja env vars are missing — set them or keep using the simulator. `502` means Daraja rejected the request (see `errorMessage`); `400` is a validation error (bad phone/amount).
