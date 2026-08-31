/**
 * pricing.js — the adaptive calculation engine. Same function is used
 * by the live website (via POST /api/calculate-price) and by the bot's
 * "preview" screen, so admin and visitor always see the identical
 * number — there is exactly one place this math happens.
 *
 * Discounts stack in this fixed order, each applied as a percentage of
 * whatever remains after the previous step (so admins can reason about
 * "15% off, then another 20% off that" rather than everything being a
 * flat % of the original):
 *   1. Package sale (admin's one-tap "🏷️ 20% off this package" toggle)
 *   2. Bulk / group-size discount (automatic, based on person count)
 *   3. Seasonal discount (automatic, based on today's date)
 *   4. Discount code (admin-created, visitor-entered)
 * A code's flat-₹ component (if any) is subtracted last, after all
 * percentage discounts.
 */

export const DEFAULT_DISCOUNTS = {
  codes: {},
  bulkTiers: [
    { minPeople: 3, maxPeople: 4, percent: 10 },
    { minPeople: 5, maxPeople: 6, percent: 15 },
    { minPeople: 7, maxPeople: 8, percent: 20 },
    { minPeople: 9, maxPeople: 999, percent: 25 },
  ],
  seasonal: [],
  // saleBySite.<site>.<packageKey> = percent off, e.g.
  // { "krem-chympe": { "group": 20 } }
  saleBySite: {},
};

export function bulkDiscountPercent(bulkTiers, persons) {
  if (!persons || persons < 1) return null;
  for (const tier of bulkTiers || []) {
    if (persons >= tier.minPeople && persons <= tier.maxPeople) {
      return { percent: tier.percent, label: `Group discount (${tier.minPeople}${tier.maxPeople >= 999 ? "+" : "–" + tier.maxPeople} people)` };
    }
  }
  return null;
}

export function seasonalDiscount(seasonal, dateISO) {
  const d = dateISO ? new Date(dateISO) : new Date();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  for (const s of seasonal || []) {
    if (!s.active) continue;
    if (inSeasonRange(month, day, s)) {
      return { percent: s.percent, label: s.label || "Seasonal discount" };
    }
  }
  return null;
}

function inSeasonRange(month, day, s) {
  const val = (m, d) => m * 100 + d;
  const cur = val(month, day);
  const start = val(s.startMonth, s.startDay);
  const end = val(s.endMonth, s.endDay);
  if (start <= end) return cur >= start && cur <= end;
  // wraps across year end (e.g. Dec 1 -> Jan 15)
  return cur >= start || cur <= end;
}

export function findCode(discounts, code) {
  if (!code) return null;
  const c = (discounts.codes || {})[code.trim().toUpperCase()];
  if (!c || c.active === false) return null;
  if (c.expiresAt && new Date(c.expiresAt) < new Date()) return null;
  return c;
}

export function salePercent(discounts, site, packageKey) {
  const pct = discounts.saleBySite?.[site]?.[packageKey];
  return typeof pct === "number" && pct > 0 ? pct : null;
}

/**
 * @param {object} discounts   the discounts:global doc
 * @param {object} p
 * @param {string} p.site
 * @param {string} p.packageKey  e.g. "group", "private", "trek"
 * @param {number} p.unitPrice   ₹ per person (or per group, if persons=1)
 * @param {number} p.persons
 * @param {Array<{name:string,price:number,qty:number}>} [p.addons]
 * @param {string} [p.dateISO]
 * @param {string} [p.code]
 */
export function calculatePrice(discounts, p) {
  const addonsTotal = (p.addons || []).reduce((s, a) => s + a.price * (a.qty || 1), 0);
  const subtotal = Math.round(p.unitPrice * (p.persons || 1) + addonsTotal);

  const breakdown = [];
  let running = subtotal;

  const sale = salePercent(discounts, p.site, p.packageKey);
  if (sale) running = applyPercent(breakdown, running, sale, `🏷️ Special offer (${sale}% off)`);

  const bulk = bulkDiscountPercent(discounts.bulkTiers, p.persons);
  if (bulk) running = applyPercent(breakdown, running, bulk.percent, `👥 ${bulk.label}`);

  const season = seasonalDiscount(discounts.seasonal, p.dateISO);
  if (season) running = applyPercent(breakdown, running, season.percent, `📅 ${season.label}`);

  const code = findCode(discounts, p.code);
  if (code) {
    if (code.percent) running = applyPercent(breakdown, running, code.percent, `🎟️ Code ${p.code.toUpperCase()} (${code.percent}% off)`);
    if (code.flat) {
      const amt = Math.min(code.flat, running);
      running -= amt;
      breakdown.push({ label: `🎟️ Code ${p.code.toUpperCase()} (₹${code.flat} off)`, amount: -amt });
    }
    if (!code.percent && !code.flat) {
      breakdown.push({ label: `🎟️ Code ${p.code.toUpperCase()} — invalid`, amount: 0 });
    }
  } else if (p.code) {
    breakdown.push({ label: `🎟️ Code ${p.code.toUpperCase()} — not valid`, amount: 0 });
  }

  running = Math.max(0, Math.round(running));
  return {
    subtotal,
    breakdown,
    total: running,
    savings: subtotal - running,
  };
}

function applyPercent(breakdown, running, percent, label) {
  const amt = Math.round((running * percent) / 100);
  breakdown.push({ label, amount: -amt });
  return running - amt;
}
