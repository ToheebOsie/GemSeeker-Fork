'use strict';

const fs = require('fs');
const path = require('path');
const { FLIP_TIERS } = require('./flipBaseline');

/**
 * Loads feature-model.json (train-flip-feature-model.js's output) once,
 * caches it in memory, and NEVER throws — same contract as
 * flipShadowModelLoader.js, and for the same reason: this is meant to be
 * called from tokenScanner.js's hot path, and a missing/malformed model
 * file must never be able to affect a live alert decision. Every failure
 * mode here degrades to "no feature-model shadow prediction attached this
 * run," logged once, not thrown.
 *
 * Deliberately a SEPARATE loader/cache from flipShadowModelLoader.js, not
 * a parameterized version of it — the two model files have genuinely
 * different shapes (tierModels' groupRates vs. tiers' featureNames/
 * featureStats/weights/bias/calibration) and are meant to be swapped,
 * missing, or updated independently of one another (e.g. retraining the
 * feature model shouldn't require touching anything about the baseline's
 * cache, and a deployment might legitimately run with only one of the two
 * present while the other is still being trained/validated).
 *
 * Path is configurable via FLIP_FEATURE_MODEL_PATH, independent of
 * FLIP_SHADOW_MODEL_PATH; defaults to the same relative path
 * train-flip-feature-model.js's own --output default writes to.
 */

const DEFAULT_MODEL_PATH = path.resolve(process.cwd(), 'exports/flip-dataset/splits/feature-model/feature-model.json');

let cached; // undefined = not yet attempted, null = attempted and failed/absent, object = loaded
let warnedOnce = false;

function loadFlipFeatureModel() {
  if (cached !== undefined) return cached;
  const modelPath = process.env.FLIP_FEATURE_MODEL_PATH ? path.resolve(process.env.FLIP_FEATURE_MODEL_PATH) : DEFAULT_MODEL_PATH;
  try {
    if (!fs.existsSync(modelPath)) { cached = null; return cached; }
    const raw = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const tierModels = {};
    for (const tier of FLIP_TIERS) {
      const tierData = raw.tiers?.[tier];
      // A tier model with no calibration is unusable here on purpose — the
      // live/scoring path always calls predictCalibrated, never the raw
      // predictProba, so an uncalibrated tier is treated the same as a
      // missing one rather than silently falling back to uncalibrated
      // output train-flip-feature-model.js never intended to be read
      // directly.
      if (tierData && tierData.calibration) tierModels[tier] = tierData;
    }
    if (Object.keys(tierModels).length === 0) { cached = null; return cached; }
    cached = { modelType: raw.modelType || null, tierModels, modelPath };
  } catch (error) {
    if (!warnedOnce) { console.error(`[flipFeatureModelLoader] failed to load ${modelPath}, feature-model shadow predictions disabled: ${error.message}`); warnedOnce = true; }
    cached = null;
  }
  return cached;
}

// Test-only: lets tests exercise both branches without touching the real
// filesystem cache or waiting for process restart.
function resetFlipFeatureModelCache() { cached = undefined; warnedOnce = false; }

module.exports = { loadFlipFeatureModel, resetFlipFeatureModelCache, DEFAULT_MODEL_PATH };
