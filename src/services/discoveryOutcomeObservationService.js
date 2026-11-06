'use strict';

const dexscreenerService = require('./dexscreenerService');
const { upsertDiscoveryObservation } = require('../storage/discoveryObservationStore');

function findPair(pairs, pairAddress) {
  return (pairs || []).find((pair) => pair.pairAddress === pairAddress) || null;
}

async function collectDiscoveryOutcomeObservation({ discoveryEventId, pairAddress, mintAddress, source, horizonKey, targetAt }) {
  const observedAt = new Date();
  try {
    const pairs = await dexscreenerService.getPairsForToken(mintAddress);
    const pair = findPair(pairs, pairAddress);
    if (!pair || !pair.priceUsd) {
      return upsertDiscoveryObservation({ discoveryEventId, horizonKey, targetAt, observedAt, status: 'unavailable', dataQualityStatus: 'unavailable', source: 'dexscreener', sourceObservedAt: observedAt, pairResolvable: false, errorCode: 'pair_not_resolvable', rawObservation: { pairCount: pairs ? pairs.length : 0 } });
    }
    return upsertDiscoveryObservation({
      discoveryEventId, horizonKey, targetAt, observedAt, status: 'complete', dataQualityStatus: 'complete', source: 'dexscreener', sourceObservedAt: observedAt, pairResolvable: true,
      priceUsd: Number(pair.priceUsd) || null,
      marketCapUsd: Number(pair.marketCap ?? pair.fdv) || null,
      liquidityUsd: Number(pair.liquidity?.usd) || null,
      volume1h: Number(pair.volume?.h1) || null,
      rawObservation: { pairAddress: pair.pairAddress, dexId: pair.dexId, priceUsd: pair.priceUsd, marketCap: pair.marketCap, fdv: pair.fdv, liquidity: pair.liquidity, volume: pair.volume },
    });
  } catch (err) {
    return upsertDiscoveryObservation({ discoveryEventId, horizonKey, targetAt, observedAt, status: 'failed', dataQualityStatus: 'unavailable', source: 'discovery-observation-worker', pairResolvable: null, errorCode: String(err.message || 'discovery_observation_failed').slice(0, 500) });
  }
}

module.exports = { collectDiscoveryOutcomeObservation, findPair };
