/**
 * telegram-bot.js — the whole admin experience. Everything is a button.
 * The ONLY time the admin has to type or send something is the literal
 * content itself (new text, a new number, a new photo) — never a
 * command, never a menu choice.
 *
 * Navigation model: the current "where am I" (which document, which
 * site, which path inside the JSON tree) lives in a short-lived KV
 * session, NOT in callback_data — so callback_data stays tiny (well
 * under Telegram's 64-byte limit) no matter how deep the admin has
 * drilled into the content tree.
 */

import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { SITES, SITE_LABELS, getDoc, saveDoc, deepMerge, getPath, setPath, deletePath, getSession, setSession, clearSession } from "./store.js";
import { listChildren, humanize, chunk } from "./walker.js";
import { DEFAULT_DISCOUNTS } from "./pricing.js";
import { tg, tgSendMessage, tgAnswerCallbackQuery, kb, btn } from "./telegram.js";
import { getLiveStats, resetStats } from "./stats.js";
import { getEraStatusText, listUnanswered, teachAnswer, discardUnanswered, setLearningEnabled, parseQABlob, teachBulkAnswers, addAdminNotes } from "./era-ai.js";
import { getConversation, getConversationByShortId, setConversationStatus, toggleConversationActive, toggleSessionBlocked, resolveTelegramMessage, pushOutbox, statusLabel } from "./conversations.js";
import {
  SITE_PACKAGES,
  GUIDE_SITES,
  getGuides,
  getGuide,
  getGuideByChatId,
  isLinkedGuide,
  createGuide,
  regenerateGuideCode,
  redeemGuideCode,
  setGuideActive,
  setGuideBookingAccess,
  removeGuide as removeGuideRecord,
  getGuideBookingIds,
} from "./guides.js";

// The Worker's own public URL — used to build the /media-video proxy
// link an uploaded background video is served from (see
// content-api.js's handleVideoMedia). Same domain the frontend's
// booking-bridge.js already calls for /api/*. If this project is ever
// moved to a custom domain, set a WORKER_BASE_URL env var and that
// takes priority over this fallback — see its one use below.
const DEFAULT_WORKER_BASE_URL = "https://chympe-booking-backend.senlysuchiang87.workers.dev";

const CATEGORIES = [
  { kind: "content", label: "✏️ Edit Website Text", perSite: true },
  { kind: "images", label: "🖼️ Change Photos", perSite: true },
  { kind: "prices", label: "💰 Edit Prices", perSite: true, sites: ["krem-chympe", "wilderness-expedition"] },
  { kind: "discounts", label: "🏷️ Discounts & Sales", perSite: false },
  { kind: "highlights", label: "🌟 Highlights / Banner", perSite: true },
  { kind: "ratings", label: "⭐ Visitor Ratings", perSite: true },
];

function isAdmin(env, userId) {
  const allowed = (env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true; // no allowlist configured yet — open (see DEPLOY.md)
  return allowed.includes(String(userId));
}

// ---------------------------------------------------------------------
// GUIDE ACCESS CODES — self-service way to link a new guide's Telegram
// chat to a guide profile the admin already created (name + site +
// which packages they cover — see "➕ Add Guide" below), without
// touching ADMIN_USER_IDS / the Cloudflare dashboard. One admin creates
// the guide, shares the 6-character code, the new guide just sends
// that code as a plain message to this bot. One-time use, expires
// after 7 days.
//
// A linked guide is NOT the same as a full admin — they get their own
// separate Guide Dashboard menu (bookings assigned to them, their own
// 🟢/🔴 Active toggle, My Services, My Account), not the content-editing
// admin menu. See sendGuideMenu below, and the isAdmin/isLinkedGuide
// branch in handleTelegramAdminUpdate.
// ---------------------------------------------------------------------

// Called from handleTelegramAdminUpdate for a message from someone who
// isn't already an admin — the ONLY thing such a message is allowed to
// do is redeem a valid code. Returns true if it handled the message
// (redeemed or not, still counts as handled so the normal "you're not
// an admin" refusal doesn't also fire), false to fall through to that
// refusal as before.
async function tryRedeemGuideCode(env, chatId, userId, msg) {
  const raw = (msg.text || "").trim().toUpperCase();
  const text = raw.replace(/^\/JOIN\s+/, "");
  if (!/^[A-Z0-9]{6}$/.test(text)) return false;

  const guide = await redeemGuideCode(env, text, userId);
  if (!guide) return false; // not a real/pending code — treat as a normal (refused) message

  const packages = (SITE_PACKAGES[guide.site] || []).filter((p) => guide.services.includes("all") || guide.services.includes(p.key));
  const servicesLine = guide.services.includes("all") ? "All Services" : packages.map((p) => p.label).join(", ") || guide.services.join(", ");

  await tgSendMessage(
    env,
    chatId,
    `✅ You're linked, ${escapeHtml(guide.name)}!\n\n<b>Site:</b> ${SITE_LABELS[guide.site] || guide.site}\n<b>Services:</b> ${escapeHtml(servicesLine)}\n\nWhile you're 🟢 Active, new bookings for your services will be sent to you right here — with full details and ✅ Confirm / ❌ Reject buttons. Tap "📊 Dashboard" any time to see what's assigned to you.`
  );
  await sendGuideMenu(env, chatId, guide);
  return true;
}

export async function handleTelegramAdminUpdate(env, update) {
  const msg = update.message;
  const cb = update.callback_query;

  const userId = msg?.from?.id ?? cb?.from?.id;
  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chatId) return;

  const realAdmin = isAdmin(env, userId);
  const guide = realAdmin ? null : await getGuideByChatId(env, userId);

  if (!realAdmin && !guide) {
    // Not recognized at all yet — the only thing such a message is
    // allowed to do is redeem a valid guide access code (see "➕ Add
    // Guide" in Guide Management). Anything else gets the standard
    // refusal.
    if (msg && msg.text && (await tryRedeemGuideCode(env, chatId, userId, msg))) return;
    if (msg) await tgSendMessage(env, chatId, "❌ You're not recognized by this bot yet.");
    return;
  }

  // A linked guide gets an entirely separate, much smaller menu (their
  // own bookings, their own 🟢/🔴 toggle, My Services, My Account) —
  // never the content-editing admin menu. Buttons only, per spec, so
  // there's no text-input flow to handle here at all.
  if (guide && !realAdmin) {
    if (cb) {
      await tgAnswerCallbackQuery(env, cb.id);
      await handleGuideCallback(env, chatId, guide, cb.data);
      return;
    }
    if (msg?.text === "/start" || msg?.text === "/menu") {
      await sendGuideMenu(env, chatId, guide);
      return;
    }
    await sendGuideMenu(env, chatId, guide, "Tap a button to get started 👇");
    return;
  }

  if (cb) {
    await tgAnswerCallbackQuery(env, cb.id);
    await handleCallback(env, chatId, cb.message.message_id, cb.data);
    return;
  }

  if (msg?.text === "/start" || msg?.text === "/menu") {
    await clearSession(env, chatId);
    await sendMainMenu(env, chatId);
    return;
  }

  // Jump straight into bulk-teach mode from anywhere, anytime — no
  // need to navigate the menu first.
  if (msg?.text === "/teach") {
    await startEraBulkTeach(env, chatId);
    return;
  }

  // /reply <id> <message> — reply to a specific visitor's conversation
  // by its short ID, from anywhere, anytime (see spec §12, option 2).
  if (msg?.text && /^\/reply\b/i.test(msg.text)) {
    return handleReplyCommand(env, chatId, msg.text);
  }

  // Native Telegram "swipe to reply" on a visitor-turn message we
  // forwarded — this is an unambiguous, explicit admin gesture, so it
  // takes priority over whatever button-flow session might otherwise
  // be active (spec §12, option 3 — the preferred, easiest path for a
  // non-technical guide).
  if (msg?.text && msg.reply_to_message?.message_id) {
    const sessionId = await resolveTelegramMessage(env, msg.reply_to_message.message_id);
    if (sessionId) {
      await deliverHumanReply(env, chatId, sessionId, msg.text);
      return;
    }
  }

  // Anything else is a reply to something the bot asked for
  const session = await getSession(env, chatId);
  if (session?.awaiting) {
    await handleAwaitedInput(env, chatId, session, msg);
    return;
  }

  await sendMainMenu(env, chatId, "Tap a button to get started 👇");
}

// ---------------- MAIN MENU ----------------

