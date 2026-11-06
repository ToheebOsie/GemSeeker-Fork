const { median } = require('./patternAnalyzer');

/**
 * "Market Memory" layer, per SUGGESTIONS_FOR_BOT.docx — everything here is
 * pure aggregation over data this codebase already stores (the pattern
 * archive + currently tracked tokens), the same way patternAnalyzer.js's
 * predictForCategory works. No new external calls, no new storage: this is
 * a second, complementary way of reading the SAME "store data and learn
 * from it" pipeline patternTracking/patternAnalyzer.js already implements
 * — narrativeIntelligence.js doesn't touch how data is stored or archived,
 * it only adds new ways of summarizing what's already there.
 *
 * Terminology from the doc:
 *   - "Token Memory" = patternAnalyzer.js's per-token prediction/matching
 *     (predictForCategory, findKnownAccumulatorWallets) — already existed.
 *   - "Market Memory" = the narrative-level functions below: which
 *     narratives are hot right now, which are rotating up/down, and how
 *     they've trended week over week.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function withinLastDays(timestampMs, days, now) {
  return typeof timestampMs === 'number' && (now - timestampMs) <= days * DAY_MS;
}

/**
 * Every token that has EVER entered tracking in the last `days` days,
 * whether it's still actively tracked or has since been archived —
 * narrative heat/rotation are about "how much is qualifying right now,"
 * which both sets answer together (an archived-yesterday token was still
 * a qualification event this week).
 */
function collectRecentQualifications(archiveRecords, trackedRecords, days, now) {
  const fromArchive = archiveRecords.filter((r) => withinLastDays(r.qualifiedAt, days, now));
  const fromTracked = trackedRecords.filter((r) => withinLastDays(r.qualifiedAt, days, now));
  return [...fromArchive, ...fromTracked];
}

/**
 * "Narrative Heat" — how much qualification activity + hype each narrative
 * is generating right now, folded into a single 0-10 number per narrative
 * for the bar-chart display the doc shows under a proposed /narratives
 * command.
 *
 * Combines two real, available signals:
 *   - recent qualification COUNT for the narrative, relative to whichever
 *     narrative had the most (so the busiest narrative always anchors at
 *     the top of the scale, rather than an arbitrary fixed count),
 *   - the median hypeScoreAtQualification of those same qualifications.
 * 60/40 weighting toward count over hype — a narrative producing MANY
 * qualifications is "hot" even at moderate hype, whereas a single
 * very-high-hype qualification alone shouldn't read as an entire narrative
 * trending.
 *
 * @param {Array} archiveRecords - tokenPatternStore.getArchive()
 * @param {Array} trackedRecords - tokenPatternStore.getTrackedTokens()
 * @param {{ windowDays?: number, now?: number }} [opts]
 * @returns {Array<{ narrativeTag: string, heat: number, qualificationCount: number, medianHypeScore: number|null }>}
 *   sorted by heat, descending
 */
function getNarrativeHeat(archiveRecords, trackedRecords, opts = {}) {
  const windowDays = opts.windowDays ?? 7;
  const now = opts.now ?? Date.now();
  const recent = collectRecentQualifications(archiveRecords, trackedRecords, windowDays, now);

  const byNarrative = new Map();
  for (const record of recent) {
    if (!byNarrative.has(record.narrativeTag)) byNarrative.set(record.narrativeTag, []);
    byNarrative.get(record.narrativeTag).push(record);
  }
  if (byNarrative.size === 0) return [];

  const maxCount = Math.max(...Array.from(byNarrative.values()).map((records) => records.length));

  const rows = Array.from(byNarrative.entries()).map(([narrativeTag, records]) => {
    const hypeScores = records.map((r) => r.hypeScoreAtQualification).filter((n) => typeof n === 'number');
    const medianHypeScore = median(hypeScores);
    const normalizedCount = maxCount > 0 ? records.length / maxCount : 0;
    const hypeComponent = medianHypeScore !== null ? medianHypeScore / 10 : 0;
    const heat = Math.round((normalizedCount * 6 + hypeComponent * 4) * 10) / 10;
    return {
      narrativeTag,
      heat,
      qualificationCount: records.length,
      medianHypeScore,
    };
  });

  return rows.sort((a, b) => b.heat - a.heat);
}

/**
 * "Narrative Rotation" — % change in qualification volume for each
 * narrative between the last `windowDays` and the `windowDays` before
 * that. Deliberately uses qualification COUNT, not ROI, as the rotation
 * metric: it's available immediately for every qualifying token (not just
 * ones that have finished their lifecycle), which is what makes a
 * "last 7 days" rotation view possible at all.
 *
 * A narrative with 0 qualifications in the prior window and >0 now is
 * reported as `null` % change (mathematically undefined, not "+Infinity%")
 * — still sorted to the top as a "new" narrative via `isNew: true`.
 *
 * @returns {Array<{ narrativeTag: string, currentCount: number,
 *   previousCount: number, pctChange: number|null, isNew: boolean }>}
 *   sorted by pctChange descending (nulls/new narratives first, then
 *   biggest gainers, ties broken by currentCount)
 */
