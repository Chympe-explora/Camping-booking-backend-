/**
 * chympe-booking-backend
 * -----------------------------------------------------------------------
 * Cloudflare Worker that sits behind booking-bridge.js on any Krem/Chympe
 * site. Telegram is the storage: every draft, receipt, and submitted
 * booking is posted (or edited) as a message in your Telegram chat, so
 * the chat itself is the permanent, human-readable record. A small KV
 * namespace is used only as a fast lookup cache so the visitor's browser
 * can poll "is this booking confirmed yet?" without hitting Telegram's
 * API on every poll, and so a draft can be *edited* in place instead of
 * spamming a new message every 1.5s while someone types.
 *
 * Endpoints (all under /api, called by booking-bridge.js):
 *   POST /api/draft            { sessionId, siteId, data }
 *   POST /api/receipt          multipart: sessionId, siteId, caption, file
 *   POST /api/submit           { sessionId, siteId, data } -> { bookingId }
 *   GET  /api/status/:id       -> { status }
 *   POST /telegram-webhook     Telegram calls this when the guide taps
 *                              Confirm / Cancel under a booking message.
 *
 * Required secrets / vars (set with `wrangler secret put ...` or in the
 * Cloudflare dashboard — see DEPLOY.md):
 *   TELEGRAM_BOT_TOKEN     - from @BotFather
 *   TELEGRAM_CHAT_ID       - the guide's chat/group id the bot posts to
 *   TELEGRAM_WEBHOOK_SECRET- random string, also set on the webhook URL
 *   ALLOWED_ORIGIN         - e.g. https://your-site.pages.dev ("*" for dev)
 *
 * Required binding:
 *   BOOKINGS  - a KV namespace (see wrangler.toml)
 */

export function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
  };
}

export function json(data, env, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", ...corsHeaders(env) },
  });
}

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function tgSendPhotoOrDoc(env, formFields, file) {
  const form = new FormData();
  form.append("chat_id", env.TELEGRAM_CHAT_ID);
  form.append("caption", formFields.caption || "");
  const isImage = /^image\//.test(file.type || "");
  form.append(isImage ? "photo" : "document", file, file.name || "receipt");
  const endpoint = isImage ? "sendPhoto" : "sendDocument";
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${endpoint}`, {
    method: "POST",
    body: form,
  });
  return r.json();
}

function fmtData(data) {
  return Object.entries(data || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}`)
    .join("\n");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function newId() {
  return crypto.randomUUID().slice(0, 8);
}

// Silent visit ping — fired the moment a visitor opens/scrolls the site.
// Never shown to the visitor; just a Telegram heads-up for the admin.
export async function handleVisit(request, env) {
  const { sessionId, siteId, path, referrer } = await request.json();
  const text =
    `\ud83d\udc40 <b>New visitor — ${escapeHtml(siteId || "site")}</b>\n` +
    `page: ${escapeHtml(path || "/")}\n` +
    (referrer ? `from: ${escapeHtml(referrer)}\n` : "") +
    `session: ${escapeHtml(sessionId || "")}`;
  await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  return json({ ok: true }, env);
}

// Silent destination/package tap — fired when a visitor taps a specific
// destination or package card, before they've filled anything in.
export async function handleTap(request, env) {
  const { sessionId, siteId, destination } = await request.json();
  const text =
    `\ud83d\udc49 <b>Tapped a destination — ${escapeHtml(siteId || "site")}</b>\n` +
    `destination: ${escapeHtml(destination || "unknown")}\n` +
    `session: ${escapeHtml(sessionId || "")}`;
  await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  return json({ ok: true }, env);
}

