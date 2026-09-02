/**
 * reviews.js — visitor star ratings + comments for the website itself.
 * -----------------------------------------------------------------------
 * Shown as a "Visitor Reviews" section near the bottom of the home page:
 * visitors pick a 1–5 star rating and (optionally) leave a comment, and
 * the section displays the live average rating plus recent comments.
 *
 * TELEGRAM IS STILL THE RECORD-KEEPER for visibility — every new review
 * is also forwarded as a message to the admin chat, same pattern as
 * /api/visit and /api/tap — but the reviews themselves are stored as a
 * simple JSON array in KV (keyed by site) since they're read back on
 * every home page load and need to be fast, and there's no in-place
 * "one message per thing" editing need the way drafts/content have.
 */

import { json } from "./booking.js";
import { tgSendMessage } from "./telegram.js";

const MAX_NAME_LEN = 60;
const MAX_COMMENT_LEN = 500;
const MAX_STORED = 500; // keep the most recent 500 per site; older ones just age out
const MAX_RETURNED = 100;

function docKey(site) {
  return `reviews:${site || "root"}`;
}

async function kvGetReviews(env, site) {
  const raw = await env.BOOKINGS.get(docKey(site));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function kvSetReviews(env, site, reviews) {
  await env.BOOKINGS.put(docKey(site), JSON.stringify(reviews.slice(-MAX_STORED)));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// GET /api/reviews?site=root
export async function handleGetReviews(url, env) {
  const site = url.searchParams.get("site") || "root";
  const reviews = await kvGetReviews(env, site);
  const count = reviews.length;
  const average = count ? reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / count : 0;
  const sorted = [...reviews].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return json(
    {
      ok: true,
      average: Math.round(average * 10) / 10,
      count,
      reviews: sorted.slice(0, MAX_RETURNED).map((r) => ({
        id: r.id, name: r.name, rating: r.rating, comment: r.comment, ts: r.ts,
      })),
    },
    env
  );
}

// POST /api/reviews  { site, name, rating, comment }
export async function handleSubmitReview(request, env) {
  const body = await request.json().catch(() => ({}));
  const site = (body.site || "root").toString().slice(0, 40);
  const rating = Math.round(Number(body.rating));
  if (!rating || rating < 1 || rating > 5) {
    return json({ ok: false, error: "rating must be 1-5" }, env, 400);
  }
  const name = (body.name || "").toString().trim().slice(0, MAX_NAME_LEN) || "Anonymous";
  const comment = (body.comment || "").toString().trim().slice(0, MAX_COMMENT_LEN);

  const review = { id: crypto.randomUUID().slice(0, 8), name, rating, comment, ts: Date.now() };

  const reviews = await kvGetReviews(env, site);
  reviews.push(review);
  await kvSetReviews(env, site, reviews);

  // Let the admin know right away, same as a visit/tap ping.
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID || env.TELEGRAM_CHAT_ID;
  if (chatId) {
    const stars = "\u2b50".repeat(rating) + "\u2606".repeat(5 - rating);
    const text =
      `\ud83d\udcdd <b>New website review</b> — ${escapeHtml(site)}\n` +
      `${stars} (${rating}/5)\n` +
      `<b>${escapeHtml(name)}</b>` +
      (comment ? `:\n${escapeHtml(comment)}` : "");
    await tgSendMessage(env, chatId, text).catch(() => {});
  }

  return json({ ok: true, review }, env);
}
