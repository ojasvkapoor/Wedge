'use strict';
/* Razorpay: create an order, verify a payment signature, verify a webhook.
   No SDK. HMAC and fetch only, so the behaviour is visible. */

const crypto = require('node:crypto');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';
const API = 'https://api.razorpay.com/v1';

const configured = () => Boolean(KEY_ID && KEY_SECRET);

/** Create an order. Amount is in paise. */
async function createOrder({ amountInr, receipt, notes }) {
  if (!configured()) {
    // dev mode: a stand-in order so the flow can be exercised without keys
    return {
      id: 'order_dev_' + crypto.randomBytes(8).toString('hex'),
      amount: amountInr * 100,
      currency: 'INR',
      receipt,
      status: 'created',
      dev: true
    };
  }
  const auth = Buffer.from(KEY_ID + ':' + KEY_SECRET).toString('base64');
  const res = await fetch(API + '/orders', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Basic ' + auth
    },
    body: JSON.stringify({
      amount: amountInr * 100,
      currency: 'INR',
      receipt,
      notes: notes || {}
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Razorpay order failed: ' + (data.error?.description || res.status));
  return data;
}

/** The checkout callback signature: HMAC_SHA256(order_id + "|" + payment_id, secret). */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (!KEY_SECRET) throw new Error('RAZORPAY_KEY_SECRET is not set');
  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(orderId + '|' + paymentId)
    .digest('hex');
  return timingSafeEqual(expected, signature);
}

/** Webhook signature: HMAC_SHA256(rawBody, webhook_secret) against X-Razorpay-Signature. */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) throw new Error('RAZORPAY_WEBHOOK_SECRET is not set');
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { createOrder, verifyPaymentSignature, verifyWebhookSignature, configured };
