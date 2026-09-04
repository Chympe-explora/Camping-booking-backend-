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
import { isSessionActive, isSessionBlocked, toggleSessionBlocked } from "./conversations.js";
import { getGuides } from "./telegram-bot.js";

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
async function tgSendPhotoByIdWithButtons(env, fileId, caption, replyMarkup, silent, chatId) {
  return tg(env, "sendPhoto", {
    chat_id: chatId || env.TELEGRAM_CHAT_ID,
    photo: fileId,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    disable_notification: !!silent,
  });
}
async function tgSendDocumentByIdWithButtons(env, fileId, caption, replyMarkup, silent, chatId) {
  return tg(env, "sendDocument", {
    chat_id: chatId || env.TELEGRAM_CHAT_ID,
    document: fileId,
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup,
    disable_notification: !!silent,
  });
}
async function tgEditMessageCaption(env, chatId, messageId, caption) {
  return tg(env, "editMessageCaption", {
    chat_id: chatId || env.TELEGRAM_CHAT_ID,
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
//
// SPEED: the actual Telegram network calls (typing bubble + send/edit)
// are pushed into ctx.waitUntil() and the visitor's browser gets an
// immediate { ok: true } — a live draft preview is a nice-to-have for
// the admin, not something the visitor should ever wait on. If ctx
// isn't available for some reason (older caller), falls back to the
// previous fully-awaited behavior so nothing breaks.
export async function handleDraft(request, env, ctx) {
  const { sessionId, siteId, data } = await request.json();
  if (!sessionId) return json({ ok: false }, env, 400);

  const text = `\u270f\ufe0f <b>Draft — ${escapeHtml(siteId || "site")}</b>\n${fmtData(data)}`;
  const existingMsgId = await env.BOOKINGS.get(`draftmsg:${sessionId}`);

  async function sendDraft() {
    await tgTyping(env);
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
  }

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendDraft().catch(() => {}));
  } else {
    await sendDraft().catch(() => {});
  }
  return json({ ok: true }, env);
}

// Fired the moment a visitor taps "Pay Now" (before they've paid or
// submitted anything). Sends a brand-new, distinct Telegram message with
// every detail collected so far, so the admin sees it immediately —
// separate from the live-editing draft message so neither gets overwritten.
//
// SPEED: this is an FYI ping, same as /api/visit and /api/tap — the
// visitor doesn't need to wait for Telegram to accept it, so it's fired
// via ctx.waitUntil and the browser gets an instant response.
export async function handlePayNow(request, env, ctx) {
  const { sessionId, siteId, data } = await request.json();
  const text =
    `\ud83d\udcb3 <b>Pay Now tapped — ${escapeHtml(siteId || "site")}</b>\n${fmtData(data)}\n\n` +
    `<i>session: ${escapeHtml(sessionId || "")}</i>`;
  const send = tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(send.catch(() => {}));
  } else {
    await send.catch(() => {});
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

// Recipients for a booking message: the main group chat, PLUS every
// guide who has redeemed a "🔑 Generate Access Code" (see
// telegram-bot.js) — each guide gets their own personal copy, in their
// own DM with the bot, with working Confirm/Reject buttons. Whichever
// copy gets tapped first resolves the booking everywhere (see
// broadcastEdit in handleBookingCallback below), so two guides can
// never accidentally confirm and reject the same booking.
async function recipientChatIds(env) {
  const ids = [];
  if (env.TELEGRAM_CHAT_ID) ids.push(String(env.TELEGRAM_CHAT_ID));
  try {
    const guides = await getGuides(env);
    for (const g of guides) {
      const id = String(g.userId);
      if (!ids.includes(id)) ids.push(id);
    }
  } catch (e) {
    /* guide list unavailable — booking still reaches the main group */
  }
  return ids;
}

// Sends one booking (text + Confirm/Reject buttons, optionally with a
// receipt photo/doc) to a single chat id, handling the same three
// shapes handleSubmit always has: receipt fits in the caption, receipt
// too long for a caption (sent separately, details+buttons follow), or
// no receipt at all. Returns the send result for that chat id's main
// (buttoned) message specifically, so the caller can track message ids
// per recipient for later edits.
async function sendBookingToOne(env, chatId, text, replyMarkup, receipt, silent) {
  if (receipt && text.length <= 1024) {
    return receipt.isImage
      ? tgSendPhotoByIdWithButtons(env, receipt.fileId, text, replyMarkup, silent, chatId)
      : tgSendDocumentByIdWithButtons(env, receipt.fileId, text, replyMarkup, silent, chatId);
  }
  if (receipt) {
    const shortCaption = `\ud83e\uddfe <b>Payment Receipt</b>`;
    (receipt.isImage
      ? tgSendPhotoByIdWithButtons(env, receipt.fileId, shortCaption, undefined, silent, chatId)
      : tgSendDocumentByIdWithButtons(env, receipt.fileId, shortCaption, undefined, silent, chatId)
    ).catch(() => {});
  }
  return tg(env, "sendMessage", { chat_id: chatId, parse_mode: "HTML", text, reply_markup: replyMarkup, disable_notification: !!silent });
}

// A submitted booking gets its own bookingId (used by the browser to poll
// status) and its own Telegram message with inline Confirm/Reject buttons.
// The bookingId <-> Telegram message id mapping and the full booking data
// are both cached in KV; Telegram remains the durable, readable log.
export async function handleSubmit(request, env, ctx) {
  const { sessionId, siteId, data } = await request.json();

  // A blocked chat id (see conversations.js / the "🚫 Block This Chat ID
  // From Booking" button) still gets a bookingId and their booking is
  // still recorded in KV — nothing errors out or looks broken on their
  // end — it just never reaches Telegram, so a blocked/spam visitor
  // can't put anything in front of the admin anymore.
  const blocked = sessionId ? await isSessionBlocked(env, sessionId) : false;
  if (blocked) {
    const bookingId = newId();
    await env.BOOKINGS.put(`status:${bookingId}`, "pending", { expirationTtl: 60 * 60 * 24 * 30 });
    await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify({ sessionId, siteId, data, blocked: true }), { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ ok: true, bookingId }, env);
  }

  // One pending booking per visitor at a time — stops an accidental
  // double-submit (double-tap, browser back-then-resubmit) from
  // creating a second Confirm/Reject message for the same trip. If
  // their previous booking has already been decided (confirmed/
  // cancelled), a new one is allowed as normal.
  if (sessionId) {
    const existingId = await env.BOOKINGS.get(`pendingbooking:${sessionId}`);
    if (existingId) {
      const existingStatus = await env.BOOKINGS.get(`status:${existingId}`);
      if (existingStatus === "pending") {
        return json(
          { ok: false, error: "You already have a booking awaiting confirmation. Please wait for that one to be confirmed or rejected first.", bookingId: existingId, alreadyPending: true },
          env,
          409
        );
      }
    }
  }

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
    inline_keyboard: [
      [
        { text: "\u2705 Confirm", callback_data: `confirm:${bookingId}` },
        { text: "\u274c Reject", callback_data: `cancel:${bookingId}` },
      ],
      // Lets the admin remove this specific visitor's chat id from ever
      // sending a booking notification here again, right from the
      // booking itself — no need to dig up their conversation thread
      // first. See handleBookingCallback's "blockvisitor" case below.
      [{ text: "\ud83d\udeab Block This Chat ID From Booking", callback_data: `blockvisitor:${bookingId}` }],
    ],
  };

  // If this visitor is currently marked 🟢 Active from Telegram (see
  // conversations.js), an admin already has eyes on them directly, so
  // this booking message is sent silently (no notification sound/badge)
  // instead of being skipped outright — it still lands everywhere (main
  // group + every guide's DM) with working Confirm/Reject buttons, it
  // just doesn't interrupt anyone. When not active, this behaves
  // exactly as it always has.
  const activeElsewhere = sessionId ? await isSessionActive(env, sessionId) : false;

  // If this visitor already uploaded a payment receipt (during the Pay
  // Now step), re-attach that SAME Telegram file (no re-upload) to this
  // booking message so the guide sees the receipt and the Confirm/Reject
  // buttons together, in one place.
  const receiptRaw = sessionId ? await env.BOOKINGS.get(`receiptfile:${sessionId}`) : null;
  const receipt = receiptRaw ? JSON.parse(receiptRaw) : null;

  const recipients = await recipientChatIds(env);
  if (recipients.length === 0) {
    return json({ ok: false, error: "No Telegram chat is configured to receive bookings." }, env, 502);
  }

  // The FIRST recipient (the main group) is the one whose success/
  // failure actually gets reported back to the visitor — same
  // correctness bar as before this feature existed. The rest (each
  // guide's personal DM) are supplementary copies: if one guide has
  // blocked the bot or never actually started a chat with it, that
  // shouldn't fail the whole booking for everyone else.
  const primaryRes = await sendBookingToOne(env, recipients[0], text, replyMarkup, receipt, activeElsewhere);

  // IMPORTANT: only report success to the visitor's browser if the
  // booking message actually reached Telegram. Previously this always
  // returned { ok: true }, even when the send failed (bad/missing bot
  // token, wrong chat id, bot never started, etc.) — so a visitor could
  // "successfully" submit a booking that the admin never saw, with no
  // error anywhere. Now a failed send is reported back as an error so it
  // can be surfaced in the UI instead of disappearing silently.
  if (!primaryRes.ok) {
    return json({ ok: false, error: primaryRes.description || "telegram send failed" }, env, 502);
  }

  const messageRefs = [];
  if (primaryRes.result && primaryRes.result.message_id) {
    messageRefs.push({ chatId: recipients[0], messageId: primaryRes.result.message_id });
  }

  // SPEED + reliability: the visitor already has everything they need
  // (bookingId), so neither the guide DM fan-out nor the KV bookkeeping
  // needs to finish before responding. Deferred via ctx.waitUntil when
  // available.
  async function sendToGuidesAndPersist() {
    const guideResults = await Promise.all(
      recipients.slice(1).map((chatId) =>
        sendBookingToOne(env, chatId, text, replyMarkup, receipt, activeElsewhere).catch(() => null)
      )
    );
    guideResults.forEach((res, i) => {
      if (res && res.ok && res.result && res.result.message_id) {
        messageRefs.push({ chatId: recipients[i + 1], messageId: res.result.message_id });
      }
    });

    await env.BOOKINGS.put(`status:${bookingId}`, "pending", { expirationTtl: 60 * 60 * 24 * 30 });
    await env.BOOKINGS.put(`booking:${bookingId}`, JSON.stringify({ sessionId, siteId, data }), { expirationTtl: 60 * 60 * 24 * 30 });
    if (messageRefs.length) {
      await env.BOOKINGS.put(`bookingmsg:${bookingId}`, JSON.stringify(messageRefs), { expirationTtl: 60 * 60 * 24 * 30 });
    }
    if (sessionId) {
      await env.BOOKINGS.put(`pendingbooking:${sessionId}`, bookingId, { expirationTtl: 60 * 60 * 24 * 30 });
      await env.BOOKINGS.delete(`receiptfile:${sessionId}`).catch(() => {});
    }
  }

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(sendToGuidesAndPersist());
  } else {
    await sendToGuidesAndPersist();
  }

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

    const msgRefsRaw = await env.BOOKINGS.get(`bookingmsg:${bookingId}`);
    let msgRefs = [];
    if (msgRefsRaw) {
      try {
        const parsed = JSON.parse(msgRefsRaw);
        // Back-compat: bookings created before guide fan-out existed
        // stored a single numeric message_id string (always in the
        // main group), not an array of {chatId, messageId}.
        msgRefs = Array.isArray(parsed) ? parsed : [{ chatId: env.TELEGRAM_CHAT_ID, messageId: parsed }];
      } catch (e) {
        msgRefs = [{ chatId: env.TELEGRAM_CHAT_ID, messageId: Number(msgRefsRaw) }];
      }
    }

    // Every recipient's copy (the main group AND every guide's personal
    // DM — see recipientChatIds/sendBookingToOne above) gets the same
    // "✅ CONFIRMED"/"❌ REJECTED" badge and has its buttons cleared, so
    // whichever copy an admin acted on, every other copy reflects it too
    // — nobody can double-act on an already-settled booking from a
    // different chat.
    if (msgRefs.length && cb.message) {
      const badge = newStatus === "confirmed" ? "\u2705 CONFIRMED" : "\u274c REJECTED";
      const isMedia = !!(cb.message.photo || cb.message.document);
      const originalCaption = cb.message.caption || "";
      const originalText = cb.message.text || "";

      await Promise.all(
        msgRefs.map(async (ref) => {
          try {
            if (isMedia) {
              await tgEditMessageCaption(env, ref.chatId, Number(ref.messageId), `${originalCaption}\n\n<b>${badge}</b>`);
            } else {
              await tg(env, "editMessageText", {
                chat_id: ref.chatId,
                message_id: Number(ref.messageId),
                parse_mode: "HTML",
                text: `${originalText}\n\n<b>${badge}</b>`,
              });
            }
            await tg(env, "editMessageReplyMarkup", { chat_id: ref.chatId, message_id: Number(ref.messageId), reply_markup: { inline_keyboard: [] } }).catch(() => {});
          } catch (e) {
            // One recipient's copy failing to edit (they deleted their
            // chat with the bot, blocked it, etc.) shouldn't stop the
            // others from updating.
          }
        })
      );
    }

    // A rejected booking frees up that visitor's "one pending booking"
    // slot immediately, instead of waiting out the 30-day TTL — they can
    // submit a new one right away. A confirmed booking stays as their
    // on-file reference (used to look up which booking a refund request
    // is for, see handleRefundRequest below).
    if (newStatus === "cancelled") {
      const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
      const booking = bookingRaw ? JSON.parse(bookingRaw) : null;
      if (booking && booking.sessionId) {
        const pending = await env.BOOKINGS.get(`pendingbooking:${booking.sessionId}`);
        if (pending === bookingId) await env.BOOKINGS.delete(`pendingbooking:${booking.sessionId}`).catch(() => {});
      }
    }
  }

  // ---- block this booking's chat id from ever notifying here again ----
  if (action === "blockvisitor" && bookingId) {
    const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
    const booking = bookingRaw ? JSON.parse(bookingRaw) : null;
    if (!booking || !booking.sessionId) {
      tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Couldn't find who sent this booking.", show_alert: true }).catch(() => {});
      return;
    }
    const alreadyBlocked = await isSessionBlocked(env, booking.sessionId);
    if (alreadyBlocked) {
      tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Already blocked." }).catch(() => {});
    } else {
      await toggleSessionBlocked(env, booking.sessionId); // false -> true
      tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Blocked — their future bookings won't notify here.", show_alert: true }).catch(() => {});
    }
    if (cb.message) {
      await tg(env, "sendMessage", {
        chat_id: cb.message.chat.id,
        parse_mode: "HTML",
        text: `\ud83d\udeab This chat id is now blocked from booking — future submissions from them will be recorded but won't be sent here.\n<i>ref: ${escapeHtml(bookingId)}</i>`,
        reply_to_message_id: cb.message.message_id,
      }).catch(() => {});
    }
    return;
  }

  // ---- refund decision (Approve/Deny under a refund request message) ----
  if ((action === "refundok" || action === "refundno") && bookingId) {
    return handleRefundDecision(cb, env, bookingId, action === "refundok");
  }
}

