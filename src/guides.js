/**
 * guides.js — Guide Management + package-based random booking
 * assignment, and the guide's own Telegram dashboard.
 *
 * Data model (plain KV, NOT the saveDoc/getDoc "permanent Telegram log"
 * pattern used for content/prices/etc — this data churns far too often
 * for that; every booking assignment or Active toggle would spam the
 * admin chat with a JSON dump otherwise):
 *
 *   guides:list          -> array of guide records (see shape below)
 *   guidecode:<code>     -> guideId (one-time-use, 7-day TTL)
 *   guideBookings:<id>   -> array of bookingIds assigned to that guide,
 *                           most-recent-last, capped to the last 300
 *
 * Guide record:
 *   {
 *     id,             // short internal id, e.g. "G1" — NOT their chat id
 *     name,           // display name the admin gave them
 *     site,           // "krem-chympe" | "wilderness-expedition"
 *     services,       // array of package keys, or ["all"]
 *     active,         // bool — the guide's own 🟢/🔴 toggle
 *     bookingAccess,  // bool — admin-only hard lock (🚫 Remove Booking
 *                     // Access); false overrides `active` either way
 *     chatId,         // null until their code is redeemed
 *     code,           // the still-pending access code, cleared on redemption
 *     createdAt, linkedAt
 *   }
 *
 * A guide is only eligible for a NEW booking when active && bookingAccess
 * && chatId is set (code redeemed) && (services includes "all" or the
 * booking's package key).
 */

// Every site with an actual booking backend has these two packages
// today (see content-schema.js's `packages` block for each site) — kept
// as a small constant here rather than re-deriving it from the pricing
// doc on every call, since adding a genuinely new package is a code
// change anyway (new pricing rules, new form fields), not something
// this list needs to stay dynamically in sync with.
export const SITE_PACKAGES = {
  "krem-chympe": [
    { key: "sharedTour", label: "📦 Package 1 — Shared Tour" },
    { key: "privatePackage", label: "🧭 Private Tour" },
  ],
  "wilderness-expedition": [
    { key: "sharedTour", label: "📦 Package 1 — Shared Tour" },
    { key: "privatePackage", label: "🧭 Private Tour" },
  ],
};
export const GUIDE_SITES = Object.keys(SITE_PACKAGES);

export async function getGuides(env) {
  const raw = await env.BOOKINGS.get("guides:list");
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
export async function saveGuides(env, guides) {
  await env.BOOKINGS.put("guides:list", JSON.stringify(guides));
}
export async function getGuide(env, guideId) {
  const guides = await getGuides(env);
  return guides.find((g) => g.id === guideId) || null;
}
export async function getGuideByChatId(env, chatId) {
  const guides = await getGuides(env);
  return guides.find((g) => String(g.chatId) === String(chatId)) || null;
}
export async function isLinkedGuide(env, chatId) {
  return !!(await getGuideByChatId(env, chatId));
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I — easy to read aloud
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function nextGuideId(env) {
  const n = (parseInt((await env.BOOKINGS.get("guides:counter")) || "0", 10) || 0) + 1;
  await env.BOOKINGS.put("guides:counter", String(n));
  return `G${n}`;
}

// Creates a new (not-yet-linked) guide record and a fresh code for it.
// Returns { guide, code }.
export async function createGuide(env, { name, site, services }) {
  const guides = await getGuides(env);
  const id = await nextGuideId(env);
  const code = randomCode();
  const guide = {
    id,
    name: name || `Guide ${id}`,
    site,
    services: services && services.length ? services : ["all"],
    active: true,
    bookingAccess: true,
    chatId: null,
    code,
    createdAt: Date.now(),
    linkedAt: null,
  };
  guides.push(guide);
  await saveGuides(env, guides);
  await env.BOOKINGS.put(`guidecode:${code}`, id, { expirationTtl: 60 * 60 * 24 * 7 });
  return { guide, code };
}

// Regenerates the code for an existing guide (e.g. they lost it, or
// admin wants to re-link them to a different Telegram account).
export async function regenerateGuideCode(env, guideId) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  const code = randomCode();
  guide.code = code;
  await saveGuides(env, guides);
  await env.BOOKINGS.put(`guidecode:${code}`, guideId, { expirationTtl: 60 * 60 * 24 * 7 });
  return code;
}

// Called when someone pastes a code into the bot. Links their chat id to
// the guide record that code belongs to. Returns the linked guide, or
// null if the code isn't valid/pending.
export async function redeemGuideCode(env, code, chatId) {
  const key = `guidecode:${code}`;
  const guideId = await env.BOOKINGS.get(key);
  if (!guideId) return null;
  await env.BOOKINGS.delete(key);

  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.chatId = String(chatId);
  guide.code = null;
  guide.linkedAt = Date.now();
  await saveGuides(env, guides);
  return guide;
}

export async function setGuideActive(env, guideId, active) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.active = active;
  await saveGuides(env, guides);
  return guide;
}
export async function setGuideBookingAccess(env, guideId, allowed) {
  const guides = await getGuides(env);
  const guide = guides.find((g) => g.id === guideId);
  if (!guide) return null;
  guide.bookingAccess = allowed;
  await saveGuides(env, guides);
  return guide;
}
export async function removeGuide(env, guideId) {
  const guides = await getGuides(env);
  const next = guides.filter((g) => g.id !== guideId);
  await saveGuides(env, next);
  // Existing bookings already assigned to this guide are untouched —
  // only removes them from future random assignment.
}

// ---------------------------------------------------------------------
// ASSIGNMENT — called from booking.js's handleSubmit.
// ---------------------------------------------------------------------

// Picks ONE eligible active guide at random for this site+package, or
// null if none exist (caller falls back to the admin group as the
// actionable recipient in that case).
export async function pickGuideForBooking(env, site, packageKey) {
  const guides = await getGuides(env);
  const eligible = guides.filter(
    (g) =>
      g.site === site &&
      g.chatId && // code must actually be redeemed
      g.active &&
      g.bookingAccess !== false &&
      (!packageKey || g.services.includes("all") || g.services.includes(packageKey))
  );
  if (eligible.length === 0) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

// Records the assignment (for the guide's dashboard) and appends to
// their booking index. Capped so one very active guide's index can't
// grow forever.
export async function assignBookingToGuide(env, guideId, bookingId) {
  const key = `guideBookings:${guideId}`;
  const raw = await env.BOOKINGS.get(key);
  let list = [];
  if (raw) {
    try {
      list = JSON.parse(raw);
    } catch {
      list = [];
    }
  }
  list.push(bookingId);
  if (list.length > 300) list = list.slice(-300);
  await env.BOOKINGS.put(key, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 120 });
}

export async function getGuideBookingIds(env, guideId) {
  const raw = await env.BOOKINGS.get(`guideBookings:${guideId}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
