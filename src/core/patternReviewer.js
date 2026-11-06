const { patternTracking } = require('../config');
const dexscreenerService = require('../services/dexscreenerService');
const rugcheckService = require('../services/rugcheckService');
const store = require('../storage/tokenPatternStore');
const { buildCategoryKey, deriveOutcomeEnrichment } = require('./patternAnalyzer');
const { withAdvisoryLock, LOCK_IDS } = require('../db/advisoryLock');
const { runtimeTag } = require('../observability/runtimeIdentity');

/**
 * The 3-hourly job: re-check every actively-tracked token's price and
 * safety data, update its all-time-high, and either continue tracking it
 * or archive it (as 'rugged' or 'survived') into the permanent historical
 * dataset patternAnalyzer.js draws statistics from.
 *
 * This intentionally does NOT re-run the market/safety filters from
 * filters.js — a tracked token is being watched precisely because it
 * already passed those once. This job asks three questions: what's its
 * price now, has it crossed the "we're calling this rugged" line, and has
 * it instead held up long enough to call it "survived" (either the fast
 * sustained-threshold path or the maxTrackingAgeMs fallback — see
 * config.js's patternTracking.survivedThreshold/maxTrackingAgeMs).
 */

function findMatchingPair(pairs, pairAddress) {
  return pairs.find((p) => p.pairAddress === pairAddress) || null;
}

/**
 * Re-checks a single tracked token. Returns a small result object for
 * logging/testing rather than throwing on expected "couldn't update this
 * cycle" conditions — those aren't errors, they're routine.
 *
 * @param {object} record - the tracked-token record
 * @param {number} now
 * @param {object|null} [prefetchedPair] - when provided (including
 *   explicitly `null`, meaning "already looked up, no match"), skips the
 *   internal getPairsForToken call and uses this instead. Lets
 *   reviewAllTrackedTokens() batch-resolve every tracked token's pair in
 *   groups of 30 (see dexscreenerService.js's getPairsForTokens) rather
 *   than one HTTP call per token — this function's own standalone
 *   contract (fetch it itself when called directly, e.g. every existing
 *   test that calls reviewToken() on its own) is unchanged either way.
 */
