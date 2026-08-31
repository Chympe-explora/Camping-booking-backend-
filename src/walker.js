/**
 * walker.js — turns ANY plain JSON object (site content, prices,
 * highlights, add-on lists, ...) into a navigable menu tree, so the bot
 * never needs a hand-written list of "every field". It just walks
 * whatever object it's given.
 *
 * This is what makes "edit every letter" possible without maintaining a
 * giant hardcoded field list: point the walker at KC_CONTENT (merged
 * with the admin's saved overrides) and it can drill into and edit any
 * string or number anywhere in that tree, however deeply nested.
 */

export function kindOf(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "string";
  const t = typeof value;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

// List the direct children of `obj` at the given path, formatted for
// menu buttons. Skips a few structural keys that aren't meant for
// free-text editing (ids used for linking, e.g. "id").
const SKIP_KEYS = new Set(["id"]);

export function listChildren(obj, opts = {}) {
  if (obj == null) return [];
  const entries = Array.isArray(obj)
    ? obj.map((v, i) => [String(i), v])
    : Object.entries(obj);

  return entries
    .filter(([k]) => opts.includeSkipped || !SKIP_KEYS.has(k))
    .map(([k, v]) => ({
      key: k,
      kind: kindOf(v),
      preview: preview(v),
      isArrayItem: Array.isArray(obj),
    }));
}

function preview(v) {
  if (v == null) return "(empty)";
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object") {
    const n = Object.keys(v).length;
    // Nice label for common shapes: named list items, block objects, etc.
    if (typeof v.name === "string") return v.name;
    if (typeof v.label === "string") return v.label;
    if (typeof v.text === "string") return truncate(v.text);
    if (typeof v.heading === "string") return v.heading;
    return `{${n} field${n === 1 ? "" : "s"}}`;
  }
  return truncate(String(v));
}

function truncate(s, n = 40) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Human label for a raw object key, e.g. "whatsappNumber" -> "Whatsapp Number"
export function humanize(key) {
  if (/^\d+$/.test(key)) return `#${Number(key) + 1}`;
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
