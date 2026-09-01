/**
 * conversations.js — the hybrid AI + human-support layer for ERA AI.
 * -----------------------------------------------------------------------
 * This is what turns era-ai.js from a plain FAQ bot into the system
 * described in the ERA AI spec: every visitor gets a stable short ID,
 * EVERY message they send is forwarded to the Telegram admin chat (not
 * just the ones ERA can't answer), and an admin can reply to a specific
 * visitor or flip their conversation between AI / Human / Paused /
 * Closed at any time, straight from Telegram.
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

import { tgSendMessage, kb, btn } from "./telegram.js";

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
    status: "ai", // "ai" | "human" | "paused" | "closed"
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

function convButtons(sessionId) {
  return kb([
    [btn("↩️ Reply", `convreply:${sessionId}`)],
    [btn("🤖 AI", `convai:${sessionId}`), btn("👤 Take Over", `convtakeover:${sessionId}`), btn("⏸ Pause", `convpause:${sessionId}`), btn("🔴 Close", `convclose:${sessionId}`)],
  ]);
}

// meta: { isNew?: bool, escalated?: bool, reopened?: bool }
export async function forwardToTelegram(env, conv, visitorMessage, aiReply, meta = {}) {
  const chatId = adminChatId(env);
  if (!chatId) return;

  const flag = meta.escalated ? "⚠️ " : meta.isNew ? "🔔 " : "";
  const lines = [
    `${flag}<b>Visitor #${conv.id}</b> — ${statusLabel(conv.status)}${conv.site ? ` · <i>${escapeHtml(conv.site)}</i>` : ""}`,
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

  const sent = await tgSendMessage(env, chatId, lines.join("\n"), { reply_markup: convButtons(conv.sessionId) });
  if (sent && sent.ok) {
    await mapTelegramMessage(env, sent.result.message_id, conv.sessionId);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