// Drafts are edited in place (one Telegram message per session) instead of
// posting a new message every time the visitor types — the message id is
// cached in KV against the sessionId.
export async function handleDraft(request, env) {
  const { sessionId, siteId, data } = await request.json();
  if (!sessionId) return json({ ok: false }, env, 400);

  const text = `\u270f\ufe0f <b>Draft — ${escapeHtml(siteId || "site")}</b>\n${fmtData(data)}`;
  const existingMsgId = await env.BOOKINGS.get(`draftmsg:${sessionId}`);

  let res;
  if (existingMsgId) {
    res = await tg(env, "editMessageText", {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_id: Number(existingMsgId),
      parse_mode: "HTML",
      text,
    });
    if (!res.ok) {
      // original message may have been deleted / too old to edit — send a fresh one
      res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
    }
  } else {
    res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  }

  if (res.ok && res.result && res.result.message_id) {
    await env.BOOKINGS.put(`draftmsg:${sessionId}`, String(res.result.message_id), { expirationTtl: 60 * 60 * 24 });
  }
  return json({ ok: true }, env);
}

export async function handleReceipt(request, env) {
  const form = await request.formData();
  const sessionId = form.get("sessionId");
  const siteId = form.get("siteId");
  const caption = form.get("caption") || "";
  const file = form.get("file");
  if (!file) return json({ ok: false, error: "no file" }, env, 400);

  const res = await tgSendPhotoOrDoc(env, { caption: `\ud83e\uddfe Receipt — ${siteId || "site"}\n${caption}\nsession: ${sessionId}` }, file);
  return json({ ok: !!res.ok }, env);
}

// A submitted booking gets its own bookingId (used by the browser to poll
// status) and its own Telegram message with inline Confirm/Cancel buttons.
// The bookingId <-> Telegram message id mapping and the full booking data
// are both cached in KV; Telegram remains the durable, readable log.
export async function handleSubmit(request, env) {
  const { sessionId, siteId, data } = await request.json();
  const bookingId = newId();

  const text = `\u2705 <b>New Booking — ${escapeHtml(siteId || "site")}</b>\n${fmtData(data)}\n\n<i>ref: ${bookingId}</i>`;
  const res = await tg(env, "sendMessage", {
    chat_id: env.TELEGRAM_CHAT_ID,
    parse_mode: "HTML",
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: "\u2705 Confirm", callback_data: `confirm:${bookingId}` },
        { text: "\u274c Cancel", callback_data: `cancel:${bookingId}` },
      ]],
    },
  });

  await env.BOOKINGS.put(`status:${bookingId}`, "pending", { expirationTtl: 60 * 60 * 24 * 30 });
  await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify({ sessionId, siteId, data }), { expirationTtl: 60 * 60 * 24 * 30 });
  if (res.ok && res.result && res.result.message_id) {
    await env.BOOKINGS.put(`bookingmsg:${bookingId}`, String(res.result.message_id), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  return json({ ok: true, bookingId }, env);
}

// Called by the central webhook dispatcher in index.js for callback
// taps that happen in the guide/booking chat (Confirm / Cancel under a
// booking message) — kept separate from the admin bot's own button
// vocabulary so the two never collide.
export async function handleBookingCallback(cb, env) {
  if (!cb || !cb.data) return;

  const [action, bookingId] = cb.data.split(":");
  if ((action === "confirm" || action === "cancel") && bookingId) {
    const newStatus = action === "confirm" ? "confirmed" : "cancelled";
    await env.BOOKINGS.put(`status:${bookingId}`, newStatus, { expirationTtl: 60 * 60 * 24 * 30 });

    const msgId = await env.BOOKINGS.get(`bookingmsg:${bookingId}`);
    if (msgId && cb.message) {
      const badge = newStatus === "confirmed" ? "\u2705 CONFIRMED" : "\u274c CANCELLED";
      const originalText = cb.message.text || "";
      await tg(env, "editMessageText", {
        chat_id: env.TELEGRAM_CHAT_ID,
        message_id: Number(msgId),
        parse_mode: "HTML",
        text: `${originalText}\n\n<b>${badge}</b>`,
      });
    }
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `Marked ${newStatus}` });
  }
}