async function reviewToken(record, now = Date.now(), prefetchedPair = undefined) {
  const pair = prefetchedPair !== undefined
    ? prefetchedPair
    : findMatchingPair(await dexscreenerService.getPairsForToken(record.mintAddress), record.pairAddress);

  if (!pair || !pair.priceUsd) {
    // Pair not resolvable this cycle (DexScreener hiccup, or possibly
    // delisted). Conservative choice: skip this cycle rather than guess.
    // A token that's genuinely gone will eventually hit maxTrackingAgeMs
    // and get archived as 'survived' — an admittedly imperfect label for
    // that specific case, but better than recording a fabricated price.
    return { pairAddress: record.pairAddress, action: 'skipped', reason: 'pair not resolvable this cycle' };
  }

  const currentPriceUsd = Number(pair.priceUsd);
  // Same fields tokenScanner.js's normalizePair reads off a DexScreener
  // pair at qualification time — available here too since `pair` comes
  // from the same dexscreenerService.getPairsForToken() call above, it
  // just wasn't being persisted before Tier 2's Feature Extraction needed
  // checkpoint-over-checkpoint buy/volume trend, not just price/safety.
  const txns1h = (pair.txns && pair.txns.h1) || {};
  const volume1h = pair.volume ? Number(pair.volume.h1) || 0 : 0;
  const buys1h = Number(txns1h.buys) || 0;
  const sells1h = Number(txns1h.sells) || 0;

  let topHolderPct = null;
  let lpLockedPct = null;
  let mintAuthorityHeld = null;
  let freezeAuthorityHeld = null;
  try {
    const report = await rugcheckService.getTokenReport(record.mintAddress);
    // AUDIT FIX: pairAddress needed to pick the right pool out of
    // report.markets[] — see rugcheckService.js's extractSafetySignals
    // doc comment for the full "why."
    const safety = rugcheckService.extractSafetySignals(report, record.pairAddress);
    if (safety.available) {
      topHolderPct = safety.topHolderPct;
      lpLockedPct = safety.lpLockedPct;
      // Item 5 (AI-training-pipeline proposal audit) — same already-
      // fetched `safety` object, no extra call.
      mintAuthorityHeld = safety.mintAuthorityHeld;
      freezeAuthorityHeld = safety.freezeAuthorityHeld;
    }
  } catch (err) {
    console.error(`[patternReviewer] rugcheck lookup failed for ${record.baseToken.symbol}: ${err.message} (${runtimeTag()})`);
  }

  const athPriceUsd = Math.max(record.athPriceUsd, currentPriceUsd);
  const athAt = currentPriceUsd >= record.athPriceUsd ? now : record.athAt;

  // Phase 2: append a snapshot row directly rather than building a
  // trimmed array in JS and rewriting it wholesale — see
  // tokenPatternStore.js's appendSnapshot for the pruning/cap behavior.
  await store.appendSnapshot(record.pairAddress, { t: now, priceUsd: currentPriceUsd, topHolderPct, lpLockedPct, volume1h, buys1h, sells1h, mintAuthorityHeld, freezeAuthorityHeld });

  // "Survived" fast path: has price held at/above survivedThreshold.minPctOfAth
  // for an unbroken survivedThreshold.sustainedHours? Recompute the watermark
  // THIS cycle first (using this cycle's own currentPctOfAth reading), then
  // measure the window from it — a dip observed this same cycle must reset
  // the clock to zero, not to whatever it was before this reading.
  const currentPctOfAth = athPriceUsd > 0 ? currentPriceUsd / athPriceUsd : 0;
  const droppedBelowSurvivalThresholdNow = currentPctOfAth < patternTracking.survivedThreshold.minPctOfAth;
  const lastBelowSurvivalThresholdAt = droppedBelowSurvivalThresholdNow
    ? now
    : (record.lastBelowSurvivalThresholdAt ?? null);
  // null lastBelowSurvivalThresholdAt means "never observed below
  // threshold" — measure the sustained window from qualifiedAt in that case.
  const survivedWindowStart = lastBelowSurvivalThresholdAt ?? record.qualifiedAt;
  const isSustainedSurvivor = !droppedBelowSurvivalThresholdNow
    && (now - survivedWindowStart) >= patternTracking.survivedThreshold.sustainedHours * 3_600_000;

  const nextRecord = { ...record, athPriceUsd, athAt, lastPriceUsd: currentPriceUsd, lastCheckedAt: now, lastBelowSurvivalThresholdAt, lastReviewedAt: now };

  const isRugged = athPriceUsd > 0 && currentPriceUsd <= athPriceUsd * patternTracking.rugThresholdPctOfAth;
  const isAgedOut = patternTracking.maxTrackingAgeMs !== null
    && (now - record.qualifiedAt) >= patternTracking.maxTrackingAgeMs;
  // isRugged and isSustainedSurvivor can never both be true on the same
  // cycle: isRugged requires currentPctOfAth <= rugThresholdPctOfAth (1%),
  // which is always < minPctOfAth (50%), so droppedBelowSurvivalThresholdNow
  // is forced true whenever isRugged is true — isSustainedSurvivor's own
  // !droppedBelowSurvivalThresholdNow guard rules it out on that same cycle.

  if (isRugged || isAgedOut || isSustainedSurvivor) {
    const archiveRecord = await buildArchiveRecord(nextRecord, isRugged ? 'rugged' : 'survived', now);
    // Archive-delete + tracked-token-insert run in one transaction so a
    // crash between the two can't leave the token both archived and still
    // tracked (which would re-archive it, duplicated, next review cycle) —
    // and the delete-first/rowCount-gated ordering inside
    // archiveAndRemoveTrackedToken means a concurrent second caller for the
    // same pairAddress loses cleanly instead of also archiving. A null
    // return means that happened here: someone else (another process, or
    // another path within this same cycle) already archived this token —
    // not an error, nothing left to do.
    const inserted = await store.archiveAndRemoveTrackedToken(archiveRecord, record.pairAddress); // snapshot history is preserved past archiving — see schema.sql
    if (!inserted) return { pairAddress: record.pairAddress, action: 'already-archived' };
    return { pairAddress: record.pairAddress, action: 'archived', outcome: archiveRecord.outcome };
  }

  await store.updateTrackedToken(record.pairAddress, nextRecord);
  return { pairAddress: record.pairAddress, action: 'updated', currentPriceUsd, athPriceUsd };
}

