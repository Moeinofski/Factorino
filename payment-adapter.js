'use strict';

const crypto = require('node:crypto');

const API_URL = 'https://variza.ir/api/v1/pay';
const API_KEY = process.env.VARIZA_API_KEY || '';
const CARD_LAST_4 = process.env.VARIZA_CARD_LAST_4 || '';

async function createCheckout({ orderId, amount, currency, description, callbackUrl }) {
  if (!API_KEY) throw new Error('VARIZA_API_KEY is not configured');
  if (currency !== 'IRR' || !Number.isSafeInteger(amount) || amount <= 0 || amount % 10 !== 0) {
    throw new Error('Variza amount must be a positive IRR amount divisible by 10');
  }
  const returnUrl = new URL(callbackUrl);
  if (returnUrl.protocol !== 'https:') throw new Error('Variza requires an HTTPS return URL');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      amount: amount / 10,
      return_url: returnUrl.href,
      title: String(description || `Factorino Pro ${orderId}`).slice(0, 120),
      ...(CARD_LAST_4 ? { card_last_4: CARD_LAST_4 } : {})
    }),
    signal: AbortSignal.timeout(15000)
  });
  let result;
  try { result = await response.json(); } catch { throw new Error(`Variza returned invalid JSON (${response.status})`); }
  if (!response.ok) throw new Error(`Variza payment link request failed (${response.status})`);

  const checkoutUrl = new URL(String(result.pay_url || ''));
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'variza.ir') {
    throw new Error('Variza returned an unexpected payment URL');
  }
  if (String(result.slug || '').length < 6 || Number(result.amount) !== amount / 10) {
    throw new Error('Variza response does not match the requested order amount');
  }
  return { checkoutUrl: checkoutUrl.href, reference: result.slug };
}

function verifyWebhook({ rawBody, signature, secret }) {
  if (!secret || !Buffer.isBuffer(rawBody) || typeof signature !== 'string') throw new Error('Missing webhook verification data');
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(actualBytes, expectedBytes)) {
    throw new Error('Invalid Variza webhook signature');
  }
  const payload = JSON.parse(rawBody.toString('utf8'));
  if (payload.event !== 'payment.paid' || payload.status !== 'paid' || typeof payload.slug !== 'string') {
    throw new Error('Unsupported Variza webhook event');
  }
  const amount = Number(payload.base_amount);
  if (!Number.isSafeInteger(amount) || amount < 1000) throw new Error('Invalid Variza payment amount');
  return { reference: payload.slug, amount: amount * 10, status: 'paid' };
}

module.exports = { createCheckout, verifyWebhook };