async function sendMainMenu(env, chatId, note) {
  const rows = CATEGORIES.map((c) => [btn(c.label, `pick:${c.kind}`)]);
  // Quick-access shortcuts straight into the two new config trees added
  // for the background-video/section-styling upgrade — same underlying
  // data as "✏️ Edit Website Text" (background / sectionStyles live
  // inside KC_CONTENT), just jumping past the top-level menu so admins
  // don't have to know those keys exist to find them.
  rows.push([btn("🎬 Background Manager", "bgpick")]);
  rows.push([btn("🧱 Section Styling", "secpick")]);
  rows.push([btn("🔘 Hero Button (text & link)", "herobtnpick")]);
  rows.push([btn("📹 Upload Background Video", "vidpick")]);
  rows.push([btn("🧭 Guide Management", "guidemgmt")]);
  rows.push([btn("🤖 ERA AI Assistant", "eraai")]);
  rows.push([btn("👁️ Preview Live Sites", "preview")]);
  rows.push([btn("📊 Live Stats", "stats")]);
  rows.push([btn("🧨 Reset EVERYTHING to default", "resetworld")]);
  const text =
    (note ? note + "\n\n" : "") +
    "👑 <b>Website Admin</b>\nWhat do you want to do?";
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

// ---------------- GUIDE MANAGEMENT (admin side) ----------------

async function sendGuideManagementMenu(env, chatId, note) {
  const guides = await getGuides(env);
  const rows = [
    [btn("➕ Add Guide", "addguide")],
    [btn(`👥 Guides (${guides.length})`, "guidelist")],
    [btn("⬅️ Main Menu", "home")],
  ];
  await tgSendMessage(
    env,
    chatId,
    (note ? note + "\n\n" : "") + "🧭 <b>Guide Management</b>\n\nCreate guides, assign them to Package 1 / Package 2 / Private Tour / All Services, and control who's currently eligible for new bookings.",
    { reply_markup: kb(rows) }
  );
}

async function startAddGuide(env, chatId) {
  await setSession(env, chatId, { awaiting: { type: "guidename" } });
  await tgSendMessage(env, chatId, "➕ <b>Add Guide</b>\n\nWhat's this guide's name? Send it as a plain message.", {
    reply_markup: kb([[btn("❌ Cancel", "guidemgmt")]]),
  });
}

async function chooseAddGuideSite(env, chatId, site) {
  const session = await getSession(env, chatId);
  const name = session?.addGuide?.name;
  if (!name) return sendGuideManagementMenu(env, chatId, "⚠️ Let's start over.");
  await setSession(env, chatId, { addGuide: { name, site, services: [] } });
  await sendServicePicker(env, chatId, site, []);
}

async function sendServicePicker(env, chatId, site, selected) {
  const packages = SITE_PACKAGES[site] || [];
  const rows = packages.map((p) => [
    btn(`${selected.includes(p.key) ? "☑️" : "⬜"} ${p.label}`, `addguidesvc:${p.key}`),
  ]);
  rows.push([btn("✅ All Services", "addguideall")]);
  rows.push([btn(`✅ Done (${selected.length} selected)`, "addguidedone")]);
  rows.push([btn("❌ Cancel", "guidemgmt")]);
  await tgSendMessage(
    env,
    chatId,
    `📦 <b>Which services does this guide cover?</b>\n\nTap each package to toggle it, or just tap "All Services". Then tap Done.`,
    { reply_markup: kb(rows) }
  );
}

async function toggleAddGuideService(env, chatId, key) {
  const session = await getSession(env, chatId);
  const ag = session?.addGuide;
  if (!ag || !ag.site) return sendGuideManagementMenu(env, chatId, "⚠️ Let's start over.");
  const services = ag.services.includes(key) ? ag.services.filter((s) => s !== key) : [...ag.services, key];
  await setSession(env, chatId, { addGuide: { ...ag, services } });
  await sendServicePicker(env, chatId, ag.site, services);
}

async function finishAddGuide(env, chatId, allServices) {
  const session = await getSession(env, chatId);
  const ag = session?.addGuide;
  if (!ag || !ag.site) return sendGuideManagementMenu(env, chatId, "⚠️ Let's start over.");
  if (!allServices && ag.services.length === 0) {
    return sendServicePicker(env, chatId, ag.site, ag.services); // nudge them to pick at least one or tap All Services
  }
  const services = allServices ? ["all"] : ag.services;
  const { guide, code } = await createGuide(env, { name: ag.name, site: ag.site, services });
  await clearSession(env, chatId);
  await tgSendMessage(
    env,
    chatId,
    `✅ <b>${escapeHtml(guide.name)}</b> created (${SITE_LABELS[guide.site] || guide.site}).\n\n🔑 <b>Their access code:</b>\n<code>${code}</code>\n\nSend this to them. They just open a chat with this bot and send the code as a plain message — no /commands needed. Expires in 7 days, works once.`,
    { reply_markup: kb([[btn("⬅️ Guide Management", "guidemgmt")]]) }
  );
}

async function sendGuideListMenu(env, chatId, site) {
  const guides = await getGuides(env);
  if (!site) {
    // First tap: choose which site's guides to list (guides only make
    // sense per-site, since packages are per-site).
    const rows = GUIDE_SITES.map((s) => [btn(`${SITE_LABELS[s] || s} (${guides.filter((g) => g.site === s).length})`, `guidelist:${s}`)]);
    rows.push([btn("⬅️ Guide Management", "guidemgmt")]);
    await tgSendMessage(env, chatId, "👥 <b>Guides</b>\n\nWhich site?", { reply_markup: kb(rows) });
    return;
  }
  const siteGuides = guides.filter((g) => g.site === site);
  if (!siteGuides.length) {
    await tgSendMessage(env, chatId, `No guides yet for ${SITE_LABELS[site] || site}.`, {
      reply_markup: kb([[btn("➕ Add Guide", "addguide")], [btn("⬅️ Guide Management", "guidemgmt")]]),
    });
    return;
  }
  const rows = siteGuides.map((g) => {
    const status = !g.chatId ? "⏳" : g.bookingAccess === false ? "🚫" : g.active ? "🟢" : "🔴";
    return [btn(`${status} ${truncateLabel(g.name)}`, `guidedetail:${g.id}`)];
  });
  rows.push([btn("⬅️ Guide Management", "guidemgmt")]);
  await tgSendMessage(env, chatId, `👥 <b>Guides — ${SITE_LABELS[site] || site}</b>\n\n⏳ = code not redeemed yet · 🟢 Active · 🔴 Not Active · 🚫 Booking access removed`, { reply_markup: kb(rows) });
}

async function sendGuideDetailMenu(env, chatId, guideId, note) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");

  const packages = SITE_PACKAGES[guide.site] || [];
  const servicesLine = guide.services.includes("all")
    ? "All Services"
    : packages.filter((p) => guide.services.includes(p.key)).map((p) => p.label).join(", ") || "(none selected)";
  const linkLine = guide.chatId ? `Linked ✅ (chat id ${escapeHtml(String(guide.chatId))})` : `⏳ Awaiting code redemption\n<code>${escapeHtml(guide.code || "")}</code>`;

  const text =
    (note ? note + "\n\n" : "") +
    `👤 <b>${escapeHtml(guide.name)}</b>\n` +
    `Site: ${SITE_LABELS[guide.site] || guide.site}\n` +
    `Services: ${escapeHtml(servicesLine)}\n` +
    `Status: ${guide.active ? "🟢 Active" : "🔴 Not Active"} · ${guide.bookingAccess === false ? "🚫 Booking access removed" : "✅ Booking access OK"}\n` +
    `${linkLine}`;

  const rows = [
    [btn(guide.active ? "🔴 Set Not Active" : "🟢 Set Active", `guidetoggleactive:${guide.id}`)],
    [btn(guide.bookingAccess === false ? "✅ Restore Booking Access" : "🚫 Remove Booking Access", `guidetoggleaccess:${guide.id}`)],
    [btn("📋 View Bookings", `guidebookings:${guide.id}`)],
    [btn("🔑 Regenerate Code", `guideregencode:${guide.id}`)],
    [btn("🗑 Remove Guide", `guideremove:${guide.id}`)],
    [btn("⬅️ Back", `guidelist:${guide.site}`)],
  ];
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

async function toggleGuideActiveFromAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  await setGuideActive(env, guideId, !guide.active);
  await sendGuideDetailMenu(env, chatId, guideId);
}

async function toggleGuideAccessFromAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  await setGuideBookingAccess(env, guideId, guide.bookingAccess === false); // flips false->true, true/undefined->false
  await sendGuideDetailMenu(env, chatId, guideId);
}

async function regenGuideCodeFromAdmin(env, chatId, guideId) {
  const code = await regenerateGuideCode(env, guideId);
  if (!code) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  await sendGuideDetailMenu(env, chatId, guideId, `🔑 New code: <code>${code}</code> (expires in 7 days, works once — their old code, if any, no longer works)`);
}

async function removeGuideFromAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  await removeGuideRecord(env, guideId);
  await sendGuideListMenu(env, chatId, guide ? guide.site : null);
}

async function sendGuideBookingsForAdmin(env, chatId, guideId) {
  const guide = await getGuide(env, guideId);
  if (!guide) return sendGuideManagementMenu(env, chatId, "⚠️ That guide no longer exists.");
  const ids = (await getGuideBookingIds(env, guideId)).slice(-15).reverse();
  if (!ids.length) {
    await tgSendMessage(env, chatId, `${escapeHtml(guide.name)} has no bookings assigned yet.`, {
      reply_markup: kb([[btn("⬅️ Back", `guidedetail:${guideId}`)]]),
    });
    return;
  }
  const lines = await Promise.all(
    ids.map(async (id) => {
      const status = (await env.BOOKINGS.get(`status:${id}`)) || "pending";
      return `• <code>${escapeHtml(id)}</code> — ${escapeHtml(status)}`;
    })
  );
  await tgSendMessage(env, chatId, `📋 <b>${escapeHtml(guide.name)}'s recent bookings</b>\n\n${lines.join("\n")}`, {
    reply_markup: kb([[btn("⬅️ Back", `guidedetail:${guideId}`)]]),
  });
}