async function buildArchiveRecord(record, outcome, archivedAt) {
  const peakRoiMultiple = record.firstPriceUsd > 0 ? record.athPriceUsd / record.firstPriceUsd : null;
  const [checkpointCount, lastKnownSafety] = await Promise.all([
    store.getSnapshotCount(record.pairAddress),
    // AUDIT FIX: was store.getLatestSnapshot(...), i.e. the single most
    // recent snapshot row — including whichever field(s) that specific
    // review cycle's Rugcheck call happened to fail to populate. That
    // silently misclassified rugMechanism as what's now called
    // 'unknown-mechanism-data-gap' for tokens with a perfectly good
    // tracked history whose *final* cycle (often exactly the archiving
    // cycle, since a vanished pool is a plausible cause of both the rug
    // and the Rugcheck miss) just couldn't reach Rugcheck.
    // getLastKnownSafetyReading finds each field's own last non-null
    // value independently instead — see its doc comment in
    // tokenPatternStore.js.
    store.getLastKnownSafetyReading(record.pairAddress),
  ]);

  const base = {
    pairAddress: record.pairAddress,
    mintAddress: record.mintAddress,
    symbol: record.baseToken.symbol,
    name: record.baseToken.name,
    narrativeTag: record.narrativeTag,
    hypeScoreAtQualification: record.hypeScoreAtQualification,
    riskLevelAtQualification: record.riskLevelAtQualification,
    // The BUY/WAIT/SKIP label the AI signal carried at qualification time
    // (see tokenScanner.js). Older records enrolled before this field
    // existed simply won't have it — selfAssessment.js treats a missing
    // label as "unlabeled" rather than guessing.
    signalLabel: record.signalLabel ?? null,
    // Plan A: carried through unchanged from the tracked-token record —
    // computed once at qualification time (tokenScanner.js) and never
    // recomputed here, same reasoning as signalLabel just above. Older
    // records enrolled before this field existed simply won't have it.
    signalStatus: record.signalStatus ?? null,
    // Plan B: same reasoning as signalStatus just above — carried through
    // unchanged from the tracked-token record, never recomputed here.
    narrativeConfidence: record.narrativeConfidence ?? null,
    narrativeMatchMethod: record.narrativeMatchMethod ?? null,
    categoryKey: buildCategoryKey(record.narrativeTag, record.hypeScoreAtQualification),
    qualifiedAt: record.qualifiedAt,
    // See schema.sql's tracked_tokens.pair_created_at comment — carried
    // through unchanged, same reasoning as signalStatus/narrativeConfidence
    // just above.
    pairCreatedAt: record.pairCreatedAt ?? null,
    firstPriceUsd: record.firstPriceUsd,
    athPriceUsd: record.athPriceUsd,
    athAt: record.athAt,
    finalPriceUsd: record.lastPriceUsd,
    peakRoiMultiple,
    outcome, // 'rugged' | 'survived'
    archivedAt,
    timeToRugFromQualificationHours: outcome === 'rugged' ? (archivedAt - record.qualifiedAt) / 3_600_000 : null,
    timeToRugFromAthHours: outcome === 'rugged' ? (archivedAt - record.athAt) / 3_600_000 : null,
    checkpointCount,
    // firstTopHolderPct/firstLpLockedPct are captured once at enrollment
    // (tokenScanner.js) and never overwritten, so they're accurate
    // regardless of how long the token ends up being tracked — same
    // reasoning as the Phase-1-era fix that used to be documented here in
    // more detail; see git history if you need the full "why not
    // checkpoints[0]" explanation.
    firstTopHolderPct: record.firstTopHolderPct ?? null,
    lastTopHolderPct: lastKnownSafety.topHolderPct ?? null,
    firstLpLockedPct: record.firstLpLockedPct ?? null,
    lastLpLockedPct: lastKnownSafety.lpLockedPct ?? null,
    // Item 5 (AI-training-pipeline proposal audit) — same first/last
    // pattern as the top-holder/LP fields just above.
    firstMintAuthorityHeld: record.firstMintAuthorityHeld ?? null,
    lastMintAuthorityHeld: lastKnownSafety.mintAuthorityHeld ?? null,
    firstFreezeAuthorityHeld: record.firstFreezeAuthorityHeld ?? null,
    lastFreezeAuthorityHeld: lastKnownSafety.freezeAuthorityHeld ?? null,
  };

  // Phase 8: derived from the fields already assembled above — see
  // patternAnalyzer.js's deriveOutcomeEnrichment for what each one means
  // and why 'rugged'/'survived' itself stays untouched.
  return { ...base, ...deriveOutcomeEnrichment(base) };
}

