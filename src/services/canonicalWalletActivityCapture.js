'use strict';

const { Connection, PublicKey } = require('@solana/web3.js');
const { query } = require('../db/pool');
const shardPool = require('../db/shardPool');
const { solana, walletActivityEvidence } = require('../config');
const { resolveTrade } = require('../core/transactionEconomicsResolver');
const { retryWithBackoff } = require('./retryWithBackoff');
const patternStore = require('../storage/tokenPatternStore');
const {
  enqueueWalletActivityCaptureJobs,
  enqueueWalletEvidenceCaptureJobs,
  recordWalletActivityCaptureCoverage,
  getWalletActivityCaptureCoverage,
  getWalletActivityEvidenceState,
  upsertWalletActivityEvidenceState,
} = require('../storage/researchJobStore');
const { detectAbuseEvents } = require('../core/solanaAbuseDetector');

const PAGE_RETRY_COUNT = 3;
const PAGE_RETRY_BASE_MS = 500;
const TX_PARSE_BATCH_SIZE = 100;
const DEFAULT_SIG_PAGE_CAP = 25;
const DEFAULT_MAX_TX_PARSE = 100;
const DEFAULT_WINDOW_MINUTES = 30;
const DEFAULT_MIN_SOL = 0.5;
const DEFAULT_PAGE_SLEEP_MS = 200;
const DEFAULT_TX_SLEEP_MS = 150;
const DEFAULT_MAX_PAIRS = 8;
const DEFAULT_MAX_WALLETS = 20;
const DEFAULT_COUNTER_PRICE_MAX_SKEW_MS = 60 * 1000;
const WALLET_EVIDENCE_TARGET = walletActivityEvidence.targetRelevantTransactions;
const WALLET_EVIDENCE_RAW_PAGE_SIZE = walletActivityEvidence.rawPageSize;
const WALLET_EVIDENCE_MAX_RAW = walletActivityEvidence.maxRawTransactions;
const WALLET_EVIDENCE_MAX_PAGES = walletActivityEvidence.maxPages;
const WALLET_EVIDENCE_POLICY_VERSION = 'v2';
const WALLET_EVIDENCE_MAX_PAIRS = walletActivityEvidence.maxHistoricalPairs;

function isWindowCoveredBySignatures(signatures, windowStartMs) {
  return Array.isArray(signatures) && signatures.some((signature) => Number.isFinite(Number(signature?.blockTime)) && Number(signature.blockTime) * 1000 <= windowStartMs);
}

async function walkUntilWindowCovered(pairAddress, windowStartMs, sigPageCap = DEFAULT_SIG_PAGE_CAP, options = {}) {
  const connection = options.connection || new Connection(solana.backfillRpcUrl || solana.rpcUrl, 'confirmed');
  const pubkey = new PublicKey(pairAddress);
  let allSigs = Array.isArray(options.initialSigs) ? [...options.initialSigs] : [];
  let before = options.before || allSigs[allSigs.length - 1]?.signature || undefined;
  let pages = Number(options.initialPages || 0);
  let hitCap = false;
  let coveredWindow = isWindowCoveredBySignatures(allSigs, windowStartMs);
  let terminalError = null;
  while (pages < sigPageCap && !coveredWindow) {
    let batch;
    try {
      batch = await retryWithBackoff(
        () => options.budget ? (options.budget.consumeRequests(), connection.getSignaturesForAddress(pubkey, { limit: WALLET_EVIDENCE_RAW_PAGE_SIZE, before })) : connection.getSignaturesForAddress(pubkey, { limit: WALLET_EVIDENCE_RAW_PAGE_SIZE, before }),
        { retries: PAGE_RETRY_COUNT, baseMs: PAGE_RETRY_BASE_MS, onRetry: options.onRetry },
      );
    } catch (err) {
      terminalError = err.message;
      break;
    }
    pages += 1;
    if (!batch || batch.length === 0) break;
    const beforeSignature = before || null;
    const afterSignature = batch[batch.length - 1]?.signature || null;
    allSigs = allSigs.concat(batch);
    if (typeof options.onPage === 'function') {
      await options.onPage({ pageNumber: pages, beforeSignature, afterSignature, signatures: batch, pagesWalked: pages });
    }
    const last = batch[batch.length - 1];
    if (last.blockTime && last.blockTime * 1000 <= windowStartMs) {
      coveredWindow = true;
      break;
    }
    if (batch.length < WALLET_EVIDENCE_RAW_PAGE_SIZE) break;
    before = last.signature;
    if (pages === sigPageCap) hitCap = true;
    await new Promise((resolve) => setTimeout(resolve, options.pageSleepMs ?? DEFAULT_PAGE_SLEEP_MS));
  }
  if (terminalError && pages === 0) return { error: terminalError, sigs: [], hitCap: false, coveredWindow: false, pagesWalked: 0, nextBefore: before || null };
  allSigs.reverse();
  return { sigs: allSigs, hitCap, coveredWindow, pagesWalked: pages, error: null, recoveredAfterError: terminalError !== null, nextBefore: before || null };
}

