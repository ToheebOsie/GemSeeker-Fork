'use strict';

const crypto = require('crypto');
const { fixedWindowWallet, modelFocus, tier2Scoring } = require('../config');
const { withTransaction } = require('../db/pool');
const {
  ProviderError,
  fetchHeliusWindow,
  fetchBirdeyeWindow,
  fetchHellomoonWindow,
} = require('./fixedWindowWalletProviders');
const { collectPlatformTimingFeatures } = require('./platformTimingCollector');
const { scoreTier2FixedWindowFeatures, DEFAULT_TIER2_RULES } = require('../core/tier2ScoringEngine');

const FEATURE_SCHEMA_VERSION = 'fixed-window-features-v1';
const WALLET_FEATURE_SCHEMA_VERSION = 'fixed-window-wallet-v1';

function hashWallet(wallet) {
  return crypto.createHash('sha256').update(String(wallet).trim().toLowerCase()).digest('hex');
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function utcHour(ms) {
  return new Date(ms).getUTCHours();
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function valueBasis_(entries, srcs) {
  if (!entries.length || entries.some((e) => e.usd === null)) return null;
  return srcs.size === 1 ? [...srcs][0] : 'mixed';
}

// Value basis: concentration/ratio features need ONE consistent unit across all rows in a window.
// 'usd' only if every attributable row carries a USD value; otherwise 'token_amount' if every row
// carries a token amount (shares and ratios are unit-free); otherwise null (unknown, never 0).
function aggregateTransfers(transfers, { pairAddress, windowStartMs, windowEndMs, priceUsd = null }) {
  const spot = Number.isFinite(Number(priceUsd)) && Number(priceUsd) > 0 ? Number(priceUsd) : null; // 0/NaN = price missing, never a real price
  const rows = (transfers || []).filter((row) => row.timestampMs >= windowStartMs && row.timestampMs < windowEndMs && row.mintAddress);
  const entries = [];
  for (const row of rows) {
    const role = row.role || (row.fromAddress === pairAddress ? 'buyer' : row.toAddress === pairAddress ? 'seller' : null);
    const wallet = row.walletAddress || (role === 'buyer' ? row.toAddress : role === 'seller' ? row.fromAddress : null);
    if (!wallet || !role) continue;
    const amt = optionalNumber(row.amount);
    const providerUsd = optionalNumber(row.valueUsd);
    // Convert to USD BEFORE any evaluation: provider USD if present, else amount x pair price at capture.
    const usd = providerUsd !== null ? providerUsd : amt !== null && spot !== null ? amt * spot : null;
    entries.push({ role, wallet, ts: row.timestampMs, usd, amt, src: providerUsd !== null ? (row.valueSource || 'provider') : usd !== null ? 'spot_price_estimate' : null });
  }
  const valueBasis = entries.length === 0 ? null
    : entries.every((e) => e.usd !== null) ? 'usd'
    : entries.every((e) => e.amt !== null) ? 'token_amount' : null;
  const srcs = new Set(entries.map((e) => e.src));
  const usdSource = valueBasis_(entries, srcs);
  const byWallet = new Map();
  const total = { buyUsd: 0, sellUsd: 0, buyAmt: 0, sellAmt: 0 };
  for (const e of entries) {
    const key = e.wallet.toLowerCase();
    const prior = byWallet.get(key) || { walletAddress: e.wallet, role: null, buyCount: 0, sellCount: 0, buyVolumeUsd: null, sellVolumeUsd: null, buyAmount: null, sellAmount: null, firstBuyAtMs: null, firstSellAtMs: null, sourceAttemptId: null };
    const side = e.role === 'buyer' ? 'buy' : 'sell';
    if (e.role === 'buyer') prior.firstBuyAtMs = prior.firstBuyAtMs === null ? e.ts : Math.min(prior.firstBuyAtMs, e.ts);
    else prior.firstSellAtMs = prior.firstSellAtMs === null ? e.ts : Math.min(prior.firstSellAtMs, e.ts);
    prior[`${side}Count`] += 1;
    if (e.usd !== null) { total[`${side}Usd`] += e.usd; if (valueBasis === 'usd') prior[`${side}VolumeUsd`] = (prior[`${side}VolumeUsd`] ?? 0) + e.usd; }
    if (e.amt !== null) { prior[`${side}Amount`] = (prior[`${side}Amount`] ?? 0) + e.amt; total[`${side}Amt`] += e.amt; }
    prior.role = prior.buyCount && prior.sellCount ? 'buyer_and_seller' : e.role;
    byWallet.set(key, prior);
  }
  const valueOf = (w) => (valueBasis === 'usd' ? w.buyVolumeUsd : valueBasis === 'token_amount' ? w.buyAmount : null);
  const buyers = [...byWallet.values()].filter((w) => w.buyCount > 0);
  const sellers = [...byWallet.values()].filter((w) => w.sellCount > 0);
  const shares = buyers.filter((w) => valueOf(w) > 0);
  const denominator = shares.reduce((sum, w) => sum + valueOf(w), 0);
  const sorted = shares.slice().sort((x, y) => valueOf(y) - valueOf(x));
  const share = (n) => denominator > 0 ? sorted.slice(0, n).reduce((sum, w) => sum + valueOf(w), 0) / denominator * 100 : null;
  const hhi = denominator > 0 ? shares.reduce((sum, w) => sum + Math.pow(valueOf(w) / denominator, 2), 0) : null;
  const buyTransactionCount = entries.filter((e) => e.role === 'buyer').length;
  const sellTransactionCount = entries.filter((e) => e.role === 'seller').length;
  const buyValue = valueBasis === 'usd' ? total.buyUsd : valueBasis === 'token_amount' ? total.buyAmt : null;
  // No sell rows at all is a real zero on a known basis, not a missing value.
  const sellValue = valueBasis === null ? null : sellTransactionCount === 0 ? 0 : valueBasis === 'usd' ? total.sellUsd : total.sellAmt;
  return {
    transfers: rows,
    participants: [...byWallet.values()],
    uniqueBuyers: buyers.length,
    uniqueSellers: sellers.length,
    buyTransactionCount,
    sellTransactionCount,
    valueBasis,
    usdSource: valueBasis === 'usd' ? usdSource : null,
    usdPriceUsed: valueBasis === 'usd' && (usdSource === 'spot_price_estimate' || usdSource === 'mixed') ? spot : null,
    buyValue,
    sellValue,
    buyVolumeUsd: valueBasis === 'usd' ? total.buyUsd : null,
    sellVolumeUsd: valueBasis === 'usd' ? total.sellUsd : null,
    buyTokenAmount: valueBasis ? total.buyAmt : null,
    sellTokenAmount: valueBasis ? total.sellAmt : null,
    top1BuyerSharePct: share(1),
    top5BuyerSharePct: share(5),
    top10BuyerSharePct: share(10),
    buyerHhi: hhi,
    walletDataCompletenessPct: null,
  };
}

function providerStatus(error) {
  if (error instanceof ProviderError) {
    if (error.code === 'rate_limited') return 'rate_limited';
    if (error.code === 'timeout') return 'timeout';
    if (error.code === 'not_configured' || error.code === 'unsupported' || error.code === 'missing_pair_address') return 'unsupported';
    return 'error';
  }
  return error?.name === 'AbortError' ? 'timeout' : 'error';
}

async function fetchWithFallback(args) {
  const providers = [
    ['helius', () => fetchHeliusWindow({ ...args, apiKey: fixedWindowWallet.heliusApiKey })],
    ['birdeye', () => fetchBirdeyeWindow({ ...args, apiKey: fixedWindowWallet.birdeyeApiKey })],
    ['hellomoon', () => fetchHellomoonWindow({ ...args, apiKey: fixedWindowWallet.hellomoonApiKey })],
  ];
  const attempts = [];
  let selected = null;
  for (let index = 0; index < providers.length; index += 1) {
    const [provider, call] = providers[index];
    const requestedAt = new Date();
    try {
      const result = await call();
      const accepted = result.status === 'success' || (!selected && result.status === 'partial');
      attempts.push({ provider, fallbackRank: index + 1, requestedAt, completedAt: new Date(), result, status: result.status, accepted });
      if (result.status === 'success' || (accepted && !selected)) selected = attempts[attempts.length - 1];
      if (result.status === 'success') break;
    } catch (error) {
      attempts.push({ provider, fallbackRank: index + 1, requestedAt, completedAt: new Date(), result: null, status: providerStatus(error), error, accepted: false });
    }
  }
  return { selected, attempts };
}

// USD value of one unit of the pair's QUOTE token (SOL, USDC, ...) = priceUsd / priceNative.
function quoteUsdPerUnit(token) {
  const usd = Number(token.priceUsd);
  const native = Number(token.priceNative);
  return usd > 0 && native > 0 ? usd / native : null;
}

function captureValues({ token, cutoffMs, platformTiming = null }) {
  const discoveredAtMs = platformTiming?.discoveredAtMs ?? null;
  const pairCreatedAtMs = platformTiming?.pairCreatedAtMs ?? null;
  return {
    chainId: 'solana',
    pairAddress: token.pairAddress,
    mintAddress: token.baseToken?.address,
    discoveredAtMs: Number.isFinite(discoveredAtMs) ? discoveredAtMs : null,
    qualifiedAtMs: cutoffMs,
    pairCreatedAtMs: Number.isFinite(pairCreatedAtMs) ? pairCreatedAtMs : null,
    featureCutoffAtMs: cutoffMs,
    captureAnchor: 'qualification',
    discoverySource: platformTiming?.discoverySource || token.discovery?.source || null,
    providerPath: platformTiming?.providerPath || token.discovery?.providerPath || null,
    platform: platformTiming?.platform || token.dexId || null,
    dexId: platformTiming?.dexId || token.dexId || null,
    discoveryHourUtc: platformTiming?.discoveryHourUtc ?? (Number.isFinite(discoveredAtMs) ? utcHour(discoveredAtMs) : null),
    qualificationHourUtc: platformTiming?.qualificationHourUtc ?? utcHour(cutoffMs),
    discoveryDayOfWeekUtc: platformTiming?.discoveryDayOfWeekUtc ?? (Number.isFinite(discoveredAtMs) ? new Date(discoveredAtMs).getUTCDay() : null),
    minutesPairToDiscovery: platformTiming?.minutesPairToDiscovery ?? null,
    minutesDiscoveryToQualification: platformTiming?.minutesDiscoveryToQualification ?? null,
    platformActivity15mCount: platformTiming?.platformActivity15mCount ?? null,
    platformActivity30mCount: platformTiming?.platformActivity30mCount ?? null,
    platformActivity60mCount: platformTiming?.platformActivity60mCount ?? null,
    timingMissingFields: platformTiming?.timingMissingFields || [],
    activityCoverageStatus: platformTiming?.activityCoverageStatus || 'not_attempted',
    platformTimingVersion: platformTiming?.version || 'platform-timing-v1',
    marketCapUsd: numeric(token.marketCap),
    volume1hUsd: numeric(token.volume1h),
    liquidityUsd: numeric(token.liquidity),
    buys1h: numeric(token.buys1h),
    sells1h: numeric(token.sells1h),
    priceUsd: numeric(token.priceUsd),
    priceChange1hPct: numeric(token.priceChange1h),
    firstTopHolderPct: numeric(token.safety?.topHolderPct),
    firstLpLockedPct: numeric(token.safety?.lpLockedPct),
    signalLabel: token.signalLabel || null,
    hypeScore: numeric(token.hypeScore),
    riskLevel: token.riskLevel || null,
  };
}

async function persistCapture({ token, cutoffMs, windows, attemptsByWindow, captureStatus, providerPath, platformTiming, tier2Score }) {
  const base = captureValues({ token, cutoffMs, platformTiming });
  return withTransaction(async (client) => {
    const captureResult = await client.query(
      `INSERT INTO token_feature_captures (
        chain_id, pair_address, mint_address, discovered_at_ms, qualified_at_ms,
        pair_created_at_ms, feature_cutoff_at_ms, capture_anchor, discovery_source,
        provider_path, platform, dex_id, discovery_hour_utc, qualification_hour_utc,
        discovery_day_of_week_utc, minutes_pair_to_discovery, minutes_discovery_to_qualification,
        platform_activity_15m_count, platform_activity_30m_count, platform_activity_60m_count,
        platform_activity_coverage_status, timing_missing_fields, platform_timing_version,
        tier2_score, tier2_raw_score, tier2_threshold, tier2_pass, tier2_classification,
        tier2_score_version, tier2_missing_fields,
        market_cap_usd, volume_1h_usd, liquidity_usd, buys_1h, sells_1h, price_usd,
        price_change_1h_pct, first_top_holder_pct, first_lp_locked_pct, signal_label,
        hype_score, risk_level, feature_schema_version, capture_status, capture_error_code
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45)
      ON CONFLICT (pair_address, mint_address, feature_cutoff_at_ms, feature_schema_version)
      DO UPDATE SET provider_path = EXCLUDED.provider_path,
        platform = EXCLUDED.platform, dex_id = EXCLUDED.dex_id,
        discovery_hour_utc = EXCLUDED.discovery_hour_utc,
        qualification_hour_utc = EXCLUDED.qualification_hour_utc,
        discovery_day_of_week_utc = EXCLUDED.discovery_day_of_week_utc,
        minutes_pair_to_discovery = EXCLUDED.minutes_pair_to_discovery,
        minutes_discovery_to_qualification = EXCLUDED.minutes_discovery_to_qualification,
        platform_activity_15m_count = EXCLUDED.platform_activity_15m_count,
        platform_activity_30m_count = EXCLUDED.platform_activity_30m_count,
        platform_activity_60m_count = EXCLUDED.platform_activity_60m_count,
        platform_activity_coverage_status = EXCLUDED.platform_activity_coverage_status,
        timing_missing_fields = EXCLUDED.timing_missing_fields,
        platform_timing_version = EXCLUDED.platform_timing_version,
        tier2_score = EXCLUDED.tier2_score,
        tier2_raw_score = EXCLUDED.tier2_raw_score,
        tier2_threshold = EXCLUDED.tier2_threshold,
        tier2_pass = EXCLUDED.tier2_pass,
        tier2_classification = EXCLUDED.tier2_classification,
        tier2_score_version = EXCLUDED.tier2_score_version,
        tier2_missing_fields = EXCLUDED.tier2_missing_fields,
        capture_status = EXCLUDED.capture_status
      RETURNING capture_id`,
      [base.chainId, base.pairAddress, base.mintAddress, base.discoveredAtMs, base.qualifiedAtMs, base.pairCreatedAtMs, base.featureCutoffAtMs, base.captureAnchor, base.discoverySource, base.providerPath, base.platform, base.dexId, base.discoveryHourUtc, base.qualificationHourUtc, base.discoveryDayOfWeekUtc, base.minutesPairToDiscovery, base.minutesDiscoveryToQualification, base.platformActivity15mCount, base.platformActivity30mCount, base.platformActivity60mCount, base.activityCoverageStatus, JSON.stringify(base.timingMissingFields), base.platformTimingVersion, tier2Score?.points ?? null, tier2Score?.rawPoints ?? null, tier2Score?.threshold ?? null, tier2Score?.pass ?? null, tier2Score?.classification ?? null, tier2Score?.schemaVersion ?? null, JSON.stringify(tier2Score?.missingFeatures || []), base.marketCapUsd, base.volume1hUsd, base.liquidityUsd, base.buys1h, base.sells1h, base.priceUsd, base.priceChange1hPct, base.firstTopHolderPct, base.firstLpLockedPct, base.signalLabel, base.hypeScore, base.riskLevel, FEATURE_SCHEMA_VERSION, captureStatus, captureStatus === 'failed' ? 'provider_unavailable' : null],
    );
    const captureId = captureResult.rows[0].capture_id;
    for (const [windowKey, info] of Object.entries(attemptsByWindow)) {
      for (const attempt of info.attempts) {
        const result = attempt.result;
        await client.query(
          `INSERT INTO wallet_feature_provider_attempts
            (capture_id, window_key, provider, fallback_rank, requested_at, completed_at, status,
             pages_requested, pages_completed, signatures_scanned, provider_cursor,
             coverage_start_ms, coverage_end_ms, raw_evidence_sha256, error_code, error_message, adapter_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (capture_id, window_key, provider, fallback_rank) DO NOTHING`,
          [captureId, windowKey, attempt.provider, attempt.fallbackRank, attempt.requestedAt, attempt.completedAt, attempt.status, result?.pagesRequested || 0, result?.pagesCompleted || 0, result?.signaturesScanned || 0, result?.cursor || null, result?.coverageStartMs || null, result?.coverageEndMs || null, result ? crypto.createHash('sha256').update(JSON.stringify(result.raw || [])).digest('hex') : null, attempt.error?.code || (attempt.status === 'success' ? null : attempt.status), attempt.error?.message || (attempt.status === 'success' ? null : 'provider did not return complete evidence'), result?.adapterVersion || 'fixed-window-providers-v1'],
        );
      }
      const selected = info.selected;
      const aggregate = selected ? aggregateTransfers(selected.result.transfers, { pairAddress: base.pairAddress, windowStartMs: info.windowStartMs, windowEndMs: info.windowEndMs, priceUsd: base.priceUsd }) : null;
      const coverageStatus = selected?.result.status === 'success' ? 'complete' : selected?.result.status === 'partial' ? 'partial' : 'unavailable';
      const featureResult = await client.query(
        `INSERT INTO wallet_window_features
          (capture_id, window_key, feature_phase, anchor_at_ms, window_start_ms, window_end_ms,
           feature_cutoff_at_ms, selected_provider, coverage_status, eligible_for_discovery_model,
           coverage_reason, unique_buyers, unique_sellers, buy_transaction_count, sell_transaction_count,
           buy_volume_usd, sell_volume_usd, top1_buyer_share_pct, top5_buyer_share_pct,
           top10_buyer_share_pct, buyer_hhi, wallet_data_completeness_pct, missing_fields, feature_schema_version,
           value_basis, buy_token_amount, sell_token_amount, usd_source, usd_price_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
         ON CONFLICT (capture_id, window_key, feature_schema_version)
         DO UPDATE SET selected_provider = EXCLUDED.selected_provider, coverage_status = EXCLUDED.coverage_status,
           eligible_for_discovery_model = EXCLUDED.eligible_for_discovery_model
         RETURNING window_feature_id`,
        [captureId, windowKey, 'discovery', base.featureCutoffAtMs, info.windowStartMs, info.windowEndMs, base.featureCutoffAtMs, selected?.provider || null, coverageStatus, coverageStatus === 'complete' && info.windowEndMs <= base.featureCutoffAtMs, coverageStatus === 'complete' ? null : (selected ? 'provider_partial_coverage' : 'no_provider_complete_or_partial'), aggregate?.uniqueBuyers ?? null, aggregate?.uniqueSellers ?? null, aggregate?.buyTransactionCount ?? null, aggregate?.sellTransactionCount ?? null, aggregate?.buyVolumeUsd ?? null, aggregate?.sellVolumeUsd ?? null, aggregate?.top1BuyerSharePct ?? null, aggregate?.top5BuyerSharePct ?? null, aggregate?.top10BuyerSharePct ?? null, aggregate?.buyerHhi ?? null, aggregate?.walletDataCompletenessPct ?? null, JSON.stringify(selected ? [] : ['wallet_activity']), WALLET_FEATURE_SCHEMA_VERSION, aggregate?.valueBasis ?? null, aggregate?.buyTokenAmount ?? null, aggregate?.sellTokenAmount ?? null, aggregate?.usdSource ?? null, aggregate?.usdPriceUsed ?? null],
      );
      const featureId = featureResult.rows[0].window_feature_id;
      if (aggregate) {
        for (const participant of aggregate.participants) {
          await client.query(
            `INSERT INTO wallet_window_participants
              (window_feature_id, wallet_address, wallet_hash_sha256, role, first_buy_at_ms,
               first_sell_at_ms, buy_count, sell_count, buy_volume_usd, sell_volume_usd, buy_token_amount, sell_token_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
             ON CONFLICT (window_feature_id, wallet_address, role)
             DO UPDATE SET buy_count = EXCLUDED.buy_count, sell_count = EXCLUDED.sell_count`,
            [featureId, participant.walletAddress, hashWallet(participant.walletAddress), participant.role, participant.firstBuyAtMs, participant.firstSellAtMs, participant.buyCount, participant.sellCount, participant.buyVolumeUsd, participant.sellVolumeUsd, participant.buyAmount, participant.sellAmount],
          );
        }
      }
    }
    return { captureId, windows: Object.keys(attemptsByWindow).length };
  });
}

async function captureFixedWindowWalletFeatures({ token, tier1Admission, cutoffMs = Date.now(), windows = fixedWindowWallet.windows } = {}) {
  if (!fixedWindowWallet.enabled) return { status: 'disabled', attempted: false };
  if (modelFocus.collectTier2OnlyAfterTier1 && !tier1Admission?.pass) return { status: 'tier1_not_admitted', attempted: false };
  if (!token?.pairAddress || !token?.baseToken?.address) return { status: 'invalid_token', attempted: false };
  const attemptsByWindow = {};
  const providerPath = [];
  const platformTiming = await collectPlatformTimingFeatures({ token, cutoffMs });
  for (const window of windows) {
    const windowEndMs = cutoffMs;
    const windowStartMs = cutoffMs - window.minutes * 60_000;
    const result = await fetchWithFallback({ pairAddress: token.pairAddress, mintAddress: token.baseToken.address, startMs: windowStartMs, endMs: windowEndMs, quoteUsdPerUnit: quoteUsdPerUnit(token), limit: fixedWindowWallet.pageLimit, maxPages: fixedWindowWallet.maxPages, timeoutMs: fixedWindowWallet.timeoutMs });
    attemptsByWindow[window.key] = { ...result, windowStartMs, windowEndMs };
    for (const attempt of result.attempts) if (!providerPath.includes(attempt.provider)) providerPath.push(attempt.provider);
  }
  const scoreWindows = Object.entries(attemptsByWindow).map(([windowKey, info]) => {
    const selected = info.selected;
    const aggregate = selected ? aggregateTransfers(selected.result.transfers, { pairAddress: token.pairAddress, windowStartMs: info.windowStartMs, windowEndMs: info.windowEndMs, priceUsd: numeric(token.priceUsd) }) : null;
    return {
      windowKey,
      featurePhase: 'discovery',
      windowEndMs: info.windowEndMs,
      featureCutoffAtMs: cutoffMs,
      coverageStatus: selected?.result.status === 'success' ? 'complete' : selected?.result.status === 'partial' ? 'partial' : 'unavailable',
      eligibleForDiscoveryModel: selected?.result.status === 'success' && info.windowEndMs <= cutoffMs,
      ...(aggregate || {}),
    };
  });
  const tier2Score = tier2Scoring.enabled
    ? scoreTier2FixedWindowFeatures({ windows: scoreWindows, platformTiming, rules: { ...DEFAULT_TIER2_RULES, ...tier2Scoring } })
    : null;
  const hasSelected = Object.values(attemptsByWindow).some((info) => info.selected);
  const status = hasSelected ? 'captured' : 'failed';
  const persisted = await persistCapture({ token, cutoffMs, windows, attemptsByWindow, captureStatus: status, providerPath: providerPath.join('>') || null, platformTiming, tier2Score });
  return { status, attempted: true, providerPath, platformTiming, tier2Score, ...persisted };
}

module.exports = { FEATURE_SCHEMA_VERSION, WALLET_FEATURE_SCHEMA_VERSION, aggregateTransfers, captureFixedWindowWalletFeatures, captureValues };
