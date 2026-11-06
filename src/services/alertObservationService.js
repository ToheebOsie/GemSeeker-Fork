'use strict';

const dexscreenerService = require('./dexscreenerService');
const rugcheckService = require('./rugcheckService');
const { upsertObservation } = require('../storage/alertObservationStore');

function findPair(pairs, pairAddress) {
  return (pairs || []).find((pair) => pair.pairAddress === pairAddress) || null;
}

function normalizePairObservation(pair, observedAt) {
  const txns1h = (pair.txns && pair.txns.h1) || {};
  return {
    observedAt,
    source: 'dexscreener',
    sourceObservedAt: observedAt,
    pairResolvable: true,
    priceUsd: Number(pair.priceUsd) || null,
    marketCapUsd: Number(pair.marketCap ?? pair.fdv) || null,
    liquidityUsd: pair.liquidity && Number(pair.liquidity.usd) || null,
    volume1h: pair.volume && Number(pair.volume.h1) || null,
    buys1h: Number(txns1h.buys) || null,
    sells1h: Number(txns1h.sells) || null,
    rawObservation: {
      pairAddress: pair.pairAddress,
      dexId: pair.dexId,
      url: pair.url,
      priceUsd: pair.priceUsd,
      marketCap: pair.marketCap,
      fdv: pair.fdv,
      liquidity: pair.liquidity,
      volume: pair.volume,
      txns: pair.txns,
    },
  };
}

async function collectAlertObservation({ alertId, pairAddress, mintAddress, horizonKey, targetAt }) {
  const observedAt = new Date();
  try {
    const pairs = await dexscreenerService.getPairsForToken(mintAddress);
    const pair = findPair(pairs, pairAddress);
    if (!pair || !pair.priceUsd) {
      return upsertObservation({
        alertId,
        horizonKey,
        targetAt,
        observedAt,
        status: 'unavailable',
        dataQualityStatus: 'unavailable',
        source: 'dexscreener',
        sourceObservedAt: observedAt,
        pairResolvable: false,
        errorCode: 'pair_not_resolvable',
        rawObservation: { pairCount: pairs ? pairs.length : 0 },
      });
    }

    const observation = normalizePairObservation(pair, observedAt);
    let safety = null;
    try {
      const report = await rugcheckService.getTokenReport(mintAddress);
      const candidate = rugcheckService.extractSafetySignals(report, pairAddress);
      if (candidate && candidate.available) safety = candidate;
    } catch (err) {
      console.warn(`[alert-observation] Rugcheck unavailable for ${mintAddress}: ${err.message}`);
    }

    return upsertObservation({
      alertId,
      horizonKey,
      targetAt,
      ...observation,
      status: safety ? 'complete' : 'partial',
      dataQualityStatus: safety ? 'complete' : 'partial',
      topHolderPct: safety ? safety.topHolderPct : null,
      lpLockedPct: safety ? safety.lpLockedPct : null,
      mintAuthorityHeld: safety ? safety.mintAuthorityHeld : null,
      freezeAuthorityHeld: safety ? safety.freezeAuthorityHeld : null,
      rawObservation: { ...observation.rawObservation, safety },
      errorCode: safety ? null : 'safety_unavailable',
    });
  } catch (err) {
    return upsertObservation({
      alertId,
      horizonKey,
      targetAt,
      observedAt,
      status: 'failed',
      dataQualityStatus: 'unavailable',
      source: 'research-worker',
      pairResolvable: null,
      errorCode: String(err.message || 'observation_failed').slice(0, 500),
      rawObservation: null,
    });
  }
}

module.exports = { collectAlertObservation, findPair, normalizePairObservation };