async function createHistoricalValuationResolver(pairAddress, options = {}) {
  const maxSkewMs = Number(options.maxSkewMs ?? DEFAULT_COUNTER_PRICE_MAX_SKEW_MS);
  let rows = [];
  try {
    const result = await query(
      `SELECT qualified_at, feature_snapshot
         FROM alert_decisions
        WHERE pair_address = $1
          AND qualified_at IS NOT NULL
        ORDER BY qualified_at ASC`,
      [pairAddress],
    );
    rows = result.rows || [];
  } catch (_) {
    rows = [];
  }
  return async function resolveHistoricalValuation(_pairAddress, transactionTimeMs) {
    const result = { priceUsd: null, priceNative: null, solUsd: null, targetPriceNative: null, counterPriceSol: null, counterPriceSource: null, counterPriceConfidence: null, evidence: null };
    const targetTime = Number(transactionTimeMs);
    let best = null;
    for (const row of rows) {
      const at = Date.parse(row.qualified_at);
      const market = row.feature_snapshot?.market || {};
      const priceUsd = Number(market.priceUsd);
      const priceNative = Number(market.priceNative);
      if (!Number.isFinite(at) || !Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(priceNative) || priceNative <= 0) continue;
      // Historical valuation must be causal: never use a market snapshot
      // observed after the transaction. The snapshot may be up to maxSkewMs
      // old, but future observations are look-ahead leakage.
      if (at > targetTime) continue;
      const skew = targetTime - at;
      if (!best || skew < best.skew) best = { at, skew, priceUsd, priceNative };
    }
    if (!best || best.skew > maxSkewMs) return result;
    result.priceUsd = best.priceUsd;
    result.priceNative = best.priceNative;
    result.solUsd = best.priceUsd / best.priceNative;
    result.targetPriceNative = best.priceNative;
    result.evidence = { type: 'alert_decision_market_snapshot', observedAt: best.at, transactionTimeMs: targetTime, skewMs: best.skew };
    return result;
  };
}

async function getHistoricalValuation(pairAddress, transactionTimeMs, options = {}) {
  const resolver = await createHistoricalValuationResolver(pairAddress, options);
  return resolver(pairAddress, transactionTimeMs);
}

function classifyTransaction(tx, mintAddress, sigInfo, minSol = DEFAULT_MIN_SOL, valuation = {}, walletFilter = null) {
  const owners = new Set([
    ...(tx?.meta?.preTokenBalances || []).filter((b) => b.mint === mintAddress && b.owner).map((b) => b.owner),
    ...(tx?.meta?.postTokenBalances || []).filter((b) => b.mint === mintAddress && b.owner).map((b) => b.owner),
  ]);
  const entries = [];
  for (const owner of owners) {
    if (walletFilter && !walletFilter.has(owner)) continue;
    const trade = resolveTrade(tx, { walletAddress: owner, targetMint: mintAddress, valuation });
    if (!trade || (trade.side !== 'BUY' && trade.side !== 'SELL')) continue;
    const targetDelta = trade.side === 'BUY' ? Number(trade.targetAmount) : -Number(trade.targetAmount);
    if (!Number.isFinite(targetDelta) || targetDelta === 0) continue;
    const solAmount = trade.valueSol === null ? null : Number(trade.valueSol);
    entries.push({
      walletAddress: owner,
      role: trade.side === 'BUY' ? 'buyer' : 'seller',
      tokenDelta: targetDelta,
      targetAmount: trade.targetAmount,
      targetDecimals: trade.side === 'BUY' ? trade.outputAsset?.decimals ?? null : trade.inputAsset?.decimals ?? null,
      solAmount,
      valueUsd: trade.valueUsd === null ? null : Number(trade.valueUsd),
      valueSol: solAmount,
      valueSource: trade.valueSource,
      confidence: trade.confidence,
      inputAsset: trade.inputAsset,
      outputAsset: trade.outputAsset,
      route: trade.route,
      evidence: trade.evidence,
      isMeaningful: solAmount !== null && solAmount >= minSol,
      signature: sigInfo.signature,
      blockTime: sigInfo.blockTime ? sigInfo.blockTime * 1000 : null,
    });
  }
  return entries;
}