/**
 * Reviews every actively-tracked token, one at a time, each isolated in
 * its own try/catch so one bad token can't abort the rest of the batch —
 * same reasoning as the per-token isolation fix in tokenScanner.js.
 *
 * BUG FIX: this used to make one dexscreenerService.getPairsForToken call
 * per tracked token — with tracking now open to any WAIT/BUY-labeled
 * token regardless of risk level (see tokenScanner.js's shouldTrack),
 * that list only grows, and each review cycle was burning one HTTP
 * request per tracked token against the documented 300 req/min DEX/pairs
 * limit. Pairs are now resolved in one batched call per 30 tokens (see
 * dexscreenerService.js's getPairsForTokens) before reviewing any of
 * them, then handed to reviewToken() via its prefetchedPair parameter —
 * same total data, up to 30x fewer requests.
 *
 * AUDIT FOLLOW-UP: as of the earlyLifeWindowMs/earlyLifeReviewIntervalMs
 * addition (config.js), "every actively-tracked token" above is no
 * longer literally every row in tracked_tokens each time this runs — see
 * the dueForReview filter, which reviews young tokens on a faster
 * cadence and older ones on the original reviewIntervalMs cadence. This
 * function is now called on the faster of the two intervals (see
 * startPatternReviewLoop below); the filter is what keeps that from
 * turning into 12x the Rugcheck/DexScreener load on the (much larger)
 * older-token population.
 */