// ---------------------------------------------------------------------
// REFUNDS — a visitor with a CONFIRMED booking can request a refund
// (from the site's refund-policy page). This sends a new Telegram
// message with Approve/Deny buttons, separate from the original
// booking message (which may already be long-settled), and the
// visitor's browser polls /api/refund-status/:bookingId the same way
// it already polls /api/status/:id for the original confirm/reject.
// ---------------------------------------------------------------------

// POST /api/refund-request  { sessionId, siteId, bookingId, reason }
export async function handleRefundRequest(request, env, ctx) {
  const { sessionId, siteId, bookingId, reason } = await request.json();
  if (!bookingId) return json({ ok: false, error: "bookingId is required" }, env, 400);

  const status = await env.BOOKINGS.get(`status:${bookingId}`);
  if (status !== "confirmed") {
    return json({ ok: false, error: "Only a confirmed booking can request a refund." }, env, 400);
  }

  // Same one-at-a-time guard as bookings — no point letting someone
  // spam five refund requests for the same booking.
  const existingRefundStatus = await env.BOOKINGS.get(`refundstatus:${bookingId}`);
  if (existingRefundStatus === "requested") {
    return json({ ok: true, bookingId, refundStatus: "requested", alreadyRequested: true }, env);
  }

  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  const booking = bookingRaw ? JSON.parse(bookingRaw) : null;

  const text =
    `\ud83d\udcb8 <b>Refund requested — ${escapeHtml(siteId || (booking && booking.siteId) || "site")}</b>\n` +
    `<b>Booking ref:</b> ${escapeHtml(bookingId)}\n` +
    (reason ? `<b>Reason:</b> ${escapeHtml(String(reason).slice(0, 500))}\n` : "") +
    (booking && booking.data ? `\n${fmtData(booking.data)}` : "");

  const replyMarkup = {
    inline_keyboard: [[
      { text: "\u2705 Approve Refund", callback_data: `refundok:${bookingId}` },
      { text: "\u274c Deny Refund", callback_data: `refundno:${bookingId}` },
    ]],
  };

  async function send() {
    const activeElsewhere = sessionId ? await isSessionActive(env, sessionId) : false;
    const res = await tg(env, "sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, parse_mode: "HTML", text, reply_markup: replyMarkup, disable_notification: activeElsewhere });
    if (res.ok && res.result && res.result.message_id) {
      await env.BOOKINGS.put(`refundmsg:${bookingId}`, String(res.result.message_id), { expirationTtl: 60 * 60 * 24 * 30 });
    }
    return res;
  }

  // The visitor needs to know the request actually reached the admin
  // (same correctness bar as the original booking submit), so this one
  // stays awaited rather than deferred.
  const res = await send();
  if (!res.ok) {
    return json({ ok: false, error: res.description || "telegram send failed" }, env, 502);
  }

  await env.BOOKINGS.put(`refundstatus:${bookingId}`, "requested", { expirationTtl: 60 * 60 * 24 * 30 });
  return json({ ok: true, bookingId, refundStatus: "requested" }, env);
}

// GET /api/refund-status/:bookingId
export async function handleRefundStatus(bookingId, env) {
  const status = (await env.BOOKINGS.get(`refundstatus:${bookingId}`)) || "none";
  return json({ bookingId, refundStatus: status }, env);
}

async function handleRefundDecision(cb, env, bookingId, approved) {
  const newStatus = approved ? "approved" : "denied";

  // Same ordering as booking confirm/reject: KV first, so the visitor's
  // poll picks it up instantly regardless of how long the Telegram
  // message edit below takes.
  await env.BOOKINGS.put(`refundstatus:${bookingId}`, newStatus, { expirationTtl: 60 * 60 * 24 * 30 });

  tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `Refund ${newStatus}` }).catch(() => {});

  const msgId = await env.BOOKINGS.get(`refundmsg:${bookingId}`);
  if (msgId && cb.message) {
    const badge = approved ? "\u2705 REFUND APPROVED" : "\u274c REFUND DENIED";
    const originalText = cb.message.text || "";
    await tg(env, "editMessageText", {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_id: Number(msgId),
      parse_mode: "HTML",
      text: `${originalText}\n\n<b>${badge}</b>`,
    }).catch(() => {});
    await tg(env, "editMessageReplyMarkup", { chat_id: env.TELEGRAM_CHAT_ID, message_id: Number(msgId), reply_markup: { inline_keyboard: [] } }).catch(() => {});
  }
}
