/**
 * ratings.js — visitor-submitted website ratings + comments.
 * -----------------------------------------------------------------------
 * Same "Telegram is the storage" pattern as the rest of this backend
 * (see store.js): the full list of ratings for a site lives as a
 * `ratings:<site>` doc, edited in place via getDoc/saveDoc — which also
 * means it's automatically browsable AND deletable from the Telegram
 * admin bot's generic content tree (see the new "⭐ Visitor Ratings"
 * entry in telegram-bot.js's CATEGORIES — no bot-specific code needed
 * for that, the existing generic array walker handles it for free).
 *
 * On top of that record, every new rating also fires a one-off heads-up
 * message straight to the admin chat (the same pattern as
 * handleVisit/handleTap in booking.js) so a new review is never missed
 * even if the admin isn't actively browsing the ratings doc.
 *
 * A rating can be hidden (soft-delete) by setting `hidden: true` on its
 * entry from the bot instead of deleting it outright, if the admin ever
 * wants to keep a record of a review without showing it publicly —
 * handleGetRatings filters those out before it reaches the website.
 */

import { isValidSite, getDoc, saveDoc } from "./store.js";
import { json } from "./booking.js";
import { tgSendMessage } from "./telegram.js";

// Keeps the stored doc (and the Telegram message that holds it) from
// growing without bound on a long-running site — oldest ratings quietly
// age out of the stored record once past this many. Newest-first, so
// what visitors see is always the most recent reviews anyway.
const MAX_RATINGS = 300;

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// GET /api/ratings?site=root|krem-chympe|wilderness-expedition
export async function handleGetRatings(url, env) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);

  const list = await getDoc(env, `ratings:${site}`, []);
  const visible = (Array.isArray(list) ? list : []).filter((r) => r && r.hidden !== true);
  const count = visible.length;
  const average = count ? Math.round((visible.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / count) * 10) / 10 : 0;

  // 5/4/3/2/1-star breakdown — lets the website show a bar per star
  // count, not just the single average number.
  const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
  for (const r of visible) {
    const stars = Math.round(Number(r.rating) || 0);
    if (breakdown[stars] !== undefined) breakdown[stars]++;
  }

  const sorted = [...visible].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return json({ ok: true, ratings: sorted, average, count, breakdown }, env);
}

// POST /api/ratings  { site, name, rating, comment, sessionId }
export async function handleSubmitRating(request, env) {
  const body = await request.json().catch(() => ({}));
  const { site, name, rating, comment, sessionId } = body || {};
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);

  const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
  if (!stars) return json({ ok: false, error: "a 1-5 star rating is required" }, env, 400);

  const entry = {
    id: crypto.randomUUID().slice(0, 8),
    name: String(name || "Anonymous visitor").trim().slice(0, 60) || "Anonymous visitor",
    rating: stars,
    comment: String(comment || "").trim().slice(0, 500),
    ts: Date.now(),
  };

  const docKey = `ratings:${site}`;
  const list = await getDoc(env, docKey, []);
  const next = [entry, ...(Array.isArray(list) ? list : [])].slice(0, MAX_RATINGS);
  await saveDoc(env, docKey, next, {
    logChange: `New ${stars}\u2605 rating from ${entry.name}${entry.comment ? " (with a comment)" : ""}`,
  });

  const chatId = env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (chatId) {
    const starsDisplay = "\u2b50".repeat(stars) + "\u2606".repeat(5 - stars);
    const text =
      `\ud83c\udf1f <b>New website rating</b> \u2014 <i>${escapeHtml(site)}</i>\n` +
      `${starsDisplay}\n` +
      `<b>${escapeHtml(entry.name)}</b>` +
      (entry.comment ? `\n\u201c${escapeHtml(entry.comment)}\u201d` : "") +
      (sessionId ? `\n\n<i>session: ${escapeHtml(String(sessionId).slice(0, 64))}</i>` : "");
    await tgSendMessage(env, chatId, text).catch(() => {});
  }

  return json({ ok: true, rating: entry }, env);
}
