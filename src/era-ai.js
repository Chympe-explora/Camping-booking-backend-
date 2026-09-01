/**
 * era-ai.js — "ERA AI", the visitor-facing chat assistant for the Team
 * Chympe Explora sites, plus the knowledge-base + learning controls
 * exposed through the Telegram admin bot.
 * -----------------------------------------------------------------------
 * How it answers:
 *   1. LIVE INTENTS — pricing, refund policy, contact details, guide info
 *      are answered by reading the CURRENT content/pricing docs (the same
 *      ones the admin bot edits) so ERA AI never repeats a stale number.
 *      These always work, learning toggle or not — they're not "learned",
 *      they're just live lookups.
 *   2. KNOWLEDGE BASE — a small built-in set of generic Q&A, plus
 *      admin-taught entries (see teachAnswer below), matched by simple
 *      keyword overlap. Good enough for FAQ-style matching without
 *      needing an external AI API.
 *   3. FALLBACK — if nothing matches confidently, ERA AI gives a graceful
 *      "not sure" reply and (only if learning is enabled) queues the
 *      question so the admin can teach it the right answer from Telegram.
 *
 * TELEGRAM IS THE STORAGE (same pattern as the rest of this backend —
 * see store.js): the knowledge base, unanswered-question queue, and
 * learning on/off flag are all persisted via getDoc/saveDoc.
 *
 * THE "STOP LEARNING" TOGGLE — what it does and doesn't do:
 *   OFF only pauses ERA AI's passive knowledge growth: new unanswered
 *   questions stop being queued, so nothing new gets added to the
 *   knowledge base on its own. ERA AI keeps answering visitors exactly
 *   as before, using whatever it already knows. An admin can still
 *   manually teach it an answer at any time (that's an explicit edit,
 *   same as editing site text) — the toggle only affects automatic
 *   learning from visitor traffic.
 */

import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { isValidSite, getDoc, saveDoc, deepMerge } from "./store.js";
import { json } from "./booking.js";

const KNOWLEDGE_DOC = "eraKnowledge:global"; // admin-taught Q&A pairs (the "learned" layer)
const SETTINGS_DOC = "eraSettings:global"; // { learningEnabled }
const UNANSWERED_DOC = "eraUnanswered:global"; // queue of questions ERA AI couldn't confidently answer
const STATS_DOC = "eraStats:global";

const MATCH_THRESHOLD = 0.34;

// A small built-in seed so ERA AI is useful on day one, before any
// admin teaching has happened. Deliberately has no hard-coded prices —
// those come from tryLiveIntent() below so they can never go stale.
const STATIC_KB = [
  {
    id: "s-who",
    questions: ["what is era ai", "who are you", "are you a bot", "what can you do", "your name"],
    answer: "I'm ERA AI 🌿 — Team Chympe Explora's assistant. Ask me about packages, pricing, what to bring, cancellations, or how booking works, and I'll help.",
  },
  {
    id: "s-book",
    questions: ["how do i book", "how to book", "booking process", "how does booking work"],
    answer: "Pick a package on the Packages page, fill in your details, then you'll get a Pay Now step followed by a receipt upload. Our guide confirms it on Telegram, usually within a few hours.",
  },
  {
    id: "s-pack",
    questions: ["what should i bring", "what to pack", "what to wear", "packing list"],
    answer: "Comfortable trekking shoes with good grip, a change of clothes, a small towel, drinking water, and a dry bag for your phone/valuables — the trail and cave/river sections can get wet.",
  },
  {
    id: "s-safe",
    questions: ["is it safe", "safety", "is it dangerous"],
    answer: "Yes — you'll be with an experienced local guide the whole way, and safety gear is provided where needed. If conditions look unsafe, the final call on any activity always rests with the guide.",
  },
  {
    id: "s-season",
    questions: ["best time to visit", "best season", "when should i go", "weather"],
    answer: "Meghalaya's cooler, drier months generally give the best visibility and easiest trekking conditions, but tours run across most of the year — check the Booking page for live date availability.",
  },
];