// ---------------- GUIDE DASHBOARD (the guide's own menu) ----------------

function guideStatusFooter(guide) {
  if (guide.bookingAccess === false) return "🚫 Your booking access has been removed by the admin — you can still view existing bookings.";
  return guide.active ? "🟢 You're Active — eligible for new bookings." : "🔴 You're Not Active — you won't receive new bookings until you switch back on.";
}

async function sendGuideMenu(env, chatId, guide, note) {
  const rows = [
    [btn("📊 Dashboard", "gdash"), btn("📅 Today's Bookings", "gtoday")],
    [btn("🔜 Future Bookings", "gfuture"), btn("📋 All Bookings", "gall")],
    [btn("📈 Booking Summary", "gsummary"), btn("📦 My Services", "gservices")],
    [btn(guide.active ? "🔴 Set Not Active" : "🟢 Set Active", "gtoggleactive")],
    [btn("👤 My Account", "gaccount")],
  ];
  await tgSendMessage(
    env,
    chatId,
    (note ? note + "\n\n" : "") + `👋 <b>${escapeHtml(guide.name)}</b>\n${guideStatusFooter(guide)}`,
    { reply_markup: kb(rows) }
  );
}

async function guideBookingBuckets(env, guideId) {
  const ids = await getGuideBookingIds(env, guideId);
  const todayStr = new Date().toISOString().slice(0, 10);
  const buckets = { today: [], future: [], all: ids, completed: [], remaining: [] };
  for (const id of ids) {
    const [statusRaw, bookingRaw, completedRaw] = await Promise.all([
      env.BOOKINGS.get(`status:${id}`),
      env.BOOKINGS.get(`booking:${id}`),
      env.BOOKINGS.get(`completed:${id}`),
    ]);
    const status = statusRaw || "pending";
    const booking = bookingRaw ? JSON.parse(bookingRaw) : null;
    const date = booking?.data?.date || null;
    const isCompleted = completedRaw === "1";
    if (date === todayStr) buckets.today.push(id);
    if (date && date > todayStr) buckets.future.push(id);
    if (isCompleted) buckets.completed.push(id);
    else if (status === "confirmed") buckets.remaining.push(id);
  }
  return buckets;
}

async function sendGuideBookingList(env, chatId, guide, ids, title) {
  if (!ids.length) {
    await tgSendMessage(env, chatId, `${title}\n\nNothing here right now.`, { reply_markup: kb([[btn("⬅️ Back", "gdash")]]) });
    return;
  }
  const rows = await Promise.all(
    ids.slice(-20).reverse().map(async (id) => {
      const status = (await env.BOOKINGS.get(`status:${id}`)) || "pending";
      return [btn(`${statusEmoji(status)} ${id}`, `gbooking:${id}`)];
    })
  );
  rows.push([btn("⬅️ Back", "gdash")]);
  await tgSendMessage(env, chatId, title, { reply_markup: kb(rows) });
}

function statusEmoji(status) {
  if (status === "confirmed") return "✅";
  if (status === "cancelled") return "❌";
  return "⏳";
}

function fmtBookingData(data) {
  return Object.entries(data || {})
    .filter(([k, v]) => v !== undefined && v !== null && v !== "" && k !== "message")
    .map(([k, v]) => `<b>${escapeHtml(k)}:</b> ${escapeHtml(String(v))}`)
    .join("\n");
}

async function sendGuideBookingDetail(env, chatId, guide, bookingId) {
  const bookingRaw = await env.BOOKINGS.get(`booking:${bookingId}`);
  const status = (await env.BOOKINGS.get(`status:${bookingId}`)) || "pending";
  const completed = (await env.BOOKINGS.get(`completed:${bookingId}`)) === "1";
  if (!bookingRaw) {
    await tgSendMessage(env, chatId, "That booking's details are no longer available.", { reply_markup: kb([[btn("⬅️ Back", "gdash")]]) });
    return;
  }
  const booking = JSON.parse(bookingRaw);
  const text = `📋 <b>Booking ${escapeHtml(bookingId)}</b>\n\nStatus: ${statusEmoji(status)} ${escapeHtml(status)}${completed ? " · ✅ Completed" : ""}\n\n${fmtBookingData(booking.data)}`;
  const rows = [];
  if (status === "confirmed" && !completed) rows.push([btn("✅ Mark Completed", `gcomplete:${bookingId}`)]);
  rows.push([btn("⬅️ Back", "gdash")]);
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

async function markGuideBookingCompleted(env, chatId, guide, bookingId) {
  await env.BOOKINGS.put(`completed:${bookingId}`, "1", { expirationTtl: 60 * 60 * 24 * 120 });
  await sendGuideBookingDetail(env, chatId, guide, bookingId);
}

async function sendGuideSummary(env, chatId, guide) {
  const buckets = await guideBookingBuckets(env, guide.id);
  const text =
    `📈 <b>Booking Summary — ${escapeHtml(guide.name)}</b>\n\n` +
    `Total assigned: <b>${buckets.all.length}</b>\n` +
    `📅 Today: <b>${buckets.today.length}</b>\n` +
    `🔜 Future: <b>${buckets.future.length}</b>\n` +
    `✅ Completed: <b>${buckets.completed.length}</b>\n` +
    `⏳ Remaining (confirmed, not yet completed): <b>${buckets.remaining.length}</b>`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb([[btn("⬅️ Back", "gdash")]]) });
}

async function sendGuideServices(env, chatId, guide) {
  const packages = SITE_PACKAGES[guide.site] || [];
  const servicesLine = guide.services.includes("all")
    ? "All Services"
    : packages.filter((p) => guide.services.includes(p.key)).map((p) => p.label).join("\n") || "(none — ask admin to assign you a service)";
  await tgSendMessage(env, chatId, `📦 <b>My Services</b>\n\n${servicesLine}\n\n<i>Only the admin can change this — ask them if it needs updating.</i>`, {
    reply_markup: kb([[btn("⬅️ Back", "gdash")]]),
  });
}

async function sendGuideAccount(env, chatId, guide) {
  const text =
    `👤 <b>My Account</b>\n\n` +
    `Name: ${escapeHtml(guide.name)}\n` +
    `Site: ${SITE_LABELS[guide.site] || guide.site}\n` +
    `Linked: ${guide.linkedAt ? new Date(guide.linkedAt).toLocaleDateString() : "—"}\n` +
    `${guideStatusFooter(guide)}`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb([[btn("⬅️ Back", "gdash")]]) });
}

async function toggleGuideActiveFromSelf(env, chatId, guide) {
  const updated = await setGuideActive(env, guide.id, !guide.active);
  await sendGuideMenu(env, chatId, updated);
}

// Dispatches every button a linked guide can tap. Kept entirely
// separate from handleCallback (the admin dispatcher) — a guide should
// never be one typo away from reaching a content-editing menu.
async function handleGuideCallback(env, chatId, guide, data) {
  const [action, rest] = [data.split(":")[0], data.split(":").slice(1).join(":")];
  const buckets = ["gdash", "gtoday", "gfuture", "gall"].includes(action) ? await guideBookingBuckets(env, guide.id) : null;

  if (action === "gdash") {
    const b = buckets;
    await tgSendMessage(
      env,
      chatId,
      `📊 <b>Dashboard</b>\n\n📅 Today: <b>${b.today.length}</b>\n🔜 Upcoming: <b>${b.future.length}</b>\n✅ Completed: <b>${b.completed.length}</b>\n⏳ Remaining: <b>${b.remaining.length}</b>`,
      { reply_markup: kb([[btn("📅 Today", "gtoday"), btn("🔜 Upcoming", "gfuture")], [btn("✅ Completed", "gcompletedlist"), btn("⏳ Remaining", "gremaining")], [btn("⬅️ Main Menu", "gmenu")]]) }
    );
    return;
  }
  if (action === "gmenu") return sendGuideMenu(env, chatId, guide);
  if (action === "gtoday") return sendGuideBookingList(env, chatId, guide, buckets.today, "📅 <b>Today's Bookings</b>");
  if (action === "gfuture") return sendGuideBookingList(env, chatId, guide, buckets.future, "🔜 <b>Future Bookings</b>");
  if (action === "gall") return sendGuideBookingList(env, chatId, guide, buckets.all, "📋 <b>All Bookings</b>");
  if (action === "gcompletedlist") {
    const b = await guideBookingBuckets(env, guide.id);
    return sendGuideBookingList(env, chatId, guide, b.completed, "✅ <b>Completed</b>");
  }
  if (action === "gremaining") {
    const b = await guideBookingBuckets(env, guide.id);
    return sendGuideBookingList(env, chatId, guide, b.remaining, "⏳ <b>Remaining</b>");
  }
  if (action === "gsummary") return sendGuideSummary(env, chatId, guide);
  if (action === "gservices") return sendGuideServices(env, chatId, guide);
  if (action === "gaccount") return sendGuideAccount(env, chatId, guide);
  if (action === "gtoggleactive") return toggleGuideActiveFromSelf(env, chatId, guide);
  if (action === "gbooking") return sendGuideBookingDetail(env, chatId, guide, rest);
  if (action === "gcomplete") return markGuideBookingCompleted(env, chatId, guide, rest);

  await sendGuideMenu(env, chatId, guide);
}

