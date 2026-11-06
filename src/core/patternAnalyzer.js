const { patternTracking } = require('../config');
const {
  delta, trendLabel, TOP_HOLDER_PCT_TREND_EPSILON, LP_LOCKED_PCT_TREND_EPSILON,
} = require('./featureExtraction');

/**
 * Pure logic for turning a token's hype score into a coarse bucket label,
 * and archived (completed) token records into category-level statistics
 * and predictions. No I/O here — the caller (patternReviewer.js /
 * tokenScanner.js) is responsible for loading archive data from storage and
 * passing it in. Keeping this pure makes it trivial to unit test and to
 * reason about independently of storage/network concerns.
 */

/**
 * @param {number} hypeScore
 * @returns {string} bucket label, e.g. 'strong-hype'
 */
function bucketHypeScore(hypeScore) {
  const bucket = patternTracking.hypeScoreBuckets.find(
    (b) => hypeScore >= b.min && hypeScore < b.max,
  );
  return bucket ? bucket.label : 'unbucketed';
}

/**
 * Same bucketing idea as bucketHypeScore, applied to a completed token's
 * peak ROI multiple (Phase 8).
 * @param {number|null} peakRoiMultiple
 * @returns {string} bucket label, e.g. '2x-5x', or 'unbucketed' if not a valid positive number
 */
function bucketPeakRoi(peakRoiMultiple) {
  if (typeof peakRoiMultiple !== 'number' || !Number.isFinite(peakRoiMultiple) || peakRoiMultiple < 0) return 'unbucketed';
  const bucket = patternTracking.peakRoiBuckets.find(
    (b) => peakRoiMultiple >= b.min && peakRoiMultiple < b.max,
  );
  return bucket ? bucket.label : 'unbucketed';
}

/**
 * Phase 8: a finer-grained outcome label than the base 'rugged'/'survived'
 * distinction, derived entirely from fields already computed for the
 * archive record — no new tracking signals needed. This is an ADDITIONAL
 * field, not a replacement: 'rugged'/'survived' itself is left untouched
 * everywhere it's already used (predictForCategory's ruggedCount/
 * survivedCount tallies below depend on those exact string values).
 *
 * @param {{ outcome: string, peakRoiMultiple: number|null, timeToRugFromQualificationHours: number|null, athPriceUsd: number|null, finalPriceUsd: number|null }} record
 * @returns {'immediate-rug'|'rug-within-3h'|'rug-within-6h'|'rug-within-12h'|'rug-within-24h'|'rug-after-24h'|'rug-timing-unknown'|'dead'|'pump-and-dump'|'stable-survivor'}
 */
function classifyOutcomeDetail(record) {
  const cfg = patternTracking.outcomeDetail;

  if (record.outcome === 'rugged') {
    const hours = record.timeToRugFromQualificationHours;
    // 'rug-timing-unknown', not the generic 'unclassified' fallback
    // selfAssessment.js/reportFormatter.js use elsewhere — that string is
    // reserved for records where outcomeDetail itself was never computed
    // (pre-Phase-8 data). This is a different, narrower case: outcomeDetail
    // WAS computed, the record just doesn't have a usable
    // timeToRugFromQualificationHours to bucket by (e.g. missing
    // qualifiedAt on very old migrated records). Conflating the two would
    // hide a real data-quality distinction behind one vague label.
    if (typeof hours !== 'number' || !Number.isFinite(hours)) return 'rug-timing-unknown';
    const bucket = cfg.rugTimingBuckets.find((b) => hours < b.maxHours);
    // Unreachable in practice (the last bucket's maxHours is Infinity,
    // so it always matches), but falling back to that same last bucket's
    // label rather than throwing keeps this safe if the config array is
    // ever edited down to a shorter, finite-only list.
    return bucket ? bucket.label : cfg.rugTimingBuckets[cfg.rugTimingBuckets.length - 1].label;
  }

  // outcome === 'survived' from here on. 'dead' and 'pump-and-dump' are
  // mutually exclusive by construction (dead requires a low peak,
  // pump-and-dump requires a high one), so order between these two checks
  // doesn't matter — checking 'dead' first just avoids computing
  // retracement for a token that obviously never went anywhere.
  const peak = record.peakRoiMultiple;
  if (typeof peak !== 'number' || !Number.isFinite(peak) || peak < cfg.deadMaxPeakMultiple) {
    return 'dead';
  }

  const retracementPct = (typeof record.athPriceUsd === 'number' && record.athPriceUsd > 0 && typeof record.finalPriceUsd === 'number')
    ? (1 - record.finalPriceUsd / record.athPriceUsd) * 100
    : 0;
  if (peak >= cfg.pumpAndDumpMinPeakMultiple && retracementPct >= cfg.pumpAndDumpMinRetracementPct) {
    return 'pump-and-dump';
  }

  return 'stable-survivor';
}

