/**
 * Classifies a token's "narrative" (dog-themed, AI-themed, political, etc.)
 * from its name/symbol using simple keyword matching.
 *
 * Deliberately NOT an AI call: this runs once per qualifying token and once
 * per 3-hourly review, so keeping it free/instant/dependency-free matters.
 * It's also fully transparent — anyone can read the rule that fired, rather
 * than trying to reverse-engineer a model's reasoning. Trade-off: it will
 * miss narratives that don't show up as a recognizable word in the name or
 * symbol, and everything that matches no rule falls into 'uncategorized'.
 * (See src/services/socialSignals.js and SCRAPERS.md for a complementary,
 * richer signal that reads a token's description/socials rather than just
 * its name/symbol — a separate "Social Score" feature, off by default.)
 *
 * To extend: add a new { tag, keywords } entry to NARRATIVE_RULES. Order
 * matters — the first matching rule wins, so put more specific rules above
 * more general ones (e.g. a 'political' rule for a specific figure's name
 * should sit above a broad 'animal' catch-all if their name also contains
 * an animal word).
 */

const NARRATIVE_RULES = [
  { tag: 'dog-themed', keywords: ['dog', 'doge', 'shiba', 'inu', 'puppy', 'pup', 'corgi', 'husky', 'retriever'] },
  { tag: 'cat-themed', keywords: ['cat', 'kitty', 'kitten', 'meow', 'neko'] },
  { tag: 'frog-themed', keywords: ['pepe', 'frog', 'toad', 'froggy'] },
  { tag: 'ai-themed', keywords: ['ai', 'gpt', 'agent', 'neural', 'llm', 'bot', 'robot', 'skynet'] },
  { tag: 'political', keywords: ['trump', 'biden', 'election', 'maga', 'potus', 'president', 'senate', 'congress'] },
  { tag: 'celebrity', keywords: ['elon', 'musk', 'kanye', 'mrbeast', 'kardashian'] },
  { tag: 'rwa', keywords: ['rwa', 'tokenized', 'realestate', 'treasury', 'realworldasset'] },
  { tag: 'defi', keywords: ['defi', 'yield', 'lend', 'lending', 'stake', 'staking', 'amm', 'vault'] },
  { tag: 'l2', keywords: ['l2', 'rollup', 'layer2', 'zk', 'optimistic', 'zkrollup'] },
  { tag: 'infrastructure', keywords: ['infra', 'infrastructure', 'validator', 'l1', 'layer1', 'oracle', 'node'] },
  { tag: 'utility', keywords: ['utility', 'payments', 'paymaster'] },
  { tag: 'space-themed', keywords: ['mars', 'galaxy', 'cosmos', 'astronaut', 'alien', 'saturn', 'nasa'] },
  { tag: 'anime-themed', keywords: ['anime', 'manga', 'waifu', 'senpai', 'kawaii', 'naruto', 'otaku'] },
  { tag: 'tiktok-meme', keywords: ['tiktok', 'fyp', 'viral'] },
  { tag: 'religion', keywords: ['jesus', 'church', 'holy'] },
  { tag: 'country', keywords: ['usa', 'america', 'murica', 'japan', 'india'] },
  { tag: 'tech-satire', keywords: ['satire', 'parody', 'copium'] },
  { tag: 'finance-meme', keywords: ['moon', 'lambo', 'rocket', 'wagmi', 'ngmi', 'fomo', 'chad', 'wojak'] },
  { tag: 'gaming', keywords: ['game', 'gaming', 'quest', 'arena', 'battle', 'rpg'] },
  { tag: 'food-themed', keywords: ['pizza', 'burger', 'taco', 'sushi', 'donut', 'candy', 'cookie'] },
  { tag: 'sports', keywords: ['football', 'soccer', 'basketball', 'nba', 'nfl', 'fifa', 'olympics'] },
];

// Optional, best-effort SUB-category layer — e.g. Primary: ai-themed,
// Sub-category: "AI Companion". Deliberately shallow (a handful of rules
// for the narratives it's most useful to break down further) rather than a
// full second taxonomy: this is display/context only, it is NEVER used for
// risk gating, pattern-tracking category keys, or anything the self-
// assessment stats key on — only the primary `tag` above is. Returns null
// (never a guess) when nothing matches, and formatters simply omit the
// line rather than showing a fabricated sub-category.
const SUB_NARRATIVE_RULES = {
  'ai-themed': [
    { subTag: 'AI Companion', keywords: ['companion', 'waifu', 'friend', 'girlfriend', 'boyfriend'] },
    { subTag: 'AI Agent', keywords: ['agent', 'agentic', 'autonomous'] },
  ],
  'dog-themed': [
    { subTag: 'Shiba Lineage', keywords: ['shiba', 'inu'] },
  ],
  political: [
    { subTag: 'US Politics', keywords: ['trump', 'biden', 'maga', 'potus', 'senate', 'congress'] },
  ],
};

