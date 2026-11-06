'use strict';

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rate(current, previous, elapsedHours) {
  if (current === null || previous === null || !(elapsedHours > 0)) return null;
  return (current - previous) / elapsedHours;
}

function deriveNarrativeAttention(current, previous = null, opts = {}) {
  const elapsedHours = numberOrNull(opts.elapsedHours) ?? 1;
  const mentions = numberOrNull(current?.attention?.mentions);
  const authors = numberOrNull(current?.attention?.uniqueAuthors);
  const engagement = numberOrNull(current?.attention?.engagement);
  const trendInterest = numberOrNull(current?.attention?.trendInterest);
  const volume = numberOrNull(current?.market?.volumeUsd1h);
  const buyers = numberOrNull(current?.market?.uniqueBuyers);
  const holders = numberOrNull(current?.market?.holderCount);
  const liquidity = numberOrNull(current?.market?.liquidityUsd);
  const prior = previous || {};
  const mentionVelocity = rate(mentions, numberOrNull(prior?.attention?.mentions), elapsedHours);
  const priorVelocity = numberOrNull(prior?.derived?.mentionVelocity);
  const mentionAcceleration = mentionVelocity === null || priorVelocity === null ? null : (mentionVelocity - priorVelocity) / elapsedHours;
  const sourceCount = numberOrNull(current?.attention?.sourceCount);
  // Keep independent dimensions independent: authors and sources are not additive.
  const attentionBreadth = { uniqueAuthors: authors, sourceCount };
  const priorVolume = numberOrNull(prior?.market?.volumeUsd1h);
  const priorBuyers = numberOrNull(prior?.market?.uniqueBuyers);
  const priorHolders = numberOrNull(prior?.market?.holderCount);
  const priorLiquidity = numberOrNull(prior?.market?.liquidityUsd);
  const marketActivityVelocity = [rate(volume, priorVolume, elapsedHours), rate(buyers, priorBuyers, elapsedHours), rate(holders, priorHolders, elapsedHours), rate(liquidity, priorLiquidity, elapsedHours)].filter((x) => x !== null);
  // This is not a true attention-to-capital conversion measure. Leave it unknown
  // until a validated, time-aligned market response metric is supplied.
  const capitalConversion = null;
  const ageMinutes = numberOrNull(current?.market?.medianTokenAgeMinutes);
  const saturation = numberOrNull(opts.saturation);
  let state = 'UNKNOWN';
  if (mentions !== null && mentions > 0) {
    if (saturation !== null && saturation >= (opts.saturationThreshold ?? 0.8)) state = 'SATURATED';
    else if (mentionVelocity !== null && mentionVelocity < 0) state = 'DECLINING';
    else if (mentionVelocity !== null && mentionVelocity > 0 && authors !== null && authors > 1) {
      state = capitalConversion !== null && capitalConversion >= (opts.hotConversionThreshold ?? 0.75) && authors >= (opts.hotMinAuthors ?? 5) ? 'HOT' : 'EXPANDING';
    } else state = 'EMERGING';
  }
  return {
    narrativeTag: current?.narrativeTag || null,
    observedAt: current?.observedAt ?? null,
    mentionVelocity,
    mentionAcceleration,
    engagementVelocity: rate(engagement, numberOrNull(prior?.attention?.engagement), elapsedHours),
    trendVelocity: rate(trendInterest, numberOrNull(prior?.attention?.trendInterest), elapsedHours),
    attentionBreadth,
    marketActivityVelocity: marketActivityVelocity.length ? marketActivityVelocity.reduce((a, b) => a + b, 0) / marketActivityVelocity.length : null,
    capitalConversion,
    capitalConversionStatus: 'unavailable_until_validated_time_aligned_measurement',
    narrativeAgeMinutes: ageMinutes,
    lifecycleState: state,
  };
}

function deriveNarrativeAttentionBatch(observations, previousByNarrative = {}, opts = {}) {
  return (Array.isArray(observations) ? observations : []).map((observation) => deriveNarrativeAttention(observation, previousByNarrative[observation.narrativeTag] || null, opts));
}

module.exports = { deriveNarrativeAttention, deriveNarrativeAttentionBatch };
