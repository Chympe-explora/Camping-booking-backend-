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
import { SITES, SITE_LABELS, getDoc, saveDoc, deepMerge, getPath, setPath, getSession, setSession, clearSession } from "./store.js";
import { listChildren, humanize, chunk } from "./walker.js";
import { DEFAULT_DISCOUNTS } from "./pricing.js";
import { tgSendMessage, tgAnswerCallbackQuery, kb, btn } from "./telegram.js";
import { getLiveStats, resetStats } from "./stats.js";
import { getEraStatusText, listUnanswered, teachAnswer, discardUnanswered, setLearningEnabled, parseQABlob, teachBulkAnswers, addAdminNotes } from "./era-ai.js";
import { getConversation, getConversationByShortId, setConversationStatus, resolveTelegramMessage, pushOutbox, statusLabel } from "./conversations.js";

const CATEGORIES = [
  { kind: "content", label: "✏️ Edit Website Text", perSite: true },
  { kind: "images", label: "🖼️ Change Photos", perSite: true },
  { kind: "prices", label: "💰 Edit Prices", perSite: true, sites: ["krem-chympe", "wilderness-expedition"] },
  { kind: "discounts", label: "🏷️ Discounts & Sales", perSite: false },
  { kind: "highlights", label: "🌟 Highlights / Banner", perSite: true },
];

function isAdmin(env, userId) {
  const allowed = (env.ADMIN_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true; // no allowlist configured yet — open (see DEPLOY.md)
  return allowed.includes(String(userId));
}

export async function handleTelegramAdminUpdate(env, update) {
  const msg = update.message;
  const cb = update.callback_query;

  const userId = msg?.from?.id ?? cb?.from?.id;
  const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
  if (!chatId) return;

  if (!isAdmin(env, userId)) {
    if (msg) await tgSendMessage(env, chatId, "❌ You're not an admin for this bot.");
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
  rows.push([btn("🤖 ERA AI Assistant", "eraai")]);
  rows.push([btn("👁️ Preview Live Sites", "preview")]);
  rows.push([btn("📊 Live Stats", "stats")]);
  const text =
    (note ? note + "\n\n" : "") +
    "👑 <b>Website Admin</b>\nWhat do you want to do?";
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
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
    (status.learningEnabled
      ? "ERA AI is answering visitors and saving anything it can't answer, so you can teach it later."
      : "ERA AI is still answering visitors exactly as normal — it's just paused building new knowledge. Nothing new gets queued or auto-learned until you turn it back on.");
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

  // ---- ERA AI ----
  if (action === "eraai") return sendEraMenu(env, chatId);
  if (action === "eratogglelearn") return toggleEraLearning(env, chatId);
  if (action === "erapending") return sendEraPendingList(env, chatId);
  if (action === "eraview") return sendEraQuestionDetail(env, chatId, rest.join(":"));
  if (action === "eraanswer") return startEraAnswer(env, chatId, rest.join(":"));
  if (action === "eradiscard") return discardEraQuestion(env, chatId, rest.join(":"));
  if (action === "erabulk") return startEraBulkTeach(env, chatId);
  if (action === "eradonebulk") return finishEraBulkTeach(env, chatId);

  if (action === "pick") {
    const kind = rest[0];
    const cat = CATEGORIES.find((c) => c.kind === kind);
    if (!cat) return sendMainMenu(env, chatId);
    if (kind === "discounts") return sendDiscountsMenu(env, chatId);
    if (!cat.perSite) return openTree(env, chatId, { kind, site: null, path: [] });
    return sendSitePicker(env, chatId, kind, cat.sites || SITES);
  }

  if (action === "site") {
    const [kind, site] = rest;
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

  if (action === "add") {
    return addArrayItem(env, chatId);
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
      const label = `${iconFor(child.kind, session.kind)} ${humanize(child.key)} — ${child.preview}`;
      const cb = child.kind === "object" || child.kind === "array" ? `into:${child.key}` : `edit:${child.key}`;
      rows.push([btn(truncateLabel(label), cb)]);
    }
  }

  if (Array.isArray(node)) {
    rows.push([btn("➕ Add new item", "add")]);
  }
  if (session.kind === "images" && session.path.length === 0) {
    rows.push([btn("🔄 Reset ALL photos to default", "resetimages")]);
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

// ---------------- EDIT A LEAF ----------------

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