async function sendStatsMenu(env, chatId) {
  const { visitors, bookings } = await getLiveStats(env);
  const text =
    `📊 <b>Live Stats</b>\n👀 Visitors: <b>${visitors}</b>\n✅ Confirmed bookings: <b>${bookings}</b>\n\n` +
    `This is also kept as a pinned message at the top of this chat, updating automatically as visits and confirmations come in.`;
  await tgSendMessage(env, chatId, text, {
    reply_markup: kb([[btn("🔄 Reset counters to 0", "resetstats")], [btn("⬅️ Main Menu", "home")]]),
  });
}

// ---------------- ERA AI ----------------
// The chat assistant on the live sites. See era-ai.js for how it
// answers; everything here is just the Telegram controls for it.

async function sendEraMenu(env, chatId) {
  const status = await getEraStatusText(env);
  const text =
    `🤖 <b>ERA AI</b>\n` +
    `Learning: <b>${status.learningEnabled ? "ON 🟢" : "PAUSED 🔴"}</b>\n` +
    `Knowledge entries: <b>${status.knowledgeCount}</b>\n` +
    `Info notes fed in: <b>${status.notesCount}</b>\n` +
    `Questions waiting for an answer: <b>${status.pendingCount}</b>\n` +
    `Messages answered so far: <b>${status.totalMessages}</b>\n\n` +
    `Every new visitor chat is now a plain live chat with you by default — nothing auto-replies until you open Telegram and answer it. ` +
    `ERA AI only answers in a conversation you've explicitly switched to "🤖 AI" from that visitor's message (see the buttons under each visitor message).\n\n` +
    (status.learningEnabled
      ? "Learning is ON: whenever ERA AI is handling a conversation and can't confidently answer something, that question gets saved below so you can teach it."
      : "Learning is PAUSED: ERA AI (in any conversation you've switched it on for) keeps using what it already knows, but nothing new gets queued or auto-learned until you turn learning back on.");
  const rows = [
    [btn("📚 Bulk Teach Q&A", "erabulk")],
    [btn(status.learningEnabled ? "⏸️ Stop Learning" : "▶️ Resume Learning", "eratogglelearn")],
    [btn(`📋 Questions to Answer (${status.pendingCount})`, "erapending")],
    [btn("⬅️ Main Menu", "home")],
  ];
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

// ---- Bulk Teach — paste unlimited Q&A pairs (or plain info) anytime ----
// Stays in this mode across as many messages as the admin wants to
// send, so "paste 100 Q&As" can be done in one go or spread across many
// messages, in one sitting or over days (each message refreshes the
// session so it never expires mid-feed). Tap ✅ Done (or /menu) to exit.

async function startEraBulkTeach(env, chatId) {
  await setSession(env, chatId, { kind: "eraBulk", path: [], awaiting: { type: "eraBulk" } });
  await tgSendMessage(
    env,
    chatId,
    "📚 <b>Bulk Teach Mode</b>\n\n" +
      "Paste as many questions &amp; answers as you want — in one message or spread across many, any time. Any of these styles work, and you can mix them:\n\n" +
      "<code>Q: What time is check-in?\nA: 2pm onwards.</code>\n\n" +
      "<code>1. Do you allow pets?\nNo pets allowed on site.</code>\n\n" +
      "<code>Is wifi available? -- Yes, free wifi in common areas.</code>\n\n" +
      "You can also just paste a plain paragraph of info (not shaped as Q&amp;A, e.g. forwarded from a customer chat) — I'll save it so ERA AI can search it too.\n\n" +
      "Send as many messages as you like — I'll stay in this mode. Tap ✅ Done when you're finished.",
    { reply_markup: kb([[btn("✅ Done", "eradonebulk")]]) }
  );
}

async function finishEraBulkTeach(env, chatId) {
  await clearSession(env, chatId);
  await tgSendMessage(env, chatId, "✅ Got it — thanks for teaching ERA AI!");
  return sendEraMenu(env, chatId);
}

async function toggleEraLearning(env, chatId) {
  const status = await getEraStatusText(env);
  await setLearningEnabled(env, !status.learningEnabled);
  return sendEraMenu(env, chatId);
}

async function sendEraPendingList(env, chatId) {
  const pending = await listUnanswered(env);
  if (!pending.length) {
    await tgSendMessage(env, chatId, "🎉 No pending questions — ERA AI has an answer for everything visitors have asked recently.", {
      reply_markup: kb([[btn("⬅️ Back", "eraai")]]),
    });
    return;
  }
  const rows = pending.slice(0, 15).map((q) => [btn(`${truncateLabel(q.question)} (${q.count}×)`, `eraview:${q.id}`)]);
  rows.push([btn("⬅️ Back", "eraai")]);
  await tgSendMessage(env, chatId, "📋 <b>Questions ERA AI couldn't answer</b>\nTap one to teach it the right answer.", { reply_markup: kb(rows) });
}

async function sendEraQuestionDetail(env, chatId, id) {
  const pending = await listUnanswered(env);
  const q = pending.find((p) => p.id === id);
  if (!q) return sendEraPendingList(env, chatId);
  const text = `❓ <b>Visitor asked:</b>\n"${escapeHtml(q.question)}"\n\nAsked <b>${q.count}</b> time(s) on <b>${SITE_LABELS[q.site] || q.site}</b>.`;
  await tgSendMessage(env, chatId, text, {
    reply_markup: kb([[btn("✏️ Teach the answer", `eraanswer:${id}`)], [btn("🗑️ Discard", `eradiscard:${id}`)], [btn("⬅️ Back", "erapending")]]),
  });
}

async function startEraAnswer(env, chatId, id) {
  await setSession(env, chatId, { kind: "eraTeach", path: [], awaiting: { type: "eraAnswer", questionId: id } });
  await tgSendMessage(env, chatId, "Type the answer ERA AI should give next time someone asks this ⤵️", {
    reply_markup: kb([[btn("❌ Cancel", "erapending")]]),
  });
}

async function discardEraQuestion(env, chatId, id) {
  await discardUnanswered(env, id);
  return sendEraPendingList(env, chatId);
}

// ---------------- ERA AI: per-visitor conversation control ----------------
// The hybrid human-takeover layer — see conversations.js for the store
// and forwarding, era-ai.js for what gates on conversation status.

async function startConvReply(env, chatId, sessionId) {
  const conv = await getConversation(env, sessionId);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await setSession(env, chatId, { kind: "convReply", path: [], awaiting: { type: "convReply", sessionId } });
  await tgSendMessage(env, chatId, `Type your reply to <b>Visitor #${conv.id}</b> ⤵️\n(You can also just swipe-reply directly on their message next time, or use <code>/reply ${conv.id} your message</code>.)`, {
    reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
  });
}

async function changeConvStatus(env, chatId, sessionId, status) {
  const conv = await setConversationStatus(env, sessionId, status);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await tgSendMessage(env, chatId, `Visitor #${conv.id} is now <b>${statusLabel(status)}</b>.`);
}

// Flips "an admin is actively, personally handling this visitor" for
// one visitor. While active, booking.js skips sending that visitor's
// booking confirm/reject pings to the group chat (see conversations.js)
// — everything else (this chat thread, the AI/Human/Pause/Close
// controls) keeps working exactly as it does today either way.
async function toggleConvActive(env, chatId, sessionId) {
  const conv = await toggleConversationActive(env, sessionId);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await tgSendMessage(
    env,
    chatId,
    conv.active
      ? `🟢 Visitor #${conv.id} marked <b>Active</b> — their booking confirm/reject won't ping the group chat while this is on.`
      : `⚪ Visitor #${conv.id} marked <b>Not Active</b> — their bookings will notify the group chat as normal.`
  );
}

// Fully removes one visitor's chat id from ever generating a booking
// notification again (spam/abuse) — not just silenced like "Active"
// above, actually skipped in booking.js. Their bookings are still
// recorded in KV so nothing is lost, they just never reach Telegram.
async function toggleConvBlocked(env, chatId, sessionId) {
  const conv = await getConversation(env, sessionId);
  const nowBlocked = await toggleSessionBlocked(env, sessionId);
  const label = conv ? `Visitor #${conv.id}` : "That chat id";
  await tgSendMessage(
    env,
    chatId,
    nowBlocked
      ? `🚫 ${label} is now <b>blocked</b> — any booking they submit from now on will be recorded but won't be sent here.`
      : `✅ ${label} <b>unblocked</b> — their bookings will notify the group chat as normal again.`
  );
}

// Delivers an admin's free-form reply to a specific visitor. This is
// the one function all three reply paths (Reply button, swipe-reply,
// /reply command) funnel through. It does NOT force a takeover — per
// the hybrid spec, a guide can answer one question without pulling the
// whole conversation out of AI mode (see era-ai.js's status gating).
async function deliverHumanReply(env, chatId, sessionId, text) {
  const conv = await getConversation(env, sessionId);
  if (!conv) {
    await tgSendMessage(env, chatId, "⚠️ Couldn't find that visitor's conversation — it may have expired.");
    return;
  }
  await pushOutbox(env, sessionId, text, "human");
  await tgSendMessage(env, chatId, `✅ Sent to Visitor #${conv.id}.`);
}

async function handleReplyCommand(env, chatId, text) {
  const rest = text.replace(/^\/reply\s*/i, "").trim();
  const spaceIdx = rest.indexOf(" ");
  if (spaceIdx > 0) {
    const shortId = rest.slice(0, spaceIdx).replace(/^#/, "").trim();
    const replyText = rest.slice(spaceIdx + 1).trim();
    if (shortId && replyText) {
      const conv = await getConversationByShortId(env, shortId);
      if (!conv) {
        await tgSendMessage(env, chatId, `⚠️ No conversation found for Visitor #${shortId}.`);
        return;
      }
      await deliverHumanReply(env, chatId, conv.sessionId, replyText);
      return;
    }
  }
  await tgSendMessage(env, chatId, "Usage: <code>/reply 1047 Your message here</code>");
}

// ---------------- CALLBACK ROUTER ----------------

async function handleCallback(env, chatId, messageId, data) {
  const [action, ...rest] = data.split(":");

  if (action === "home") return sendMainMenu(env, chatId);

  if (action === "preview") return sendPreviewLinks(env, chatId);

  if (action === "stats") return sendStatsMenu(env, chatId);

  if (action === "resetstats") {
    await resetStats(env);
    return sendStatsMenu(env, chatId);
  }

  // ---- ERA AI: per-visitor conversation controls (attached to every
  // forwarded visitor message — see conversations.js#convButtons) ----
  if (action === "convreply") return startConvReply(env, chatId, rest.join(":"));
  if (action === "convai") return changeConvStatus(env, chatId, rest.join(":"), "ai");
  if (action === "convtakeover") return changeConvStatus(env, chatId, rest.join(":"), "human");
  if (action === "convpause") return changeConvStatus(env, chatId, rest.join(":"), "paused");
  if (action === "convclose") return changeConvStatus(env, chatId, rest.join(":"), "closed");
  if (action === "convactive") return toggleConvActive(env, chatId, rest.join(":"));
  if (action === "convblock") return toggleConvBlocked(env, chatId, rest.join(":"));

  // ---- ERA AI ----
  if (action === "eraai") return sendEraMenu(env, chatId);
  if (action === "eratogglelearn") return toggleEraLearning(env, chatId);
  if (action === "erapending") return sendEraPendingList(env, chatId);
  if (action === "eraview") return sendEraQuestionDetail(env, chatId, rest.join(":"));
  if (action === "eraanswer") return startEraAnswer(env, chatId, rest.join(":"));
  if (action === "eradiscard") return discardEraQuestion(env, chatId, rest.join(":"));
  if (action === "erabulk") return startEraBulkTeach(env, chatId);
  if (action === "eradonebulk") return finishEraBulkTeach(env, chatId);

  if (action === "bgpick") return sendSitePicker(env, chatId, "bgshortcut", SITES);
  if (action === "secpick") return sendSitePicker(env, chatId, "secshortcut", SITES);
  if (action === "herobtnpick") return sendSitePicker(env, chatId, "herobtnshortcut", SITES);
  if (action === "vidpick") return sendSitePicker(env, chatId, "vidupload", SITES);

  if (action === "herobtnreset") return resetHeroButtonToDefault(env, chatId, rest.join(":"));
  if (action === "guidemgmt") return sendGuideManagementMenu(env, chatId);
  if (action === "addguide") return startAddGuide(env, chatId);
  if (action === "addguidesite") return chooseAddGuideSite(env, chatId, rest.join(":"));
  if (action === "addguidesvc") return toggleAddGuideService(env, chatId, rest.join(":"));
  if (action === "addguideall") return finishAddGuide(env, chatId, true);
  if (action === "addguidedone") return finishAddGuide(env, chatId, false);
  if (action === "guidelist") return sendGuideListMenu(env, chatId, rest.join(":") || null);
  if (action === "guidedetail") return sendGuideDetailMenu(env, chatId, rest.join(":"));
  if (action === "guidetoggleactive") return toggleGuideActiveFromAdmin(env, chatId, rest.join(":"));
  if (action === "guidetoggleaccess") return toggleGuideAccessFromAdmin(env, chatId, rest.join(":"));
  if (action === "guideregencode") return regenGuideCodeFromAdmin(env, chatId, rest.join(":"));
  if (action === "guideremove") return removeGuideFromAdmin(env, chatId, rest.join(":"));
  if (action === "guidebookings") return sendGuideBookingsForAdmin(env, chatId, rest.join(":"));

  if (action === "pick") {
    const kind = rest[0];
    const cat = CATEGORIES.find((c) => c.kind === kind);
    if (!cat) return sendMainMenu(env, chatId);
    if (kind === "discounts") return sendDiscountsMenu(env, chatId);
    if (!cat.perSite) return openTree(env, chatId, { kind, site: null, path: [] });
    return sendSitePicker(env, chatId, kind, cat.sites || SITES);
  }

  // "bgshortcut"/"secshortcut" aren't real content kinds — they're
  // just a shorter path to two spots already inside the "content" tree
  // (KC_CONTENT.background / KC_CONTENT.sectionStyles). Translating to
  // the real kind here (rather than inventing a parallel "kind") means
  // every existing save/reset/breadcrumb function keeps working
  // unchanged, and — critically — "Reset ALL" from this shortcut still
  // means "reset all of Website Text", never a separate/smaller scope
  // that could desync from what actually renders on the site.
  const SHORTCUT_START_PATHS = { bgshortcut: ["background"], secshortcut: ["sectionStyles"], herobtnshortcut: ["hero"] };

  if (action === "site") {
    const [kind, site] = rest;
    if (kind === "vidupload") return startVideoUpload(env, chatId, site);
    const startPath = SHORTCUT_START_PATHS[kind];
    if (startPath) {
      await openTree(env, chatId, { kind: "content", site, path: [...startPath] });
      if (kind === "herobtnshortcut") {
        // A dedicated, narrowly-scoped reset — only the four hero
        // BUTTON fields (label/link/target), never the rest of hero
        // (badge/title/video/etc.) and never CONTENT.nav.items, which
        // lives at a completely different top-level key and this never
        // touches. See resetHeroButtonToDefault below.
        await tgSendMessage(env, chatId, "Just the hero button, not the nav menu:", {
          reply_markup: kb([[btn("🔄 Reset Hero Button to Default", `herobtnreset:${site}`)]]),
        });
      }
      return;
    }
    return openTree(env, chatId, { kind, site, path: [] });
  }

  if (action === "into") {
    const session = await getSession(env, chatId);
    if (!session) return sendMainMenu(env, chatId, "Session expired, starting over.");
    session.path.push(rest.join(":"));
    await setSession(env, chatId, session);
    return renderTree(env, chatId, session);
  }

  if (action === "up") {
    const session = await getSession(env, chatId);
    if (!session) return sendMainMenu(env, chatId);
    session.path.pop();
    await setSession(env, chatId, session);
    return renderTree(env, chatId, session);
  }

  if (action === "edit") {
    return startEdit(env, chatId, rest.join(":"));
  }

  if (action === "toggle") {
    return toggleBoolean(env, chatId, rest.join(":"));
  }

  if (action === "add") {
    return addArrayItem(env, chatId);
  }

  if (action === "moveup") {
    return moveItem(env, chatId, rest.join(":"), -1);
  }

  if (action === "movedown") {
    return moveItem(env, chatId, rest.join(":"), 1);
  }

  if (action === "del") {
    return deleteChild(env, chatId, rest.join(":"));
  }

  if (action === "resetimages") {
    return resetAllImages(env, chatId);
  }

  if (action === "resetimage") {
    return resetOneImage(env, chatId, rest.join(":"));
  }

  // ---- generic "reset to default" (content / prices / highlights /
  // discounts / ratings — images have their own version above) ----
  if (action === "resetsection") return resetSection(env, chatId);
  if (action === "resetall") return confirmResetAll(env, chatId);
  if (action === "resetallconfirm") return resetAllForCurrentTree(env, chatId);

  // ---- the big one: wipe every override, every doc, every site ----
  if (action === "resetworld") return confirmResetEverything(env, chatId);
  if (action === "resetworldconfirm") return resetEverything(env, chatId);

  if (action === "cancel") {
    const session = await getSession(env, chatId);
    if (session && session.kind === "eraTeach") {
      await clearSession(env, chatId);
      return sendEraPendingList(env, chatId);
    }
    if (session && session.kind === "eraBulk") {
      return finishEraBulkTeach(env, chatId);
    }
    if (session && session.kind === "convReply") {
      await clearSession(env, chatId);
      await tgSendMessage(env, chatId, "Cancelled — nothing sent.");
      return;
    }
    if (session) {
      delete session.awaiting;
      await setSession(env, chatId, session);
      return renderTree(env, chatId, session, "Cancelled.");
    }
    return sendMainMenu(env, chatId);
  }

  // ---- discounts & sales shortcuts ----
  if (action === "sale") return handleSaleShortcut(env, chatId, rest);
  if (action === "salepick") return sendSalePackagePicker(env, chatId, rest[0]);
  if (action === "seasontoggle") return toggleSeasonal(env, chatId, Number(rest[0]));

  return sendMainMenu(env, chatId);
}

// ---------------- SITE PICKER ----------------

async function sendSitePicker(env, chatId, kind, sites) {
  const rows = sites.map((s) => [btn(SITE_LABELS[s] || s, `site:${kind}:${s}`)]);
  rows.push([btn("⬅️ Back", "home")]);
  await tgSendMessage(env, chatId, "Which part of the website?", { reply_markup: kb(rows) });
}

async function sendPreviewLinks(env, chatId) {
  const base = env.SITE_BASE_URL || "https://your-site.example.com";
  const text =
    `👁️ <b>Live site links</b>\n\n` +
    `🏠 <a href="${base}/">Home</a>\n` +
    `🌊 <a href="${base}/krem-chympe/">Krem Chympe</a>\n` +
    `🥾 <a href="${base}/wilderness-expedition/">Wilderness Expedition</a>\n\n` +
    `Changes usually appear within a few seconds of saving.`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb([[btn("⬅️ Main Menu", "home")]]) });
}

