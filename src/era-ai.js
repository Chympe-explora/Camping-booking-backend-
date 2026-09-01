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
 *   2. KNOWLEDGE BASE — a small built-in set of generic Q&A (including
 *      casual small talk — greetings, thanks, "how are you", jokes,
 *      etc., each with several varied replies so ERA AI doesn't sound
 *      robotic on repeat visits), plus admin-taught entries (see
 *      teachAnswer / teachBulkAnswers below), matched by simple keyword
 *      overlap. Checked first because a confident KB match is usually
 *      better-phrased than raw site text.
 *   3. FULL-SITE SEARCH — every real sentence on the site (title, sub,
 *      descriptions, bios, policy text, everything) PLUS every freeform
 *      "info note" the admin has pasted in (see addAdminNotes below) is
 *      indexed as a "chunk" grouped by whichever section/card it
 *      belongs to. A visitor's question — however it's phrased — is
 *      matched by keyword overlap against that whole index, not just a
 *      hand-picked FAQ list, so any twist on a question whose answer
 *      genuinely exists somewhere on the site (or in something the
 *      admin fed it) can be found, wherever it lives. The site the
 *      visitor is chatting from AND the home/root site are both
 *      indexed, so general company questions work from any page.
 *   4. FALLBACK — if nothing matches confidently, ERA AI gives a graceful
 *      "not sure" reply and (only if learning is enabled) queues the
 *      question so the admin can teach it the right answer from Telegram.
 *
 * TELEGRAM IS THE STORAGE (same pattern as the rest of this backend —
 * see store.js): the knowledge base, admin info notes, unanswered-
 * question queue, and learning on/off flag are all persisted via
 * getDoc/saveDoc.
 *
 * ADMIN BULK TEACHING — the admin can paste an unlimited number of
 * question/answer pairs (or just plain paragraphs of info) from
 * Telegram at any time, in whatever format is natural to paste
 * (`Q:`/`A:` labels, a numbered list, "Question? -- Answer" on one
 * line, or blank-line-separated blocks). parseQABlob() below turns
 * that raw paste into structured pairs, teachBulkAnswers() adds them
 * straight to the knowledge base, and anything that isn't shaped like
 * a question gets kept as a searchable info note via addAdminNotes()
 * instead of being thrown away — so nothing the admin sends is wasted,
 * and there is no limit on how much or how often they feed it. See the
 * "📚 Bulk Teach Q&A" flow / `/teach` command in telegram-bot.js.
 *
 * THE "STOP LEARNING" TOGGLE — what it does and doesn't do:
 *   OFF only pauses ERA AI's passive knowledge growth: new unanswered
 *   questions stop being queued, so nothing new gets added to the
 *   knowledge base on its own. ERA AI keeps answering visitors exactly
 *   as before, using whatever it already knows. An admin can still
 *   manually teach it an answer (single or bulk) at any time — that's
 *   an explicit edit, same as editing site text — the toggle only
 *   affects automatic learning from visitor traffic.
 */

import { SCHEMA_DEFAULTS } from "./content-schema.js";
import { isValidSite, getDoc, saveDoc, deepMerge } from "./store.js";
import { json } from "./booking.js";
import { getOrCreateConversation, saveConversation, getConversation, forwardToTelegram, readOutbox } from "./conversations.js";

const KNOWLEDGE_DOC = "eraKnowledge:global"; // admin-taught Q&A pairs (the "learned" layer)
const SETTINGS_DOC = "eraSettings:global"; // { learningEnabled }
const UNANSWERED_DOC = "eraUnanswered:global"; // queue of questions ERA AI couldn't confidently answer
const NOTES_DOC = "eraNotes:global"; // freeform info the admin has pasted in — not shaped as Q&A, indexed alongside site text for full-site search
const STATS_DOC = "eraStats:global";

const MATCH_THRESHOLD = 0.34;
const CHUNK_MATCH_THRESHOLD = 0.32;

// Keys we never want to treat as visitor-facing content — filenames,
// ids, links, colors, and other structural/asset metadata that lives
// in the same content tree as the actual sentences.
const SKIP_KEYS = new Set([
  "image", "images", "icon", "icons", "id", "ids", "link", "href", "url", "src",
  "color", "colour", "backgroundimage", "logoimage", "logo", "key", "type", "cat",
  "span", "file", "fileid", "path", "route", "action", "callback", "value", "code",
  "currency", "unit", "order", "index", "site", "siteid",
]);

