/**
 * help.js — the "❓ explain every button" layer for the Telegram admin
 * bot, plus a couple of small layout helpers (small buttons, pagination).
 *
 * DESIGN
 * ------
 * Telegram has no real "accordion" UI element, so collapsible Q&A is
 * built out of the two primitives the Bot API actually gives us:
 * editMessageText + editMessageReplyMarkup. Every question is its own
 * button. Tapping a question re-renders the SAME message with that
 * question's answer inserted (or removed) directly under its heading,
 * and flips that one button between ▶️ (collapsed) and 🔽 (expanded).
 *
 * There is deliberately NO session/KV state for "what's expanded" —
 * which questions are open is encoded entirely in the callback_data as
 * a small bitmask (one bit per question), the same "server holds no
 * state it doesn't have to" philosophy the rest of this file uses.
 * Every help entry has at most ~7 questions, so the mask is always a
 * 1-2 digit number and callback_data (`bhelp:<key>:<mask>:<toggleIdx>`)
 * stays tiny — nowhere near Telegram's 64-byte limit.
 *
 * USAGE
 * -----
 *   registerHelp("guideregencode", {
 *     title: "🔑 Regenerate Guide Code",
 *     questions: [
 *       { q: "What is this?", a: "..." },
 *       { q: "How do I use it?", a: "..." },
 *     ],
 *     back: { label: "⬅️ Back", action: "guidedetail" },  // no id needed for shared/static screens
 *   });
 *
 *   // next to the real action button:
 *   [btn("🔑 Regenerate Code", "guideregencode:" + id), helpButton("guideregencode")]
 *
 *   // in handleCallback:
 *   if (action === "bhelp") return handleHelpCallback(env, chatId, messageId, rest.join(":"));
 */

import { tgEditMessageText, tgSendMessage, kb, btn } from "./telegram.js";

const HELP_REGISTRY = Object.create(null);

/**
 * Register (or overwrite) a help entry.
 * entry = {
 *   title: string,
 *   intro?: string,                         // one short line shown above the Q&A list
 *   questions: [{ q, a }],                  // a is plain text/HTML, keep it phone-short
 *   backLabel?: string,  backAction?: string,  // defaults to "⬅️ Back" / "home"
 * }
 */