/**
 * Phase 9: WHY a 'rugged' token rugged, derived from the same
 * firstTopHolderPct/lastTopHolderPct/firstLpLockedPct/lastLpLockedPct
 * fields already assembled onto the archive record (buildArchiveRecord in
 * patternReviewer.js) — no new tracking signals needed here either, same
 * as classifyOutcomeDetail above. This is an ADDITIONAL field
 * (`rugMechanism`), not a replacement for `outcomeDetail`'s rug-timing
 * bucket (immediate-rug / rug-within-3h / .../ rug-after-24h) — the two
 * are orthogonal (how fast vs by what mechanism) and a record carries
 * both.
 *
 * Only meaningful for outcome === 'rugged'; returns null for 'survived'
 * records, since "what mechanism caused the rug" doesn't apply to a token
 * that never crossed the rug threshold.
 *
 * Reuses featureExtraction.js's trendLabel/delta/epsilon exports rather
 * than redefining "what counts as a meaningful move" a second time — see
 * that module's own doc comment for why this stays deliberately simple
 * (plain first-vs-latest deltas, not a fitted trend).
 *
 * @param {{ outcome: string, firstTopHolderPct: number|null, lastTopHolderPct: number|null, firstLpLockedPct: number|null, lastLpLockedPct: number|null, checkpointCount: number|null|undefined, firstMintAuthorityHeld: boolean|null|undefined, lastMintAuthorityHeld: boolean|null|undefined, firstFreezeAuthorityHeld: boolean|null|undefined, lastFreezeAuthorityHeld: boolean|null|undefined }} record
 * @returns {'liquidity-pull-rug'|'distribution-dump-rug'|'mint-authority-rug'|'freeze-authority-rug'|'organic-death'|'partial-unknown'|'unknown-mechanism-no-review'|'unknown-mechanism-data-gap'|'unknown-mechanism-no-checkpoint-data'|null}
 */
