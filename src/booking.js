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
 *                              Confirm / Reject under a booking message.
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

import { bumpVisitors, bumpBookings } from "./stats.js";

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
  const res = await r.json();
  return { ...res, isImage };
}

// Re-send a file already sitting on Telegram's CDN (by file_id) — no
// re-upload needed. Used to attach the receipt the visitor already sent
// to the final booking message. photo captions are capped at 1024 chars
// by Telegram, so callers must check length before relying on this.
async function tgSendPhotoByIdWithButtons(env, fileId, caption, replyMarkup) {
  return tg(env, "sendPhoto", {
    chat_id: env.TELEGRAM_CHAT_ID,
    photo: fileId,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}
async function tgSendDocumentByIdWithButtons(env, fileId, caption, replyMarkup) {
  return tg(env, "sendDocument", {
    chat_id: env.TELEGRAM_CHAT_ID,
    document: fileId,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
  });
}
async function tgEditMessageCaption(env, messageId, caption) {
  return tg(env, "editMessageCaption", {
    chat_id: env.TELEGRAM_CHAT_ID,
    message_id: messageId,
    caption,
    parse_mode: "HTML",
  });
}

// Triggers Telegram's native "…is typing" bubble in the admin chat — the
// same WhatsApp-style live indicator, just driven by a visitor filling in
// the booking form instead of a chat message. Telegram clears it on its
// own after ~5 seconds, so this just needs to be re-sent while the
// visitor keeps typing (handleDraft already fires on every field change).
// Fails silently — a missed typing bubble should never break a booking.
async function tgTyping(env) {
  try {
    return await tg(env, "sendChatAction", { chat_id: env.TELEGRAM_CHAT_ID, action: "typing" });
  } catch (e) {
    return { ok: false };
  }
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
  await bumpVisitors(env).catch(() => {});
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

  // Fire the native "typing…" bubble every time a draft update comes in —
  // this is what happens while the visitor is actively filling the form
  // (and immediately again the moment they tap Next/Back to a new step),
  // giving the admin the same live, WhatsApp-style typing signal as chat.
  await tgTyping(env);

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

// Fired the moment a visitor taps "Pay Now" (before they've paid or
// submitted anything). Sends a brand-new, distinct Telegram message with
// every detail collected so far, so the admin sees it immediately —
// separate from the live-editing draft message so neither gets overwritten.
export async function handlePayNow(request, env) {
  const { sessionId, siteId, data } = await request.json();
  const text =
    `\ud83d\udcb3 <b>Pay Now tapped — ${escapeHtml(siteId || "site")}</b>\n${fmtData(data)}\n\n` +
    `<i>session: ${escapeHtml(sessionId || "")}</i>`;
  const res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  return json({ ok: !!res.ok, error: res.ok ? undefined : (res.description || "telegram send failed") }, env, res.ok ? 200 : 502);
}

export async function handleReceipt(request, env) {
  const form = await request.formData();
  const sessionId = form.get("sessionId");
  const siteId = form.get("siteId");
  const caption = form.get("caption") || "";
  const file = form.get("file");
  if (!file) return json({ ok: false, error: "no file" }, env, 400);

  const res = await tgSendPhotoOrDoc(env, { caption: `\ud83e\uddfe Receipt — ${siteId || "site"}\n${caption}\nsession: ${sessionId}` }, file);

  // Remember this receipt's Telegram file_id against the sessionId so the
  // final /api/submit booking message can re-attach the SAME receipt
  // (no re-upload needed) alongside the Confirm/Reject buttons — instead
  // of the receipt sitting in an earlier, disconnected message. Short TTL:
  // this is only a bridge between "receipt uploaded" and "booking submitted",
  // which normally happen a minute or two apart.
  if (res.ok && sessionId) {
    const fileId = res.isImage
      ? (res.result.photo && res.result.photo[res.result.photo.length - 1]?.file_id)
      : (res.result.document && res.result.document.file_id);
    if (fileId) {
      await env.BOOKINGS.put(
        `receiptfile:${sessionId}`,
        JSON.stringify({ fileId, isImage: res.isImage }),
        { expirationTtl: 60 * 60 * 2 }
      );
    }
  }

  return json({ ok: !!res.ok, error: res.ok ? undefined : (res.description || "telegram send failed") }, env, res.ok ? 200 : 502);
}

// A submitted booking gets its own bookingId (used by the browser to poll
// status) and its own Telegram message with inline Confirm/Reject buttons.
// The bookingId <-> Telegram message id mapping and the full booking data
// are both cached in KV; Telegram remains the durable, readable log.
export async function handleSubmit(request, env) {
  const { sessionId, siteId, data } = await request.json();
  const bookingId = newId();

  // Prefer the fully pretty-formatted text the site already builds for
  // WhatsApp (ref no, itemized breakdown, totals, payment method — the
  // same layout the guide sees on WhatsApp) so the Telegram message
  // matches it 1:1. Falls back to a plain field list for older frontends
  // that don't send `data.message` yet.
  const bodyText = data && data.message
    ? escapeHtml(data.message)
    : fmtData(data);
  const text = `${bodyText}\n\n<i>ref: ${bookingId}</i>`;

  const replyMarkup = {
    inline_keyboard: [[
      { text: "\u2705 Confirm", callback_data: `confirm:${bookingId}` },
      { text: "\u274c Reject", callback_data: `cancel:${bookingId}` },
    ]],
  };

  // If this visitor already uploaded a payment receipt (during the Pay
  // Now step), re-attach that SAME Telegram file (no re-upload) to this
  // booking message so the guide sees the receipt and the Confirm/Reject
  // buttons together, in one place. Telegram photo/document captions are
  // capped at 1024 chars — if the itemized breakdown is longer than that,
  // send the receipt with a short caption and the full details as a
  // separate message right after it (with the buttons), rather than let
  // sendPhoto fail outright.
  const receiptRaw = sessionId ? await env.BOOKINGS.get(`receiptfile:${sessionId}`) : null;
  const receipt = receiptRaw ? JSON.parse(receiptRaw) : null;

  let res;
  if (receipt && text.length <= 1024) {
    res = receipt.isImage
      ? await tgSendPhotoByIdWithButtons(env, receipt.fileId, text, replyMarkup)
      : await tgSendDocumentByIdWithButtons(env, receipt.fileId, text, replyMarkup);
  } else if (receipt) {
    // Receipt shown first (short caption), full details + buttons follow.
    const shortCaption = `\ud83e\uddfe <b>Payment Receipt</b> — ref ${bookingId}`;
    (receipt.isImage
      ? tgSendPhotoByIdWithButtons(env, receipt.fileId, shortCaption, undefined)
      : tgSendDocumentByIdWithButtons(env, receipt.fileId, shortCaption, undefined)
    ).catch(() => {});
    res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text, reply_markup: replyMarkup });
  } else {
    res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text, reply_markup: replyMarkup });
  }

  // IMPORTANT: only report success to the visitor's browser if the
  // booking message actually reached Telegram. Previously this always
  // returned { ok: true }, even when the send failed (bad/missing bot
  // token, wrong chat id, bot never started, etc.) — so a visitor could
  // "successfully" submit a booking that the admin never saw, with no
  // error anywhere. Now a failed send is reported back as an error so it
  // can be surfaced in the UI instead of disappearing silently.
  if (!res.ok) {
    return json({ ok: false, error: res.description || "telegram send failed" }, env, 502);
  }

  await env.BOOKINGS.put(`status:${bookingId}`, "pending", { expirationTtl: 60 * 60 * 24 * 30 });
  await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify({ sessionId, siteId, data }), { expirationTtl: 60 * 60 * 24 * 30 });
  if (res.result && res.result.message_id) {
    await env.BOOKINGS.put(`bookingmsg:${bookingId}`, String(res.result.message_id), { expirationTtl: 60 * 60 * 24 * 30 });
  }
  if (sessionId) await env.BOOKINGS.delete(`receiptfile:${sessionId}`).catch(() => {});

  return json({ ok: true, bookingId }, env);
}

