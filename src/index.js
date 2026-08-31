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
 * One shared webhook, routed by which chat the tap came from:
 *   POST /telegram-webhook
 *     -> admin chat (TELEGRAM_ADMIN_CHAT_ID)   => the button-driven admin bot
 *     -> booking chat (TELEGRAM_CHAT_ID)       => Confirm/Cancel a booking (unchanged)
 *
 * Required secrets/vars beyond the original booking backend — see
 * DEPLOY.md:
 *   TELEGRAM_ADMIN_CHAT_ID  - chat the admin bot posts/manages in
 *   ADMIN_USER_IDS          - comma-separated Telegram user ids allowed
 *                             to drive the admin bot (leave blank while
 *                             testing, then lock it down — see DEPLOY.md)
 *   SITE_BASE_URL           - e.g. https://your-site.pages.dev (used only
 *                             for the bot's "preview" links)
 */

import { json, corsHeaders, handleVisit, handleTap, handleDraft, handleReceipt, handleSubmit, handleBookingCallback } from "./booking.js";
import { handleGetContent, handleGetPrices, handleGetImages, handleGetHighlights, handleGetDiscounts, handleCalculatePrice, handleMedia } from "./content-api.js";
import { handleTelegramAdminUpdate } from "./telegram-bot.js";

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
      if (url.pathname === "/api/draft" && request.method === "POST") return handleDraft(request, env);
      if (url.pathname === "/api/receipt" && request.method === "POST") return handleReceipt(request, env);
      if (url.pathname === "/api/submit" && request.method === "POST") return handleSubmit(request, env);
      if (url.pathname.startsWith("/api/status/") && request.method === "GET") {
        const id = url.pathname.split("/").pop();
        const status = (await env.BOOKINGS.get(`status:${id}`)) || "pending";
        return json({ status }, env);
      }

      // ---- content / pricing (new) ----
      if (url.pathname === "/api/content" && request.method === "GET") return handleGetContent(url, env);
      if (url.pathname === "/api/prices" && request.method === "GET") return handleGetPrices(url, env);
      if (url.pathname === "/api/images" && request.method === "GET") return handleGetImages(url, env);
      if (url.pathname === "/api/highlights" && request.method === "GET") return handleGetHighlights(url, env);
      if (url.pathname === "/api/discounts" && request.method === "GET") return handleGetDiscounts(env);
      if (url.pathname === "/api/calculate-price" && request.method === "POST") return handleCalculatePrice(request, env);
      if (url.pathname.startsWith("/media/") && request.method === "GET") return handleMedia(url, env);

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

async function handleTelegramWebhook(request, env) {
  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
  if (env.TELEGRAM_WEBHOOK_SECRET && secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const update = await request.json();
  const chatId = update.callback_query?.message?.chat?.id ?? update.message?.chat?.id;
  const adminChatId = env.TELEGRAM_ADMIN_CHAT_ID ? String(env.TELEGRAM_ADMIN_CHAT_ID) : null;

  // Route by which chat this happened in. If no admin chat is configured
  // yet, everything is treated as admin (fine for a single-chat setup —
  // see DEPLOY.md for splitting them once you're ready).
  const isAdminChat = !adminChatId || String(chatId) === adminChatId;

  if (isAdminChat) {
    await handleTelegramAdminUpdate(env, update);
  } else if (update.callback_query) {
    await handleBookingCallback(update.callback_query, env);
  }

  return new Response("ok");
}