function classifyRugMechanism(record) {
  if (record.outcome !== 'rugged') return null;

  const lpLockedPctDelta = delta(record.lastLpLockedPct, record.firstLpLockedPct);
  const topHolderPctDelta = delta(record.lastTopHolderPct, record.firstTopHolderPct);
  const lpLockTrend = trendLabel(lpLockedPctDelta, LP_LOCKED_PCT_TREND_EPSILON, 'locking_more', 'unlocking');
  const topHolderTrend = trendLabel(topHolderPctDelta, TOP_HOLDER_PCT_TREND_EPSILON, 'accumulating', 'distributing');

  // LP unlocking is the more direct, more deliberate signal — a creator
  // pulling previously-locked liquidity — so it's checked first. A token
  // that both unlocked LP and saw its top holder distribute still gets
  // tagged by the more actionable of the two mechanisms.
  if (lpLockTrend === 'unlocking') return 'liquidity-pull-rug';
  if (topHolderTrend === 'distributing') return 'distribution-dump-rug';

  // Item 5 (AI-training-pipeline proposal audit, HANDOFF.md): a direct
  // on-chain fact — mint/freeze authority was held (not renounced) at
  // some point during this token's tracked lifetime — checked next.
  // Lower priority than the two checks just above: those are DIRECTLY
  // OBSERVED behavior (liquidity actually moved, holdings actually
  // shifted), while this is a standing CAPABILITY that may or may not
  // have been exercised, so a real observed movement still wins when
  // both are present. But it's a meaningfully better answer than
  // 'organic-death'/'unknown-mechanism-*' below when neither of the
  // above triggered — a mint-then-dump or a freeze-then-drain doesn't
  // necessarily show up as classic LP-unlock or top-holder-
  // concentration movement, so without this check those cases would
  // silently fall through to "no idea why it rugged" despite there
  // being a real, known, sufficient explanation available.
  //
  // firstXHeld / lastXHeld combined with OR, not just first: SPL
  // authority revocation is one-way and permanent (held -> revoked is
  // possible; revoked -> held never is — it can't be re-acquired once
  // given up), so a `true` reading at EITHER checkpoint is equally
  // valid evidence the authority was live for at least part of the
  // tracked window. This also means a token whose FIRST reading failed
  // (Rugcheck unavailable right at qualification, a common gap for a
  // very fast rug — see the checkpointCount === 0 case below) can still
  // get credit for a later successful reading instead of losing the
  // signal entirely.
  if (record.firstMintAuthorityHeld === true || record.lastMintAuthorityHeld === true) return 'mint-authority-rug';
  if (record.firstFreezeAuthorityHeld === true || record.lastFreezeAuthorityHeld === true) return 'freeze-authority-rug';

  // Fail closed on missing data rather than silently calling it "organic":
  // if there's no first-vs-latest safety reading at all (e.g. Rugcheck was
  // unavailable for this token's entire tracked lifetime), that's "we
  // don't know," a different claim than "we checked and neither mechanism
  // moved."
  //
  // AUDIT FOLLOW-UP (D): split further, into honestly-different "we don't
  // know" situations that used to collapse into one label —
  // checkpointCount === 0 means zero snapshot rows exist at all for this
  // token (it archived before its very first review tick ever ran; see
  // config.js's earlyLifeWindowMs comment for the review-cadence gap
  // that causes this — enrollToken never writes a snapshot, only
  // reviewToken does). That's a TIMING gap, the common case for a fast
  // rug, and one A's early-life review cadence directly shrinks over
  // time. checkpointCount >= 1 here means the token WAS reviewed at
  // least once and Rugcheck still never returned a usable
  // topHolderPct/lpLockedPct either time — a genuine DATA gap, not a
  // timing one, and not something reviewing sooner would have fixed.
  //
  // AUDIT FIX: a plain `checkpointCount === 0 ? no-review : data-gap`
  // ternary silently mapped checkpointCount === undefined/null onto
  // 'data-gap' — asserting "this token WAS reviewed at least once,"
  // a claim this function has no basis to make when it doesn't actually
  // know the count. The only real path to that (verified against every
  // call site in the codebase, not assumed): scripts/migrate.js's
  // one-time legacy-JSON migration, for archive records that predate
  // checkpointCount existing as a tracked concept at all (patternReviewer.js's
  // live archiving path always supplies a real number via
  // store.getSnapshotCount, which returns 0, never null/undefined).
  // Genuinely not knowing the count is a third, distinct epistemic state
  // from "know it's 0" and "know it's >=1" — neither existing label is
  // honestly supportable without guessing, so it gets its own label
  // rather than silently picking one of the two more specific (and
  // therefore overclaiming) options.
  //
  // Neither -no-review, -data-gap, nor -no-checkpoint-data should ever be
  // read as "checked and saw nothing move" — that claim is reserved for
  // 'organic-death' below, where both signals were genuinely captured.
  if (lpLockTrend === null && topHolderTrend === null) {
    if (record.checkpointCount === 0) return 'unknown-mechanism-no-review';
    if (typeof record.checkpointCount === 'number') return 'unknown-mechanism-data-gap';
    return 'unknown-mechanism-no-checkpoint-data';
  }

  // AUDIT FOLLOW-UP: exactly one signal known (and flat/non-triggering),
  // the other never captured at all — 'organic-death' would silently
  // imply "we checked both, neither moved," when really only one of the
  // two was ever checked. Distinguishing this from the fully-confident
  // 'organic-death' case below keeps the label honest about how much was
  // actually verified, same fail-closed spirit as the unknown-mechanism-*
  // labels above, just for the half-known case rather than the
  // fully-unknown one.
  if (lpLockTrend === null || topHolderTrend === null) return 'partial-unknown';

  return 'organic-death';
}

