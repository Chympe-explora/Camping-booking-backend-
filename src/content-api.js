/**
 * content-api.js — the read endpoints the live website calls, plus the
 * /media proxy that serves admin-uploaded photos straight out of
 * Telegram (no separate image host, no bytes duplicated anywhere).
 */

import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { isValidSite, getDoc, saveDoc, deepMerge } from "./store.js";
import { calculatePrice, DEFAULT_DISCOUNTS } from "./pricing.js";
import { tgResolveFileUrl } from "./telegram.js";
import { json, corsHeaders } from "./booking.js";

export async function handleGetContent(url, env) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  const base = SCHEMA_DEFAULTS[site]?.KC_CONTENT || {};
  const override = await getDoc(env, `content:${site}`, {});
  return json({ ok: true, content: deepMerge(base, override) }, env);
}

export async function handleGetPrices(url, env) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  const base = SCHEMA_DEFAULTS[site]?.KC_PRICES || {};
  const override = await getDoc(env, `prices:${site}`, {});
  return json({ ok: true, prices: deepMerge(base, override) }, env);
}

// Only returns keys the admin has actually changed via the bot — the
// site keeps using its own local static image for everything else.
//
// Defensive guard: an older version of the admin bot could accidentally
// save the *entire* default image map (filenames like "hero-bg-2.jpg",
// not real Telegram file_ids) into this doc instead of just the one
// photo that was actually changed (see saveLeaf in telegram-bot.js).
// That "poisoned" every image on the site, because /media/:site/:key
// would then try to resolve a plain filename as if it were a Telegram
// file_id and always 404. We now skip any key whose stored value is
// still just the untouched default filename — only genuine overrides
// ever get turned into a /media link. This makes any already-poisoned
// KV doc self-heal on the very next page load, no manual reset needed.
export async function handleGetImages(url, env) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  const override = await getDoc(env, `images:${site}`, {});
  const defaults = SCHEMA_DEFAULTS[site]?.KC_IMAGES || {};
  const urls = {};
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (!value || typeof value !== "string" || value === defaults[key]) continue;
    urls[key] = `/media/${site}/${key}`;
  }
  return json({ ok: true, images: urls }, env);
}

export async function handleGetHighlights(url, env) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  const items = await getDoc(env, `highlights:${site}`, []);
  return json({ ok: true, highlights: (items || []).filter((h) => h.active !== false) }, env);
}

export async function handleGetDiscounts(env) {
  const override = await getDoc(env, "discounts:global", {});
  return json({ ok: true, discounts: deepMerge(DEFAULT_DISCOUNTS, override) }, env);
}

// POST /api/admin/reset-images  { site, keys: ["logo", "expeditionPackageCard"] }
// Header: x-admin-secret: <ADMIN_API_SECRET>
//
// Same effect as tapping "↩️ Reset this one to default" on the Telegram
// admin bot, but callable over HTTP — for fixing a stale/broken photo
// override without going through the bot's menus. Clears only the
// named keys from the images:<site> doc (leaving every other
// admin-uploaded photo untouched) so the site falls back to whatever
// is currently the static default (config.js / SCHEMA_DEFAULTS) for
// those keys.
export async function handleAdminResetImages(request, env) {
  if (!env.ADMIN_API_SECRET) {
    return json({ ok: false, error: "ADMIN_API_SECRET is not configured on this Worker" }, env, 500);
  }
  const secret = request.headers.get("x-admin-secret");
  if (secret !== env.ADMIN_API_SECRET) {
    return json({ ok: false, error: "forbidden" }, env, 403);
  }

  const { site, keys } = await request.json();
  if (!isValidSite(site) || !Array.isArray(keys) || !keys.length) {
    return json({ ok: false, error: "site and keys[] are required" }, env, 400);
  }

  const docKey = `images:${site}`;
  const override = await getDoc(env, docKey, {});
  const removed = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(override, key)) {
      delete override[key];
      removed.push(key);
    }
  }
  await saveDoc(env, docKey, override, {
    logChange: removed.length
      ? `Reset photo(s) to default via admin API: ${removed.join(", ")}`
      : "Admin API reset requested — nothing was overridden",
  });

  return json({ ok: true, removed }, env);
}

export async function handleCalculatePrice(request, env) {
  const body = await request.json();
  const { site, packageKey, unitPrice, persons, addons, dateISO, code } = body || {};
  if (!isValidSite(site) || typeof unitPrice !== "number") {
    return json({ ok: false, error: "site and unitPrice are required" }, env, 400);
  }
  const override = await getDoc(env, "discounts:global", {});
  const discounts = deepMerge(DEFAULT_DISCOUNTS, override);
  const result = calculatePrice(discounts, {
    site,
    packageKey: packageKey || "default",
    unitPrice,
    persons: persons || 1,
    addons: addons || [],
    dateISO,
    code,
  });
  return json({ ok: true, ...result }, env);
}

// GET /media/<site>/<key> — resolves the stored Telegram file_id to a
// fresh CDN link and streams the bytes straight through. Nothing is
// cached on our side beyond normal HTTP caching, by design — Telegram
// is the only place the image bytes live.
export async function handleMedia(url, env) {
  const parts = url.pathname.split("/").filter(Boolean); // ["media", site, key]
  const [, site, key] = parts;
  if (!isValidSite(site) || !key) return new Response("not found", { status: 404 });

  const override = await getDoc(env, `images:${site}`, {});
  const fileId = override[key];
  const defaults = SCHEMA_DEFAULTS[site]?.KC_IMAGES || {};
  // Same guard as handleGetImages: never try to resolve a plain default
  // filename (not a real Telegram file_id) through the Telegram API.
  if (!fileId || typeof fileId !== "string" || fileId === defaults[key]) {
    return new Response("not found", { status: 404 });
  }

  const fileUrl = await tgResolveFileUrl(env, fileId);
  if (!fileUrl) return new Response("not found", { status: 404 });

  const upstream = await fetch(fileUrl);
  if (!upstream.ok) return new Response("not found", { status: 404 });

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Access-Control-Allow-Origin", corsHeaders(env)["Access-Control-Allow-Origin"]);
  return new Response(upstream.body, { status: 200, headers });
}
