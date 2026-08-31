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
  rows.push([btn("👁️ Preview Live Sites", "preview")]);
  const text =
    (note ? note + "\n\n" : "") +
    "👑 <b>Website Admin</b>\nWhat do you want to do?";
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

// ---------------- CALLBACK ROUTER ----------------

async function handleCallback(env, chatId, messageId, data) {
  const [action, ...rest] = data.split(":");

  if (action === "home") return sendMainMenu(env, chatId);

  if (action === "preview") return sendPreviewLinks(env, chatId);

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

  if (action === "cancel") {
    const session = await getSession(env, chatId);
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
      reply_markup: kb([[btn("❌ Cancel", "cancel")]]),
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

async function saveLeaf(env, session, value, logChange) {
  const { docKey, merged } = await loadMerged(env, session.kind, session.site);
  setPath(merged, session.awaiting.path, value);
  await saveDoc(env, docKey, merged, { logChange });
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
