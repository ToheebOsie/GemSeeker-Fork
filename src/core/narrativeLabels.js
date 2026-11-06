// Display labels for narrative tags — split out into its own module (no
// dependencies) because both alertFormatter.js and narrativeFormatter.js
// need it, and alertFormatter.js already needs to be requirable BY
// narrativeFormatter.js (for escapeMarkdown) — requiring narrativeFormatter.js
// back from alertFormatter.js would create a circular require.
const NARRATIVE_LABELS = {
  'dog-themed': 'Dog Meme',
  'cat-themed': 'Cat Meme',
  'frog-themed': 'Frog Meme',
  'ai-themed': 'AI',
  political: 'Political',
  celebrity: 'Celebrity',
  rwa: 'RWA',
  defi: 'DeFi',
  l2: 'L2',
  infrastructure: 'Infrastructure',
  utility: 'Utility',
  'space-themed': 'Space',
  'anime-themed': 'Anime',
  'tiktok-meme': 'TikTok Meme',
  religion: 'Religion',
  country: 'Country',
  'tech-satire': 'Tech Satire',
  'finance-meme': 'Finance Meme',
  gaming: 'Gaming',
  'food-themed': 'Food Meme',
  sports: 'Sports',
  uncategorized: 'Uncategorized',
};

function narrativeLabel(tag) {
  return NARRATIVE_LABELS[tag] || tag;
}

/**
 * Resolves free-text user input (e.g. from /insightshistory's argument) to
 * a canonical narrative tag, or null if it doesn't match anything. Tries,
 * in order:
 *   1. The tag itself, case/whitespace-insensitive with spaces/underscores
 *      folded to hyphens — "Dog-Themed", "dog themed", "dog_themed" all
 *      resolve to "dog-themed".
 *   2. The display label, case-insensitive — "Dog Meme" also resolves to
 *      "dog-themed".
 * NARRATIVE_LABELS' keys cover every tag narrativeClassifier.js's
 * NARRATIVE_RULES can produce, plus FALLBACK_TAG 'uncategorized' — but NOT
 * the dynamically-minted 'desc:*' tags descriptionClassifier.js can now
 * also assign (see tokenScanner.js's fallback wiring). Those tags DO
 * appear in market_state_daily and /insights' full list just fine
 * (narrativeLabel() below falls back to the raw tag string for anything
 * unrecognized), but an admin can't currently type one into
 * /insightshistory to drill into its trend history — this function has no
 * way to validate a tag it was never told about without a DB round-trip,
 * which its callers currently assume it doesn't need. Worth fixing if
 * /insightshistory on a desc: category turns out to matter in practice;
 * not done here to keep this change scoped to the classifier itself.
 */
function resolveNarrativeTag(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const asTag = trimmed.toLowerCase().replace(/[\s_]+/g, '-');
  if (NARRATIVE_LABELS[asTag]) return asTag;

  const lowerInput = trimmed.toLowerCase();
  const byLabel = Object.entries(NARRATIVE_LABELS).find(
    ([, label]) => label.toLowerCase() === lowerInput,
  );
  return byLabel ? byLabel[0] : null;
}

module.exports = { NARRATIVE_LABELS, narrativeLabel, resolveNarrativeTag };