async function parseTransactions(connection, signatures, options = {}) {
  const results = [];
  let failures = 0;
  let stoppedEarly = false;
  const emitBatch = async (batchResults, batchFailures) => {
    if (typeof options.onBatch !== 'function') return false;
    const shouldStop = await options.onBatch(batchResults, batchFailures);
    if (shouldStop) stoppedEarly = true;
    return shouldStop;
  };
  const parseOne = async (sigInfo) => {
    try {
      const tx = await retryWithBackoff(
        () => options.budget ? (options.budget.consumeRequests(), connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })) : connection.getParsedTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
        { retries: 2, baseMs: 300 },
      );
      return tx ? { tx, sigInfo } : null;
    } catch (_) { return null; }
  };

  for (let start = 0; start < signatures.length; start += TX_PARSE_BATCH_SIZE) {
    const chunk = signatures.slice(start, start + TX_PARSE_BATCH_SIZE);
    const batchResults = [];
    let batchFailures = 0;
    try {
      const txs = await retryWithBackoff(
        () => options.budget ? (options.budget.consumeRequests(), connection.getParsedTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })) : connection.getParsedTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
        { retries: 2, baseMs: 300 },
      );
      for (let i = 0; i < chunk.length; i += 1) {
        if (txs[i]) batchResults.push({ tx: txs[i], sigInfo: chunk[i] });
        else batchFailures += 1;
      }
    } catch (_) {
      for (const sigInfo of chunk) {
        const parsed = await parseOne(sigInfo);
        if (parsed) batchResults.push(parsed);
        else batchFailures += 1;
      }
    }
    results.push(...batchResults);
    failures += batchFailures;
    if (await emitBatch(batchResults, batchFailures)) break;
    if (start + TX_PARSE_BATCH_SIZE < signatures.length) await new Promise((resolve) => setTimeout(resolve, options.txSleepMs ?? DEFAULT_TX_SLEEP_MS));
  }
  return { results, failures, stoppedEarly };
}