function looksLikeFilenameOrUrl(v) {
  return /\.(jpg|jpeg|png|svg|gif|webp)$/i.test(v) || /^https?:\/\//i.test(v) || /^#?[0-9a-f]{3,8}$/i.test(v);
}

function isContentString(key, value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 3) return false;
  if (looksLikeFilenameOrUrl(v)) return false;
  if (SKIP_KEYS.has(String(key).toLowerCase())) return false;
  if (/^\d+(\.\d+)?$/.test(v)) return false;
  return true;
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "do", "does", "did", "what", "which",
  "who", "whom", "how", "when", "where", "why", "of", "in", "on", "at", "to", "for",
  "and", "or", "with", "about", "can", "could", "would", "should", "will", "i", "you",
  "your", "my", "me", "it", "this", "that", "these", "those", "be", "been", "have",
  "has", "had", "there", "any", "some", "if", "so", "just", "please", "tell", "know",
]);

function meaningfulTokens(s) {
  return tokenize(s).filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

// Walks the whole content tree (an object graph of nested sections,
// objects, and arrays) and turns every real sentence in it into a
// labeled "chunk" — grouped by whichever object it belongs to, so a
// chunk reads as one coherent unit (a card, a section, a policy block)
// rather than one word at a time. This is what lets ERA AI answer from
// ANY part of the site's actual text, not just curated FAQ entries.
function collectContentChunks(node, ancestorLabel, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectContentChunks(item, ancestorLabel, out);
    return;
  }
  const ownStrings = [];
  const childObjects = [];
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (typeof v === "string") {
      if (isContentString(k, v)) ownStrings.push(v);
    } else if (v && typeof v === "object") {
      childObjects.push([k, v]);
    }
  }
  const label = node.title || node.name || node.heading || node.label || ancestorLabel;
  if (ownStrings.length) {
    out.push({ section: label, text: ownStrings.join(". ") });
  }
  for (const [k, v] of childObjects) {
    collectContentChunks(v, humanizeKey(k), out);
  }
}

function buildChunkIndex(content) {
  const chunks = [];
  collectContentChunks(content, "General", chunks);
  return chunks.map((c) => ({ ...c, tokens: new Set(meaningfulTokens(c.section + " " + c.text)) }));
}

function scoreChunk(queryTokens, chunk) {
  if (!queryTokens.length) return 0;
  const matched = queryTokens.filter((t) => chunk.tokens.has(t));
  return matched.length / queryTokens.length;
}

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

  // ---- casual small talk — several varied replies each, picked at
  // random (see pickAnswer), so ERA AI feels like a friendly chat and
  // not a script repeating the same line every time. ----
  {
    id: "c-greet",
    questions: [
      "hi", "hello", "hey", "heya", "hiya", "yo", "hii", "hiii",
      "good morning", "good afternoon", "good evening", "morning", "evening", "namaste",
    ],
    answers: [
      "Hey there! 👋 I'm ERA AI. Ask me anything about the trip — packages, pricing, what to bring, or how booking works.",
      "Hello! 🌿 Great to have you here. What can I help you plan today?",
      "Hey! 😊 I'm around for anything camping, pricing, or booking related — what's up?",
    ],
  },
  {
    id: "c-howareyou",
    questions: ["how are you", "how are you doing", "hows it going", "whats up", "sup", "hows life", "how you doing"],
    answers: [
      "I'm doing great, thanks for asking! 🌿 Ready to help you plan an awesome trip. What's on your mind?",
      "All good here! 😊 What can I help you with today?",
      "Doing well! Excited to help you get sorted for the trip — what do you need?",
    ],
  },
  {
    id: "c-thanks",
    questions: ["thanks", "thank you", "thx", "thankyou", "appreciate it", "ty", "many thanks"],
    answers: [
      "You're very welcome! 🙌 Anything else you'd like to know?",
      "Anytime! 😊 Happy to help.",
      "No problem at all — let me know if you need anything else!",
    ],
  },
  {
    id: "c-bye",
    questions: ["bye", "goodbye", "see you", "see ya", "cya", "ttyl", "bye bye", "gtg"],
    answers: [
      "See you soon! 🌿 Come back anytime you have questions.",
      "Take care! Hope to see you on the trail soon. 🥾",
      "Bye for now! I'll be right here whenever you need me.",
    ],
  },
  {
    id: "c-joke",
    questions: ["tell me a joke", "make me laugh", "say something funny", "know any jokes", "youre funny"],
    answers: [
      "Why don't campers ever get cold? They always sleep near their fans! 😄 Anyway — want to hear about our packages?",
      "I tried cracking a joke about caves once… it fell a bit flat. 😅 Need help with dates or pricing instead?",
    ],
  },
  {
    id: "c-compliment",
    questions: ["you are awesome", "good bot", "nice bot", "you are smart", "you are helpful", "i like you", "youre the best"],
    answers: [
      "Aww, thank you! 🌿 I try my best. Let me know what else you need!",
      "That's really kind! 😊 Happy to keep helping — what's next?",
    ],
  },
  {
    id: "c-bored",
    questions: ["im bored", "i am bored", "entertain me", "im booored"],
    answers: [
      "Let's fix that — ask me 'what packages do you have' and I'll show you something fun to plan around! 🌿",
    ],
  },
  {
    id: "c-isbot",
    questions: ["are you human", "are you real", "are you a real person", "is this a bot", "are you ai", "are you a robot"],
    answers: [
      "I'm ERA AI — a virtual assistant, not a human! 🤖 But I know this trip inside and out, so ask away.",
    ],
  },
  {
    id: "c-okay",
    questions: ["ok", "okay", "cool", "nice", "great", "alright", "got it", "sounds good"],
    answers: [
      "👍 Let me know if you want to dig into packages, pricing, or booking.",
      "Great! I'm here if anything else comes up.",
    ],
  },
];

