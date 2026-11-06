'use strict';

/**
 * EDPI wallet POPULATION selection — answers exactly one question, kept
 * deliberately separate from position reconstruction and outcome
 * profiling (see positionLifecycle.js / walletOutcomeProfile.js): "which
 * of this token's wallets should EDPI even look at."
 *
 * WHY TOP HOLDERS, NOT EARLY BUYERS: early buyers (the population
 * early_wallet_activity itself is captured from) mixes in snipers,
 * scalpers, and bots entering only for immediate momentum — none of that
 * is evidence of conviction. A wallet that currently holds a substantial
 * share of the token has, whatever its original entry looked like,
 * committed real capital/exposure to it right now. Top holders are a
 * CURRENT-STATE population; early_wallet_activity remains the data SOURCE
 * this module's callers use to look up those wallets' PAST behavior on
 * OTHER tokens (see positionLifecycle.js) — the two are not the same
 * population and this module is what keeps that distinction real rather
 * than accidental.
 *
 * RANK-THEN-EXCLUDE, NOT EXCLUDE-THEN-RANK: `selectEdpiCandidateWallets`
 * takes the top `topN` holders BY RAW RANK FIRST (LP/pool entries
 * included in that ranking), THEN excludes any of those `topN` that are
 * identifiable infrastructure. This is deliberate, not incidental — an
 * LP holding 40% of supply and sitting at rank #1 should cost the real
 * top-20 population one of its 20 slots (a token whose liquidity is
 * genuinely concentrated in a handful of real wallets past the LP looks
 * different from one where the "top 20" only reaches rank 25 once the
 * LP is skipped). Filtering infrastructure out BEFORE ranking would
 * silently pull in a 21st+-ranked real wallet that was never actually
 * one of the 20 largest holders, changing what "top 20" even means.
 *
 * INFRASTRUCTURE DETECTION REUSES RUGCHECK'S OWN `type` FIELD (via
 * rugcheckService.extractRawTopHolders), the SAME mechanism
 * extractTopHolderWallets already relies on for wallet-clustering's own
 * LP exclusion — see that function's header for the "inferred from
 * third-party example responses, not Rugcheck's own schema docs" caveat,
 * which applies here identically. Deliberately NOT holder-percentage-
 * based: a genuine wallet can legitimately hold a very large share of a
 * token, so `pct` is carried through on every candidate for CONTEXT (a
 * caller/analyst can see it) but is never itself a basis for exclusion —
 * see isInfrastructureHolder's own contract.
 */

const DEFAULT_TOP_N = 20;

/**
 * Whether one raw Rugcheck top-holder entry is identifiable
 * infrastructure (LP/pool/vault/protocol account) rather than a
 * participant wallet. Pure function of the entry's OWN `type` field only
 * — never `pct`, per the spec's explicit "do not use holder percentage
 * alone to identify LPs" instruction. A holder with no `type` at all is
 * treated as a real wallet (Rugcheck's own convention — see
 * rugcheckService.js's extractTopHolderWallets header).
 *
 * @param {{type?: string|null}} rawHolder
 * @returns {boolean}
 */
function isInfrastructureHolder(rawHolder) {
  return Boolean(rawHolder && typeof rawHolder.type === 'string' && rawHolder.type.length > 0);
}

/**
 * @param {Array<{owner:string, pct:number, type?:string|null, insider?:boolean|null}>} rawHolders
 *   - UNFILTERED top-holder entries (rugcheckService.extractRawTopHolders
 *     output, or an equivalent raw shape) — must still include the
 *     `type`-tagged entries for the rank-then-exclude ordering above to
 *     mean anything; passing an already-filtered list just makes this a
 *     no-op slice.
 * @param {{topN?: number}} [options]
 * @returns {{
 *   candidates: Array<{owner:string, pct:number, insider:boolean|null}>,
 *   rawTop: Array<{owner:string, pct:number, type:string|null}>,
 *   excludedInfrastructure: Array<{owner:string, pct:number, type:string|null}>,
 *   rawHolderCount: number,
 *   topN: number,
 * }}
 */
function selectEdpiCandidateWallets(rawHolders, options = {}) {
  const topN = Number.isFinite(options.topN) && options.topN > 0 ? options.topN : DEFAULT_TOP_N;
  const list = Array.isArray(rawHolders) ? rawHolders.filter((h) => h && typeof h.owner === 'string' && h.owner.length > 0) : [];

  // `extractRawTopHolders` preserves Rugcheck's ranked top-holder order.
  // Preserve that order here: raw rank is an input contract, not a rank we
  // recompute from percentage. This keeps the rank-then-exclude rule faithful
  // to the source population even if percentages contain ties/rounding.
  const rawTop = list.slice(0, topN);

  const candidateByOwner = new Map();
  const excludedInfrastructure = [];
  for (const holder of rawTop) {
    const rawRank = rawTop.indexOf(holder) + 1;
    if (isInfrastructureHolder(holder)) {
      excludedInfrastructure.push({ owner: holder.owner, pct: Number(holder.pct) || 0, type: holder.type ?? null, rawRank });
    } else if (!candidateByOwner.has(holder.owner)) {
      // A wallet identity is scored once even if the upstream holder list
      // contains duplicate associated-account rows. Keep rawTop/rawHolderCount
      // intact so population accounting remains auditable.
      candidateByOwner.set(holder.owner, {
        owner: holder.owner,
        pct: Number(holder.pct) || 0,
        insider: typeof holder.insider === 'boolean' ? holder.insider : null,
        rawRank,
      });
    }
  }
  const candidates = [...candidateByOwner.values()];

  return {
    candidates,
    rawTop: rawTop.map((h, index) => ({ owner: h.owner, pct: Number(h.pct) || 0, type: h.type ?? null, rawRank: index + 1 })),
    excludedInfrastructure,
    rawHolderCount: list.length,
    topN,
  };
}

/**
 * Live hot-path integration point, mirroring edpiLive.js's own
 * attachEdpiLiveResult exactly (same signature shape, same "own
 * try/catch, `null` is a clean no-op" contract) — tokenScanner.js calls
 * this the same way it calls that one. Adds ONE new key,
 * `evidence.edpiWalletSelection`; never touches anything else on the
 * evidence object.
 */
function attachEdpiWalletSelectionResult(evidence, selectionResult) {
  try {
    if (selectionResult) evidence.edpiWalletSelection = selectionResult;
  } catch (error) {
    console.error(`[edpiWalletSelection] attachEdpiWalletSelectionResult failed, continuing without it: ${error.message}`);
  }
  return evidence;
}

module.exports = {
  DEFAULT_TOP_N,
  isInfrastructureHolder,
  selectEdpiCandidateWallets,
  attachEdpiWalletSelectionResult,
};
