/**
 * chympe-booking-backend — now also the website's admin brain.
 * -----------------------------------------------------------------------
 * TELEGRAM IS THE STORAGE for everything: bookings (as before), and now
 * also site text, photos, prices, discounts and highlight banners. One
 * bot, one Telegram chat for bookings, one Telegram chat for admin
 * control (can be the same chat if you want). No database was added.
 *
 * Booking endpoints (unchanged — see booking.js):
 *   POST /api/visit /api/tap /api/draft /api/receipt /api/submit
 *   GET  /api/status/:id
 *
 * New content/pricing endpoints, called by live-content.js on the site:
 *   GET  /api/content?site=root|krem-chympe|wilderness-expedition
 *   GET  /api/images?site=...
 *   GET  /api/prices?site=...
 *   GET  /api/highlights?site=...
 *   GET  /api/discounts
 *   POST /api/calculate-price   { site, packageKey, unitPrice, persons, addons, dateISO, code }
 *   GET  /media/:site/:key      admin-uploaded photo, proxied from Telegram
 *
 * ERA AI — the visitor-facing hybrid AI + human-support chat assistant
 * (see era-ai.js + conversations.js):
 *   POST /api/era/message  { site, sessionId, message }
 *                          -> { reply, status, convId }
 *     Every message is forwarded to the Telegram admin chat, always
 *     (see conversations.js#forwardToTelegram). `reply` is the AI's
 *     answer when the conversation is in AI mode, or null when a human
 *     has taken over / paused it — the visitor's browser is expected to
 *     poll for the eventual human reply in that case.
 *   GET  /api/era/poll?site&sessionId&since=<ms timestamp>
 *                          -> { status, messages: [{id,text,from,ts}] }
 *     Polled by the widget while the chat panel is open, to pick up
 *     replies a human typed in Telegram after the original request
 *     already completed.
 *   POST /api/era/typing  { site, sessionId }
 *     Fired by the widget while the visitor is composing a message
 *     (before Send) — triggers Telegram's native "…is typing" bubble in
 *     the admin chat, live, the same way WhatsApp shows it.
 *   Managed entirely from the Telegram admin bot's "🤖 ERA AI" menu
 *   (knowledge base / learning toggle) plus, per-visitor, the
 *   ↩️ Reply / 🤖 AI / 👤 Take Over / ⏸ Pause / 🔴 Close buttons attached
 *   to every forwarded visitor message (see telegram-bot.js).
 *
 * Visitor ratings (new) — see ratings.js:
 *   GET  /api/ratings?site=...     -> { ratings: [...], average, count }
 *   POST /api/ratings  { site, name, rating, comment, sessionId }
 *     Stored as an admin-editable list (Telegram is the storage, same as
 *     highlights/content) — browsable/deletable from the bot's new
 *     "⭐ Visitor Ratings" menu — and a heads-up message is sent to the
 *     admin chat the moment a new rating comes in.
 *
 * One shared webhook, routed by which chat the tap came from:
 *   POST /telegram-webhook
 *     -> admin chat (TELEGRAM_ADMIN_CHAT_ID)   => the button-driven admin bot
 *     -> booking chat (TELEGRAM_CHAT_ID)       => Confirm/Reject a booking
 *
 * Required secrets/vars beyond the original booking backend — see
 * DEPLOY.md:
 *   TELEGRAM_ADMIN_CHAT_ID  - chat the admin bot posts/manages in
 *   ADMIN_USER_IDS          - comma-separated Telegram user ids allowed
 *                             to drive the admin bot (leave blank while
 *                             testing, then lock it down — see DEPLOY.md)
 *   SITE_BASE_URL           - e.g. https://your-site.pages.dev (used only
 *                             for the bot's "preview" links)
 *   ADMIN_API_SECRET        - random string; required by
 *                             POST /api/admin/reset-images (send it as
 *                             the x-admin-secret header). Lets you clear
 *                             a stale/broken photo override over HTTP —
 *                             the same effect as the bot's "Reset this
 *                             one to default" button — without opening
 *                             Telegram. Set with:
 *                               wrangler secret put ADMIN_API_SECRET
 */