// ---------------- TREE NAVIGATION (generic — works for content, images, prices, highlights, discounts) ----------------

function defaultsFor(kind, site) {
  if (kind === "discounts") return DEFAULT_DISCOUNTS;
  if (kind === "highlights") return [];
  if (kind === "ratings") return [];
  const schema = SCHEMA_DEFAULTS[site];
  if (!schema) return {};
  if (kind === "content") return schema.KC_CONTENT || {};
  if (kind === "images") return schema.KC_IMAGES || {};
  if (kind === "prices") return schema.KC_PRICES || {};
  return {};
}

function docKeyFor(kind, site) {
  return kind === "discounts" ? "discounts:global" : `${kind}:${site}`;
}

async function loadMerged(env, kind, site) {
  const docKey = docKeyFor(kind, site);
  const base = defaultsFor(kind, site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  return { docKey, merged: deepMerge(base, override) };
}

async function openTree(env, chatId, session) {
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session);
}

async function renderTree(env, chatId, session, note) {
  const { merged } = await loadMerged(env, session.kind, session.site);
  const currentPath = session.path.join(".");
  const node = currentPath ? getPath(merged, currentPath) : merged;
  const children = listChildren(node);

  const catLabel = CATEGORIES.find((c) => c.kind === session.kind)?.label || session.kind;
  const crumbs = [SITE_LABELS[session.site] || null, ...session.path.map(humanize)].filter(Boolean).join(" › ") || "Top level";

  const rows = [];
  for (const group of chunk(children, 1)) {
    for (const child of group) {
      // Booleans get a single tap-to-flip toggle button instead of a
      // "type true/false" text prompt — this is what makes things like
      // "Hero Video: On/Off" or "Notice: On/Off" a real on/off switch
      // in the bot, with no typing required.
      if (child.kind === "boolean") {
        const isOnVal = child.preview === "true";
        const label = `${isOnVal ? "✅" : "⛔"} ${humanize(child.key)} — ${isOnVal ? "ON (tap to turn off)" : "OFF (tap to turn on)"}`;
        rows.push([btn(truncateLabel(label), `toggle:${child.key}`)]);
        continue;
      }
      const label = `${iconFor(child.kind, session.kind)} ${humanize(child.key)} — ${child.preview}`;
      const cb = child.kind === "object" || child.kind === "array" ? `into:${child.key}` : `edit:${child.key}`;
      const row = [btn(truncateLabel(label), cb)];
      // Reordering: only offered for items that live directly inside an
      // array (nav items, highlights, meals, ...) — not for object
      // fields. First item has no "up", last has no "down".
      if (Array.isArray(node)) {
        const idx = Number(child.key);
        if (idx > 0) row.push(btn("⬆️", `moveup:${child.key}`));
        if (idx < node.length - 1) row.push(btn("⬇️", `movedown:${child.key}`));
      }
      rows.push(row);
    }
  }

  if (Array.isArray(node)) {
    rows.push([btn("➕ Add new item", "add")]);
  }
  if (session.kind === "images" && session.path.length === 0) {
    rows.push([btn("🔄 Reset ALL photos to default", "resetimages")]);
  }
  // Every non-image section gets the same two reset options images
  // already had: reset just what you're looking at right now, or reset
  // the whole category (this site's text / highlights / ratings /
  // prices, or the global discounts) back to what's baked into the
  // code. This is also the fix if a section ever gets emptied out by
  // accident (like Destinations did) — open it and tap Reset.
  if (session.kind !== "images" && session.path.length > 0) {
    rows.push([btn("↩️ Reset this section to default", "resetsection")]);
  }
  if (session.kind !== "images" && session.path.length === 0) {
    rows.push([btn(`🔄 Reset ALL ${catLabel.replace(/^[^\s]+\s/, "")} to default`, "resetall")]);
  }
  if (session.path.length && Array.isArray(getPath(merged, session.path.slice(0, -1).join(".")) ?? merged)) {
    // current node is an item inside an array one level up — offer delete
    rows.push([btn("🗑️ Delete this item", `del:${session.path[session.path.length - 1]}:__self`)]);
  }

  const navRow = [];
  if (session.path.length) navRow.push(btn("⬆️ Up", "up"));
  navRow.push(btn("🏠 Main Menu", "home"));
  rows.push(navRow);

  const text = (note ? note + "\n\n" : "") + `<b>${catLabel}</b>\n📍 ${crumbs}\n\nTap to open, or tap a field to edit it.`;
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

function iconFor(childKind, docKind) {
  if (docKind === "images") return "🖼️";
  if (childKind === "object") return "📁";
  if (childKind === "array") return "📋";
  if (childKind === "number") return "🔢";
  return "✏️";
}

function truncateLabel(s) {
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
}

// ---------------- TOGGLE A BOOLEAN (on/off switches, e.g. hero video, notice) ----------------

async function toggleBoolean(env, chatId, key) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId, "Session expired, starting over.");
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);
  const path = [...session.path, key].join(".");
  const current = getPath(merged, path);
  const next = !(current === true || current === "true");

  const base = defaultsFor(session.kind, session.site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  setPath(override, path, next);
  await saveDoc(env, docKey, override, { logChange: `Changed ${path} → ${next}` });

  return renderTree(env, chatId, session, `${next ? "✅ Turned ON" : "⛔ Turned OFF"}: ${humanize(key)}`);
}