const FALLBACK_TAG = 'uncategorized';

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Precompiled once at module load, not per-call: each rule's keywords are
// combined into a single regex.
//
// FIXED: this used to be `haystack.includes(kw)` — plain substring
// matching. Short/common keywords collided with unrelated words constantly:
// 'ai' matched inside CHAIN, PAIN, RAIN, MAIN, AIRDROP, SPAIN; 'cat' matched
// inside VACATION, EDUCATION, CATEGORY, DELICATE. Since this classification
// feeds directly into the historical ROI/rug-time statistics shown to
// users, those false matches were quietly polluting the 'ai-themed' and
// 'cat-themed' buckets with unrelated tokens and skewing the numbers.
//
// Using `\b` word boundaries would fix that, but breaks a different real
// case: ticker suffixes like 'DOGE2' or 'PEPE3' are extremely common in
// memecoin naming (sequels/parodies of a popular token), and `\b` treats
// digits as word characters — 'doge' followed directly by '2' has no
// boundary between them, so 'doge2' would NOT match `\bdoge\b`. Instead,
// `(?<![a-z])keyword(?![a-z])` blocks a match only when directly adjacent
// to another LETTER (i.e. actually part of a different word) while still
// allowing a match adjacent to a digit, punctuation, space, or string edge.
const COMPILED_RULES = NARRATIVE_RULES.map((rule) => ({
  tag: rule.tag,
  pattern: new RegExp(`(?<![a-z])(${rule.keywords.map(escapeRegExp).join('|')})(?![a-z])`),
}));

const SUB_COMPILED_RULES = Object.fromEntries(
  Object.entries(SUB_NARRATIVE_RULES).map(([tag, rules]) => [
    tag,
    rules.map((rule) => ({
      subTag: rule.subTag,
      pattern: new RegExp(`(?<![a-z])(${rule.keywords.map(escapeRegExp).join('|')})(?![a-z])`),
    })),
  ]),
);

// FIXED: 'cat' and 'ai' used to be written as '\bcat\b' / '\bai\b' inside
// this array, on the assumption that '\b' meant regex word-boundary. It
// doesn't, inside a plain string literal — '\b' is the JS escape for the
// BACKSPACE control character (charCode 8), so those two keywords were
// silently `<BS>cat<BS>` / `<BS>ai<BS>`, which can never appear in a real
// token name and never matched anything. Escaping it correctly as '\\b'
// wouldn't have fixed it either: escapeRegExp() above escapes every
// backslash it sees (it has to, for keywords that might contain real
// regex metacharacters), which would turn an intentional '\b' into a
// literal backslash-then-b match instead of a boundary. Short version:
// don't hand-roll regex syntax into individual keyword strings here — the
// (?<![a-z])...(?![a-z]) wrapper above already applies boundary logic to
// every keyword uniformly, correctly, and with the DOGE2/PEPE3
// digit-adjacency behavior described above. Plain words only.

/**
 * @param {{ symbol?: string, name?: string }} baseToken
 * @returns {string} narrative tag, e.g. 'dog-themed' or 'uncategorized'
 */
function classifyNarrative(baseToken) {
  const haystack = `${baseToken?.symbol || ''} ${baseToken?.name || ''}`.toLowerCase();
  if (!haystack.trim()) return FALLBACK_TAG;

  for (const rule of COMPILED_RULES) {
    if (rule.pattern.test(haystack)) {
      return rule.tag;
    }
  }
  return FALLBACK_TAG;
}

/**
 * @param {string} primaryTag result of classifyNarrative()
 * @param {{ symbol?: string, name?: string }} baseToken
 * @returns {string|null} a more specific sub-category label, or null if
 *   none of the (intentionally sparse) sub-rules for this primary tag hit
 */
function classifySubNarrative(primaryTag, baseToken) {
  const rules = SUB_COMPILED_RULES[primaryTag];
  if (!rules) return null;
  const haystack = `${baseToken?.symbol || ''} ${baseToken?.name || ''}`.toLowerCase();
  if (!haystack.trim()) return null;
  for (const rule of rules) {
    if (rule.pattern.test(haystack)) return rule.subTag;
  }
  return null;
}

module.exports = {
  classifyNarrative,
  classifySubNarrative,
  NARRATIVE_RULES, // exported so tests (and you) can inspect/extend the rule set directly
  SUB_NARRATIVE_RULES,
  FALLBACK_TAG,
};
