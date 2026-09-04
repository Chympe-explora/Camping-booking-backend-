/**
 * conversations.js — the live chat layer between visitors and the admin.
 * -----------------------------------------------------------------------
 * Every visitor gets a stable short ID, and EVERY message they send is
 * forwarded straight to the Telegram admin chat. By default a
 * conversation is plain manual chat: nothing auto-replies until the
 * admin types a reply in Telegram. The admin can optionally flip a
 * specific visitor's conversation to AI / Human / Paused / Closed at
 * any time, straight from Telegram — "AI" hands that one conversation
 * to era-ai.js's knowledge-base auto-responder; every other state
 * leaves it as a plain human-to-human chat.
 *
 * Storage split, deliberately different from store.js's doc pattern:
 *   - store.js's getDoc/saveDoc treats a Telegram message as the
 *     PERMANENT record of slow-changing content (site text, prices...),
 *     edited in place. That's wrong for live chat traffic — a
 *     conversation changes on every visitor keystroke and editing one
 *     Telegram message in place would erase the very scrollback an
 *     admin needs to read the conversation.
 *   - So here, each visitor turn is forwarded as its OWN new Telegram
 *     message (the scrollback in that chat *is* the conversation log —
 *     no separate "history" feature needed, per spec §14). Conversation
 *     *state* (status, id, counters) is small and changes constantly,
 *     so it lives in plain KV, the same way store.js keeps the admin's
 *     transient button-flow session in KV only (see getSession there).
 *
 * Reply routing: every forwarded visitor-turn message's Telegram
 * message_id is mapped back to the visitor's sessionId. An admin can
 * reply three ways (per spec §12) — tap "↩️ Reply", swipe-reply on the
 * Telegram message itself (native reply_to_message), or run
 * `/reply <id> <text>` — all three end up here in deliverHumanReply().
 *
 * Delivery back to the visitor: a human's reply usually arrives after
 * the visitor's original HTTP request has already completed, so it
 * can't be returned in that response. It's queued in a small outbox
 * that the website widget polls (GET /api/era/poll) while the chat
 * panel is open.
 */

import { tgSendMessage, tgSendChatAction, kb, btn } from "./telegram.js";

const START_ID = 1047; // cosmetic — matches the spec's example IDs
const TGMSG_TTL = 60 * 60 * 24 * 30; // 30 days
const OUTBOX_TTL = 60 * 60 * 6; // 6 hours — plenty for a visitor to come back to an open tab

async function kvGet(env, key, fallback) {
  const raw = await env.BOOKINGS.get(key);
  if (!raw) return fallback ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback ?? null;
  }
}
async function kvSet(env, key, value, opts) {
  await env.BOOKINGS.put(key, JSON.stringify(value), opts);
}

// ---------------------------------------------------------------------
// conversation records
// ---------------------------------------------------------------------
async function nextShortId(env) {
  const cur = await kvGet(env, "conv:counter:global", START_ID - 1);
  const next = cur + 1;
  await kvSet(env, "conv:counter:global", next);
  return String(next);
}

export async function getConversation(env, sessionId) {
  if (!sessionId) return null;
  return kvGet(env, `conv:${sessionId}`, null);
}

export async function getConversationByShortId(env, shortId) {
  const sessionId = await env.BOOKINGS.get(`convid:${shortId}`);
  if (!sessionId) return null;
  return getConversation(env, sessionId);
}

export async function getOrCreateConversation(env, sessionId, site) {
  let conv = await getConversation(env, sessionId);
  if (conv) return conv;
  const id = await nextShortId(env);
  conv = {
    id,
    sessionId,
    site: site || "root",
    // Every new visitor chat starts in "human" mode: nothing auto-replies,
    // the message just goes straight to Telegram and waits for the admin
    // to type a reply there. An admin can still flip a specific
    // conversation to "🤖 AI" from Telegram if they want the knowledge-base
    // auto-responder for that visitor, but that's now opt-in per
    // conversation, not the default. "ai" | "human" | "paused" | "closed"
    status: "human",
    // "active" is separate from the above chat-mode status — it just
    // means "an admin is personally, actively handling this visitor
    // right now" (toggled from Telegram, per visitor). While a visitor
    // is marked active, booking.js skips the group-chat booking
    // confirm/reject ping for THEIR bookings specifically, since the
    // admin already has eyes on them directly and a second group
    // notification would just be noise. Defaults to false — the
    // group behaves exactly as it always has until an admin flips this.
    active: false,
    needsHuman: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    lastQuestion: "",
  };
  await kvSet(env, `conv:${sessionId}`, conv);
  await env.BOOKINGS.put(`convid:${id}`, sessionId);
  return conv;
}

export async function saveConversation(env, conv) {
  conv.lastActivity = Date.now();
  await kvSet(env, `conv:${conv.sessionId}`, conv);
}

export async function setConversationStatus(env, sessionId, status) {
  const conv = await getConversation(env, sessionId);
  if (!conv) return null;
  conv.status = status;
  if (status !== "ai") conv.needsHuman = false; // a human is on it now, one way or another
  await saveConversation(env, conv);
  return conv;
}

// Flips the "an admin is actively, personally handling this visitor"
// flag — independent of the ai/human/paused/closed chat-mode status
// above. See getOrCreateConversation() for what this controls.
export async function toggleConversationActive(env, sessionId) {
  const conv = await getConversation(env, sessionId);
  if (!conv) return null;
  conv.active = !conv.active;
  await saveConversation(env, conv);
  return conv;
}

// Used by booking.js to decide whether a booking confirm/reject ping
// should go to the group chat. Defensive against conversations that
// don't exist yet or predate this field (both just mean "not active").
export async function isSessionActive(env, sessionId) {
  if (!sessionId) return false;
  const conv = await getConversation(env, sessionId);
  return !!(conv && conv.active);
}