/**
 * Plan B: classifyRugMechanism's bare-string return can't change shape
 * (it's asserted with `assert.strictEqual` against a plain string in 15
 * places in test/regression.test.js — verified by actually grepping for
 * every call site before choosing this design, not assumed). This wraps
 * it instead of touching it, adding a confidence tier and the raw
 * evidence (the exact deltas/checkpointCount classifyRugMechanism itself
 * already computes and throws away) for callers that want more than the
 * label alone — deriveOutcomeEnrichment stores both alongside the
 * unchanged `rugMechanism` field.
 *
 * confidence is a statement about how much was actually VERIFIED, not
 * about how "good" or "bad" the outcome was:
 *   - HIGH: a real signal was genuinely captured — liquidity-pull-rug,
 *     distribution-dump-rug, and organic-death from two independently
 *     captured behavioral readings; mint-authority-rug/freeze-
 *     authority-rug from a direct, unambiguous on-chain fact (item 5,
 *     AI-training-pipeline proposal audit) rather than an inference.
 *   - MEDIUM: only one signal was ever captured (partial-unknown).
 *   - NONE: neither signal was ever captured, for any of the three
 *     reasons classifyRugMechanism itself distinguishes (no review ever
 *     happened, reviewed but Rugcheck had nothing, or the checkpoint
 *     count itself is unknown) — see evidence.checkpointCount to tell
 *     those apart, same as classifyRugMechanism's own label does.
 *   - null: mechanism is null too (a 'survived' record — the question
 *     doesn't apply).
 *
 * @param {Parameters<typeof classifyRugMechanism>[0]} record
 * @returns {{ mechanism: ReturnType<typeof classifyRugMechanism>, confidence: 'HIGH'|'MEDIUM'|'NONE'|null, evidence: { lpLockedPctDelta: number|null, topHolderPctDelta: number|null, checkpointCount: number|null|undefined, firstMintAuthorityHeld: boolean|null, lastMintAuthorityHeld: boolean|null, firstFreezeAuthorityHeld: boolean|null, lastFreezeAuthorityHeld: boolean|null } }}
 */
function classifyRugMechanismDetail(record) {
  const mechanism = classifyRugMechanism(record);
  const confidence = {
    'liquidity-pull-rug': 'HIGH',
    'distribution-dump-rug': 'HIGH',
    // Item 5 (AI-training-pipeline proposal audit): HIGH, same tier as
    // the two above — this is backed by a direct, unambiguous on-chain
    // fact (a real pubkey present or genuinely absent), not an inference.
    'mint-authority-rug': 'HIGH',
    'freeze-authority-rug': 'HIGH',
    'organic-death': 'HIGH',
    'partial-unknown': 'MEDIUM',
    'unknown-mechanism-no-review': 'NONE',
    'unknown-mechanism-data-gap': 'NONE',
    'unknown-mechanism-no-checkpoint-data': 'NONE',
  }[mechanism] ?? null;
  return {
    mechanism,
    confidence,
    evidence: {
      // Recomputed here rather than threaded out of classifyRugMechanism
      // (which keeps them private/internal) — delta() is a pure, cheap
      // function of exactly the same two record fields each time, so
      // this can never disagree with what classifyRugMechanism itself
      // used to decide the label; it's the same inputs through the same
      // function, not a second, potentially-divergent computation.
      lpLockedPctDelta: delta(record.lastLpLockedPct, record.firstLpLockedPct),
      topHolderPctDelta: delta(record.lastTopHolderPct, record.firstTopHolderPct),
      checkpointCount: record.checkpointCount,
      // Item 5 (AI-training-pipeline proposal audit) — raw values, not a
      // derived delta like the two above (delta doesn't make sense for a
      // one-way boolean the way it does for a percentage): callers can
      // see exactly what was read at each checkpoint, same transparency
      // as the two fields above.
      firstMintAuthorityHeld: record.firstMintAuthorityHeld ?? null,
      lastMintAuthorityHeld: record.lastMintAuthorityHeld ?? null,
      firstFreezeAuthorityHeld: record.firstFreezeAuthorityHeld ?? null,
      lastFreezeAuthorityHeld: record.lastFreezeAuthorityHeld ?? null,
    },
  };
}

/**
 * How long a token took to reach its all-time-high from qualification —
 * the roadmap's "time to peak" (Phase 8/11 both want this; it's cheap
 * enough to compute now rather than waiting for Phase 11's fuller
 * lifecycle engine).
 * @returns {number|null}
 */
function timeToAthFromQualificationHours(athAt, qualifiedAt) {
  if (typeof athAt !== 'number' || typeof qualifiedAt !== 'number') return null;
  return (athAt - qualifiedAt) / 3_600_000;
}

