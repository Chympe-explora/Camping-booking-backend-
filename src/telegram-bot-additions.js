/**
 * CODE ADDITIONS FOR telegram-bot.js
 * 
 * These additions allow admins to edit the hero video URL and notice popup
 * from the Telegram bot menu.
 */

// ===== STEP 1: Add to CATEGORIES array (around line 23) =====
/*
const CATEGORIES = [
  { kind: "content", label: "✏️ Edit Website Text", perSite: true },
  { kind: "images", label: "🖼️ Change Photos", perSite: true },
  { kind: "prices", label: "💰 Edit Prices", perSite: true, sites: ["krem-chympe", "wilderness-expedition"] },
  { kind: "discounts", label: "🏷️ Discounts & Sales", perSite: false },
  { kind: "highlights", label: "🌟 Highlights / Banner", perSite: true },
  // ← ADD THIS LINE:
  { kind: "heroVideo", label: "🎬 Hero Video & Notice", perSite: true },
];
*/

// ===== STEP 2: Add these functions before the handleCallback function =====

/**
 * Main menu for editing hero video and notice popup
 */
async function sendHeroVideoMenu(env, chatId, site) {
  const site_ = site || "root";
  const content = await getDoc(env, `site:${site_}`, {});
  const hero = content.hero || {};
  const notice = content.notice || {};
  
  const videoUrl = hero.videoUrl || "(not set)";
  const videoDisplay = videoUrl.length > 40 
    ? videoUrl.substring(0, 37) + "..." 
    : videoUrl;
  
  const text = `🎬 <b>Hero Video &amp; Notice Popup</b> — <code>${site_}</code>

<b>📺 Video Settings:</b>
Current video URL: <code>${videoDisplay}</code>
Fallback image: <code>${hero.fallbackImage || "Trek Trail Mist.jpg"}</code>

<b>📢 Notice Popup:</b>
Title: <code>${notice.title || "PUBLIC NOTICE"}</code>
Status: ${notice.enabled !== false ? "🟢 Enabled" : "🔴 Disabled"}

Tap a button to edit:`;

  const rows = [
    [btn("🎬 Change Video URL", `editVideoUrl:${site_}`)],
    [btn("🖼️ Fallback Image", `editVideoFallback:${site_}`)],
    [btn("📢 Edit Notice Text", `editNotice:${site_}`)],
    [btn(notice.enabled !== false ? "⏸️ Disable Notice" : "▶️ Enable Notice", `toggleNotice:${site_}`)],
    [btn("🔄 Reset (show to all)", `resetNotice:${site_}`)],
    [btn("⬅️ Main Menu", "home")]
  ];
  
  await tgSendMessage(env, chatId, text, { reply_markup: kb(rows) });
}

/**
 * Prompt admin to enter video URL
 */
async function handleEditVideoUrl(env, chatId) {
  await setSession(env, chatId, { awaiting: "videoUrl" });
  await tgSendMessage(
    env,
    chatId,
    `Paste the full URL to your hero video (MP4):\n\n<code>https://example.com/videos/hero.mp4</code>\n\nOr send <code>reset</code> to remove the video (will use fallback image instead).`
  );
}

/**
 * Prompt admin to enter fallback image name
 */
async function handleEditVideoFallback(env, chatId, site) {
  await setSession(env, chatId, { awaiting: "videoFallback", site });
  await tgSendMessage(
    env,
    chatId,
    `Which image should be shown if the video fails to load?\n\nExample: <code>Trek Trail Mist.jpg</code>\n\nLeave blank to use default.`
  );
}

/**
 * Prompt admin to enter notice popup content
 */
async function handleEditNotice(env, chatId, site) {
  await setSession(env, chatId, { awaiting: "noticeText", site });
  await tgSendMessage(
    env,
    chatId,
    `Paste the notice popup content.\n\nFormat (each on a new line):\n<code>Line 1: Title (e.g., PUBLIC NOTICE)\nLine 2: Subtitle (e.g., Important Update)\nLines 3+: Main text (can be multiple lines)</code>\n\nExample:\n<code>PUBLIC NOTICE\nImportant Update\nNormal vehicular movement has been reinstated. There are no restrictions on travel within Meghalaya.</code>`
  );
}

/**
 * Toggle notice enabled/disabled
 */