export function registerHelp(key, entry) {
  HELP_REGISTRY[key] = entry;
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

const FULL_MASK = (n) => (1 << n) - 1;

/**
 * Small "❓" button that opens a help entry. Pass the id/site of the
 * thing being explained as the third argument if this is a per-record
 * screen (e.g. a booking id) whose "back" target needs it — otherwise
 * leave it off for static/shared help entries.
 */
export function helpButton(key, label) {
  return btn(label || "❓", `bhelp:${key}:0`);
}

export function renderHelp(key, mask) {
  const entry = HELP_REGISTRY[key];
  if (!entry) return null;
  mask = mask | 0;

  let text = `❓ <b>${entry.title}</b>\n`;
  if (entry.intro) text += `<i>${entry.intro}</i>\n`;

  entry.questions.forEach((qa, i) => {
    const open = !!(mask & (1 << i));
    text += `\n${open ? "🔽" : "▶️"} <b>${qa.q}</b>`;
    if (open) text += `\n${qa.a}`;
  });

  const rows = entry.questions.map((qa, i) => {
    const open = !!(mask & (1 << i));
    const newMask = mask ^ (1 << i);
    return [btn(`${open ? "▲" : "▼"} ${truncate(qa.q, 26)}`, `bhelp:${key}:${newMask}`)];
  });

  if (entry.questions.length > 1) {
    const full = FULL_MASK(entry.questions.length);
    const allOpen = mask === full;
    rows.push([btn(allOpen ? "🔼 Collapse All" : "🔽 Expand All", `bhelp:${key}:${allOpen ? 0 : full}`)]);
  }
  rows.push([btn(entry.backLabel || "⬅️ Back", entry.backAction || "home")]);

  return { text, rows };
}

// Called from handleCallback for action === "bhelp". `rest` is
// "<key>:<mask>" (mask may be omitted/blank on first open).
export async function handleHelpCallback(env, chatId, messageId, rest) {
  const [key, maskStr] = rest.split(":");
  const rendered = renderHelp(key, Number(maskStr) || 0);
  if (!rendered) {
    await tgSendMessage(env, chatId, "⚠️ No help is available for that yet.");
    return;
  }
  const extra = { reply_markup: kb(rendered.rows) };
  const r = await tgEditMessageText(env, chatId, messageId, rendered.text, extra);
  if (!r.ok) await tgSendMessage(env, chatId, rendered.text, extra); // e.g. original message too old to edit
}

// ---------------------------------------------------------------------
// Small-button layout helpers
// ---------------------------------------------------------------------

// Group a flat array of buttons into rows of `perRow` (default 2) —
// use this for any list of peer buttons (categories, toggles, short
// labels) so the keyboard stays compact instead of one giant column.
// Don't use it for buttons whose label needs the full row width (long
// names, "Confirm"/"Cancel" pairs that read better stacked, etc).
export function smallRows(buttons, perRow) {
  perRow = perRow || 2;
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

// Simple page-window helper for long lists (guides, bookings, etc.) —
// returns { pageItems, rows: [pagination row] } where the pagination
// row is [] if everything fits on one page.
export function paginate(items, page, pageSize, pageAction) {
  page = page || 0;
  pageSize = pageSize || 8;
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  page = Math.min(Math.max(0, page), totalPages - 1);
  const pageItems = items.slice(page * pageSize, page * pageSize + pageSize);
  const navRow = [];
  if (totalPages > 1) {
    if (page > 0) navRow.push(btn("◀️ Prev", `${pageAction}:${page - 1}`));
    navRow.push(btn(`${page + 1}/${totalPages}`, `noop`));
    if (page < totalPages - 1) navRow.push(btn("Next ▶️", `${pageAction}:${page + 1}`));
  }
  return { pageItems, navRow, page, totalPages };
}

// ---------------------------------------------------------------------
// Built-in help entries for the parts of the bot that exist today.
// Add a registerHelp(...) call here every time a new button gets a
// real action — that's the whole extension pattern (see file header).
// ---------------------------------------------------------------------

registerHelp("paymentgateway", {
  title: "💳 Payment Gateway",
  intro: "Scaffolding for a real payment gateway — no gateway is live yet, this is where you'll set one up once you have a merchant account.",
  questions: [
    { q: "What is this?", a: "Per-site payment configuration: pick a provider (Razorpay/Stripe/PayPal), paste in its API credentials, set the currency, and turn it on." },
    { q: "Is it actually charging cards right now?", a: "No — the architecture (order tracking, webhook handling, admin notifications) is ready, but each gateway's real API calls are still a deliberate TODO until you have a live account to test against." },
    { q: "Are my credentials safe?", a: "Yes — they're stored server-side only, never shown here in full again (just the last 4 characters), and never sent to the website." },
    { q: "What's the Webhook URL for?", a: "Paste it into your gateway's own dashboard so it can tell this bot when a payment succeeds, fails, or gets refunded." },
  ],
  backAction: "paypick",
});

registerHelp("mainmenu", {
  title: "Website Admin — Main Menu",
  intro: "This is the top-level hub. Every category below opens its own submenu.",
  questions: [
    { q: "What is this menu?", a: "The starting point for every admin action — editing site content, managing guides, checking stats, and more." },
    { q: "How is it organized?", a: "Tap a category to open its submenu. Each submenu has its own ⬅️ Back and every action button has a ❓ next to it." },
    { q: "Who can use it?", a: "Only Telegram accounts listed as admins (ADMIN_USER_IDS). Guides get a separate, smaller menu." },
  ],
  backAction: "home",
});

registerHelp("guidemgmt", {
  title: "🧭 Guide Management",
  questions: [
    { q: "What is this?", a: "Where you create guides, hand out their one-time login code, and control who's currently eligible for new bookings." },
    { q: "What can I do here?", a: "➕ Add Guide creates a new guide profile. 👥 Guides lists everyone already added, grouped by site." },
    { q: "Who can use it?", a: "Admin only." },
  ],
  backAction: "guidemgmt",
});

registerHelp("addguide", {
  title: "➕ Add Guide",
  questions: [
    { q: "What is it?", a: "Creates a new guide profile and a secure one-time code to connect their Telegram." },
    { q: "What does it do?", a: "Generates a unique 6-character code tied to the guide's name, site, and the services/packages you select for them." },
    {
      q: "How to use",
      a: "1. Send the guide's name as a message.\n2. Pick which site they guide for.\n3. Select the services/packages they cover (or All Services).\n4. Tap Done — the code is generated automatically.\n5. Give the code to the guide; they send it to this same bot to link.",
    },
    { q: "Requirements", a: "None — just the guide's name and which services they'll cover." },
    { q: "Result", a: "A guide profile is created with status ⏳ (awaiting code redemption) until they link their Telegram." },
    { q: "Warning", a: "Never share a guide's code with anyone other than that guide." },
    { q: "Related", a: "🔑 Regenerate Code, 🗑 Remove Guide" },
  ],
  backAction: "guidemgmt",
});

registerHelp("guideregencode", {
  title: "🔑 Regenerate Guide Code",
  questions: [
    { q: "What is this?", a: "Creates a fresh secure code for connecting this guide's Telegram to the system." },
    { q: "What does it do?", a: "Invalidates the guide's old code (if unused) and generates a brand-new one-time code." },
    {
      q: "How to use",
      a: "1. Open the guide's detail screen.\n2. Tap 🔑 Regenerate Code.\n3. Send the new code to the guide.\n4. The guide sends that code as a plain message to their own Telegram bot to (re)link.",
    },
    { q: "Requirements", a: "The guide profile must already exist." },
    { q: "Result", a: "A new code is shown here, valid for 7 days, usable once." },
    { q: "Warning", a: "Never share the code with an unauthorized person. Any previous unused code stops working." },
    { q: "Related", a: "➕ Add Guide, 🚫 Remove Booking Access" },
  ],
  backAction: "guidemgmt",
});

registerHelp("guidetoggleactive", {
  title: "🟢 / 🔴 Active Toggle",
  questions: [
    { q: "What is this?", a: "Controls whether this guide is currently eligible to receive new booking assignments." },
    { q: "What does it do?", a: "🟢 Active = can be assigned new bookings. 🔴 Not Active = won't get new bookings, but keeps existing ones." },
    { q: "How to use", a: "Tap the button on the guide's detail screen — it flips immediately, no confirmation needed since it's reversible." },
    { q: "Result", a: "The guide's status updates instantly; they see the same status in their own Guide Dashboard." },
  ],
  backAction: "guidemgmt",
});

registerHelp("guidetoggleaccess", {
  title: "🚫 Booking Access",
  questions: [
    { q: "What is this?", a: "A stronger control than Active/Not Active — it removes a guide's ability to receive bookings entirely, even if they're marked Active." },
    { q: "What does it do?", a: "🚫 Removes booking access (they keep read-only access to existing bookings). ✅ Restores it." },
    { q: "How to use", a: "Tap the button on the guide's detail screen. This is reversible — tap again to restore." },
    { q: "Related", a: "🟢/🔴 Active Toggle" },
  ],
  backAction: "guidemgmt",
});

registerHelp("guideremove", {
  title: "🗑 Remove Guide",
  questions: [
    { q: "What is this?", a: "Permanently deletes a guide's profile from the system." },
    { q: "What does it do?", a: "Removes the guide record. Any bookings already assigned to them keep the historical record, but the guide can no longer be assigned new ones." },
    { q: "How to use", a: "Tap 🗑 Remove Guide, then confirm on the warning screen that appears." },
    { q: "Requirements", a: "None — but this cannot be undone." },
    { q: "Warning", a: "This action is permanent. The guide's code and profile are deleted immediately after you confirm." },
  ],
  backAction: "guidemgmt",
});

registerHelp("stats", {
  title: "📊 Live Stats",
  questions: [
    { q: "What is this?", a: "A quick snapshot of activity across the site — visits, taps, drafts, and completed bookings." },
    { q: "How to use", a: "Just view it. 🔄 Reset clears the counters back to zero (does not affect real bookings/content)." },
    { q: "Warning", a: "Resetting stats cannot be undone — it only affects these counters, not bookings or guide data." },
  ],
  backAction: "home",
});

registerHelp("eraai", {
  title: "🤖 ERA AI Assistant",
  questions: [
    { q: "What is this?", a: "The automated assistant that answers visitor questions on the live site, plus the queue of questions it couldn't answer yet." },
    { q: "What can I do here?", a: "Review pending questions, teach it new answers one at a time or in bulk, and turn its self-learning on/off." },
    { q: "How to use", a: "Open 📋 Pending, tap a question, then either ✏️ Answer it or 🗑 Discard it." },
  ],
  backAction: "home",
});

registerHelp("fontmenu", {
  title: "🔤 Fonts & Colors",
  intro: "Change how headings and body text look, one page/section at a time.",
  questions: [
    { q: "What is this?", a: "Controls the font size and color for headings and body text, per page (or per section on the home site) — separately for each site." },
    {
      q: "How to use",
      a: "1. Pick a site.\n2. Pick a page/section.\n3. Tap Heading Size, Heading Color, Body Size, or Body Color.\n4. Choose a preset, or send a custom value.",
    },
    { q: "Result", a: "Changes go live on the site immediately — no re-deploy needed." },
    { q: "Related", a: "🧱 Section Styling (background/overlay/glass for the same pages)" },
  ],
  backAction: "fontpick",
});

registerHelp("fontheadingsize", {
  title: "🔠 Heading Font Size",
  questions: [
    { q: "What is it?", a: "Controls how large every heading (H1–H5) is within this one page/section." },
    { q: "What does it do?", a: "Overrides the page's normal heading size with the value you set — every other page keeps its own default." },
    { q: "How to use", a: "Tap a preset (Small/Medium/Large/XL), or tap ✏️ Custom Size and send a value like 2rem, 24px, or 150%." },
    { q: "Requirements", a: "A custom value must be a number followed by a unit: px, rem, em, or %." },
    { q: "Result", a: "Headings on this page/section resize immediately on the live site." },
    { q: "Related", a: "🎨 Heading Font Color, 🔡 Body Size" },
  ],
  backAction: "fontpick",
});

registerHelp("fontheadingcolor", {
  title: "🎨 Heading Font Color",
  questions: [
    { q: "What is it?", a: "Controls the color of every heading (H1–H5) within this one page/section." },
    { q: "What does it do?", a: "Overrides the page's normal heading color with the color you set." },
    { q: "How to use", a: "Tap a preset swatch, or tap ✏️ Custom Color and send a hex code like #38bdf8." },
    { q: "Requirements", a: "A custom value must be a valid hex color (e.g. #fff or #38bdf8)." },
    { q: "Result", a: "Headings on this page/section change color immediately on the live site." },
    { q: "Related", a: "🔠 Heading Font Size, 🎨 Body Font Color" },
  ],
  backAction: "fontpick",
});

registerHelp("fontbodysize", {
  title: "🔡 Body Font Size",
  questions: [
    { q: "What is it?", a: "Controls how large the regular text (paragraphs, list items, links) is within this one page/section." },
    { q: "What does it do?", a: "Overrides the page's normal body text size — headings are unaffected." },
    { q: "How to use", a: "Tap a preset (Small/Medium/Large/XL), or tap ✏️ Custom Size and send a value like 1rem, 16px, or 110%." },
    { q: "Requirements", a: "A custom value must be a number followed by a unit: px, rem, em, or %." },
    { q: "Result", a: "Body text on this page/section resizes immediately on the live site." },
  ],
  backAction: "fontpick",
});

registerHelp("fontbodycolor", {
  title: "🎨 Body Font Color",
  questions: [
    { q: "What is it?", a: "Controls the color of the regular text (paragraphs, list items, links) within this one page/section." },
    { q: "What does it do?", a: "Overrides the page's normal body text color — headings are unaffected." },
    { q: "How to use", a: "Tap a preset swatch, or tap ✏️ Custom Color and send a hex code like #ffffff." },
    { q: "Requirements", a: "A custom value must be a valid hex color (e.g. #fff or #38bdf8)." },
    { q: "Result", a: "Body text on this page/section changes color immediately on the live site." },
  ],
  backAction: "fontpick",
});
