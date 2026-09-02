/**
 * store.js — "documents" backed by Telegram, cached in KV.
 *
 * TELEGRAM IS THE STORAGE (same pattern the booking backend already
 * uses for drafts). Every editable document — site text, prices,
 * discounts, highlights, the image map — is a single message in your
 * Telegram admin chat that the bot EDITS IN PLACE every time something
 * changes, exactly like a booking draft. That message is the permanent,
 * human-readable, scrollable-in-Telegram record of the site's current
 * state. KV holds only a tiny cached copy of the last-known value +
 * that message's id, purely so the live website can be answered in a
 * few milliseconds instead of calling Telegram on every page load. If
 * KV is ever cleared, the very next bot edit re-creates the cache —
 * nothing is ever lost because the message in Telegram never was the
 * cache, it was always the record.
 *
 * Uploaded photos work the same way: the photo the admin sends in the
 * chat *is* the storage (Telegram's file_id), never re-uploaded
 * anywhere else. The website's /media route just resolves that file_id
 * to a fresh Telegram CDN link on demand.
 */

import {
  tgSendMessage,
  tgEditMessageText,
  tgPinMessage,
  tgSendDocumentText,
  tgEditMessageMediaDocument,
} from "./telegram.js";

export const SITES = ["root", "krem-chympe", "wilderness-expedition"];
export const SITE_LABELS = {
  root: "🏠 Home site",
  "krem-chympe": "🌊 Krem Chympe",
  "wilderness-expedition": "🥾 Wilderness Expedition",
};

export function isValidSite(site) {
  return SITES.includes(site);
}

// ---- low-level KV cache helpers ----
async function cacheGet(env, key, fallback) {
  const raw = await env.BOOKINGS.get(key);
  if (!raw) return fallback ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback ?? null;
  }
}
async function cacheSet(env, key, value) {
  await env.BOOKINGS.put(key, JSON.stringify(value));
}

// ---- document read/write ----
// docKey examples: "content:root", "prices:krem-chympe",
// "discounts:global", "highlights:root", "images:krem-chympe"
const DOC_TITLES = {
  content: "📝 SITE TEXT",
  prices: "💰 PRICES",
  discounts: "🏷️ DISCOUNTS & SALES",
  highlights: "🌟 HIGHLIGHTS",
  images: "🖼️ IMAGE MAP (key → telegram file_id)",
  ratings: "⭐ VISITOR RATINGS",
};

export async function getDoc(env, docKey, fallback) {
  return cacheGet(env, `doc:${docKey}`, fallback ?? {});
}

// Save a full doc value: updates the KV cache AND edits (or creates) the
// permanent Telegram message that stores it.
export async function saveDoc(env, docKey, value, opts = {}) {
  await cacheSet(env, `doc:${docKey}`, value);

  const [kind, site] = docKey.split(":");
  const title = DOC_TITLES[kind] || kind.toUpperCase();
  const heading = site ? `${title} — ${SITE_LABELS[site] || site}` : title;
  const json = JSON.stringify(value, null, 2);
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  const msgIdKey = `docmsg:${docKey}`;
  const modeKey = `docmode:${docKey}`; // "text" | "document"
  const existingMsgId = await cacheGet(env, msgIdKey, null);
  const existingMode = await cacheGet(env, modeKey, null);

  const useDocument = json.length > 3200; // stay well under Telegram's 4096-char cap

  if (!useDocument) {
    const text =
      `<b>${heading}</b>\n` +
      `<i>Auto-updated by the admin bot. Do not edit this message by hand.</i>\n\n` +
      `<pre>${escapeHtml(json)}</pre>`;
    if (existingMsgId && existingMode === "text") {
      const r = await tgEditMessageText(env, chatId, existingMsgId, text);
      if (r && r.ok) {
        if (opts.logChange) await logChange(env, docKey, opts.logChange);
        return;
      }
    }
    const sent = await tgSendMessage(env, chatId, text);
    if (sent && sent.ok) {
      await cacheSet(env, msgIdKey, sent.result.message_id);
      await cacheSet(env, modeKey, "text");
      safePin(env, chatId, sent.result.message_id);
    }
  } else {
    const caption = `<b>${heading}</b>\nAuto-updated by the admin bot — full record attached as JSON.`;
    const filename = `${docKey.replace(/[:/]/g, "-")}.json`;
    if (existingMsgId && existingMode === "document") {
      const r = await tgEditMessageMediaDocument(env, chatId, existingMsgId, filename, json, caption);
      if (r && r.ok) {
        if (opts.logChange) await logChange(env, docKey, opts.logChange);
        return;
      }
    }
    const sent = await tgSendDocumentText(env, chatId, filename, json, caption);
    if (sent && sent.ok) {
      await cacheSet(env, msgIdKey, sent.result.message_id);
      await cacheSet(env, modeKey, "document");
      safePin(env, chatId, sent.result.message_id);
    }
  }
  if (opts.logChange) await logChange(env, docKey, opts.logChange);
}

function safePin(env, chatId, messageId) {
  tgPinMessage(env, chatId, messageId).catch(() => {});
}

async function logChange(env, docKey, summary) {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  await tgSendMessage(env, chatId, `✏️ <b>${escapeHtml(docKey)}</b>\n${escapeHtml(summary)}`);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---- path helpers (dotted / array-index paths like "hero.title" or
// "destinations.items.0.description") ----
export function setPath(obj, path, value) {
  const parts = pathParts(path);
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const nextKey = parts[i + 1];
    if (cur[key] === undefined || cur[key] === null) {
      cur[key] = /^\d+$/.test(nextKey) ? [] : {};
    }
    cur = cur[key];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

// Removes whatever override lives at `path` (an object key, or an
// array index) so that path falls back to the code's default again —
// this is the building block behind every "↩️ Reset to default"
// button. Unlike setPath, this never creates intermediate objects: if
// nothing was overridden along the way, it's a no-op.
export function deletePath(obj, path) {
  const parts = pathParts(path);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur == null || cur[key] === undefined) return obj;
    cur = cur[key];
  }
  const lastKey = parts[parts.length - 1];
  if (cur == null) return obj;
  if (Array.isArray(cur)) {
    const idx = Number(lastKey);
    if (!Number.isNaN(idx)) cur.splice(idx, 1);
  } else if (typeof cur === "object") {
    delete cur[lastKey];
  }
  return obj;
}

export function getPath(obj, path) {
  let cur = obj;
  for (const p of pathParts(path)) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function pathParts(path) {
  return String(path).split(".").filter((p) => p.length);
}

export function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(override)) return override;
  if (typeof override !== "object") return override;
  if (typeof base !== "object" || base === null || Array.isArray(base)) base = {};
  const out = { ...base };
  for (const k of Object.keys(override)) out[k] = deepMerge(base[k], override[k]);
  return out;
}

// ---- bot conversation state (transient — KV only, never posted to
// Telegram; this is just "what button flow is this admin mid-way
// through", not part of the site record) ----
export async function getSession(env, chatId) {
  return cacheGet(env, `admin:session:${chatId}`, null);
}
export async function setSession(env, chatId, state) {
  await env.BOOKINGS.put(`admin:session:${chatId}`, JSON.stringify(state), { expirationTtl: 1800 });
}
export async function clearSession(env, chatId) {
  await env.BOOKINGS.delete(`admin:session:${chatId}`);
}