async function captureWalletActivityWindow({
  pairAddress,
  mintAddress,
  windowStartMs,
  windowEndMs,
  walletAddresses = null,
  minSol = DEFAULT_MIN_SOL,
  sigPageCap = DEFAULT_SIG_PAGE_CAP,
  maxTxParse = DEFAULT_MAX_TX_PARSE,
  pageSleepMs = DEFAULT_PAGE_SLEEP_MS,
  txSleepMs = DEFAULT_TX_SLEEP_MS,
  connection = null,
  budget = null,
  initialSigs = [],
  initialPages = 0,
  before = null,
  onPage = null,
  persist = true,
  capturedAt = Date.now(),
  valuationResolver = getHistoricalValuation,
  recordCoverage = false,
  economicTxTarget = null,
} = {}) {
  if (!pairAddress || !mintAddress || !Number.isFinite(Number(windowStartMs)) || !Number.isFinite(Number(windowEndMs))) throw new Error('pairAddress, mintAddress, windowStartMs and windowEndMs are required');
  const rpc = connection || new Connection(solana.backfillRpcUrl || solana.rpcUrl, 'confirmed');
  const walk = await walkUntilWindowCovered(pairAddress, Number(windowStartMs), sigPageCap, { connection: rpc, budget, initialSigs, initialPages, before, pageSleepMs, onPage });
  if (walk.error) {
    const result = { status: 'error', entries: [], pagesWalked: walk.pagesWalked, rawSignaturesScanned: walk.sigs.length, parseFailures: 0, error: walk.error, nextBefore: walk.nextBefore || null };
    if (recordCoverage) await recordWalletActivityCaptureCoverage({ pairAddress, mintAddress, windowStartMs: Number(windowStartMs), windowEndMs: Number(windowEndMs), walletAddresses, status: result.status, signaturesInWindow: 0, parsedEntries: 0, pagesWalked: walk.pagesWalked, resumeSignature: walk.nextBefore || null, error: walk.error });
    return result;
  }
  if (walk.sigs.length === 0) {
    const status = walk.coveredWindow ? 'complete-empty' : 'truncated';
    const result = { status, entries: [], pagesWalked: walk.pagesWalked, rawSignaturesScanned: walk.sigs.length, parseFailures: 0, signaturesInWindow: 0, nextBefore: walk.nextBefore || null };
    if (recordCoverage) await recordWalletActivityCaptureCoverage({ pairAddress, mintAddress, windowStartMs: Number(windowStartMs), windowEndMs: Number(windowEndMs), walletAddresses, status, signaturesInWindow: 0, parsedEntries: 0, pagesWalked: walk.pagesWalked, resumeSignature: walk.nextBefore || null });
    return result;
  }

  const inWindow = walk.sigs.filter((s) => s.blockTime && s.blockTime * 1000 >= Number(windowStartMs) && s.blockTime * 1000 < Number(windowEndMs));
  const toParse = inWindow.slice(0, Math.max(0, Number(maxTxParse) || 0));
  const allEntries = [];
  const abuseEvents = [];
  const walletFilter = walletAddresses ? new Set(walletAddresses) : null;
  const target = economicTxTarget === null || economicTxTarget === undefined
    ? null
    : Math.max(1, Number(economicTxTarget) || 1);
  const seenEconomicSignatures = new Set();
  const valuationForPair = valuationResolver === getHistoricalValuation
    ? await createHistoricalValuationResolver(pairAddress)
    : valuationResolver;
  const parsed = await parseTransactions(rpc, toParse, {
    budget,
    txSleepMs,
    onBatch: async (batchResults) => {
      for (const { tx, sigInfo } of batchResults) {
        const txTime = sigInfo.blockTime ? sigInfo.blockTime * 1000 : null;
        let valuation = {};
        if (txTime !== null) valuation = valuationForPair ? await valuationForPair(pairAddress, txTime) : {};
        const entries = classifyTransaction(tx, mintAddress, sigInfo, minSol, valuation, walletFilter);
        const signature = sigInfo.signature;
        const isNewEconomicTransaction = entries.length > 0 && !seenEconomicSignatures.has(signature);
        if (target !== null && isNewEconomicTransaction && seenEconomicSignatures.size >= target) {
          abuseEvents.push(...detectAbuseEvents(tx, { mintAddress, signature, slot: tx.slot, blockTime: txTime }));
          continue;
        }
        allEntries.push(...entries);
        if (entries.length > 0) seenEconomicSignatures.add(signature);
        abuseEvents.push(...detectAbuseEvents(tx, { mintAddress, signature, slot: tx.slot, blockTime: txTime }));
      }
      return target !== null && seenEconomicSignatures.size >= target;
    },
  });

  if (persist && allEntries.length > 0) {
    if (budget) budget.consumeWrites(allEntries.length);
    await patternStore.recordEarlyWalletActivity(pairAddress, mintAddress, allEntries, capturedAt);
  }

  const capped = inWindow.length > maxTxParse;
  const targetReached = target !== null && seenEconomicSignatures.size >= target;
  const status = targetReached
    ? 'target-reached'
    : !walk.coveredWindow ? 'truncated'
      : capped ? 'complete-tx-capped'
        : parsed.failures > 0 ? 'parse-incomplete' : 'complete';
  const result = { status, entries: allEntries, abuseEvents, pagesWalked: walk.pagesWalked, rawSignaturesScanned: walk.sigs.length, parseFailures: parsed.failures, signaturesInWindow: inWindow.length, parsedSignatures: parsed.results.length, economicTransactions: seenEconomicSignatures.size, targetReached, hitCap: walk.hitCap };
  if (recordCoverage) {
    await recordWalletActivityCaptureCoverage({
      pairAddress, mintAddress, windowStartMs: Number(windowStartMs), windowEndMs: Number(windowEndMs),
      walletAddresses, status, signaturesInWindow: inWindow.length, parsedEntries: allEntries.length,
      pagesWalked: walk.pagesWalked,
      resumeSignature: walk.nextBefore || null,
    });
  }
  return result;
}

async function getLegacyActivityOwners(pairAddress, walletAddresses, beforeMs) {
  const owners = [...new Set((walletAddresses || []).filter(Boolean))];
  if (!owners.length) return new Set();
  const buckets = shardPool.bucketByShard(owners);
  const results = await Promise.all(Array.from(buckets.entries()).map(([shardIndex, addrs]) =>
    shardPool.queryShard(
      shardIndex,
      `SELECT DISTINCT wallet_address
         FROM early_wallet_activity
        WHERE pair_address = $1
          AND wallet_address = ANY($2::text[])
          AND block_time IS NOT NULL
          AND block_time < $3`,
      [pairAddress, addrs, beforeMs],
    )));
  const covered = new Set();
  for (const result of results) for (const row of result.rows || []) covered.add(row.wallet_address);
  return covered;
}

