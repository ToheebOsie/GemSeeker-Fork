/**
 * Fallback narrative classifier for tokens that don't match any hand-curated
 * rule in narrativeClassifier.js's NARRATIVE_RULES (i.e. classifyNarrative
 * returned FALLBACK_TAG / 'uncategorized'). This is what tokenScanner.js
 * falls through to in that case — see its integration there. It NEVER runs
 * ahead of the curated rules and never overrides a real theme match.
 *
 * Why 'uncategorized' matters enough to fix: it's directly what feeds
 * category_key (see patternAnalyzer.js's buildCategoryKey), which is the
 * unit every historical prediction, "similar past tokens" lookup, and
 * per-category admin stat is grouped by. A token landing in
 * 'uncategorized' isn't a cosmetic gap — it's a token whose outcome data
 * never contributes to (or benefits from) any narrative-specific pattern.
 *
 * Two matching paths, both against a persisted registry of previously-seen
 * description-derived categories (see description_categories in
 * schema.sql; the registry itself is loaded/persisted by the caller —
 * everything in this module is a pure function, deliberately DB-free, so
 * it's directly unit-testable):
 *
 *   1. Token HAS a description: extract its significant keywords and
 *      compare (Jaccard similarity over the keyword sets) against every
 *      existing registry entry's keyword set. A score at or above
 *      SIMILARITY_THRESHOLD joins that existing category (token_count
 *      increments, caller's job). Below threshold against everything ->
 *      mints a brand new category, labeled from this description's own
 *      top keyword(s). Two tokens with byte-identical descriptions
 *      trivially score 1.0 against each other's keyword sets, so
 *      "identical descriptions -> same class" falls out of this same
 *      mechanism rather than needing a separate exact-match code path —
 *      as does "similar keywords and context", by the same comparison at
 *      a lower (but still high-bar) score.
 *
 *   2. Token has NO description: nothing to extract keywords from, so
 *      instead compare its name+symbol text directly against every
 *      registry entry's sample_token_name using character-trigram
 *      similarity (word-level Jaccard is close to useless on 1-2 word
 *      token names — trigram overlap is the standard technique for
 *      short-string "lexical similarity", e.g. spelling-correction /
 *      near-duplicate detection). At or above NAME_SIMILARITY_THRESHOLD ->
 *      joins that category. Below threshold against everything -> stays
 *      'uncategorized' entirely; there's nothing to name a new category
 *      FROM without a description, so minting one here isn't possible,
 *      only joining an existing one is.
 *
 *   These are deliberately two separate constants, not one shared bar.
 *   NAME_SIMILARITY_THRESHOLD is lower (0.6 vs 0.7) because it's the only
 *   path that can ever apply to a historical archive row (there's no
 *   description text stored for old tokens to run path 1 against at
 *   all — see backfill-description-narrative.js's own header for why),
 *   and real near-miss data pulled from production justified loosening
 *   it specifically for that path. That evidence says nothing about
 *   whether path 1's bar over real description text is calibrated
 *   right — it hasn't been tested, so it hasn't moved.
 *
 * Boilerplate short-circuit (wired in this session — see HANDOFF.md item
 * 22): before path 1 ever extracts keywords from a description, it's
 * checked against descriptionBoilerplateFilter.js's isBoilerplateDescription
 * — the same launchpad-credit-line / vacuous-text filter
 * backfill-narrative-gemini.js already runs ahead of its Gemini calls. A
 * description that's ENTIRELY "Deployed using https://j7tracker.io" or
 * "memecoin" carries no real signal to extract keywords FROM, and worse,
 * feeding it through anyway would let two unrelated tokens that happen to
 * share the same launchpad's default credit line get Jaccard-matched into
 * the SAME category purely because they both used the same tool — a false
 * merge, not a real narrative connection. A boilerplate description is
 * treated exactly like a missing one: falls through to path 2 (name-
 * similarity), never mints a new desc:* category from boilerplate text.
 * This is a plausible, cheap-to-fix contributor to the registry
 * fragmentation item 18 found (242 categories for only 299 tokens joined)
 * — not confirmed as the dominant cause, just a real gap that's now closed
 * rather than left open on the "flagged, not done" footing it shipped
 * under last session.
 */

const { isBoilerplateDescription } = require('./descriptionBoilerplateFilter');

