/**
 * Filters out description text that carries no real narrative signal —
 * launchpad-tool credit lines and vacuous placeholder text — before it
 * ever reaches a Gemini call in backfill-narrative-gemini.js. Every
 * pattern here is anchored to real examples observed in a production
 * sample (see HANDOFF.md), not a guessed list:
 *
 *   "Deployed using https://j7tracker.io"    (appeared verbatim on 2 of
 *   "Launched on discord.gg/uxento"           30 sampled tokens EACH —
 *                                              i.e. a shared launchpad
 *                                              default, not narrative
 *                                              content specific to
 *                                              either token)
 *   "Created on https://rapidlaunch.io"
 *   "memecoin"                                (vacuous — says nothing)
 *   "littleorjao"                             (tautological — just the
 *                                              token's own name)
 *
 * Deliberately conservative: false negatives (boilerplate that slips
 * through to Gemini) cost a few cents and a wasted classification.
 * False positives (real narrative content wrongly filtered out) cost the
 * row a chance at recovery entirely, silently. So every rule here
 * requires the ENTIRE trimmed description to match a short, specific
 * template — not just contain a keyword somewhere — to avoid filtering
 * a real description that happens to mention a deployment tool in
 * passing as one clause of a longer story.
 *
 * A pure function on purpose: this is exported from src/core/ (not
 * scoped inside the backfill script) because the same problem plausibly
 * affects the LIVE Jaccard description classifier too — if
 * descriptionClassifier.js has been minting desc:* categories from this
 * same boilerplate text, that's a real, cheap-to-test contributor to the
 * registry fragmentation HANDOFF.md's item 18 already found (242
 * categories for 299 tokens). Not wired in there this session — that's
 * a separate, deliberate decision, not an oversight — but living here
 * means it can be without moving files later.
 */

// Whole-description launchpad-credit templates. Anchored (^...$) against
// the FULL trimmed text, not a substring match, and length-capped — a
// short credit line, not a real description with a passing mention.
const LAUNCHPAD_CREDIT_PATTERNS = [
  /^(deployed|created|minted|launched)\s+(using|on|via)\s+\S+$/i,
];
const LAUNCHPAD_CREDIT_MAX_LENGTH = 80;

// Exact (case-insensitive, trimmed) vacuous strings that say nothing
// about the token specifically.
const VACUOUS_EXACT_MATCHES = new Set([
  'memecoin',
  'meme coin',
  'coin',
  'token',
  'meme',
  'solana meme',
  'solana memecoin',
  'solana meme coin',
]);

function normalize(text) {
  return text.trim().replace(/\s+/g, ' ');
}

/**
 * @param {string} description - already known to be non-empty; callers
 *   should check that separately (see recovered_description's NULL-vs-''
 *   distinction in schema.sql — this function isn't the place for that).
 * @param {{ name?: string, symbol?: string }} [tokenIdentity] - if
 *   given, also catches a description that's just the token's own
 *   name/symbol repeated back (tautological, e.g. a token named "orjao"
 *   whose entire description is "littleorjao").
 * @returns {boolean}
 */
function isBoilerplateDescription(description, tokenIdentity = {}) {
  const normalized = normalize(description);
  if (normalized.length === 0) return true;

  if (normalized.length <= LAUNCHPAD_CREDIT_MAX_LENGTH) {
    for (const pattern of LAUNCHPAD_CREDIT_PATTERNS) {
      if (pattern.test(normalized)) return true;
    }
  }

  const lower = normalized.toLowerCase();
  if (VACUOUS_EXACT_MATCHES.has(lower)) return true;

  const { name, symbol } = tokenIdentity;
  for (const identity of [name, symbol]) {
    if (identity && lower === identity.trim().toLowerCase()) return true;
    // Catches "littleorjao" against name "orjao" — identity is a
    // substring of a SHORT description with nothing else in it, not
    // identity appearing somewhere inside a real longer description.
    if (identity && normalized.length <= identity.trim().length + 12 && lower.includes(identity.trim().toLowerCase())) return true;
  }

  return false;
}

module.exports = { isBoilerplateDescription };