function pickAnswer(entry) {
  if (entry.answer) return entry.answer;
  if (Array.isArray(entry.answers) && entry.answers.length) {
    return entry.answers[Math.floor(Math.random() * entry.answers.length)];
  }
  return "";
}

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

export async function getAdminNotes(env) {
  return getDoc(env, NOTES_DOC, []);
}

// Freeform info the admin pastes that isn't shaped like a question
// (a paragraph about facilities, a policy update, background on a new
// package, etc). Stored as-is and folded into the full-site search
// index (tier 3) so a visitor's question can match it just like it
// would match real site text — always allowed, same as teachAnswer.
export async function addAdminNotes(env, notes) {
  const clean = (notes || []).map((n) => String(n || "").trim()).filter((n) => n.length > 4);
  if (!clean.length) return 0;
  const list = await getDoc(env, NOTES_DOC, []);
  for (const text of clean) {
    list.unshift({ id: crypto.randomUUID().slice(0, 8), text, addedFrom: "admin-note", ts: Date.now() });
  }
  await saveDoc(env, NOTES_DOC, list.slice(0, 500), {
    logChange: `ERA AI saved ${clean.length} new info note(s) from the admin`,
  });
  return clean.length;
}

// Admin explicitly teaching MANY answers at once — same trust level as
// teachAnswer (single question from the pending queue), just batched
// into one write so pasting 100+ pairs doesn't fire 100+ Telegram
// message edits. Always allowed regardless of the learning toggle.
export async function teachBulkAnswers(env, pairs) {
  const clean = (pairs || []).filter((p) => p && p.question && p.answer);
  if (!clean.length) return 0;
  const knowledge = await getTaughtKnowledge(env);
  for (const p of clean) {
    knowledge.push({
      id: crypto.randomUUID().slice(0, 8),
      questions: [String(p.question).trim()],
      answer: String(p.answer).trim(),
      addedFrom: "admin-bulk",
      ts: Date.now(),
    });
  }
  await saveDoc(env, KNOWLEDGE_DOC, knowledge, {
    logChange: `ERA AI bulk-learned ${clean.length} new Q&A pair(s) from the admin`,
  });
  return clean.length;
}

// ---------------------------------------------------------------------
// Bulk Q&A parsing — lets the admin paste any number of Q&A pairs (or
// even plain informational paragraphs) in one Telegram message, in
// whichever format is natural to type or paste. Anything that isn't
// shaped like a question/answer is kept as a "note" (see
// addAdminNotes) rather than silently dropped, so nothing pasted is
// ever wasted. Supported shapes, freely mixed in the same message:
//   Q: What time is check-in?          1. Do you allow pets?
//   A: 2pm onwards.                    No pets allowed on site.
//
//   Is wifi available? -- Yes, free wifi in common areas.
//
//   (blank-line separated block: first line = question, rest = answer)
// ---------------------------------------------------------------------
const Q_LABEL = /^(?:\d+[).\-:]?\s*)?q(?:uestion)?\s*[:\-–)]\s*(.+)$/i;
const A_LABEL = /^(?:\d+[).\-:]?\s*)?a(?:nswer)?\s*[:\-–)]\s*(.+)$/i;
const INLINE_QA = /^(.{3,}\?)\s*(?:::|=>|--|—|\|)\s*(.+)$/;