async function requestMissingWalletActivity({ walletAddresses, currentPairAddress, beforeMs, maxPairs = DEFAULT_MAX_PAIRS, maxWallets = DEFAULT_MAX_WALLETS, windowMinutes = DEFAULT_WINDOW_MINUTES }) {
  const owners = [...new Set((walletAddresses || []).filter(Boolean))].slice(0, maxWallets);
  if (!owners.length || !Number.isFinite(Number(beforeMs))) return [];

  if (walletActivityEvidence.enabled) {
    const requests = [];
    for (const walletAddress of owners) {
      const state = await getWalletActivityEvidenceState(walletAddress);
      const target = Math.max(WALLET_EVIDENCE_TARGET, Number(state?.target_relevant_transactions || 0));
      const relevant = Number(state?.relevant_transactions || 0);
      const coveredBefore = Number(state?.coverage_before_ms || 0);
      const requestedBeforeMs = Number(beforeMs);
      const stateCoversRequestedCutoff = coveredBefore >= requestedBeforeMs;
      // Direction matters. A relevant-transaction COUNT produced at cutoff T2 includes activity up to T2, so
      // it can only vouch for requests whose cutoff is >= T2 (every counted transaction precedes the request).
      // It must never satisfy an earlier point-in-time cutoff T1 < T2. By contrast "history exhausted" and
      // "raw ceiling hit" are statements about the pairs before the cutoff, which remain true for any EARLIER
      // cutoff (hence stateCoversRequestedCutoff for those two below).
      const countIsValidForRequestedCutoff = coveredBefore > 0 && coveredBefore <= requestedBeforeMs;
      const targetAlreadyReached = countIsValidForRequestedCutoff && relevant >= target;
      const exhaustedAtThisCutoff = state?.status === 'end_of_history' && stateCoversRequestedCutoff;
      const rawSafetyReachedAtThisCutoff = state?.status === 'raw_safety_cap' && stateCoversRequestedCutoff;
      if (targetAlreadyReached || exhaustedAtThisCutoff || rawSafetyReachedAtThisCutoff) continue;
      requests.push({
        walletAddress,
        currentPairAddress,
        beforeMs: Number(beforeMs),
        targetRelevantTransactions: target,
        maxHistoricalPairs: WALLET_EVIDENCE_MAX_PAIRS,
        windowMinutes,
      });
    }
    return enqueueWalletEvidenceCaptureJobs(requests);
  }

  // Compatibility path for explicitly disabled wallet-level evidence mode.
  const { rows } = await query(
    `SELECT DISTINCT ON (th.pair_address)
            th.pair_address, th.mint_address, pa.pair_created_at
       FROM token_holders th
       JOIN pattern_archive pa ON pa.pair_address = th.pair_address
      WHERE th.wallet_owner = ANY($1::text[])
        AND th.pair_address <> $2
        AND th.first_captured_at < $3
        AND pa.pair_created_at IS NOT NULL
        AND pa.pair_created_at < $3
      ORDER BY th.pair_address, pa.qualified_at DESC
      LIMIT $4`,
    [owners, currentPairAddress, beforeMs, maxPairs],
  );
  if (!rows.length) return [];
  const requests = [];
  for (const row of rows) {
    const windowStartMs = Number(row.pair_created_at);
    const requestedEndMs = windowStartMs + windowMinutes * 60_000;
    const windowEndMs = Math.min(requestedEndMs, Number(beforeMs));
    if (!Number.isFinite(windowStartMs) || windowEndMs <= windowStartMs) continue;
    const coverage = await getWalletActivityCaptureCoverage({
      pairAddress: row.pair_address, mintAddress: row.mint_address, windowStartMs, windowEndMs, walletAddresses: owners,
    });
    const hasIncompleteCapture = coverage.some((entry) => ['truncated', 'complete-tx-capped', 'parse-incomplete', 'error', 'target-reached'].includes(entry.status));
    const hasCompleteCapture = coverage.some((entry) => ['complete', 'complete-empty'].includes(entry.status));
    if (hasCompleteCapture) continue;
    if (!hasIncompleteCapture && coverage.length === 0) {
      const coveredOwners = await getLegacyActivityOwners(row.pair_address, owners, beforeMs);
      if (coveredOwners.size === owners.length) continue;
    }
    requests.push({ pairAddress: row.pair_address, mintAddress: row.mint_address, windowStartMs, windowEndMs, walletAddresses: owners });
  }
  return enqueueWalletActivityCaptureJobs(requests);
}

