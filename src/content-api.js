/**
 * content-api.js — the read endpoints the live website calls, plus the
 * /media proxy that serves admin-uploaded photos straight out of
 * Telegram (no separate image host, no bytes duplicated anywhere).
 */

import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { isValidSite, getDoc, deepMerge } from "./store.js";
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
export async function handleGetImages(url, env) {
  const site = url.searchParams.get("site");
  if (!isValidSite(site)) return json({ ok: false, error: "bad site" }, env, 400);
  const override = await getDoc(env, `images:${site}`, {});
  const urls = {};
  for (const key of Object.keys(override)) {
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
  if (!fileId) return new Response("not found", { status: 404 });

  const fileUrl = await tgResolveFileUrl(env, fileId);
  if (!fileUrl) return new Response("not found", { status: 404 });

  const upstream = await fetch(fileUrl);
  if (!upstream.ok) return new Response("not found", { status: 404 });

  const headers = new Headers(upstream.headers);
  headers.set("Cache-Control", "public, max-age=300");
  headers.set("Access-Control-Allow-Origin", corsHeaders(env)["Access-Control-Allow-Origin"]);
  return new Response(upstream.body, { status: 200, headers });
}