const SIMILARITY_THRESHOLD = 0.7; // Jaccard description-path only — see below for why this didn't move alongside NAME_SIMILARITY_THRESHOLD.
const NAME_SIMILARITY_THRESHOLD = 0.6; // trigram name-path — lowered from 0.7 per _diagnostic_description_near_miss.js run against production (HANDOFF.md item 18): real near-misses in 0.60-0.69 (Pumpfun/PumpFun rebrand, "Bungalu"/"Bani The Odyssean Elephant" character-series pair) judged genuinely same-concept by eye, while the nearest false-positive case (SpaceXcoin/SexCoin, coincidental substring overlap) sits safely below at 0.417 — so 0.60 recovers those without crossing into the false-positive's territory. Deliberately NOT applied to SIMILARITY_THRESHOLD above: that diagnostic only ever exercised the trigram path (the only one historical backfill rows can use at all, per this file's own top comment on why), so it's evidence about name-matching specifically, not about whether Jaccard's bar over real description text needs the same treatment — moving both on name-only evidence would be an unvalidated change dressed up as a validated one.

// Generic filler that would otherwise dominate almost every category label
// and every keyword set — either plain English stopwords, or words so
// common across Solana meme/utility tokens specifically that they carry no
// distinguishing signal (every third token's description says "community"
// or "the next generation of Solana").
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by',
  'from', 'up', 'about', 'into', 'over', 'after', 'this', 'that', 'these',
  'those', 'it', 'its', 'as', 'we', 'our', 'you', 'your', 'their', 'they',
  'will', 'can', 'not', 'no', 'all', 'more', 'most', 'first', 'new',
  'token', 'coin', 'crypto', 'cryptocurrency', 'project', 'community',
  'solana', 'blockchain', 'meme', 'memecoin', 'ecosystem', 'platform',
  'next', 'generation', 'best', 'join', 'welcome', 'official',
]);

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} text raw description (or any free text)
 * @param {{ minLength?: number, maxKeywords?: number }} [opts]
 * @returns {string[]} significant keywords, most-frequent first, deduped
 */
function extractKeywords(text, opts = {}) {
  const minLength = opts.minLength ?? 3;
  const maxKeywords = opts.maxKeywords ?? 8;

  const words = normalizeText(text).split(' ').filter((w) => w.length >= minLength && !STOPWORDS.has(w));
  if (words.length === 0) return [];

  const counts = new Map();
  for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) // frequency desc, then alphabetical for a stable tie-break
    .slice(0, maxKeywords)
    .map(([w]) => w);
}

/**
 * Jaccard similarity between two keyword sets: |intersection| / |union|.
 * Both empty -> 0 (not 1 — two descriptions with no extractable signal
 * shouldn't be treated as "identical", that's just "we don't know").
 */
