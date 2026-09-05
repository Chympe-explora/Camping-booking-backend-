/**
 * payments.js — Payment Gateway scaffolding (master-prompt items 19-21).
 *
 * This intentionally does NOT process real payments — per the original
 * spec: "Do not implement fake payment processing. The architecture
 * should simply be ready for real gateway integration later." What's
 * here is the part that CAN be built now without a live merchant
 * account: the adapter interface, the order/status lifecycle, secure
 * credential storage, and the admin-configuration flow (so "the admin
 * just needs to upload everything through Telegram admin" once a real
 * gateway account exists — no code changes at that point, just filling
 * in the one adapter's TODOs and pasting in real credentials here).
 *
 *                Payment Service (this file's exports)
 *                          |
 *                Payment Gateway Adapter (ADAPTERS below)
 *                          |
 *                  Selected Gateway (Razorpay/Stripe/PayPal/...)
 *
 * ---------------------------------------------------------------------
 * SECURITY: credentials live in their own raw KV doc (paymentcreds:<site>),
 * NEVER via store.js's saveDoc() — that helper posts the full JSON to
 * the Telegram admin chat as a permanent, readable log, which is fine
 * for site text/prices but would leak API secrets into chat history.
 * Telegram messages here only ever show masked previews
 * (`rzp_live_••••1234`), never the raw value. Nothing here is ever sent
 * to the frontend — the 3 sites never see a credential, only this
 * Worker does.
 * ---------------------------------------------------------------------
 *
 * Data model (plain KV):
 *   paymentconfig:<site>  -> { provider, currency, enabled }
 *   paymentcreds:<site>   -> { ...provider-specific fields, raw }
 *   order:<orderId>       -> { orderId, site, bookingId, amount, currency,
 *                              status, provider, providerOrderId,
 *                              createdAt, updatedAt }
 *   bookingorder:<bookingId> -> orderId  (reverse lookup)
 */

export const ORDER_STATUSES = [
  "pending",
  "payment_initiated",
  "paid",
  "failed",
  "cancelled",
  "refunded",
  "partially_refunded",
];

// Every supported (or plannable) gateway and exactly what credential
// fields it needs — this is the ONLY thing that changes when adding a
// new gateway later: add an entry here, add its adapter below, done.
// Nothing in the Telegram menu or storage code is gateway-specific.
export const GATEWAYS = {
  razorpay: {
    label: "Razorpay",
    fields: [
      { key: "keyId", label: "Key ID", mask: true },
      { key: "keySecret", label: "Key Secret", mask: true },
    ],
  },
  stripe: {
    label: "Stripe",
    fields: [
      { key: "publishableKey", label: "Publishable Key", mask: true },
      { key: "secretKey", label: "Secret Key", mask: true },
      { key: "webhookSigningSecret", label: "Webhook Signing Secret", mask: true },
    ],
  },
  paypal: {
    label: "PayPal",
    fields: [
      { key: "clientId", label: "Client ID", mask: true },
      { key: "clientSecret", label: "Client Secret", mask: true },
      { key: "mode", label: "Mode (sandbox/live)", mask: false },
    ],
  },
};

function maskValue(v) {
  if (!v) return "(not set)";
  const s = String(v);
  if (s.length <= 4) return "••••";
  return "••••" + s.slice(-4);
}

// ---------------------------------------------------------------------
// CONFIG (provider + currency + enabled) — small, non-secret, fine to
// read/write with plain KV like everything else operational.
// ---------------------------------------------------------------------
export async function getPaymentConfig(env, site) {
  const raw = await env.BOOKINGS.get(`paymentconfig:${site}`);
  if (!raw) return { provider: "none", currency: "INR", enabled: false };
  try {
    return JSON.parse(raw);
  } catch {
    return { provider: "none", currency: "INR", enabled: false };
  }
}
export async function savePaymentConfig(env, site, config) {
  await env.BOOKINGS.put(`paymentconfig:${site}`, JSON.stringify(config));
}