// ---------------- EDIT A LEAF ----------------

// Starts the "upload a background video from your phone" flow — a
// dedicated one-off session (not tied to the generic content tree),
// since a video upload isn't editing one leaf value, it's replacing a
// whole file and re-pointing background.global.videoUrl at it.
// Resets ONLY the hero button's four fields (label, link, and whichever
// target field this site uses) back to schema defaults — deletes them
// from the content override doc entirely so they fall back to
// content-schema.js's defaults naturally, same as any other field reset
// to default. Never touches the rest of `hero` (badge/title/video/etc)
// and never touches CONTENT.nav.items, which lives at a completely
// separate top-level key this function never reads or writes.
async function resetHeroButtonToDefault(env, chatId, site) {
  const override = await getDoc(env, `content:${site}`, {});
  const HERO_BUTTON_KEYS = ["hero.bookNowLabel", "hero.bookNowLink", "hero.bookNowTargetId", "hero.bookNowTargetPage"];
  for (const path of HERO_BUTTON_KEYS) deletePath(override, path);
  await saveDoc(env, `content:${site}`, override, { logChange: "Hero button reset to default" });
  await tgSendMessage(
    env,
    chatId,
    `✅ Hero button reset to default on ${SITE_LABELS[site] || site} — label, link, and destination are all back to the site's original values. Nothing else (including the nav menu) was touched.`,
    { reply_markup: kb([[btn("🔘 Hero Button (text & link)", "herobtnpick")], [btn("⬅️ Main Menu", "home")]]) }
  );
}

async function startVideoUpload(env, chatId, site) {
  await setSession(env, chatId, { awaiting: { type: "video", site } });
  await tgSendMessage(
    env,
    chatId,
    `🎬 <b>New background video — ${SITE_LABELS[site] || site}</b>\n\nSend the video now, right here in this chat (as a normal video message, not a document). It'll replace the current site-wide background video and go live immediately — no other steps needed.\n\n<i>Telegram caps bot uploads at 50MB — if yours is bigger, compress it first.</i>`,
    { reply_markup: kb([[btn("❌ Cancel", "cancel")]]) }
  );
}