async function listHistoricalWalletPairs(walletAddress, currentPairAddress, beforeMs, maxPairs, windowMinutes) {
  const walletHash = require('crypto').createHash('sha1').update(String(walletAddress)).digest('hex');
  const { rows } = await query(
    `SELECT pair_address, mint_address, pair_created_at
       FROM (
         SELECT DISTINCT ON (th.pair_address)
                th.pair_address, th.mint_address, pa.pair_created_at, pa.qualified_at
           FROM token_holders th
           JOIN pattern_archive pa ON pa.pair_address = th.pair_address
          WHERE th.wallet_owner = $1
            AND th.pair_address <> $2
            AND th.first_captured_at < $3
            AND pa.pair_created_at IS NOT NULL
            AND pa.pair_created_at < $3
            AND NOT EXISTS (
              SELECT 1
                FROM wallet_activity_capture_coverage c
               WHERE c.pair_address = th.pair_address
                 AND c.mint_address = th.mint_address
                 AND c.wallet_hash = $5
                 AND c.window_start_ms = pa.pair_created_at
                 AND c.window_end_ms = LEAST(
                   pa.pair_created_at + ($4::bigint * 60000),
                   $3::bigint
                 )
                 AND c.status IN ('complete', 'complete-empty', 'target-reached')
            )
          ORDER BY th.pair_address, pa.qualified_at DESC
       ) historical_pairs
      ORDER BY pair_created_at DESC, pair_address
      LIMIT $6`,
    [walletAddress, currentPairAddress || '', beforeMs, windowMinutes, walletHash, Math.max(maxPairs + 1, maxPairs)],
  );
  const pairs = rows
    .map((row) => {
      const windowStartMs = Number(row.pair_created_at);
      const requestedEndMs = windowStartMs + windowMinutes * 60_000;
      const windowEndMs = Math.min(requestedEndMs, Number(beforeMs));
      return { pairAddress: row.pair_address, mintAddress: row.mint_address, windowStartMs, windowEndMs };
    })
    .filter((row) => Number.isFinite(row.windowStartMs) && row.windowEndMs > row.windowStartMs);
  return { pairs: pairs.slice(0, maxPairs), hasMore: pairs.length > maxPairs };
}