export function parseQABlob(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const pairs = [];
  const notes = [];
  let curQ = null;
  let curA = [];
  let noteBuf = [];

  const flushQA = () => {
    if (curQ && curA.length) {
      pairs.push({ question: curQ.trim(), answer: curA.join(" ").trim() });
    } else if (curQ) {
      noteBuf.push(curQ.trim());
    }
    curQ = null;
    curA = [];
  };
  const flushNote = () => {
    if (noteBuf.length) notes.push(noteBuf.join(" ").trim());
    noteBuf = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushQA();
      flushNote();
      continue;
    }

    const inline = line.match(INLINE_QA);
    if (inline) {
      flushQA();
      flushNote();
      pairs.push({ question: inline[1].trim(), answer: inline[2].trim() });
      continue;
    }

    const qMatch = line.match(Q_LABEL);
    if (qMatch) {
      flushQA();
      curQ = qMatch[1];
      continue;
    }

    const aMatch = line.match(A_LABEL);
    if (aMatch && curQ) {
      curA.push(aMatch[1]);
      continue;
    }

    if (!curQ && !curA.length && /\?\s*$/.test(line)) {
      // a bare question line with no "Q:" label — e.g. a numbered list
      // pasted straight from notes ("1. What time is check-in?")
      curQ = line.replace(/^\d+[).\-:]?\s*/, "");
      continue;
    }

    if (curQ) {
      curA.push(line); // multi-line answer, keep collecting until a blank line / next question
    } else {
      noteBuf.push(line);
    }
  }
  flushQA();
  flushNote();

  return { pairs, notes: notes.filter((n) => n.length > 4) };
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
  const notes = await getAdminNotes(env);
  const stats = await getDoc(env, STATS_DOC, { totalMessages: 0 });
  return {
    learningEnabled: settings.learningEnabled !== false,
    pendingCount: unanswered.length,
    knowledgeCount: STATIC_KB.length + knowledge.length,
    notesCount: notes.length,
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

// Builds the searchable index for a visitor's question: everything on
// the site they're currently on, plus the root/home site's content
// (company-level info like About Us, Instagram, WhatsApp number) so
// general questions are answered no matter which page the chat opened
// from.
async function buildSiteIndex(env, site) {
  const sites = new Set(["root"]);
  if (isValidSite(site)) sites.add(site);
  const chunks = [];
  for (const s of sites) {
    const content = await siteContent(env, s);
    chunks.push(...buildChunkIndex(content));
  }
  // Freeform info notes the admin has fed in via Telegram — searchable
  // exactly like real site text, so anything the admin pastes (not
  // just structured Q&A) can surface as an answer.
  const notes = await getAdminNotes(env);
  for (const n of notes) {
    chunks.push({ section: "Admin note", text: n.text, tokens: new Set(meaningfulTokens(n.text)) });
  }
  return chunks;
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
// The tiered answer engine, factored out so it can be reused for a
// visitor's turn without needing to be the one thing that decides
// whether Telegram gets notified — that now always happens, per the
// hybrid spec (see handleEraMessage below).
//
// `context` is the previous visitor question in this conversation (if
// any). When the current message is short or leans on a pronoun ("that",
// "it", "does it include..."), its tokens are folded into tier 2/3
// matching alongside the new message's own tokens, so a short follow-up
// question still has enough to match against (spec §14).
// ---------------------------------------------------------------------
const ANAPHORA = /\b(that|this|it|those|these)\b/i;

async function computeAiReply(env, site, trimmed, context) {
  // 1. live intents — never gated by the learning toggle, these read
  //    current content rather than "learning" anything.
  const liveAnswer = await tryLiveIntent(env, site, trimmed);
  if (liveAnswer) return { reply: liveAnswer, source: "live" };

  const needsContext = context && (meaningfulTokens(trimmed).length < 4 || ANAPHORA.test(trimmed));
  const searchText = needsContext ? `${trimmed} ${context}` : trimmed;

  // 2. knowledge base (built-in seed + admin-taught entries) — curated,
  //    short, well-phrased answers. Checked first because when it has a
  //    confident match, it's usually a nicer answer than raw site text.
  const taught = await getTaughtKnowledge(env);
  const knowledge = STATIC_KB.concat(taught);
  const queryTokens = tokenize(searchText);
  let bestKb = null;
  let bestKbScore = 0;
  for (const entry of knowledge) {
    const score = scoreMatch(queryTokens, entry.questions);
    if (score > bestKbScore) {
      bestKbScore = score;
      bestKb = entry;
    }
  }
  if (bestKb && bestKbScore >= MATCH_THRESHOLD) return { reply: pickAnswer(bestKb), source: "kb" };

  // 3. full-site search — every real sentence on the site (and the home
  //    page) is indexed as a chunk, so a question about ANYTHING that's
  //    actually written on the site gets answered, however it's phrased,
  //    regardless of which section it lives in.
  const meaningfulQueryTokens = meaningfulTokens(searchText);
  if (meaningfulQueryTokens.length) {
    const index = await buildSiteIndex(env, site);
    let ranked = index
      .map((c) => ({ chunk: c, score: scoreChunk(meaningfulQueryTokens, c) }))
      .filter((r) => r.score >= CHUNK_MATCH_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    if (ranked.length) {
      const top = ranked.slice(0, 2).filter((r, i) => i === 0 || r.score >= ranked[0].score - 0.15);
      const seen = new Set();
      const parts = [];
      for (const r of top) {
        if (seen.has(r.chunk.text)) continue;
        seen.add(r.chunk.text);
        parts.push(r.chunk.text);
      }
      return { reply: parts.join("\n\n"), source: "content" };
    }
  }

  // 4. fallback — nothing found. Caller decides what to do about it
  //    (queue for teaching, escalate to Telegram, etc).
  return {
    reply: "I'm not fully sure about that one yet — I've flagged it for the team. For anything urgent, tap Book Now or message us directly and we'll help right away.",
    source: "fallback",
  };
}

// ---------------------------------------------------------------------
// POST /api/era/message  { site, sessionId, message }
// -----------------------------------------------------------------------
// Every visitor turn now does three things, always, regardless of one
// another (per the hybrid spec):
//   1. gets logged against that visitor's conversation
//   2. gets forwarded to Telegram (§2, §9) — the notification never
//      depends on whether ERA could answer it
//   3. gets an AI answer ONLY if the conversation is currently in "ai"
//      mode; in "human"/"paused" mode ERA stays quiet and a guide
//      answers from Telegram instead (§4, §5, §17 — no spamming
//      "please wait" while a human is expected to respond)
// ---------------------------------------------------------------------
export async function handleEraMessage(request, env) {
  const body = await request.json().catch(() => ({}));
  const { site, sessionId: rawSessionId, message } = body || {};

  if (!message || typeof message !== "string" || !message.trim()) {
    return json({ ok: false, error: "message is required" }, env, 400);
  }
  const trimmed = message.trim().slice(0, 600);
  // Defensive fallback if a caller forgets sessionId — conversations
  // still work, they just won't survive a page reload.
  const sessionId = (rawSessionId && String(rawSessionId).slice(0, 64)) || crypto.randomUUID();

  const conversation = await getOrCreateConversation(env, sessionId, site);

  const isNew = conversation.messageCount === 0;
  const reopened = conversation.status === "closed";
  if (reopened) conversation.status = "ai"; // a new message reopens a closed chat

  conversation.messageCount += 1;

  let replyText = null;
  let escalated = false;

  if (conversation.status === "ai") {
    const result = await computeAiReply(env, site, trimmed, conversation.lastQuestion);
    replyText = result.reply;
    escalated = result.source === "fallback";
    if (escalated) {
      conversation.needsHuman = true;
      const settings = await getSettings(env);
      if (settings.learningEnabled !== false) {
        await queueUnanswered(env, site, trimmed);
      }
    }
  }
  // in "human" or "paused" mode: replyText stays null — ERA doesn't
  // auto-answer, a guide is expected to reply from Telegram instead.

  conversation.lastQuestion = trimmed;
  await saveConversation(env, conversation);

  await forwardToTelegram(env, conversation, trimmed, replyText, { isNew, escalated, reopened });
  await bumpStats(env);

  return json({ ok: true, reply: replyText, status: conversation.status, convId: conversation.id }, env);
}

// ---------------------------------------------------------------------
// GET /api/era/poll?site=...&sessionId=...&since=<timestamp>
// -----------------------------------------------------------------------
// The widget polls this while the chat panel is open to pick up
// anything that arrived after the visitor's own message already got
// its response — most commonly a human's reply typed in Telegram.
// ---------------------------------------------------------------------
export async function handleEraPoll(url, env) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return json({ ok: false, error: "sessionId is required" }, env, 400);
  const since = Number(url.searchParams.get("since") || 0);

  const conversation = await getConversation(env, sessionId);
  const messages = await readOutbox(env, sessionId, since);

  return json({ ok: true, status: conversation ? conversation.status : "ai", messages }, env);
}