function getNarrativeRotation(archiveRecords, trackedRecords, opts = {}) {
  const windowDays = opts.windowDays ?? 7;
  const now = opts.now ?? Date.now();

  const currentWindow = collectRecentQualifications(archiveRecords, trackedRecords, windowDays, now);
  const all = collectRecentQualifications(archiveRecords, trackedRecords, windowDays * 2, now);
  const previousWindowCutoffStart = now - windowDays * 2 * DAY_MS;
  const previousWindowCutoffEnd = now - windowDays * DAY_MS;
  const previousWindow = all.filter(
    (r) => r.qualifiedAt >= previousWindowCutoffStart && r.qualifiedAt < previousWindowCutoffEnd,
  );

  const narrativeTags = new Set([
    ...currentWindow.map((r) => r.narrativeTag),
    ...previousWindow.map((r) => r.narrativeTag),
  ]);

  const rows = Array.from(narrativeTags).map((narrativeTag) => {
    const currentCount = currentWindow.filter((r) => r.narrativeTag === narrativeTag).length;
    const previousCount = previousWindow.filter((r) => r.narrativeTag === narrativeTag).length;
    const isNew = previousCount === 0 && currentCount > 0;
    const pctChange = previousCount > 0
      ? Math.round(((currentCount - previousCount) / previousCount) * 1000) / 10
      : null;
    return {
      narrativeTag, currentCount, previousCount, pctChange, isNew,
    };
  });

  return rows.sort((a, b) => {
    if (a.pctChange === null && b.pctChange === null) return b.currentCount - a.currentCount;
    if (a.pctChange === null) return -1;
    if (b.pctChange === null) return 1;
    return b.pctChange - a.pctChange;
  });
}

/**
 * "Narrative Evolution" — average peak ROI multiple per narrative, broken
 * out week by week for the trailing `weeks` weeks. Deliberately archive-
 * only (unlike heat/rotation above): peakRoiMultiple is only meaningful
 * once a token's lifecycle is actually finished (rugged or survived past
 * the tracking window) — an actively-tracked token's "ROI so far" isn't
 * comparable to a completed one's peak, so mixing them in would quietly
 * bias the average toward whatever partial data young tokens happen to
 * have.
 *
 * @param {Array} archiveRecords - tokenPatternStore.getArchive()
 * @param {{ weeks?: number, now?: number }} [opts]
 * @returns {Array<{ weekStart: number, weekEnd: number, narratives:
 *   Array<{ narrativeTag: string, avgPeakRoiMultiple: number, sampleSize: number }> }>}
 *   ordered oldest week first; each week's `narratives` sorted by
 *   avgPeakRoiMultiple descending
 */
function getNarrativeEvolution(archiveRecords, opts = {}) {
  const weeks = opts.weeks ?? 4;
  const now = opts.now ?? Date.now();
  const weekMs = 7 * DAY_MS;

  const result = [];
  for (let i = weeks - 1; i >= 0; i -= 1) {
    const weekEnd = now - i * weekMs;
    const weekStart = weekEnd - weekMs;
    const recordsThisWeek = archiveRecords.filter(
      (r) => r.qualifiedAt >= weekStart && r.qualifiedAt < weekEnd
        && typeof r.peakRoiMultiple === 'number' && Number.isFinite(r.peakRoiMultiple),
    );

    const byNarrative = new Map();
    for (const record of recordsThisWeek) {
      if (!byNarrative.has(record.narrativeTag)) byNarrative.set(record.narrativeTag, []);
      byNarrative.get(record.narrativeTag).push(record.peakRoiMultiple);
    }

    const narratives = Array.from(byNarrative.entries())
      .map(([narrativeTag, rois]) => ({
        narrativeTag,
        avgPeakRoiMultiple: Math.round((rois.reduce((sum, v) => sum + v, 0) / rois.length) * 100) / 100,
        sampleSize: rois.length,
      }))
      .sort((a, b) => b.avgPeakRoiMultiple - a.avgPeakRoiMultiple);

    result.push({ weekStart, weekEnd, narratives });
  }
  return result;
}

/**
 * Monthly (or any window) narrative leaderboard — the "assessment for the
 * top ten narratives that month" the doc asks for. Archive-only, same
 * reasoning as getNarrativeEvolution above. Ranked by median peak ROI, but
 * ONLY among narratives clearing `minSampleSize` — an unranked narrative
 * with 1-2 archived tokens isn't a statistic, same principle
 * patternAnalyzer.js's predictForCategory already applies per-category.
 *
 * @returns {Array<{ narrativeTag: string, tokensTracked: number,
 *   medianPeakRoiMultiple: number, avgTimeToPeakHours: number|null,
 *   rugRate: number, survivalOver30DaysRate: number }>} top `limit`, sorted
 *   by medianPeakRoiMultiple descending
 */