async function startEdit(env, chatId, key) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId, "Session expired, starting over.");
  const { merged } = await loadMerged(env, session.kind, session.site);
  const path = [...session.path, key].join(".");
  const current = getPath(merged, path);

  if (session.kind === "images") {
    session.awaiting = { path, type: "photo" };
    await setSession(env, chatId, session);
    await tgSendMessage(env, chatId, `📸 Send the new photo for <b>${humanize(key)}</b>.\n(Just send it as a normal photo message.)`, {
      reply_markup: kb([[btn("↩️ Reset this one to default", `resetimage:${key}`)], [btn("❌ Cancel", "cancel")]]),
    });
    return;
  }

  const type = typeof current === "number" ? "number" : "text";
  session.awaiting = { path, type };
  await setSession(env, chatId, session);
  await tgSendMessage(
    env,
    chatId,
    `✏️ <b>${humanize(key)}</b>\nCurrent value:\n<code>${escapeHtml(String(current ?? ""))}</code>\n\nReply with the new ${type === "number" ? "number" : "text"}.`,
    { reply_markup: kb([[btn("❌ Cancel", "cancel")]]) }
  );
}

async function handleAwaitedInput(env, chatId, session, msg) {
  const { awaiting } = session;

  if (awaiting.type === "eraBulk") {
    const text = (msg.text ?? "").trim();
    if (!text) {
      await tgSendMessage(env, chatId, "Paste some Q&A text (or plain info), or tap ✅ Done to finish.", {
        reply_markup: kb([[btn("✅ Done", "eradonebulk")]]),
      });
      return;
    }
    const { pairs, notes } = parseQABlob(text);
    const addedPairs = await teachBulkAnswers(env, pairs);
    const addedNotes = await addAdminNotes(env, notes);
    await setSession(env, chatId, session); // refresh the session TTL — stay in bulk mode for the next paste

    const parts = [];
    if (addedPairs) parts.push(`✅ Learned ${addedPairs} Q&amp;A pair${addedPairs === 1 ? "" : "s"}.`);
    if (addedNotes) parts.push(`📝 Saved ${addedNotes} info note${addedNotes === 1 ? "" : "s"} for ERA AI to search.`);
    if (!parts.length) parts.push("Hmm, I couldn't find any Q&amp;A or info in that — try again, or check the format examples above.");

    await tgSendMessage(env, chatId, parts.join("\n") + "\n\nKeep pasting more any time, or tap ✅ Done when finished.", {
      reply_markup: kb([[btn("✅ Done", "eradonebulk")]]),
    });
    return;
  }

  if (awaiting.type === "convReply") {
    const text = (msg.text ?? "").trim();
    if (!text) {
      await tgSendMessage(env, chatId, "Please type your reply, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", "cancel")]]) });
      return;
    }
    await deliverHumanReply(env, chatId, awaiting.sessionId, text);
    await clearSession(env, chatId);
    return;
  }

  if (awaiting.type === "eraAnswer") {
    const text = (msg.text ?? "").trim();
    if (!text) {
      await tgSendMessage(env, chatId, "Please type an answer, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", "erapending")]]) });
      return;
    }
    await teachAnswer(env, awaiting.questionId, text);
    await clearSession(env, chatId);
    await tgSendMessage(env, chatId, "✅ ERA AI learned that answer! It'll use it next time this question comes up.", {
      reply_markup: kb([[btn("⬅️ Back to ERA AI", "eraai")]]),
    });
    return;
  }

  if (awaiting.type === "guidename") {
    const name = (msg.text ?? "").trim();
    if (!name) {
      await tgSendMessage(env, chatId, "Please send a name as plain text, or tap Cancel.", { reply_markup: kb([[btn("❌ Cancel", "guidemgmt")]]) });
      return;
    }
    await setSession(env, chatId, { addGuide: { name } });
    const rows = GUIDE_SITES.map((s) => [btn(SITE_LABELS[s] || s, `addguidesite:${s}`)]);
    rows.push([btn("❌ Cancel", "guidemgmt")]);
    await tgSendMessage(env, chatId, `Which site is <b>${escapeHtml(name)}</b> a guide for?`, { reply_markup: kb(rows) });
    return;
  }

  if (awaiting.type === "video") {
    const video = msg.video || (msg.document && /^video\//.test(msg.document.mime_type || "") ? msg.document : null);
    if (!video) {
      await tgSendMessage(env, chatId, "That's not a video — please send it as a normal video message, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
      });
      return;
    }
    const site = awaiting.site;
    const fileId = video.file_id;

    // Store the raw file_id (same pattern as images), then re-point
    // background.global.videoUrl at the stable proxy route that
    // resolves it fresh on every request — see content-api.js's
    // handleVideoMedia. This is what makes it "go live automatically":
    // the website already reads background.global.videoUrl on every
    // load, it just now points here instead of a static filename.
    const videosDoc = await getDoc(env, `videos:${site}`, {});
    videosDoc.global = fileId;
    await saveDoc(env, `videos:${site}`, videosDoc, { logChange: "Uploaded new background video" });

    const proxyUrl = `${env.WORKER_BASE_URL || DEFAULT_WORKER_BASE_URL}/media-video/${site}/global`;
    const override = await getDoc(env, `content:${site}`, {});
    setPath(override, "background.global.videoUrl", proxyUrl);
    setPath(override, "background.global.videoEnabled", true);
    setPath(override, "background.global.enabled", true);
    await saveDoc(env, `content:${site}`, override, { logChange: "Background video → uploaded via Telegram" });

    await clearSession(env, chatId);
    await tgSendMessage(
      env,
      chatId,
      `✅ New background video is live on <b>${SITE_LABELS[site] || site}</b> right now — no other steps needed.`,
      { reply_markup: kb([[btn("⬅️ Main Menu", "home")]]) }
    );
    return;
  }

  if (awaiting.type === "photo") {
    const photos = msg.photo;
    if (!photos || !photos.length) {
      await tgSendMessage(env, chatId, "That's not a photo — please send an image, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
      });
      return;
    }
    const fileId = photos[photos.length - 1].file_id; // largest size
    await saveLeaf(env, session, fileId, `Changed photo: ${awaiting.path}`);
    delete session.awaiting;
    await setSession(env, chatId, session);
    await renderTree(env, chatId, session, "✅ Photo updated!");
    return;
  }

  const text = msg.text ?? "";
  if (awaiting.type === "number") {
    const num = Number(text.replace(/[^\d.-]/g, ""));
    if (Number.isNaN(num)) {
      await tgSendMessage(env, chatId, "That doesn't look like a number. Try again, or tap Cancel.", {
        reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
      });
      return;
    }
    await saveLeaf(env, session, num, `Changed ${awaiting.path} → ${num}`);
  } else {
    await saveLeaf(env, session, text, `Changed ${awaiting.path} → "${truncateLabel(text)}"`);
  }
  delete session.awaiting;
  await setSession(env, chatId, session);
  await renderTree(env, chatId, session, "✅ Saved!");
}

// IMPORTANT: this saves only the RAW override doc (not the merged
// defaults+override view) — a single changed leaf gets written back on
// top of whatever overrides already existed, nothing else. Previously
// this saved the full `merged` object (defaults + overrides together),
// which meant editing even one photo silently wrote every OTHER photo's
// key into the override doc too, holding its plain default filename
// instead of a real Telegram file_id. Since /media resolves override
// values as Telegram file_ids, that "poisoned" every untouched image on
// the site with a broken link. Only ever persist what was actually
// changed.
async function saveLeaf(env, session, value, logChange) {
  const docKey = docKeyFor(session.kind, session.site);
  const base = defaultsFor(session.kind, session.site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  setPath(override, session.awaiting.path, value);
  await saveDoc(env, docKey, override, { logChange });
}

// Wipes every photo override for the current site back to the static
// defaults baked into config.js (i.e. clears the images:<site> doc
// entirely). Also the fix for any already-poisoned doc from the old
// saveLeaf bug, if the self-healing read-side guard is ever bypassed.
async function resetAllImages(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session || session.kind !== "images") return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  await saveDoc(env, docKey, {}, { logChange: "Reset ALL photos to default" });
  session.path = [];
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session, "🔄 All photos reset to their defaults.");
}

// Removes a single key's override, so that one photo falls back to the
// static default again, leaving every other admin-uploaded photo alone.
async function resetOneImage(env, chatId, key) {
  const session = await getSession(env, chatId);
  if (!session || session.kind !== "images") return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  const override = await getDoc(env, docKey, {});
  delete override[key];
  await saveDoc(env, docKey, override, { logChange: `Reset photo to default: ${key}` });
  delete session.awaiting;
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session, `↩️ ${humanize(key)} reset to default.`);
}

// ---------------- GENERIC RESET (content / prices / highlights / discounts / ratings) ----------------
// Same idea as the images reset above, just working off whatever tree
// the admin is currently browsing instead of being hard-coded to
// photos. "Reset this section" clears the override at exactly the path
// you're standing in (e.g. Destinations, or one destination inside it)
// and falls back to the code's default for that path — everything else
// on the site, and every other site, is untouched.

async function resetSection(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session || session.kind === "images") return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  const base = defaultsFor(session.kind, session.site);
  const override = await getDoc(env, docKey, Array.isArray(base) ? [] : {});
  const path = session.path.join(".");
  deletePath(override, path);
  await saveDoc(env, docKey, override, { logChange: `Reset "${path || "(top level)"}" to default` });
  const label = humanize(session.path[session.path.length - 1] || "this section");
  return renderTree(env, chatId, session, `↩️ ${label} reset to default.`);
}

