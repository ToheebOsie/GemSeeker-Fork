'use strict';

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildNarrativeWalletBuckets(rows, options = {}) {
  const bucketMs = Math.max(1, Math.floor(Number(options.bucketMinutes ?? 60) * 60_000));
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const tag = row.narrativeTag ?? row.narrative_tag;
    const blockTime = finite(row.blockTime ?? row.block_time);
    // block_time is Unix seconds in early_wallet_activity. No captured_at fallback:
    // ingestion time is not a valid substitute for transaction-time participation.
    if (!tag || blockTime === null || blockTime <= 0) continue;
    const at = blockTime < 1e12 ? blockTime * 1000 : blockTime;
    const bucketAt = Math.floor(at / bucketMs) * bucketMs;
    const key = `${tag}\u0000${bucketAt}`;
    if (!groups.has(key)) groups.set(key, { narrativeTag: tag, bucketAt, rows: [], wallets: new Set(), buyers: new Set(), sellers: new Set() });
    const group = groups.get(key);
    group.rows.push(row);
    const wallet = row.walletAddress ?? row.wallet_address;
    if (wallet) {
      group.wallets.add(String(wallet));
      if (String(row.role || '').toLowerCase() === 'buyer') group.buyers.add(String(wallet));
      if (String(row.role || '').toLowerCase() === 'seller') group.sellers.add(String(wallet));
    }
  }
  return [...groups.values()].map((group) => {
    const knownValues = group.rows.map((r) => finite(r.valueSol ?? r.value_sol)).filter((n) => n !== null && n >= 0);
    const meaningfulBuyerWallets = new Set(group.rows
      .filter((r) => (r.role || '').toLowerCase() === 'buyer' && (r.isMeaningful ?? r.is_meaningful) === true)
      .map((r) => r.walletAddress ?? r.wallet_address).filter(Boolean).map(String));
    const confidenceKnown = group.rows.filter((r) => r.economicConfidence != null || r.economic_confidence != null).length;
    return {
      narrativeTag: group.narrativeTag,
      bucketAt: group.bucketAt,
      activityRowCount: group.rows.length,
      uniqueWalletCount: group.wallets.size,
      buyerWalletCount: group.buyers.size,
      sellerWalletCount: group.sellers.size,
      meaningfulBuyerWalletCount: meaningfulBuyerWallets.size,
      valueKnownRowCount: knownValues.length,
      valueCoverage: group.rows.length ? knownValues.length / group.rows.length : null,
      knownValueSolTotal: knownValues.length ? knownValues.reduce((sum, n) => sum + n, 0) : null,
      economicConfidenceKnownRowCount: confidenceKnown,
      timeBasis: 'transaction_block_time',
      researchOnly: true,
    };
  }).sort((a, b) => a.bucketAt - b.bucketAt || a.narrativeTag.localeCompare(b.narrativeTag));
}

function attachWalletParticipation(leadLagReport, walletBuckets, options = {}) {
  const maxLagMs = options.maxLagMs ?? 3 * 60 * 60 * 1000;
  const maxBaselineAgeMs = options.maxBaselineAgeMs ?? 3 * 60 * 60 * 1000;
  const bucketMs = Math.max(1, Math.floor(Number(options.bucketMinutes ?? 60) * 60_000));
  const byTag = new Map();
  for (const row of Array.isArray(walletBuckets) ? walletBuckets : []) {
    if (!byTag.has(row.narrativeTag)) byTag.set(row.narrativeTag, []);
    byTag.get(row.narrativeTag).push(row);
  }
  // A bucket is only eligible as baseline once its entire interval has ended.
  // Using bucketAt <= attentionAt alone leaks transactions later in the same
  // bucket into the supposed pre-attention baseline.
  const nearestBefore = (rows, at) => rows.filter((r) => r.bucketAt + bucketMs <= at && at - (r.bucketAt + bucketMs) <= maxBaselineAgeMs).at(-1) || null;
  const nearestAfter = (rows, at) => rows.find((r) => r.bucketAt > at && r.bucketAt - at <= maxLagMs) || null;
  for (const report of leadLagReport.reports || []) {
    const rows = (byTag.get(report.narrativeTag) || []).slice().sort((a, b) => a.bucketAt - b.bucketAt);
    report.walletParticipationBucketCount = rows.length;
    report.walletParticipationCoverage = rows.length ? rows.filter((r) => r.activityRowCount > 0).length / rows.length : null;
    report.walletParticipationPairs = (report.pairs || []).map((pair) => {
      const baseline = nearestBefore(rows, pair.attentionAt);
      const response = nearestAfter(rows, pair.attentionAt);
      const delta = (field) => baseline && response && finite(baseline[field]) !== null && finite(response[field]) !== null
        ? finite(response[field]) - finite(baseline[field]) : null;
      return {
        attentionAt: pair.attentionAt,
        walletBaselineAt: baseline?.bucketAt ?? null,
        walletResponseAt: response?.bucketAt ?? null,
        responseLagMs: response ? response.bucketAt - pair.attentionAt : null,
        baselineUniqueWalletCount: baseline?.uniqueWalletCount ?? null,
        responseUniqueWalletCount: response?.uniqueWalletCount ?? null,
        uniqueWalletDelta: delta('uniqueWalletCount'),
        baselineMeaningfulBuyerWalletCount: baseline?.meaningfulBuyerWalletCount ?? null,
        responseMeaningfulBuyerWalletCount: response?.meaningfulBuyerWalletCount ?? null,
        meaningfulBuyerWalletDelta: delta('meaningfulBuyerWalletCount'),
        baselineKnownValueSolTotal: baseline?.knownValueSolTotal ?? null,
        responseKnownValueSolTotal: response?.knownValueSolTotal ?? null,
        knownValueSolDelta: delta('knownValueSolTotal'),
        baselineValueCoverage: baseline?.valueCoverage ?? null,
        responseValueCoverage: response?.valueCoverage ?? null,
        note: 'Wallet activity is observed participation, not proof that attention caused buys; knownValueSolTotal excludes rows without value_sol and is not total capital flow.',
      };
    });
  }
  leadLagReport.walletParticipationSource = 'early_wallet_activity joined by pair_address to tracked_tokens/pattern_archive narrative tags';
  leadLagReport.walletParticipationResearchOnly = true;
  return leadLagReport;
}

module.exports = { buildNarrativeWalletBuckets, attachWalletParticipation };