// Called by the central webhook dispatcher in index.js for callback
// taps that happen in the guide/booking chat (Confirm / Reject under a
// booking message) — kept separate from the admin bot's own button
// vocabulary so the two never collide.
export async function handleBookingCallback(cb, env) {
  if (!cb || !cb.data) return;

  const [action, bookingId] = cb.data.split(":");
  if ((action === "confirm" || action === "cancel") && bookingId) {
    const newStatus = action === "confirm" ? "confirmed" : "cancelled";

    // Flip the status in KV FIRST, before touching the Telegram message.
    // The visitor's browser is polling /api/status every ~1.5s — the
    // instant this write lands, the next poll picks it up and the site
    // flips to Confirmed/Rejected, even if the Telegram message edit
    // below is slow or fails for some reason.
    await env.BOOKINGS.put(`status:${bookingId}`, newStatus, { expirationTtl: 60 * 60 * 24 * 30 });
    if (newStatus === "confirmed") await bumpBookings(env).catch(() => {});

    // Answer the callback immediately too, so the guide's own Telegram
    // button stops "spinning" right away instead of waiting on the edit.
    tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `Marked ${newStatus}` }).catch(() => {});

    const msgId = await env.BOOKINGS.get(`bookingmsg:${bookingId}`);
    if (msgId && cb.message) {
      const badge = newStatus === "confirmed" ? "\u2705 CONFIRMED" : "\u274c REJECTED";
      // A message with a photo/document attached only exposes `caption`
      // and must be edited with editMessageCaption — editMessageText
      // errors out on media messages. A plain text booking message (no
      // receipt on file) uses editMessageText as before.
      const isMedia = !!(cb.message.photo || cb.message.document);
      if (isMedia) {
        const originalCaption = cb.message.caption || "";
        await tgEditMessageCaption(env, Number(msgId), `${originalCaption}\n\n<b>${badge}</b>`);
      } else {
        const originalText = cb.message.text || "";
        await tg(env, "editMessageText", {
          chat_id: env.TELEGRAM_CHAT_ID,
          message_id: Number(msgId),
          parse_mode: "HTML",
          text: `${originalText}\n\n<b>${badge}</b>`,
        });
      }
      // Buttons no longer make sense once decided — clear them so the
      // guide can't double-tap Confirm/Reject on an already-settled booking.
      await tg(env, "editMessageReplyMarkup", { chat_id: env.TELEGRAM_CHAT_ID, message_id: Number(msgId), reply_markup: { inline_keyboard: [] } }).catch(() => {});
    }
  }
}