// ---------------------------------------------------------------------
// CREDENTIALS — the sensitive part. Raw KV only, never saveDoc/getDoc.
// Every read that's destined for a Telegram message MUST go through
// getMaskedCredentials, never getRawCredentials — that one's for the
// adapter code only, at actual gateway-call time.
// ---------------------------------------------------------------------
export async function getRawCredentials(env, site) {
  const raw = await env.BOOKINGS.get(`paymentcreds:${site}`);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
export async function setCredentialField(env, site, key, value) {
  const creds = await getRawCredentials(env, site);
  creds[key] = value;
  await env.BOOKINGS.put(`paymentcreds:${site}`, JSON.stringify(creds));
}
export async function getMaskedCredentials(env, site) {
  const provider = (await getPaymentConfig(env, site)).provider;
  const gw = GATEWAYS[provider];
  if (!gw) return [];
  const creds = await getRawCredentials(env, site);
  return gw.fields.map((f) => ({
    key: f.key,
    label: f.label,
    value: f.mask ? maskValue(creds[f.key]) : creds[f.key] || "(not set)",
    isSet: !!creds[f.key],
  }));
}

// ---------------------------------------------------------------------
// ADAPTER PATTERN — one function shape every gateway implements, so
// order.js/webhook code never needs to know which gateway is active.
// Each method throws "not configured" until real credentials +
// real SDK/fetch calls are filled in — that's the explicit boundary
// spec called out ("do not implement fake payment processing").
// ---------------------------------------------------------------------
function notConfigured(provider) {
  const err = new Error(
    `${GATEWAYS[provider] ? GATEWAYS[provider].label : provider} isn't wired up to a real payment yet — credentials are saved, but this adapter's actual API calls still need to be implemented once you have a live merchant account. This is expected at this stage — the architecture is ready, the last mile (the real gateway's SDK/API calls) is a deliberate TODO.`
  );
  err.code = "GATEWAY_NOT_IMPLEMENTED";
  return err;
}

// TODO once you have a live Razorpay account: call Razorpay's Orders
// API here (POST /v1/orders) using creds.keyId/keySecret, return
// { providerOrderId, checkoutParams }. See https://razorpay.com/docs/api/orders/
async function razorpayCreateOrder(env, site, order, creds) {
  throw notConfigured("razorpay");
}
// TODO: verify the Razorpay webhook signature (X-Razorpay-Signature)
// against creds.keySecret, per their docs, then return the parsed
// event + which of ORDER_STATUSES it maps to.
async function razorpayVerifyWebhook(env, site, request, creds) {
  throw notConfigured("razorpay");
}

// TODO once you have a live Stripe account: create a PaymentIntent via
// Stripe's API using creds.secretKey. See https://stripe.com/docs/api/payment_intents
async function stripeCreateOrder(env, site, order, creds) {
  throw notConfigured("stripe");
}
// TODO: verify the Stripe-Signature header against
// creds.webhookSigningSecret (Stripe's stripe-signature scheme).
async function stripeVerifyWebhook(env, site, request, creds) {
  throw notConfigured("stripe");
}

// TODO once you have a live PayPal account: create an Order via
// PayPal's Orders v2 API using creds.clientId/clientSecret.
async function paypalCreateOrder(env, site, order, creds) {
  throw notConfigured("paypal");
}
async function paypalVerifyWebhook(env, site, request, creds) {
  throw notConfigured("paypal");
}

const ADAPTERS = {
  razorpay: { createOrder: razorpayCreateOrder, verifyWebhook: razorpayVerifyWebhook },
  stripe: { createOrder: stripeCreateOrder, verifyWebhook: stripeVerifyWebhook },
  paypal: { createOrder: paypalCreateOrder, verifyWebhook: paypalVerifyWebhook },
};

// ---------------------------------------------------------------------
// ORDER LIFECYCLE
//   Customer -> Booking/Form -> Order creation -> Payment request ->
//   Payment Gateway -> Payment verification -> Webhook ->
//   Order status update -> Telegram Admin notification
// ---------------------------------------------------------------------
function newOrderId() {
  return "ord_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Creates an order record and (once a real adapter exists) starts the
// actual payment request with the gateway. Until then, this creates
// the record in "pending" and surfaces the adapter's not-configured
// error to the caller — the booking/order data itself is real and
// saved either way, only the live gateway call is the pending part.
export async function createOrder(env, site, bookingId, amount, currency) {
  const config = await getPaymentConfig(env, site);
  const orderId = newOrderId();
  const order = {
    orderId,
    site,
    bookingId,
    amount,
    currency: currency || config.currency || "INR",
    status: "pending",
    provider: config.provider,
    providerOrderId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await env.BOOKINGS.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 30 });
  if (bookingId) await env.BOOKINGS.put(`bookingorder:${bookingId}`, orderId, { expirationTtl: 60 * 60 * 24 * 30 });

  if (!config.enabled || config.provider === "none") {
    return { order, checkout: null, error: "No payment gateway is enabled for this site yet — set one up from Telegram admin \ud83d\udcb3 Payment Gateway." };
  }
  const adapter = ADAPTERS[config.provider];
  if (!adapter) return { order, checkout: null, error: "Unknown gateway configured." };

  const creds = await getRawCredentials(env, site);
  try {
    const result = await adapter.createOrder(env, site, order, creds);
    order.status = "payment_initiated";
    order.providerOrderId = result.providerOrderId;
    order.updatedAt = Date.now();
    await env.BOOKINGS.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 30 });
    return { order, checkout: result.checkoutParams, error: null };
  } catch (e) {
    return { order, checkout: null, error: e.message || "Gateway error" };
  }
}

export async function getOrder(env, orderId) {
  const raw = await env.BOOKINGS.get(`order:${orderId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function setOrderStatus(env, orderId, status, extra) {
  const order = await getOrder(env, orderId);
  if (!order) return null;
  order.status = status;
  order.updatedAt = Date.now();
  if (extra) Object.assign(order, extra);
  await env.BOOKINGS.put(`order:${orderId}`, JSON.stringify(order), { expirationTtl: 60 * 60 * 24 * 30 });
  return order;
}

// Verifies + applies an incoming webhook from whichever gateway a site
// has configured, updates the order's status, and returns it so the
// caller (index.js) can fire the Telegram Admin notification. Site is
// taken from the URL (/api/payment/webhook/:site) since each gateway
// dashboard is configured with a site-specific webhook URL — see
// webhookUrlFor below, shown to the admin when they set up a gateway.
export async function handlePaymentWebhook(env, site, request) {
  const config = await getPaymentConfig(env, site);
  const adapter = ADAPTERS[config.provider];
  if (!adapter) throw new Error(`No gateway configured for ${site}`);
  const creds = await getRawCredentials(env, site);
  const { orderId, status } = await adapter.verifyWebhook(env, site, request, creds);
  return setOrderStatus(env, orderId, status);
}

// Shown to the admin in Telegram when they set up a gateway — this is
// the URL they paste into Razorpay/Stripe/PayPal's own dashboard so
// its webhooks reach this Worker.
export function webhookUrlFor(env, site) {
  const base = env.WORKER_BASE_URL || "https://chympe-booking-backend.senlysuchiang87.workers.dev";
  return `${base}/api/payment/webhook/${site}`;
}
