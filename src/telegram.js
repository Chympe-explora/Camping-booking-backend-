/**
 * telegram.js — thin wrapper around the Telegram Bot API.
 *
 * This project's philosophy (same as the existing booking backend):
 * TELEGRAM IS THE STORAGE. There is no separate database. Every piece of
 * admin-editable state (site text, prices, discounts, highlights, images)
 * lives as a message in your Telegram admin chat — edited in place, the
 * same way a booking draft is edited in place. KV is only ever a small,
 * disposable *cache* of the last-known parsed value so the live website
 * can be answered in milliseconds without calling Telegram on every page
 * load. If KV is ever wiped, re-saving any field from the bot rebuilds
 * the cache — the Telegram message was always the source of truth.
 */

const API = (env) => `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;

export async function tg(env, method, body) {
  const r = await fetch(`${API(env)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export async function tgSendMessage(env, chatId, text, extra) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

export async function tgEditMessageText(env, chatId, messageId, text, extra) {
  const r = await tg(env, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
  // If the message no longer exists (deleted in chat) or content is
  // byte-identical, Telegram errors — caller falls back to sending new.
  return r;
}

export async function tgEditMessageReplyMarkup(env, chatId, messageId, replyMarkup) {
  return tg(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

export async function tgAnswerCallbackQuery(env, callbackQueryId, text, showAlert) {
  return tg(env, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: !!showAlert,
  });
}

export async function tgSendPhotoByFileId(env, chatId, fileId, caption) {
  return tg(env, "sendPhoto", { chat_id: chatId, photo: fileId, caption, parse_mode: "HTML" });
}

// Large JSON documents (bigger than Telegram's 4096-char message limit)
// are stored as an attached .json file instead of inline text, so
// nothing is ever silently truncated — Telegram genuinely holds the
// full record either way.
export async function tgSendDocumentText(env, chatId, filename, textContent, caption) {
  const form = new FormData();
  form.append("chat_id", chatId);
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  form.append("document", new Blob([textContent], { type: "application/json" }), filename);
  const r = await fetch(`${API(env)}/sendDocument`, { method: "POST", body: form });
  return r.json();
}

export async function tgEditMessageMediaDocument(env, chatId, messageId, filename, textContent, caption) {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("message_id", messageId);
  const media = { type: "document", media: "attach://file", caption, parse_mode: "HTML" };
  form.append("media", JSON.stringify(media));
  form.append("file", new Blob([textContent], { type: "application/json" }), filename);
  const r = await fetch(`${API(env)}/editMessageMedia`, { method: "POST", body: form });
  return r.json();
}

export async function tgPinMessage(env, chatId, messageId) {
  return tg(env, "pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
}

// Resolve a file_id to a fresh, fetchable Telegram CDN URL. file_id is
// permanent; the resolved file_path can rotate, so callers should not
// cache this URL for long — resolve it fresh on every image request.
export async function tgResolveFileUrl(env, fileId) {
  const r = await tg(env, "getFile", { file_id: fileId });
  if (!r.ok) return null;
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${r.result.file_path}`;
}

export function kb(rows) {
  return { inline_keyboard: rows };
}

export function btn(text, callback_data) {
  return { text, callback_data };
}