/**
 * Bundles the three Phase 8 derived fields into one call, so
 * patternReviewer.js (new archive records) and scripts/migrate.js
 * (backfilling old JSON archive records that predate these fields) share
 * exactly one derivation instead of two copies that could drift.
 */
function deriveOutcomeEnrichment(record) {
  // Plan B: classifyRugMechanismDetail calls classifyRugMechanism
  // internally, so this is one call, not two — rugMechanism below is
  // exactly what a direct classifyRugMechanism(record) call would have
  // returned, unchanged in value or shape from before this existed.
  const rugMechanismDetail = classifyRugMechanismDetail(record);
  return {
    outcomeDetail: classifyOutcomeDetail(record),
    rugMechanism: rugMechanismDetail.mechanism,
    rugMechanismConfidence: rugMechanismDetail.confidence,
    rugMechanismEvidence: rugMechanismDetail.evidence,
    peakRoiBucket: bucketPeakRoi(record.peakRoiMultiple),
    timeToAthFromQualificationHours: timeToAthFromQualificationHours(record.athAt, record.qualifiedAt),
  };
}

/**
 * The category key a token is grouped under for pattern-matching purposes:
 * narrative + hype tier. Two tokens with the same narrative but very
 * different hype at qualification time behave differently enough (a
 * "moderate-hype dog-themed" token and a "very-strong-hype dog-themed"
 * token are not really the same kind of bet) that lumping them together
 * would blur the statistics.
 *
 * @param {string} narrativeTag
 * @param {number} hypeScore
 * @returns {string} e.g. 'dog-themed:strong-hype'
 */
function buildCategoryKey(narrativeTag, hypeScore) {
  return `${narrativeTag}:${bucketHypeScore(hypeScore)}`;
}

function average(numbers) {
  if (numbers.length === 0) return null;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function median(numbers) {
  if (numbers.length === 0) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Aggregates every archived record matching `categoryKey` into summary
 * statistics. Returns `null` (not a low-confidence guess) if the sample
 * size is below patternTracking.minSampleSizeForPrediction — a prediction
 * built from 1-2 historical tokens is noise, not a statistic, and showing
 * one anyway would misrepresent confidence to whoever reads the alert.
 *
 * @param {string} categoryKey
 * @param {Array} archiveRecords - full contents of pattern_archive.json
 * @returns {{
 *   categoryKey: string,
 *   sampleSize: number,
 *   medianPeakRoiMultiple: number,
 *   medianTimeToRugFromAthHours: number,
 *   ruggedCount: number,
 *   survivedCount: number,
 * } | null}
 */
function predictForCategory(categoryKey, archiveRecords) {
  const matches = archiveRecords.filter((r) => r.categoryKey === categoryKey);
  if (matches.length < patternTracking.minSampleSizeForPrediction) return null;

  const roiMultiples = matches
    .map((r) => r.peakRoiMultiple)
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);

  // Separate from the array used for the median-time-to-rug calc:
  // ruggedCount must reflect every rugged record, including ones missing
  // a valid timeToRugFromAthHours (e.g. migrated JSON records with old/bad
  // data). Reusing the timeToRugFromAthHours-filtered array here silently
  // miscounted those as "survived" — see selfAssessment.js for the same
  // (correct) pattern this now follows.
  const ruggedCount = matches.filter((r) => r.outcome === 'rugged').length;
  const timeToRugHours = matches
    .filter((r) => r.outcome === 'rugged' && typeof r.timeToRugFromAthHours === 'number')
    .map((r) => r.timeToRugFromAthHours);

  return {
    categoryKey,
    sampleSize: matches.length,
    medianPeakRoiMultiple: median(roiMultiples),
    medianTimeToRugFromAthHours: median(timeToRugHours),
    ruggedCount,
    survivedCount: matches.length - ruggedCount,
  };
}

module.exports = {
  bucketHypeScore,
  bucketPeakRoi,
  classifyOutcomeDetail,
  classifyRugMechanism,
  classifyRugMechanismDetail,
  timeToAthFromQualificationHours,
  deriveOutcomeEnrichment,
  buildCategoryKey,
  predictForCategory,
  average,
  median, // exported for tests
};