function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function scoreMatch(queryTokens, candidateQuestions) {
  let best = 0;
  for (const q of candidateQuestions || []) {
    const qTokens = tokenize(q);
    if (!qTokens.length) continue;
    const overlap = qTokens.filter((t) => queryTokens.includes(t)).length;
    const score = overlap / Math.max(qTokens.length, queryTokens.length, 1);
    if (score > best) best = score;
  }
  return best;
}

function humanizeKey(k) {
  return String(k)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------
// settings / knowledge / stats — thin wrappers over the shared doc store
// ---------------------------------------------------------------------
async function getSettings(env) {
  return getDoc(env, SETTINGS_DOC, { learningEnabled: true });
}

export async function setLearningEnabled(env, enabled) {
  const settings = await getSettings(env);
  settings.learningEnabled = !!enabled;
  await saveDoc(env, SETTINGS_DOC, settings, {
    logChange: `ERA AI learning turned ${enabled ? "ON 🟢" : "OFF (paused) 🔴"}`,
  });
  return settings;
}

async function getTaughtKnowledge(env) {
  return getDoc(env, KNOWLEDGE_DOC, []);
}

export async function listUnanswered(env) {
  return getDoc(env, UNANSWERED_DOC, []);
}

export async function discardUnanswered(env, id) {
  const list = await getDoc(env, UNANSWERED_DOC, []);
  await saveDoc(env, UNANSWERED_DOC, list.filter((q) => q.id !== id));
}

// Admin explicitly teaching an answer — always allowed, regardless of
// the learning toggle (see the module doc-comment above for why).
export async function teachAnswer(env, questionId, answerText) {
  const list = await getDoc(env, UNANSWERED_DOC, []);
  const idx = list.findIndex((q) => q.id === questionId);
  if (idx === -1) return false;
  const [item] = list.splice(idx, 1);
  await saveDoc(env, UNANSWERED_DOC, list);

  const knowledge = await getTaughtKnowledge(env);
  knowledge.push({
    id: crypto.randomUUID().slice(0, 8),
    questions: [item.question],
    answer: answerText,
    addedFrom: "admin-taught",
    ts: Date.now(),
  });
  await saveDoc(env, KNOWLEDGE_DOC, knowledge, {
    logChange: `ERA AI learned a new answer for: "${item.question.slice(0, 80)}"`,
  });
  return true;
}

export async function getEraStatusText(env) {
  const settings = await getSettings(env);
  const unanswered = await listUnanswered(env);
  const knowledge = await getTaughtKnowledge(env);
  const stats = await getDoc(env, STATS_DOC, { totalMessages: 0 });
  return {
    learningEnabled: settings.learningEnabled !== false,
    pendingCount: unanswered.length,
    knowledgeCount: STATIC_KB.length + knowledge.length,
    totalMessages: stats.totalMessages || 0,
  };
}

// ---------------------------------------------------------------------
// live intents — read current content/pricing docs directly, no HTTP
// round-trip needed since we're in the same Worker
// ---------------------------------------------------------------------
async function siteContent(env, site) {
  const base = SCHEMA_DEFAULTS[site]?.KC_CONTENT || {};
  const override = await getDoc(env, `content:${site}`, {});
  return deepMerge(base, override);
}

async function sitePrices(env, site) {
  const base = SCHEMA_DEFAULTS[site]?.KC_PRICES || {};
  const override = await getDoc(env, `prices:${site}`, {});
  return deepMerge(base, override);
}

async function tryLiveIntent(env, site, message) {
  if (!isValidSite(site) || site === "root") return null;
  const msg = message.toLowerCase();

  if (/\b(price|cost|how much|charge|fee|rate|pricing)\b/.test(msg)) {
    const prices = await sitePrices(env, site);
    const pkgKeys = Object.keys(prices).filter((k) => prices[k] && typeof prices[k] === "object" && !Array.isArray(prices[k]));
    if (pkgKeys.length) {
      const lines = pkgKeys.slice(0, 4).map((k) => {
        const val = prices[k];
        const amount = val.price ?? val.perPerson ?? val.basePrice ?? val.total ?? val.amount;
        return amount ? `• ${humanizeKey(k)}: ₹${amount}` : `• ${humanizeKey(k)}`;
      });
      return `Here's our current pricing:\n${lines.join("\n")}\n\nWant an exact total for your group size? Head to the Booking page and I'll calculate it live there.`;
    }
  }

  if (/\b(cancel|refund|reschedule)\b/.test(msg)) {
    const content = await siteContent(env, site);
    const policy = content.refundPolicy;
    if (policy && policy.intro) {
      const cta = policy.whatsapp && policy.whatsapp.buttonLabel ? `\n\nOpen the Refund Policy page and tap "${policy.whatsapp.buttonLabel}" for help with a specific booking.` : "";
      return policy.intro + cta;
    }
  }

  if (/\b(contact|whatsapp|phone|call|reach|number)\b/.test(msg)) {
    const content = await siteContent(env, site);
    const footer = content.footer;
    if (footer && footer.phone) {
      return `You can reach the team directly:\n📞 ${footer.phone}${footer.email ? `\n✉️ ${footer.email}` : ""}\n\nOr just tap Book Now and our guide will confirm on WhatsApp/Telegram.`;
    }
  }

  if (/\b(guide|who.*guiding|instructor|who leads)\b/.test(msg)) {
    const content = await siteContent(env, site);
    if (content.guide && content.guide.name) {
      return `${content.guide.name}${content.guide.role ? ` (${content.guide.role})` : ""} will be with you.${content.guide.bio ? " " + content.guide.bio : ""}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------
// stats + unanswered-question queue
// ---------------------------------------------------------------------
async function bumpStats(env) {
  const stats = await getDoc(env, STATS_DOC, { totalMessages: 0, byDate: {} });
  stats.totalMessages = (stats.totalMessages || 0) + 1;
  const day = new Date().toISOString().slice(0, 10);
  stats.byDate = stats.byDate || {};
  stats.byDate[day] = (stats.byDate[day] || 0) + 1;
  // No logChange here on purpose — this fires on every message and
  // would otherwise spam the admin chat with a message per visitor turn.
  await saveDoc(env, STATS_DOC, stats);
}

async function queueUnanswered(env, site, question) {
  const list = await getDoc(env, UNANSWERED_DOC, []);
  const qTokens = tokenize(question);
  const dup = list.find((item) => scoreMatch(qTokens, [item.question]) > 0.7);
  if (dup) {
    dup.count = (dup.count || 1) + 1;
    await saveDoc(env, UNANSWERED_DOC, list);
    return;
  }
  list.unshift({ id: crypto.randomUUID().slice(0, 8), question, site, count: 1, ts: Date.now() });
  await saveDoc(env, UNANSWERED_DOC, list.slice(0, 100), {
    logChange: `ERA AI got a question it couldn't answer: "${question.slice(0, 80)}"`,
  });
}

// ---------------------------------------------------------------------
// POST /api/era/message  { site, sessionId, message }
// ---------------------------------------------------------------------
export async function handleEraMessage(request, env) {
  const body = await request.json().catch(() => ({}));
  const { site, message } = body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return json({ ok: false, error: "message is required" }, env, 400);
  }
  const trimmed = message.trim().slice(0, 600);

  // 1. live intents — never gated by the learning toggle, these read
  //    current content rather than "learning" anything.
  const liveAnswer = await tryLiveIntent(env, site, trimmed);
  if (liveAnswer) {
    await bumpStats(env);
    return json({ ok: true, reply: liveAnswer, source: "live" }, env);
  }

  // 2. knowledge base (built-in seed + admin-taught entries)
  const taught = await getTaughtKnowledge(env);
  const knowledge = STATIC_KB.concat(taught);
  const queryTokens = tokenize(trimmed);
  let best = null;
  let bestScore = 0;
  for (const entry of knowledge) {
    const score = scoreMatch(queryTokens, entry.questions);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (best && bestScore >= MATCH_THRESHOLD) {
    await bumpStats(env);
    return json({ ok: true, reply: best.answer, source: "kb" }, env);
  }

  // 3. fallback — queue for teaching only if learning is currently on
  const fallback = "I'm not fully sure about that one yet — I've flagged it for the team. For anything urgent, tap Book Now or message us directly and we'll help right away.";
  const settings = await getSettings(env);
  if (settings.learningEnabled !== false) {
    await queueUnanswered(env, site, trimmed);
  }
  await bumpStats(env);
  return json({ ok: true, reply: fallback, source: "fallback" }, env);
}