// "Reset ALL <category>" is destructive enough (it throws away every
// tweak made anywhere in that whole document) that it asks for a
// confirming tap before it actually runs.
async function confirmResetAll(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const catLabel = CATEGORIES.find((c) => c.kind === session.kind)?.label || session.kind;
  const scope = SITE_LABELS[session.site] ? ` for ${SITE_LABELS[session.site]}` : "";
  await tgSendMessage(
    env,
    chatId,
    `⚠️ This resets <b>everything</b> in ${catLabel}${scope} back to default — every edit you've made in this section, not just the one you're looking at.\n\nAre you sure?`,
    { reply_markup: kb([[btn("✅ Yes, reset it all", "resetallconfirm")], [btn("❌ Cancel", "cancel")]]) }
  );
}

async function resetAllForCurrentTree(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const docKey = docKeyFor(session.kind, session.site);
  const base = defaultsFor(session.kind, session.site);
  await saveDoc(env, docKey, Array.isArray(base) ? [] : {}, {
    logChange: `Reset ALL of ${session.kind}${session.site ? ":" + session.site : ""} to default`,
  });
  session.path = [];
  await setSession(env, chatId, session);
  return renderTree(env, chatId, session, "🔄 This whole section is back to default.");
}

// ---------------- RESET EVERYTHING (the big red button) ----------------
// Wipes every override doc for every site — text, photos, prices,
// highlights, ratings, and the global discounts — back to whatever is
// baked into the code. Two-tap confirm because there's no undo.

async function confirmResetEverything(env, chatId) {
  await tgSendMessage(
    env,
    chatId,
    "🧨 <b>Reset EVERYTHING?</b>\n\nThis puts the <b>entire website</b> — all text, all photos, all prices, highlights, ratings, and discounts, on all three sites — back to exactly how it is in the code, undoing every change ever made from this bot.\n\nThis cannot be undone. Are you sure?",
    { reply_markup: kb([[btn("‼️ Yes, reset the whole website", "resetworldconfirm")], [btn("❌ Cancel", "cancel")]]) }
  );
}

async function resetEverything(env, chatId) {
  const perSiteKinds = ["content", "images", "prices", "highlights", "ratings"];
  for (const site of SITES) {
    for (const kind of perSiteKinds) {
      const base = defaultsFor(kind, site);
      await saveDoc(env, docKeyFor(kind, site), Array.isArray(base) ? [] : {}, {
        logChange: `Reset ALL ${kind} for ${site} (full site reset)`,
      });
    }
  }
  await saveDoc(env, "discounts:global", {}, { logChange: "Reset ALL discounts (full site reset)" });
  await clearSession(env, chatId);
  await tgSendMessage(env, chatId, "🔄 Done — the whole website is back to its default, out-of-the-box state.", {
    reply_markup: kb([[btn("🏠 Main Menu", "home")]]),
  });
}

// ---------------- ARRAY ADD / DELETE ----------------

async function addArrayItem(env, chatId) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);
  const arr = session.path.length ? getPath(merged, session.path.join(".")) : merged;
  if (!Array.isArray(arr)) return renderTree(env, chatId, session);

  const template = arr.length ? JSON.parse(JSON.stringify(arr[arr.length - 1])) : {};
  clearStringsDeep(template);
  arr.push(template);

  await saveDoc(env, docKey, merged, { logChange: `Added new item to ${session.path.join(".") || "(top level)"}` });
  await renderTree(env, chatId, session, "➕ Added a new item (copy of the last one — edit its fields now).");
}

function clearStringsDeep(obj) {
  if (Array.isArray(obj)) {
    obj.forEach(clearStringsDeep);
  } else if (obj && typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === "string") obj[k] = "New " + humanize(k);
      else if (typeof obj[k] === "number") obj[k] = 0;
      else clearStringsDeep(obj[k]);
    }
  }
}

// ---------------- REORDER AN ITEM (nav items, highlights, meals, ...) ----------------
// Swaps an array item with its neighbor and re-saves — the ⬆️/⬇️
// buttons next to each row in renderTree. Same "save the merged view"
// convention as addArrayItem above, so a reorder always sticks even if
// nothing else on that item was ever overridden before.
async function moveItem(env, chatId, indexStr, delta) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);
  const arr = session.path.length ? getPath(merged, session.path.join(".")) : merged;
  if (!Array.isArray(arr)) return renderTree(env, chatId, session);

  const idx = Number(indexStr);
  const newIdx = idx + delta;
  if (Number.isNaN(idx) || newIdx < 0 || newIdx >= arr.length) return renderTree(env, chatId, session);

  const tmp = arr[idx];
  arr[idx] = arr[newIdx];
  arr[newIdx] = tmp;

  await saveDoc(env, docKey, merged, {
    logChange: `Reordered item #${idx + 1} \u2194 #${newIdx + 1} in ${session.path.join(".") || "(top level)"}`,
  });
  await renderTree(env, chatId, session, "\ud83d\udd00 Reordered.");
}

async function deleteChild(env, chatId, keyAndSelf) {
  const session = await getSession(env, chatId);
  if (!session) return sendMainMenu(env, chatId);
  const [key] = keyAndSelf.split(":");
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);

  const parentPath = session.path.slice(0, -1).join(".");
  const parent = parentPath ? getPath(merged, parentPath) : merged;
  const idx = Number(session.path[session.path.length - 1]);

  if (Array.isArray(parent) && !Number.isNaN(idx)) {
    parent.splice(idx, 1);
    session.path.pop();
    await saveDoc(env, docKey, merged, { logChange: `Deleted item #${idx + 1} from ${parentPath}` });
    await setSession(env, chatId, session);
    return renderTree(env, chatId, session, "🗑️ Deleted.");
  }
  return renderTree(env, chatId, session);
}

// ---------------- DISCOUNTS & SALES quick flows ----------------
// (These ride on the same generic tree for anything detailed, but
// offer one-tap shortcuts for the two most common actions.)

const SALE_PRESETS = [0, 5, 10, 15, 20, 25, 30];

export async function sendDiscountsMenu(env, chatId) {
  const rows = [
    [btn("🏷️ Put a package on sale", "salepick:krem-chympe")],
    [btn("📋 Full discounts editor (codes, bulk tiers, seasons)", "site:discounts:global")],
    [btn("⬅️ Main Menu", "home")],
  ];
  await tgSendMessage(env, chatId, "💰 <b>Discounts & Sales</b>", { reply_markup: kb(rows) });
}

async function sendSalePackagePicker(env, chatId, site) {
  const { merged } = await loadMerged(env, "prices", site);
  const packages = Object.keys(merged || {}).filter((k) => typeof merged[k] === "object" && !Array.isArray(merged[k]));
  const rows = packages.map((p) => [btn(humanize(p), `salepick2:${site}:${p}`)]);
  rows.push([btn(site === "krem-chympe" ? "🥾 Switch to Wilderness" : "🌊 Switch to Krem Chympe", `salepick:${site === "krem-chympe" ? "wilderness-expedition" : "krem-chympe"}`)]);
  rows.push([btn("⬅️ Back", "pick:discounts")]);
  await tgSendMessage(env, chatId, `Which package on <b>${SITE_LABELS[site]}</b>?`, { reply_markup: kb(rows) });
}

async function handleSaleShortcut(env, chatId, rest) {
  // rest: [site, pkg, pct]  (pct present once a preset is tapped)
  if (rest.length === 2) {
    const [site, pkg] = rest;
    const rows = chunk(
      SALE_PRESETS.map((pct) => btn(pct === 0 ? "No sale" : `${pct}% off`, `sale:${site}:${pkg}:${pct}`)),
      3
    );
    rows.push([btn("⬅️ Back", `salepick:${site}`)]);
    await tgSendMessage(env, chatId, `Sale for <b>${humanize(pkg)}</b> — pick a discount:`, { reply_markup: kb(rows) });
    return;
  }
  const [site, pkg, pctStr] = rest;
  const pct = Number(pctStr);
  const { merged } = await loadMerged(env, "discounts", null);
  merged.saleBySite = merged.saleBySite || {};
  merged.saleBySite[site] = merged.saleBySite[site] || {};
  if (pct > 0) merged.saleBySite[site][pkg] = pct;
  else delete merged.saleBySite[site][pkg];
  await saveDoc(env, "discounts:global", merged, {
    logChange: pct > 0 ? `Sale set: ${site}/${pkg} → ${pct}% off` : `Sale removed: ${site}/${pkg}`,
  });
  await tgSendMessage(
    env,
    chatId,
    pct > 0 ? `✅ ${humanize(pkg)} is now ${pct}% off on the website!` : `✅ Sale removed from ${humanize(pkg)}.`,
    { reply_markup: kb([[btn("⬅️ Main Menu", "home")]]) }
  );
}

async function toggleSeasonal(env, chatId, idx) {
  const { merged } = await loadMerged(env, "discounts", null);
  if (merged.seasonal?.[idx]) {
    merged.seasonal[idx].active = !merged.seasonal[idx].active;
    await saveDoc(env, "discounts:global", merged, { logChange: `Seasonal #${idx + 1} → ${merged.seasonal[idx].active ? "ON" : "OFF"}` });
  }
  await sendDiscountsMenu(env, chatId);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
