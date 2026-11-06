'use strict';

/**
 * The three wallet-experience features for the wallet-enhanced flip
 * shadow model (see docs/flip-wallet-shadow-experiment.md). Computed by
 * tokenPatternStore.js's getWalletExperienceAmong (leakage-safe, using
 * token_holders.captured_at strictly before the current token's own
 * qualifiedAt for any OTHER pair) and attached onto
 * featureSnapshot.context by alertDecision.js's buildFeatureSnapshot,
 * directly alongside the existing walletExposedWalletCount field — same
 * bucket, same null-safe-default-to-0 convention.
 *
 * Field shape matches flipFeatureModel.js's FEATURE_FIELDS exactly
 * ({name, extract, transform}) so a wallet-enhanced model can simply
 * train on FEATURE_FIELDS.concat(WALLET_FEATURE_FIELDS) — see
 * flipWalletShadowModel.js — without flipFeatureModel.js needing to know
 * these three fields exist at all. Kept in their own file rather than
 * appended to flipFeatureModel.js's own FEATURE_FIELDS array specifically
 * so the existing baseline model's feature set (and therefore its
 * trained weights/behavior) cannot be accidentally changed by this work —
 * see flipFeatureModel.js's own header for why FEATURE_FIELDS additions
 * are never made without re-running the ablation script first, a step
 * deliberately out of scope for this shadow-only experiment.
 *
 * TRANSFORM CHOICES — not independently ablated (same "added on
 * reasoning, not yet measured" caveat flipFeatureModel.js's header
 * applies to its own recent additions; re-run
 * analyze-flip-feature-importance.js-style analysis once real shadow
 * data accumulates, don't assume these hold just because the reasoning
 * below is plausible):
 *   - experiencedWalletCount5Plus / experiencedWalletCount10Plus: raw,
 *     not log1p. These are counts of a token's own top holders (top
 *     holder lists are bounded, typically well under 50 entries) that
 *     cross a fixed threshold — small integers, not a heavily
 *     right-skewed monetary/volume-style quantity. Same treatment as
 *     riskFlagCount above, which is the closest existing precedent
 *     (a small bounded count derived from a holder/risk list, not a
 *     market-size figure).
 *   - maxWalletExperience: log1p, not raw. Unlike the two counts above,
 *     this is the SIZE of one wallet's prior-pair history, which is
 *     unbounded in principle and can plausibly span the same kind of
 *     wide range recurringWalletCount already gets log1p treatment for
 *     above (a wallet that's shown up as a top holder on hundreds of
 *     past launches is a genuinely different case from one that's shown
 *     up on 6) — same reasoning, same transform.
 */
const WALLET_FEATURE_FIELDS = [
  {
    name: 'experiencedWalletCount5Plus',
    extract: (r) => r.featureSnapshot?.context?.experiencedWalletCount5Plus,
    transform: 'raw',
  },
  {
    name: 'experiencedWalletCount10Plus',
    extract: (r) => r.featureSnapshot?.context?.experiencedWalletCount10Plus,
    transform: 'raw',
  },
  {
    name: 'maxWalletExperience',
    extract: (r) => r.featureSnapshot?.context?.maxWalletExperience,
    transform: 'log1p',
  },
];

module.exports = { WALLET_FEATURE_FIELDS };