async function reviewAllTrackedTokens() {
  const tracked = await store.getTrackedTokens();
  const results = [];
  const now = Date.now();

  // AUDIT FOLLOW-UP: only actually review tokens that are due, on their
  // OWN cadence — a token younger than earlyLifeWindowMs (since
  // qualifiedAt) is due every earlyLifeReviewIntervalMs, an older one
  // every reviewIntervalMs, same as before this existed. Never reviewed
  // yet (lastReviewedAt null) is always due, regardless of age — that's
  // the exact gap this exists to close (see config.js's comment on
  // earlyLifeWindowMs for the full "why"). This must run BEFORE pair
  // resolution below, not after — the whole point is fewer
  // DexScreener/Rugcheck calls for the (much larger) already-reviewed-
  // recently population, not just fewer reviewToken() calls.
  const dueForReview = tracked.filter((r) => {
    if (!r.lastReviewedAt) return true;
    const age = now - r.qualifiedAt;
    const cadence = age < patternTracking.earlyLifeWindowMs
      ? patternTracking.earlyLifeReviewIntervalMs
      : patternTracking.reviewIntervalMs;
    return (now - r.lastReviewedAt) >= cadence;
  });

  const pairsByMint = new Map(); // mintAddress -> pairs[] (a mint can have multiple pairs across DEXes/pools)
  const mintAddresses = dueForReview.map((r) => r.mintAddress);
  for (const batch of dexscreenerService.chunk(mintAddresses, 30)) {
    try {
      const pairs = await dexscreenerService.getPairsForTokens(batch);
      for (const pair of pairs) {
        const mint = pair && pair.baseToken && pair.baseToken.address;
        if (!mint) continue;
        if (!pairsByMint.has(mint)) pairsByMint.set(mint, []);
        pairsByMint.get(mint).push(pair);
      }
    } catch (err) {
      // Leave this batch's tokens unresolved this cycle rather than
      // falling back to per-token calls — a batch failure (network
      // blip, rate limit) affecting up to 30 tokens shouldn't turn into
      // 30 individual retries; reviewToken's existing "pair not
      // resolvable this cycle" skip handles this the same way a single
      // failed lookup always has.
      console.error(`[patternReviewer] batch pair lookup failed for ${batch.length} token(s): ${err.message}`);
    }
  }

  for (const record of dueForReview) {
    try {
      const prefetchedPair = findMatchingPair(pairsByMint.get(record.mintAddress) || [], record.pairAddress);
      results.push(await reviewToken(record, now, prefetchedPair));
    } catch (err) {
      console.error(`[patternReviewer] review failed for ${record.pairAddress}: ${err.message}`);
      results.push({ pairAddress: record.pairAddress, action: 'error', reason: err.message });
    }
  }
  return results;
}

function startPatternReviewLoop() {
  if (!patternTracking.enabled) {
    console.log('[patternReviewer] patternTracking.enabled is false — review loop not started.');
    return () => {};
  }

  let running = false;
  const tick = async () => {
    // Fast, in-process check first — no DB round trip needed for the
    // common case of this same process's previous tick still running.
    if (running) return;
    running = true;
    try {
      // Cross-process check second — closes the gap `running` can't:
      // a second Railway process (accidental duplicate service, or two
      // replicas of what's meant to be a singleton) running its own
      // tick concurrently against the same database. If another
      // process already holds this lock, skip this tick entirely
      // rather than re-archiving tokens it's already handling — see
      // advisoryLock.js's doc comment for the full reasoning.
      const { skipped } = await withAdvisoryLock(LOCK_IDS.PATTERN_REVIEW_LOOP, async () => {
        const results = await reviewAllTrackedTokens();
        const archived = results.filter((r) => r.action === 'archived');
        if (archived.length > 0) {
          console.log(`[patternReviewer] archived ${archived.length} token(s): ${archived.map((r) => `${r.pairAddress}(${r.outcome})`).join(', ')}`);
        }
      });
      if (skipped) {
        console.log(`[patternReviewer] another process holds the review-loop lock — skipping this tick. (${runtimeTag()})`);
      }
    } catch (err) {
      console.error(`[patternReviewer] review cycle failed: ${err.message} (${runtimeTag()})`);
    } finally {
      running = false;
    }
  };

  tick();
  // AUDIT FOLLOW-UP: the loop itself must wake up on the FASTER of the
  // two cadences, or a young token's earlyLifeReviewIntervalMs is moot —
  // reviewAllTrackedTokens' dueForReview filter is what still holds
  // older tokens to the slower reviewIntervalMs cadence despite this
  // tick rate, same total load on that population as before this
  // existed. If earlyLifeWindowMs is ever set to 0 (feature effectively
  // off), this reduces to exactly the old single-cadence behavior.
  const tickIntervalMs = Math.min(patternTracking.reviewIntervalMs, patternTracking.earlyLifeReviewIntervalMs);
  const handle = setInterval(tick, tickIntervalMs);
  return () => clearInterval(handle);
}

module.exports = {
  reviewToken,
  reviewAllTrackedTokens,
  startPatternReviewLoop,
  buildArchiveRecord, // exported for tests
};
