/**
 * stats.js — a single pinned, permanently-updating message in the
 * TELEGRAM ADMIN CHAT showing a live visitor count and confirmed-booking
 * count. Edited in place (never a new message) so it genuinely "stays on
 * screen" — pinning keeps it at the top of the chat no matter how far the
 * rest of the conversation scrolls.
 *
 * - Visitors: bumped once per browser tab session, the same silent ping
 *   booking-bridge.js already sends on every page load (handleVisit).
 * - Bookings: bumped only when the admin/guide taps ✅ Confirm under a
 *   booking message — i.e. it's a count of bookings the telegram bot
 *   admin has actually confirmed, not just submitted.
 *
 * Counts live in KV as plain numbers (not JSON blobs) so bumping them is
 * a cheap read-increment-write, same pattern as everything else here:
 * Telegram is the visible record, KV is just the fast cache.
 */
import { tgSendMessage, tgEditMessageText, tgPinMessage } from "./telegram.js";

async function getNum(env, key) {
  const raw = await env.BOOKINGS.get(key);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}
async function setNum(env, key, value) {
  await env.BOOKINGS.put(key, String(value));
}

export async function getLiveStats(env) {
  const visitors = await getNum(env, "stats:visitors");
  const bookings = await getNum(env, "stats:bookings");
  return { visitors, bookings };
}

function renderStatsText(visitors, bookings) {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return (
    `📊 <b>Live Stats</b>\n` +
    `👀 Visitors: <b>${visitors}</b>\n` +
    `✅ Confirmed bookings: <b>${bookings}</b>\n\n` +
    `<i>Updates automatically — pinned so it's always visible. Last change: ${stamp}</i>`
  );
}

async function pushStatsMessage(env, visitors, bookings) {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) return; // no admin chat configured yet — skip silently
  const text = renderStatsText(visitors, bookings);
  const existingMsgId = await env.BOOKINGS.get("statsmsg");

  if (existingMsgId) {
    const r = await tgEditMessageText(env, chatId, Number(existingMsgId), text);
    if (r && r.ok) return;
    // message was deleted / too old to edit — fall through and send fresh
  }
  const sent = await tgSendMessage(env, chatId, text);
  if (sent && sent.ok && sent.result && sent.result.message_id) {
    await env.BOOKINGS.put("statsmsg", String(sent.result.message_id));
    tgPinMessage(env, chatId, sent.result.message_id).catch(() => {});
  }
}

export async function bumpVisitors(env) {
  const visitors = (await getNum(env, "stats:visitors")) + 1;
  await setNum(env, "stats:visitors", visitors);
  const bookings = await getNum(env, "stats:bookings");
  await pushStatsMessage(env, visitors, bookings);
  return visitors;
}

export async function bumpBookings(env) {
  const bookings = (await getNum(env, "stats:bookings")) + 1;
  await setNum(env, "stats:bookings", bookings);
  const visitors = await getNum(env, "stats:visitors");
  await pushStatsMessage(env, visitors, bookings);
  return bookings;
}

export async function resetStats(env) {
  await setNum(env, "stats:visitors", 0);
  await setNum(env, "stats:bookings", 0);
  await pushStatsMessage(env, 0, 0);
}