async function handleToggleNotice(env, chatId, site) {
  const content = await getDoc(env, `site:${site}`, {});
  content.notice = content.notice || {};
  content.notice.enabled = content.notice.enabled === false ? true : false; // Toggle
  await saveDoc(env, `site:${site}`, content, {
    logChange: `Notice popup ${content.notice.enabled ? "enabled" : "disabled"}`
  });
  await tgSendMessage(
    env,
    chatId,
    `✅ Notice popup is now ${content.notice.enabled ? "🟢 <b>Enabled</b>" : "🔴 <b>Disabled</b>"}`
  );
  await sendHeroVideoMenu(env, chatId, site);
}

/**
 * Reset notice popup (clear localStorage flag so it shows again to all users)
 */
async function handleResetNotice(env, chatId, site) {
  const content = await getDoc(env, `site:${site}`, {});
  content.notice = content.notice || {};
  content.notice.resetVersion = (content.notice.resetVersion || 0) + 1;
  await saveDoc(env, `site:${site}`, content, {
    logChange: `Notice popup reset (will show again to all visitors)`
  });
  await tgSendMessage(
    env,
    chatId,
    `✅ Notice popup reset!\n\nIt will now show again to all visitors, even those who already closed it.`
  );
  await sendHeroVideoMenu(env, chatId, site);
}

// ===== STEP 3: Add to handleCallback function =====
/*
In the handleCallback function (around line 276), add these cases.
Find where other button handlers are, and add:

  if (action === "heroVideo") return sendHeroVideoMenu(env, chatId, rest[0] || "root");
  if (action === "editVideoUrl") return handleEditVideoUrl(env, chatId);
  if (action.startsWith("editVideoFallback:")) return handleEditVideoFallback(env, chatId, action.split(":")[1]);
  if (action.startsWith("editNotice:")) return handleEditNotice(env, chatId, action.split(":")[1]);
  if (action.startsWith("toggleNotice:")) return handleToggleNotice(env, chatId, action.split(":")[1]);
  if (action.startsWith("resetNotice:")) return handleResetNotice(env, chatId, action.split(":")[1]);
  
Example location in handleCallback:

  async function handleCallback(env, chatId, messageId, data) {
    const [action, ...rest] = data.split(":");

    if (action === "home") return sendMainMenu(env, chatId);
    if (action === "pick") return sendCategoryMenu(env, chatId, rest[0], rest[1]);
    
    // ... other handlers ...
    
    // ← ADD HERO VIDEO HANDLERS HERE:
    if (action === "heroVideo") return sendHeroVideoMenu(env, chatId, rest[0] || "root");
    if (action === "editVideoUrl") return handleEditVideoUrl(env, chatId);
    if (action.startsWith("editVideoFallback")) return handleEditVideoFallback(env, chatId, rest[0]);
    if (action.startsWith("editNotice")) return handleEditNotice(env, chatId, rest[0]);
    if (action.startsWith("toggleNotice")) return handleToggleNotice(env, chatId, rest[0]);
    if (action.startsWith("resetNotice")) return handleResetNotice(env, chatId, rest[0]);
    
    // ... rest of handlers ...
  }
*/

// ===== STEP 4: Add to handleAwaitedInput function =====
/*
In the handleAwaitedInput function, add these handlers after the existing cases.
Find where session.awaiting === "..." is checked (around line 540), and add:
*/

/**
 * In handleAwaitedInput, add these cases:
 */

// Handler for video URL input
/*
if (session.awaiting === "videoUrl") {
  const site = session.site || "root";
  const text = msg?.text?.trim() || "";
  const content = await getDoc(env, `site:${site}`, {});
  
  if (text.toLowerCase() === "reset") {
    content.hero = content.hero || {};
    content.hero.videoUrl = "";
    await saveDoc(env, `site:${site}`, content, { 
      logChange: `Removed hero video URL` 
    });
    await tgSendMessage(env, chatId, "✅ Video URL cleared. Hero will use fallback image only.");
  } else if (text.match(/^https?:\/\/.*\.(mp4|webm|ogg)$/i)) {
    content.hero = content.hero || {};
    content.hero.videoUrl = text;
    await saveDoc(env, `site:${site}`, content, { 
      logChange: `Updated hero video URL to: ${text.substring(0, 60)}...` 
    });
    await tgSendMessage(env, chatId, `✅ Video URL updated!\n\n<code>${text}</code>`);
  } else {
    await tgSendMessage(
      env,
      chatId,
      `❌ Invalid URL. Must be a direct link to an MP4, WebM, or OGG video.\n\nExample: <code>https://example.com/video.mp4</code>`
    );
    return; // Stay in awaiting mode, don't clear session
  }
  
  await clearSession(env, chatId);
  await sendHeroVideoMenu(env, chatId, site);
  return;
}
*/