import { json, corsHeaders, handleVisit, handleTap, handleDraft, handlePayNow, handleReceipt, handleSubmit, handleBookingCallback, handleRefundRequest, handleRefundStatus } from "./booking.js";
import { handleGetContent, handleGetPrices, handleGetImages, handleGetHighlights, handleGetDiscounts, handleCalculatePrice, handleMedia, handleVideoMedia, handleAdminResetImages } from "./content-api.js";
import { handleTelegramAdminUpdate } from "./telegram-bot.js";
import { handleEraMessage, handleEraPoll, handleEraTyping } from "./era-ai.js";
import { handleGetRatings, handleSubmitRating } from "./ratings.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    try {
      // ---- booking (unchanged) ----
      if (url.pathname === "/api/visit" && request.method === "POST") return handleVisit(request, env);
      if (url.pathname === "/api/tap" && request.method === "POST") return handleTap(request, env);
      if (url.pathname === "/api/draft" && request.method === "POST") return handleDraft(request, env, ctx);
      if (url.pathname === "/api/paynow" && request.method === "POST") return handlePayNow(request, env, ctx);
      if (url.pathname === "/api/receipt" && request.method === "POST") return handleReceipt(request, env);
      if (url.pathname === "/api/submit" && request.method === "POST") return handleSubmit(request, env, ctx);
      if (url.pathname.startsWith("/api/status/") && request.method === "GET") {
        const id = url.pathname.split("/").pop();
        const status = (await env.BOOKINGS.get(`status:${id}`)) || "pending";
        return json({ status }, env);
      }

      // ---- refunds (new) — see booking.js ----
      if (url.pathname === "/api/refund-request" && request.method === "POST") return handleRefundRequest(request, env, ctx);
      if (url.pathname.startsWith("/api/refund-status/") && request.method === "GET") {
        const id = url.pathname.split("/").pop();
        return handleRefundStatus(id, env);
      }

      // ---- content / pricing (new) ----
      if (url.pathname === "/api/content" && request.method === "GET") return handleGetContent(url, env);
      if (url.pathname === "/api/prices" && request.method === "GET") return handleGetPrices(url, env);
      if (url.pathname === "/api/images" && request.method === "GET") return handleGetImages(url, env);
      if (url.pathname === "/api/highlights" && request.method === "GET") return handleGetHighlights(url, env);
      if (url.pathname === "/api/discounts" && request.method === "GET") return handleGetDiscounts(env);
      if (url.pathname === "/api/calculate-price" && request.method === "POST") return handleCalculatePrice(request, env);
      if (url.pathname === "/api/admin/reset-images" && request.method === "POST") return handleAdminResetImages(request, env);
      if (url.pathname.startsWith("/media/") && request.method === "GET") return handleMedia(url, env);
      if (url.pathname.startsWith("/media-video/") && request.method === "GET") return handleVideoMedia(request, url, env);

      // ---- ERA AI chat assistant (new) ----
      if (url.pathname === "/api/era/message" && request.method === "POST") return handleEraMessage(request, env, ctx);
      if (url.pathname === "/api/era/poll" && request.method === "GET") return handleEraPoll(url, env);
      if (url.pathname === "/api/era/typing" && request.method === "POST") return handleEraTyping(request, env, ctx);

      // ---- visitor ratings (new) ----
      if (url.pathname === "/api/ratings" && request.method === "GET") return handleGetRatings(url, env);
      if (url.pathname === "/api/ratings" && request.method === "POST") return handleSubmitRating(request, env);

      // ---- one shared Telegram webhook ----
      if (url.pathname === "/telegram-webhook" && request.method === "POST") {
        return handleTelegramWebhook(request, env, ctx);
      }

      return json({ ok: false, error: "not found" }, env, 404);
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, env, 500);
    }
  },
};

async function handleTelegramWebhook(request, env, ctx) {
  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
  if (env.TELEGRAM_WEBHOOK_SECRET && secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json();
  const cb = update.callback_query;

  // Booking-decision taps (Confirm/Reject/Block/Refund) always go
  // straight to the booking handler, no matter which chat they came
  // from — the main group, the admin chat, or a guide's own personal
  // DM (guides now get their own copy of every booking message, see
  // recipientChatIds in booking.js).
  if (cb && /^(confirm|cancel|blockvisitor|refundok|refundno):/.test(cb.data || "")) {
    await handleBookingCallback(cb, env);
    return new Response("ok");
  }

  // The shared booking group can have many members in it — only
  // booking Confirm/Reject/etc. taps (handled above) are meaningful
  // there. Skip the admin-bot flow for anything else that happens in
  // that specific chat, so ordinary chatter in the group doesn't get a
  // "you're not an admin" refusal fired back at it. Every other chat
  // (the admin chat, or any individual's own DM with the bot — new
  // guide or not) still goes through normally.
  const chatId = update.message?.chat?.id ?? cb?.message?.chat?.id;
  if (env.TELEGRAM_CHAT_ID && String(chatId) === String(env.TELEGRAM_CHAT_ID)) {
    return new Response("ok");
  }

  // Everything else — menu commands, text replies, admin-bot callback
  // buttons, and a brand-new guide's very first message pasting their
  // access code — goes to the admin bot handler, regardless of which
  // chat it came from. handleTelegramAdminUpdate does its own
  // isAdmin/isGuide check before acting on anything: a stranger's
  // message either redeems a valid code or gets refused, an admin/
  // guide's message gets the normal menu behavior. Routing everything
  // here unconditionally is what makes a new guide's first-ever
  // message even reach the code-redemption check in the first place —
  // a stricter "known chat only" filter here would silently drop it
  // before that check ever runs.
  await handleTelegramAdminUpdate(env, update);
  return new Response("ok");
}