function getMonthlyNarrativeAssessment(archiveRecords, opts = {}) {
  const days = opts.days ?? 30;
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? 10;
  const minSampleSize = opts.minSampleSize ?? 3;

  const recordsInWindow = archiveRecords.filter((r) => withinLastDays(r.qualifiedAt, days, now));
  const byNarrative = new Map();
  for (const record of recordsInWindow) {
    if (!byNarrative.has(record.narrativeTag)) byNarrative.set(record.narrativeTag, []);
    byNarrative.get(record.narrativeTag).push(record);
  }

  const rows = [];
  for (const [narrativeTag, records] of byNarrative.entries()) {
    if (records.length < minSampleSize) continue;

    const rois = records.map((r) => r.peakRoiMultiple).filter((n) => typeof n === 'number' && Number.isFinite(n));
    const timesToPeakHours = records
      .filter((r) => typeof r.athAt === 'number' && typeof r.qualifiedAt === 'number')
      .map((r) => (r.athAt - r.qualifiedAt) / 3_600_000);
    const ruggedCount = records.filter((r) => r.outcome === 'rugged').length;
    const survivedOver30Days = records.filter(
      (r) => r.outcome === 'survived' && typeof r.archivedAt === 'number'
        && (r.archivedAt - r.qualifiedAt) >= 30 * DAY_MS,
    ).length;
    rows.push({
      narrativeTag,
      tokensTracked: records.length,
      medianPeakRoiMultiple: median(rois),
      avgTimeToPeakHours: timesToPeakHours.length > 0
        ? Math.round((timesToPeakHours.reduce((sum, v) => sum + v, 0) / timesToPeakHours.length) * 10) / 10
        : null,
      rugRate: Math.round((ruggedCount / records.length) * 1000) / 10,
      survivalOver30DaysRate: Math.round((survivedOver30Days / records.length) * 1000) / 10,
      // medianPeakMarketCap was removed here — archive records never carry
      // an athMarketCap field (not in schema.sql, not written by
      // tokenScanner.js or patternReviewer.js), so it was unconditionally
      // null for every deployment. If peak-market-cap tracking is wanted,
      // it needs to be captured at archive time (a schema column plus a
      // patternReviewer.js write), not reconstructed here from a field
      // that was never populated.
    });
  }

  return rows
    .sort((a, b) => (b.medianPeakRoiMultiple ?? 0) - (a.medianPeakRoiMultiple ?? 0))
    .slice(0, limit);
}

/**
 * "Historical Matches" — the closest past archived tokens to a candidate
 * that just qualified (or is being previewed), for the alert's
 * "📚 HISTORICAL MATCHES" section. Requires the SAME narrative to count as
 * a match at all (a 92%-similar-hype AI token is not a meaningful
 * comparison for a dog-themed one), then scores closeness within that
 * narrative by how near the candidate's hype score and risk level are.
 *
 * @param {{ narrativeTag: string, hypeScoreAtQualification: number,
 *   riskLevelAtQualification?: string }} candidate
 * @param {Array} archiveRecords - tokenPatternStore.getArchive()
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{ symbol: string, name: string, similarityPct: number,
 *   peakRoiMultiple: number|null, timeToPeakHours: number|null,
 *   outcome: string, archivedAt: number }>} sorted by similarity
 *   descending, top `limit` (default 3)
 */
function findSimilarHistoricalTokens(candidate, archiveRecords, opts = {}) {
  const limit = opts.limit ?? 3;
  if (!candidate || !candidate.narrativeTag) return [];

  const sameNarrative = archiveRecords.filter((r) => r.narrativeTag === candidate.narrativeTag);

  const scored = sameNarrative.map((record) => {
    const hypeDiff = Math.abs(
      (candidate.hypeScoreAtQualification ?? 0) - (record.hypeScoreAtQualification ?? 0),
    );
    const hypeCloseness = Math.max(0, 1 - hypeDiff / 10); // 0..1, 1 = identical hype score
    const riskMatch = candidate.riskLevelAtQualification
      && candidate.riskLevelAtQualification === record.riskLevelAtQualification ? 1 : 0;
    const similarity = hypeCloseness * 0.7 + riskMatch * 0.3;

    return {
      symbol: record.symbol,
      name: record.name,
      similarityPct: Math.round(similarity * 100),
      peakRoiMultiple: typeof record.peakRoiMultiple === 'number' ? record.peakRoiMultiple : null,
      timeToPeakHours: (typeof record.athAt === 'number' && typeof record.qualifiedAt === 'number')
        ? Math.round(((record.athAt - record.qualifiedAt) / 3_600_000) * 10) / 10
        : null,
      outcome: record.outcome,
      archivedAt: record.archivedAt,
    };
  });

  return scored.sort((a, b) => b.similarityPct - a.similarityPct).slice(0, limit);
}

module.exports = {
  getNarrativeHeat,
  getNarrativeRotation,
  getNarrativeEvolution,
  getMonthlyNarrativeAssessment,
  findSimilarHistoricalTokens,
};
