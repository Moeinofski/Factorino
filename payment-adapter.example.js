'use strict';

// Copy to payment-adapter.js and implement against the chosen provider's official API.
// The returned checkout URL must come from the provider response, never from client input.
async function createCheckout({ orderId, amount, currency, description, callbackUrl }) {
  if (!process.env.PAYMENT_GATEWAY_SECRET || !process.env.PAYMENT_GATEWAY_MERCHANT_ID) {
    throw new Error('Payment gateway credentials are not configured');
  }
  // Call the provider server-to-server, verify its response, and return its hosted URL.
  // Provider-specific code intentionally belongs here; no gateway has been selected in project docs.
  throw new Error(`Implement provider checkout for order ${orderId} (${amount} ${currency})`);
}

module.exports = { createCheckout };
