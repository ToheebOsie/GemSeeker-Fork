const { median, average } = require('./patternAnalyzer');

/**
 * Turns the pattern-tracking archive (the `pattern_archive` Postgres
 * table — every completed 'rugged'/'survived' token lifecycle) into a
 * self-assessment of how the bot's own BUY/WAIT/SKIP calls actually
 * performed, for the daily/weekly admin reports. No I/O here, same
 * reasoning as patternAnalyzer.js: pure functions are trivial to unit
 * test and reason about independently of storage/network/scheduling
 * concerns.
 *
 * IMPORTANT SCOPE NOTE, on purpose: only tokens enrolled into pattern
 * tracking are ever archived, and enrollment is riskLevel 'Low' OR any
 * WAIT- or BUY-labeled token regardless of risk level (see config.js
 * patternTracking.trackRiskLevels and tokenScanner.js's shouldTrack).
 * So this report — like the historical-pattern alert line it shares data
 * with — reflects that tracked subset only, not every token the bot ever
 * alerted on. That's stated explicitly in the report text rather than
 * left implicit.
 *
 * DEDUPE, found while investigating a real /report bug: pattern_archive
 * has no unique constraint on pair_address, and startPatternReviewLoop's
 * overlap guard (patternReviewer.js's `running` flag) is in-memory and
 * per-process — it stops two overlapping review ticks within one process,
 * but does nothing across two (e.g. a brief window during a redeploy
 * where the old and new instances are both alive). scripts/review-data-
 * quality.js's own duplicate check confirmed this isn't theoretical: 14
 * real pair_address values had 2 archive rows each in production.
 * tokenScanner.js also never excludes an already-archived pair_address
 * from re-qualifying, so not every duplicate is necessarily this race —
 * some could be a genuine second lifecycle for the same pool. Either way,
 * computeSelfAssessment had zero protection against double-counting one
 * token's outcome in both the completed-count and the average ROI, so
 * dedupeByPairAddress runs unconditionally here — safe and correct
 * regardless of which mechanism produced a given duplicate, since a
 * report meant to summarize "how did the bot's calls turn out" should
 * count each pool once no matter how it ended up archived twice. Keeps
 * whichever row has the later archivedAt (getArchive()'s rows arrive
 * ordered by id, so equal-archivedAt ties keep the most recently
 * inserted row) — the most complete/final observation of the two.
 */

function dedupeByPairAddress(records) {
  const latestByPairAddress = new Map();
  for (const record of records) {
    const existing = latestByPairAddress.get(record.pairAddress);
    if (!existing || (typeof record.archivedAt === 'number' && record.archivedAt >= (existing.archivedAt ?? -Infinity))) {
      latestByPairAddress.set(record.pairAddress, record);
    }
  }
  return [...latestByPairAddress.values()];
}

/**
 * Summarizes one BUY/WAIT/SKIP group of archive records into ROI stats.
 * @param {Array} records - archive records already filtered to one label
 */
function summarizeGroup(records) {
  const roiValues = records
    .map((r) => r.peakRoiMultiple)
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);

  const ruggedCount = records.filter((r) => r.outcome === 'rugged').length;
  const survivedCount = records.length - ruggedCount;

  // Phase 8: a finer breakdown than rugged/survived — a rug-timing bucket
  // (immediate-rug through rug-after-24h) for rugged tokens, and within
  // "survived", dead (never moved) vs pump-and-dump (gave most of a real
  // peak back) vs stable-survivor. Older archive records predate this
  // field and won't have it — those fall under 'unclassified' rather than
  // being silently dropped from the count.
  const outcomeDetailBreakdown = records.reduce((acc, r) => {
    const key = r.outcomeDetail || 'unclassified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  // Phase 9: a finer breakdown of *why* the rugged subset rugged —
  // liquidity-pull-rug (LP unlocked) vs distribution-dump-rug (top holder
  // sold off) vs organic-death (neither, both signals verified) vs
  // partial-unknown (neither moved, but only one signal was ever
  // captured) vs unknown-mechanism-no-review (archived before the first
  // review tick ever ran — zero post-enrollment data, a timing gap) vs
  // unknown-mechanism-data-gap (reviewed at least once, Rugcheck still
  // never returned usable data) vs unknown-mechanism-no-checkpoint-data
  // (checkpointCount itself unknown — only reachable via a legacy-JSON
  // migration; see patternAnalyzer.js's classifyRugMechanism for the full
  // distinction). Scoped to rugged records only — rugMechanism is null
  // for survived tokens by construction (see patternAnalyzer.js's
  // classifyRugMechanism), so
  // including the full group here would just dump every survivor into a
  // meaningless 'unclassified' bucket alongside genuinely-unknown rugs.
  const ruggedRecords = records.filter((r) => r.outcome === 'rugged');
  const rugMechanismBreakdown = ruggedRecords.reduce((acc, r) => {
    const key = r.rugMechanism || 'unclassified';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return {
    count: records.length,
    averagePeakRoiMultiple: average(roiValues),
    medianPeakRoiMultiple: median(roiValues),
    ruggedCount,
    survivedCount,
    outcomeDetailBreakdown,
    rugMechanismBreakdown,
  };
}

/**
 * @param {Array} archiveRecords - full contents of pattern_archive.json
 * @param {number} windowMs - how far back to look, measured from `now`
 * @param {number} [now] - defaults to Date.now(), overridable for tests
 * @returns {{
 *   windowMs: number,
 *   windowStart: number,
 *   generatedAt: number,
 *   totalCompleted: number,
 *   buy: object, wait: object, skip: object,
 *   unlabeledCount: number,
 * }}
 */
function computeSelfAssessment(archiveRecords, windowMs, now = Date.now()) {
  const windowStart = now - windowMs;
  const deduped = dedupeByPairAddress(archiveRecords);
  // Windowed on archivedAt (when the token's outcome — rugged/survived —
  // was determined), not qualifiedAt (when it was first alerted). This
  // report is about "how did calls made in this window turn out", i.e.
  // completed lifecycles, so archivedAt is the right clock.
  const inWindow = deduped.filter((r) => typeof r.archivedAt === 'number' && r.archivedAt >= windowStart && r.archivedAt <= now);

  const buyRecords = inWindow.filter((r) => r.signalLabel === 'BUY');
  const waitRecords = inWindow.filter((r) => r.signalLabel === 'WAIT');
  const skipRecords = inWindow.filter((r) => r.signalLabel === 'SKIP');
  const unlabeledCount = inWindow.length - buyRecords.length - waitRecords.length - skipRecords.length;

  return {
    windowMs,
    windowStart,
    generatedAt: now,
    totalCompleted: inWindow.length,
    buy: summarizeGroup(buyRecords),
    wait: summarizeGroup(waitRecords),
    skip: summarizeGroup(skipRecords),
    unlabeledCount,
  };
}

module.exports = {
  average,
  summarizeGroup,
  dedupeByPairAddress,
  computeSelfAssessment,
};