// Flips "remove this chat id from receiving booking [notifications]" —
// stored independently of the conversation record (a dedicated KV key,
// not a field on conv) because a visitor can submit a booking without
// ever having chatted first, so there may be no conversation to attach
// this to. Works for every visitor either way.
export async function isSessionBlocked(env, sessionId) {
  if (!sessionId) return false;
  return (await env.BOOKINGS.get(`blocked:${sessionId}`)) === "1";
}
export async function setSessionBlocked(env, sessionId, blocked) {
  if (!sessionId) return false;
  if (blocked) await env.BOOKINGS.put(`blocked:${sessionId}`, "1", { expirationTtl: 60 * 60 * 24 * 365 });
  else await env.BOOKINGS.delete(`blocked:${sessionId}`);
  return blocked;
}
export async function toggleSessionBlocked(env, sessionId) {
  const now = await isSessionBlocked(env, sessionId);
  await setSessionBlocked(env, sessionId, !now);
  return !now;
}

export function statusLabel(status) {
  return { ai: "🤖 AI ACTIVE", human: "👤 HUMAN SUPPORT", paused: "⏸ PAUSED", closed: "🔴 CLOSED" }[status] || status;
}

// ---------------------------------------------------------------------
// Telegram message_id -> visitor sessionId (for reply-to-message routing)
// ---------------------------------------------------------------------
export async function mapTelegramMessage(env, messageId, sessionId) {
  await env.BOOKINGS.put(`tgmsg:${messageId}`, sessionId, { expirationTtl: TGMSG_TTL });
}
export async function resolveTelegramMessage(env, messageId) {
  return env.BOOKINGS.get(`tgmsg:${messageId}`);
}

// ---------------------------------------------------------------------
// outbox — messages waiting for the visitor's browser to pick up on its
// next poll (used for human replies and anything else that arrives
// after the visitor's own request already got its response)
// ---------------------------------------------------------------------
export async function pushOutbox(env, sessionId, text, from) {
  const key = `outbox:${sessionId}`;
  const list = await kvGet(env, key, []);
  list.push({ id: crypto.randomUUID().slice(0, 8), text, from, ts: Date.now() });
  await kvSet(env, key, list.slice(-30), { expirationTtl: OUTBOX_TTL });
}

export async function readOutbox(env, sessionId, since) {
  const list = await kvGet(env, `outbox:${sessionId}`, []);
  return list.filter((m) => m.ts > (since || 0));
}

// ---------------------------------------------------------------------
// forwarding every visitor turn to Telegram — the mandatory, always-on
// notification the spec calls for (§2, §9), regardless of whether ERA
// already had an answer.
// ---------------------------------------------------------------------
function adminChatId(env) {
  return env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_CHAT_ID;
}

// Native Telegram "…is typing" bubble in the admin chat — the same
// WhatsApp-style live signal, triggered while a visitor is actively
// composing a message in the chat widget (before they hit send). Fails
// silently: a missed typing bubble should never break the chat itself.
export async function notifyTyping(env) {
  const chatId = adminChatId(env);
  if (!chatId) return;
  await tgSendChatAction(env, chatId, "typing").catch(() => {});
}

function convButtons(sessionId, active, blocked) {
  return kb([
    [btn("↩️ Reply", `convreply:${sessionId}`)],
    [btn("🤖 AI", `convai:${sessionId}`), btn("👤 Take Over", `convtakeover:${sessionId}`), btn("⏸ Pause", `convpause:${sessionId}`), btn("🔴 Close", `convclose:${sessionId}`)],
    [btn(active ? "🟢 Active (tap to turn off)" : "⚪ Not Active (tap to turn on)", `convactive:${sessionId}`)],
    [btn(blocked ? "✅ Unblock Bookings" : "🚫 Block Bookings", `convblock:${sessionId}`)],
  ]);
}

// meta: { isNew?: bool, escalated?: bool, reopened?: bool }
export async function forwardToTelegram(env, conv, visitorMessage, aiReply, meta = {}) {
  const chatId = adminChatId(env);
  if (!chatId) return;

  const flag = meta.escalated ? "⚠️ " : meta.isNew ? "🔔 " : "";
  const blocked = await isSessionBlocked(env, conv.sessionId);
  const lines = [
    `${flag}<b>Visitor #${conv.id}</b> — ${statusLabel(conv.status)}${conv.active ? " · 🟢 ACTIVE" : ""}${blocked ? " · 🚫 BLOCKED" : ""}${conv.site ? ` · <i>${escapeHtml(conv.site)}</i>` : ""}`,
  ];
  if (meta.reopened) lines.push(`<i>(conversation was closed — reopened by a new message)</i>`);
  lines.push(``, `💬 <b>Visitor:</b>\n${escapeHtml(visitorMessage)}`);

  if (aiReply) {
    lines.push(``, `🤖 <b>ERA AI:</b>\n${escapeHtml(aiReply)}`);
  } else if (conv.status === "human" || conv.status === "paused") {
    lines.push(``, `<i>No auto-reply sent — this conversation is in ${statusLabel(conv.status)} mode. Reply below to answer directly.</i>`);
  } else if (meta.escalated) {
    lines.push(``, `⚠️ <i>ERA AI wasn't confident enough to answer this one — a human reply is needed.</i>`);
  }

  const sent = await tgSendMessage(env, chatId, lines.join("\n"), { reply_markup: convButtons(conv.sessionId, conv.active, blocked) });
  if (sent && sent.ok) {
    await mapTelegramMessage(env, sent.result.message_id, conv.sessionId);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