function keywordJaccardSimilarity(keywordsA, keywordsB) {
  const setA = new Set(keywordsA);
  const setB = new Set(keywordsB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function charTrigrams(text) {
  const normalized = normalizeText(text).replace(/\s/g, ''); // trigrams span word boundaries too, deliberately - short token names rarely have >1 real word
  if (normalized.length < 3) return normalized.length === 0 ? new Set() : new Set([normalized]);
  const trigrams = new Set();
  for (let i = 0; i <= normalized.length - 3; i++) trigrams.add(normalized.slice(i, i + 3));
  return trigrams;
}

/**
 * Character-trigram Jaccard similarity between two short strings — used
 * for the no-description name-matching fallback, where word-level
 * comparison would be meaningless.
 */
function charTrigramSimilarity(textA, textB) {
  const setA = charTrigrams(textA);
  const setB = charTrigrams(textB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Derives a new category's label from its own keywords: top keywords,
 * hyphen-joined, prefixed 'desc:' so a description-derived category is
 * always visibly distinct from a hand-curated NARRATIVE_RULES tag in any
 * report/admin stat that lists narrativeTag or category_key — this is a
 * fallback tier, not a silent equal to a reviewed, deliberate rule.
 *
 * Starts from the top min(2, keywords.length) keywords — 1 for a
 * single-keyword input, 2 otherwise — but widens to more (then falls back
 * to a numeric suffix) if that collides with an EXISTING category key.
 * Without this, two clusters whose full keyword sets are quite different
 * (e.g. only ~30% Jaccard overlap — well under the join threshold this
 * module uses everywhere else) but happen to share just their top 2 words
 * would silently derive the identical label. classifyByDescription would
 * then report `isNew: true` for the second one (correctly, per the real
 * similarity check), but the INSERT the caller runs from that is an
 * `ON CONFLICT DO NOTHING` against an already-existing row — a silent
 * no-op that leaves token_count wrong and quietly merges two clusters
 * that were never actually judged similar enough to merge.
 *
 * @param {string[]} keywords
 * @param {Set<string>} [existingKeys] categoryKeys already in the registry
 */
function deriveCategoryLabel(keywords, existingKeys = new Set()) {
  if (!keywords || keywords.length === 0) return null;

  // Starts from min(2, keywords.length), not a hardcoded 2 — a
  // single-keyword input (extractKeywords legitimately returns just one
  // word once STOPWORDS has filtered out "coin"/"token"/"community"/etc.
  // from a short description) must still get its natural `desc:${word}`
  // candidate tried before falling to the numeric-suffix fallback below.
  // AUDIT FIX: the old `n = 2` start meant `2 <= keywords.length` was
  // never true for a 1-keyword input, so it fell straight into the
  // "pathological, every candidate collided" branch with zero real
  // candidates ever tried — producing e.g. 'desc:dragon-2' against a
  // completely empty registry, where no collision was possible at all.
  for (let n = Math.min(2, keywords.length); n <= keywords.length; n++) {
    const candidate = `desc:${keywords.slice(0, n).join('-')}`;
    if (!existingKeys.has(candidate)) return candidate;
  }
  // Every extracted keyword, in full, still collides (pathological —
  // realistically means the registry already has this exact keyword set
  // under a category that similarity-matching itself somehow missed).
  // Numeric suffix guarantees a unique key rather than silently merging.
  const base = `desc:${keywords.slice(0, 2).join('-')}`;
  let suffix = 2;
  while (existingKeys.has(`${base}-${suffix}`)) suffix++;
  return `${base}-${suffix}`;
}

/**
 * @param {{ description?: string, name?: string, symbol?: string }} token
 * @param {Array<{ categoryKey: string, keywords: string[], sampleTokenName: string }>} existingCategories
 *   the current description_categories registry, as loaded by the caller
 * @returns {{ categoryKey: string, keywords: string[], isNew: boolean, matchedVia: 'description'|'name-similarity' } | null}
 *   null means: no description, and nothing in the registry was similar
 *   enough by name either — still 'uncategorized', caller should not call
 *   this a match. Never returns a description-path match below
 *   SIMILARITY_THRESHOLD or a name-path match below
 *   NAME_SIMILARITY_THRESHOLD.
 */
function classifyByDescription(token, existingCategories) {
  const description = token?.description;
  const nameText = `${token?.symbol || ''} ${token?.name || ''}`.trim();

  const hasUsableDescription = description
    && normalizeText(description).length > 0
    // Boilerplate ("Deployed using X", "memecoin", the token's own name
    // repeated back) carries no real narrative signal to extract keywords
    // from — treated as if no description existed at all, so it falls
    // through to the name-similarity path below instead of either minting
    // a junk desc:* category or Jaccard-matching two unrelated tokens
    // that just happen to share a launchpad's default credit line.
    && !isBoilerplateDescription(description, { name: token?.name, symbol: token?.symbol });

  if (hasUsableDescription) {
    const keywords = extractKeywords(description);
    if (keywords.length > 0) {
      let best = null;
      for (const existing of existingCategories) {
        const score = keywordJaccardSimilarity(keywords, existing.keywords);
        if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
          best = { score, existing };
        }
      }
      if (best) {
        // Plan B: surfaces the Jaccard score already computed just
        // above rather than discarding it — see
        // classifyRugMechanismDetail in patternAnalyzer.js for the
        // analogous rug-mechanism-side change and the reasoning behind
        // exposing internally-computed-but-previously-thrown-away
        // numbers like this one.
        return { categoryKey: best.existing.categoryKey, keywords, isNew: false, matchedVia: 'description', confidence: best.score };
      }
      const label = deriveCategoryLabel(keywords, new Set(existingCategories.map((c) => c.categoryKey)));
      if (label) {
        // No existing category scored above threshold, so a NEW one is
        // being minted here — there's no "how similar is this to an
        // existing bucket" score to report, a genuinely different
        // situation from the two matched-an-existing-category cases
        // below, not just a missing number. confidence: null (present
        // and explicit) rather than the key being silently absent, so a
        // consumer can tell "not applicable" apart from "forgot to set
        // this."
        return { categoryKey: label, keywords, isNew: true, matchedVia: 'description', confidence: null };
      }
    }
  }

  // No usable description (missing, or nothing but stopwords) — fall back
  // to matching this token's own name/symbol against the registry's
  // representative names. Can only ever JOIN an existing category, never
  // mint one — there's no description text here to derive a new label from.
  if (nameText.length > 0) {
    let best = null;
    for (const existing of existingCategories) {
      const score = charTrigramSimilarity(nameText, existing.sampleTokenName);
      if (score >= NAME_SIMILARITY_THRESHOLD && (!best || score > best.score)) {
        best = { score, existing };
      }
    }
    if (best) {
      // Plan B: same treatment as the description-Jaccard match above —
      // trigram score was already computed, just include it.
      return { categoryKey: best.existing.categoryKey, keywords: best.existing.keywords, isNew: false, matchedVia: 'name-similarity', confidence: best.score };
    }
  }

  return null;
}

module.exports = {
  SIMILARITY_THRESHOLD,
  NAME_SIMILARITY_THRESHOLD,
  normalizeText,
  extractKeywords,
  keywordJaccardSimilarity,
  charTrigramSimilarity,
  deriveCategoryLabel,
  classifyByDescription,
};
