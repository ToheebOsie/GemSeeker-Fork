function fmtX(n) {
  return n === null || n === undefined ? 'n/a' : `${n.toFixed(2)}x`;
}

function fmtDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Phase 8 (rug-timing buckets rebuilt to be qualification-relative,
// see patternAnalyzer.js's classifyOutcomeDetail): display order matters
// more than alphabetical here — worst to best reads naturally in a report
// meant to tell someone how their calls performed. 'rug-timing-unknown'
// sits right after the timing buckets it's a sibling-fallback for (a
// rugged record whose outcomeDetail WAS computed, just without usable
// timeToRugFromQualificationHours to bucket by) — distinct from the
// generic 'unclassified' at the end (records where outcomeDetail itself
// was never computed at all, e.g. pre-Phase-8 data).
const OUTCOME_DETAIL_ORDER = [
  'immediate-rug', 'rug-within-3h', 'rug-within-6h', 'rug-within-12h', 'rug-within-24h', 'rug-after-24h',
  'rug-timing-unknown', 'dead', 'pump-and-dump', 'stable-survivor', 'unclassified',
];
const OUTCOME_DETAIL_LABEL = {
  'immediate-rug': 'immediate rug',
  'rug-within-3h': 'rugged 3hrs later',
  'rug-within-6h': 'rugged 6hrs later',
  'rug-within-12h': 'rugged 12hrs later',
  'rug-within-24h': 'rugged 24hrs later',
  'rug-after-24h': 'rugged after 24hrs',
  'rug-timing-unknown': 'rug timing unknown',
  dead: 'dead',
  'pump-and-dump': 'pump & dump',
  'stable-survivor': 'stable',
  unclassified: 'unclassified',
};

function formatOutcomeDetailLine(breakdown) {
  const parts = OUTCOME_DETAIL_ORDER
    .filter((key) => breakdown[key] > 0)
    .map((key) => `${breakdown[key]} ${OUTCOME_DETAIL_LABEL[key]}`);
  return parts.length > 0 ? `   Breakdown: ${parts.join(', ')}` : null;
}

// Phase 9: same ordering/label-map pattern as OUTCOME_DETAIL_ORDER above,
// for the rugged-only mechanism breakdown. 'unclassified' covers archive
// records from before rugMechanism existed, same reasoning as
// outcomeDetail's own 'unclassified' fallback.
//
// AUDIT FOLLOW-UP (D): 'unknown-mechanism' split into two honestly-
// different situations — see patternAnalyzer.js's classifyRugMechanism
// for the full "why." -no-review (the common, timing-driven case: this
// token archived before its first review tick ever ran, so literally
// zero post-enrollment safety data exists) is ordered right after
// -data-gap (reviewed at least once, Rugcheck just never returned usable
// data either time) since -no-review is expected to be the larger,
// more-fixable-over-time bucket worth a report reader's attention first.
// -no-checkpoint-data is a third, rarer case (checkpointCount itself
// unknown — only reachable via scripts/migrate.js's one-time legacy-JSON
// migration for archive records that predate checkpointCount existing as
// a concept at all) — ordered last among the unknown-* labels since it
// should be a small, bounded, non-growing population, not an ongoing one.
const RUG_MECHANISM_ORDER = [
  'liquidity-pull-rug', 'distribution-dump-rug', 'organic-death', 'partial-unknown',
  'unknown-mechanism-no-review', 'unknown-mechanism-data-gap', 'unknown-mechanism-no-checkpoint-data', 'unclassified',
];
const RUG_MECHANISM_LABEL = {
  'liquidity-pull-rug': 'LP pulled',
  'distribution-dump-rug': 'holder dumped',
  'organic-death': 'organic death',
  // AUDIT FOLLOW-UP: only one of LP-lock/top-holder was ever captured for
  // this token (the other has no first-vs-latest reading at all) — kept
  // distinct from 'organic death' so this line doesn't overstate how much
  // was actually verified. See patternAnalyzer.js's classifyRugMechanism.
  'partial-unknown': 'partially unverified',
  'unknown-mechanism-no-review': 'rugged before first review',
  'unknown-mechanism-data-gap': 'mechanism unknown (data gap)',
  'unknown-mechanism-no-checkpoint-data': 'mechanism unknown (legacy record)',
  unclassified: 'unclassified',
};

function formatRugMechanismLine(breakdown) {
  const parts = RUG_MECHANISM_ORDER
    .filter((key) => breakdown[key] > 0)
    .map((key) => `${breakdown[key]} ${RUG_MECHANISM_LABEL[key]}`);
  return parts.length > 0 ? `   Rug cause: ${parts.join(', ')}` : null;
}

function formatGroupLine(label, group, emoji) {
  if (group.count === 0) return `${emoji} ${label}: no completed tokens in this window.`;
  const lines = [
    `${emoji} ${label}: ${group.count} completed (${group.ruggedCount} rugged, ${group.survivedCount} survived)`,
    `   Avg peak ROI: ${fmtX(group.averagePeakRoiMultiple)} | Median: ${fmtX(group.medianPeakRoiMultiple)}`,
  ];
  const detailLine = formatOutcomeDetailLine(group.outcomeDetailBreakdown);
  if (detailLine) lines.push(detailLine);
  const rugMechanismLine = formatRugMechanismLine(group.rugMechanismBreakdown);
  if (rugMechanismLine) lines.push(rugMechanismLine);
  return lines.join('\n');
}

/**
 * @param {'Daily'|'Weekly'|'On-demand'} periodLabel
 * @param {ReturnType<import('../core/selfAssessment').computeSelfAssessment>} stats
 */
function formatSelfAssessmentReport(periodLabel, stats) {
  const rangeLine = `${fmtDate(stats.windowStart)} → ${fmtDate(stats.generatedAt)} UTC`;

  return [
    `📊 Gem Seeker — ${periodLabel} Self-Assessment (${rangeLine})`,
    '',
    'Covers tokens whose outcome (rugged/survived) was determined in this window. Only Low-risk tokens and any WAIT- or BUY-labeled token (regardless of risk level) are ever pattern-tracked, so this reflects the archive of tokens the bot chose to track, not every alert sent.',
    '',
    formatGroupLine('BUY', stats.buy, '🟢'),
    '',
    formatGroupLine('WAIT', stats.wait, '🟡'),
    '',
    formatGroupLine('SKIP', stats.skip, '⚪'),
    '',
    `Total completed this window: ${stats.totalCompleted}${stats.unlabeledCount > 0 ? ` (${stats.unlabeledCount} unlabeled — enrolled before signal-label tracking was added)` : ''}`,
  ].join('\n');
}

module.exports = { formatSelfAssessmentReport };