// Handler for fallback image input
/*
if (session.awaiting === "videoFallback") {
  const site = session.site || "root";
  const text = msg?.text?.trim() || "";
  const content = await getDoc(env, `site:${site}`, {});
  
  if (text) {
    content.hero = content.hero || {};
    content.hero.fallbackImage = text;
    await saveDoc(env, `site:${site}`, content, { 
      logChange: `Updated video fallback image to: ${text}` 
    });
    await tgSendMessage(env, chatId, `✅ Fallback image updated to: <code>${text}</code>`);
  } else {
    content.hero = content.hero || {};
    content.hero.fallbackImage = "Trek Trail Mist.jpg"; // Reset to default
    await saveDoc(env, `site:${site}`, content, { 
      logChange: `Reset fallback image to default` 
    });
    await tgSendMessage(env, chatId, `✅ Fallback image reset to default.`);
  }
  
  await clearSession(env, chatId);
  await sendHeroVideoMenu(env, chatId, site);
  return;
}
*/

// Handler for notice text input
/*
if (session.awaiting === "noticeText") {
  const site = session.site || "root";
  const text = msg?.text?.trim() || "";
  const lines = text.split("\n").map(l => l.trim()).filter(l => l);
  
  const content = await getDoc(env, `site:${site}`, {});
  
  if (lines.length >= 2) {
    content.notice = content.notice || {};
    content.notice.title = lines[0];
    content.notice.subtitle = lines[1];
    content.notice.text = lines.slice(2).join("\n");
    content.notice.enabled = true;
    await saveDoc(env, `site:${site}`, content, { 
      logChange: `Updated notice popup text` 
    });
    
    await tgSendMessage(
      env,
      chatId,
      `✅ Notice popup updated!\n\n<b>${content.notice.title}</b>\n<i>${content.notice.subtitle}</i>\n\n${content.notice.text}`
    );
  } else {
    await tgSendMessage(
      env,
      chatId,
      `❌ Please provide at least a title (line 1) and subtitle (line 2).\n\nFormat:\nTitle\nSubtitle\nMain text...`
    );
    return; // Stay in awaiting mode
  }
  
  await clearSession(env, chatId);
  await sendHeroVideoMenu(env, chatId, site);
  return;
}
*/

// ===== STEP 5: Update main menu to include hero video option =====
/*
In sendMainMenu function (around line 100), the CATEGORIES array is 
mapped to buttons automatically, so if you added heroVideo to CATEGORIES
in Step 1, it should appear automatically.

If you need to debug, verify the sendMainMenu function looks like:

async function sendMainMenu(env, chatId, note) {
  const rows = CATEGORIES.map((c) => [btn(c.label, `pick:${c.kind}`)]);
  // ... rest of menu ...
}

And that handleCallback has:

  if (action === "pick") {
    const kind = rest[0];
    // ... handle category selection ...
    // This should call sendHeroVideoMenu if kind === "heroVideo"
  }
*/

// ===== COMPLETE EXAMPLE: handleCallback implementation =====
/*

async function handleCallback(env, chatId, messageId, data) {
  const [action, ...rest] = data.split(":");

  // Main menu
  if (action === "home") return sendMainMenu(env, chatId);

  // Category picker (✏️ Edit Text, 🎬 Hero Video, etc.)
  if (action === "pick") {
    const kind = rest[0];
    if (kind === "heroVideo") {
      return sendHeroVideoMenu(env, chatId, rest[1] || "root");
    }
    // ... other category handlers ...
  }

  // Hero Video Menu
  if (action === "heroVideo") return sendHeroVideoMenu(env, chatId, rest[0] || "root");
  if (action === "editVideoUrl") return handleEditVideoUrl(env, chatId);
  if (action.startsWith("editVideoFallback")) return handleEditVideoFallback(env, chatId, rest[0]);
  if (action.startsWith("editNotice")) return handleEditNotice(env, chatId, rest[0]);
  if (action.startsWith("toggleNotice")) return handleToggleNotice(env, chatId, rest[0]);
  if (action.startsWith("resetNotice")) return handleResetNotice(env, chatId, rest[0]);

  // ... other handlers ...
}
*/