async function processWalletEvidenceCaptureJob(payload = {}, runtimeOptions = {}) {
  const walletAddress = payload.walletAddress;
  const beforeMs = Number(payload.beforeMs);
  if (!walletAddress || !Number.isFinite(beforeMs)) throw new Error('walletAddress and beforeMs are required');
  const target = Math.max(1, Number(payload.targetRelevantTransactions) || WALLET_EVIDENCE_TARGET);
  const maxRaw = Math.max(1, Number(payload.maxRawTransactions) || WALLET_EVIDENCE_MAX_RAW);
  const maxPages = Math.max(1, Number(payload.maxPages) || WALLET_EVIDENCE_MAX_PAGES);
  const maxPairs = Math.max(1, Number(payload.maxHistoricalPairs) || WALLET_EVIDENCE_MAX_PAIRS);
  const windowMinutes = Math.max(1, Number(payload.windowMinutes) || walletActivityEvidence.windowMinutes);

  const existingStats = await patternStore.getWalletEconomicEvidenceStats(walletAddress, beforeMs, payload.currentPairAddress || null);
  let state = await getWalletActivityEvidenceState(walletAddress);
  const stateCoverageBeforeMs = Number(state?.coverage_before_ms || 0);
  // Wallet evidence state is an aggregate cache, but its relevant-transaction
  // count is only safe to reuse for a request whose cutoff is at or after the
  // cutoff that produced that state. A later cutoff must never satisfy an
  // earlier point-in-time request. The DB statistic is always cutoff-aware.
  const stateRelevantTransactions = stateCoverageBeforeMs > 0 && stateCoverageBeforeMs <= beforeMs
    ? Number(state?.relevant_transactions || 0)
    : 0;
  let relevantTransactions = Math.max(stateRelevantTransactions, existingStats.relevantTransactions);
  // raw_signatures_scanned is a per-run safety budget. It must never become
  // a lifetime wallet budget: a wallet may legitimately require many runs to
  // accumulate enough historical evidence. The persisted field records the
  // most recent run's consumption for observability.
  let rawSignaturesScanned = 0;
  const priorRawSignaturesScannedTotal = Number(state?.raw_signatures_scanned_total || state?.raw_signatures_scanned || 0);
  let pairsScanned = Number(state?.pairs_scanned || 0);
  let pagesScanned = Number(state?.pages_scanned || 0);

  if (relevantTransactions >= target) {
    state = await upsertWalletActivityEvidenceState({ walletAddress, targetRelevantTransactions: target, relevantTransactions, rawSignaturesScanned, rawSignaturesScannedTotal: priorRawSignaturesScannedTotal + rawSignaturesScanned, pairsScanned, pagesScanned, coverageBeforeMs: Math.max(Number(state?.coverage_before_ms || 0), beforeMs), lastPairAddress: state?.last_pair_address || null, lastSignature: state?.last_signature || null, status: 'target_reached' });
    return { status: 'target_reached', walletAddress, relevantTransactions, rawSignaturesScanned, pairsScanned, state };
  }

  await upsertWalletActivityEvidenceState({ walletAddress, targetRelevantTransactions: target, relevantTransactions, rawSignaturesScanned, rawSignaturesScannedTotal: priorRawSignaturesScannedTotal + rawSignaturesScanned, pairsScanned, pagesScanned, coverageBeforeMs: Math.max(Number(state?.coverage_before_ms || 0), beforeMs), lastPairAddress: state?.last_pair_address || null, lastSignature: state?.last_signature || null, status: 'running' });

  const { pairs: candidates, hasMore: hasMoreCandidates } = await listHistoricalWalletPairs(walletAddress, payload.currentPairAddress || '', beforeMs, maxPairs, windowMinutes);
  let lastPairAddress = state?.last_pair_address || null;
  let lastSignature = state?.last_signature || null;
  let pairsConsideredThisRun = 0;
  let pagesConsideredThisRun = 0;
  let captureError = false;
  let stoppedForTarget = false;
  let stoppedForRawSafety = false;
  // Status accuracy: a run is only "capped" when work genuinely remains. A pair that ends the
  // run 'truncated' (its window was not covered before the page/raw budget ran out) is
  // unresolved even when no further candidate pair exists.
  let stoppedForPageBudget = false;
  let truncatedByRaw = false;
  let truncatedByPages = false;

  for (const pair of candidates) {
    if (relevantTransactions >= target) break;
    if (pairsConsideredThisRun >= maxPairs) break;
    const coverage = await getWalletActivityCaptureCoverage({
      pairAddress: pair.pairAddress,
      mintAddress: pair.mintAddress,
      windowStartMs: pair.windowStartMs,
      windowEndMs: pair.windowEndMs,
      walletAddresses: [walletAddress],
    });
    if (coverage.some((entry) => ['complete', 'complete-empty', 'target-reached'].includes(entry.status))) continue;
    const resumableCoverage = coverage.find((entry) => entry.status === 'truncated' || entry.status === 'error' || entry.status === 'parse-incomplete' || entry.status === 'complete-tx-capped');
    const resumeSignature = resumableCoverage?.resume_signature || null;

    const rawRemaining = maxRaw - rawSignaturesScanned;
    if (rawRemaining <= 0) { stoppedForRawSafety = true; break; }
    // Signature pagination is page-granular. Never ask the walker for a page
    // that could push the wallet-level raw safety ceiling past MAX_RAW_TX.
    // If less than one full provider page remains, the ceiling is reached
    // rather than over-fetching another page and calling that safe.
    const remainingPages = maxPages - pagesConsideredThisRun;
    const pageBudget = Math.min(remainingPages, WALLET_EVIDENCE_MAX_PAGES, Math.floor(rawRemaining / WALLET_EVIDENCE_RAW_PAGE_SIZE));
    if (pageBudget <= 0) {
      if (remainingPages <= 0) { stoppedForPageBudget = true; break; }
      stoppedForRawSafety = true;
      break;
    }
    const parseBudget = Math.min(rawRemaining, walletActivityEvidence.perWindowMaxTxParse, pageBudget * WALLET_EVIDENCE_RAW_PAGE_SIZE);
    const remainingRelevant = target - relevantTransactions;
    const result = await captureWalletActivityWindow({
      pairAddress: pair.pairAddress,
      mintAddress: pair.mintAddress,
      windowStartMs: pair.windowStartMs,
      windowEndMs: pair.windowEndMs,
      walletAddresses: [walletAddress],
      minSol: walletActivityEvidence.minSol,
      sigPageCap: pageBudget,
      maxTxParse: parseBudget,
      pageSleepMs: walletActivityEvidence.pageSleepMs,
      txSleepMs: walletActivityEvidence.txSleepMs,
      economicTxTarget: remainingRelevant,
      before: resumeSignature,
      recordCoverage: true,
      connection: runtimeOptions.connection || null,
      valuationResolver: runtimeOptions.valuationResolver || getHistoricalValuation,
      persist: runtimeOptions.persist !== false,
    });

    rawSignaturesScanned += Number(result.rawSignaturesScanned || 0);
    pairsScanned += 1;
    pairsConsideredThisRun += 1;
    pagesScanned += Number(result.pagesWalked || 0);
    pagesConsideredThisRun += Number(result.pagesWalked || 0);
    lastPairAddress = pair.pairAddress;
    lastSignature = result.nextBefore || result.entries?.[result.entries.length - 1]?.signature || null;
    const afterStats = await patternStore.getWalletEconomicEvidenceStats(walletAddress, beforeMs, payload.currentPairAddress || null);
    const nextRelevant = Math.max(relevantTransactions, afterStats.relevantTransactions);
    relevantTransactions = nextRelevant;

    if (relevantTransactions >= target) { stoppedForTarget = true; break; }
    // hitCap: the walk stopped because its page budget ran out on a full page (not because history ended).
    if (result.status === 'truncated' && result.hitCap) {
      if (Math.floor((maxRaw - rawSignaturesScanned) / WALLET_EVIDENCE_RAW_PAGE_SIZE) <= 0) truncatedByRaw = true;
      else truncatedByPages = true;
    }
    if (rawSignaturesScanned >= maxRaw && !['complete', 'complete-empty', 'target-reached'].includes(result.status)) { stoppedForRawSafety = true; break; }
    if (result.status === 'error') { captureError = true; break; }
  }

  let status;
  if (stoppedForTarget || relevantTransactions >= target) status = 'target_reached';
  else if (stoppedForRawSafety || truncatedByRaw) status = 'raw_safety_cap';
  else if (captureError) status = 'error';
  // pair_safety_cap is the breadth-cap status: uncovered historical pairs remain beyond the per-run
  // pair ceiling (hasMoreCandidates) or the per-run page budget stopped the run with work pending.
  // Merely *using up* the ceiling on the final candidate is not a cap: history is exhausted.
  else if (hasMoreCandidates || stoppedForPageBudget || truncatedByPages) status = 'pair_safety_cap';
  else status = 'end_of_history';

  state = await upsertWalletActivityEvidenceState({
    walletAddress,
    targetRelevantTransactions: target,
    relevantTransactions,
    rawSignaturesScanned,
    rawSignaturesScannedTotal: priorRawSignaturesScannedTotal + rawSignaturesScanned,
    pairsScanned,
    pagesScanned,
    coverageBeforeMs: beforeMs,
    lastPairAddress,
    lastSignature,
    status,
  });
  return { status, walletAddress, relevantTransactions, rawSignaturesScanned, rawSignaturesScannedTotal: priorRawSignaturesScannedTotal + rawSignaturesScanned, pairsScanned, pairsProcessed: pairsConsideredThisRun, target, maxRaw, maxPairs, state };
}

async function processWalletActivityCaptureJob(payload) {
  if (payload?.walletEvidenceMode || payload?.walletAddress) return processWalletEvidenceCaptureJob(payload);
  return captureWalletActivityWindow(payload);
}

module.exports = {
  PAGE_RETRY_COUNT,
  PAGE_RETRY_BASE_MS,
  TX_PARSE_BATCH_SIZE,
  DEFAULT_SIG_PAGE_CAP,
  DEFAULT_MAX_TX_PARSE,
  DEFAULT_WINDOW_MINUTES,
  DEFAULT_MIN_SOL,
  isWindowCoveredBySignatures,
  walkUntilWindowCovered,
  classifyTransaction,
  captureWalletActivityWindow,
  requestMissingWalletActivity,
  processWalletEvidenceCaptureJob,
  WALLET_EVIDENCE_POLICY_VERSION,
  processWalletActivityCaptureJob,
  createHistoricalValuationResolver,
};
