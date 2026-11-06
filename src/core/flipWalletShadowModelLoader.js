'use strict';

const fs = require('fs');
const path = require('path');
const { sha256 } = require('./mlDatasetQuality');

/**
 * Loads wallet-shadow-model.json (train-flip-wallet-shadow.js's output)
 * once, caches it in memory, and NEVER throws — same contract, same
 * reasoning, and the same undefined/null/object cache-state convention as
 * flipFeatureModelLoader.js and flipShadowModelLoader.js: this is called
 * from tokenScanner.js's hot path, and a missing/malformed model file
 * must never be able to affect a live alert decision.
 *
 * A SEPARATE loader/cache from both existing loaders, not a parameterized
 * version of either — same reasoning as flipFeatureModelLoader.js's own
 * header comment on why it's separate from flipShadowModelLoader.js:
 * this model file has a genuinely different shape (two named variants,
 * baseline and walletEnhanced, sharing one target) and is meant to be
 * retrained/redeployed independently of the other two shadow models.
 *
 * Both baseline AND walletEnhanced must be present, calibrated, and
 * STRUCTURALLY SOUND (every weight/bias/calibration coefficient/feature
 * stat finite, and weights.length matching featureNames.length exactly)
 * for the cache to resolve to a usable object — buildWalletShadowPrediction
 * (see flipWalletShadowModel.js) always needs both together to produce one
 * comparison record, so a file with only one usable variant, or a variant
 * that LOOKS well-shaped but contains a non-finite value or a length
 * mismatch, is treated the same as a missing file, not a partial or
 * best-effort result. This is a real, not theoretical, distinction: a
 * single non-finite weight doesn't throw at inference time — `null * x`
 * silently coerces to 0 in JS, quietly zeroing that feature's
 * contribution — and a weights/featureNames length mismatch produces a
 * NaN probability that JSON.stringify then silently serializes as `null`
 * once it's written into the live_evidence JSONB column, indistinguishable
 * from "no shadow prediction was computed." Both were confirmed by
 * constructing them directly, not just reasoned about. Validating shape
 * (Array.isArray) is not the same as validating VALUES (Number.isFinite),
 * and only the latter actually rules these out.
 *
 * modelHash: reuses this repo's one existing model-hashing utility
 * (mlDatasetQuality.js's sha256(filePath), the same function
 * train-flip-feature-model.js's own manifest already uses for its
 * artifactHashes) rather than inventing a second hashing scheme. Computed
 * over the WHOLE model file and applied to both baselineModelHash and
 * walletModelHash — baseline and walletEnhanced are persisted together in
 * this one artifact file, so that one file hash is what "the actual model
 * artifact being used for inference" genuinely refers to for either
 * variant; the two variants already have distinct, non-hash identifiers
 * via MODEL_VERSIONS (flip-hit5x-baseline-v1 / flip-hit5x-wallet-
 * enhanced-v1) in flipWalletShadowModel.js, computed once, not hardcoded
 * per invocation.
 *
 * Path is configurable via FLIP_WALLET_SHADOW_MODEL_PATH, independent of
 * FLIP_FEATURE_MODEL_PATH/FLIP_SHADOW_MODEL_PATH; defaults to the same
 * relative path train-flip-wallet-shadow.js's own --output default writes
 * to. This is a path override only — same as the other two loaders —
 * never an enable/disable switch: whether a shadow prediction gets
 * attached is decided entirely by whether a usable file exists at this
 * path, not by any separate config flag.
 */

const DEFAULT_MODEL_PATH = path.resolve(process.cwd(), 'exports/flip-dataset/splits/wallet-shadow-model/wallet-shadow-model.json');

let cached; // undefined = not yet attempted, null = attempted and failed/absent, object = loaded
let warnedOnce = false;

function isUsableVariant(variant) {
  if (!variant || !variant.calibration) return false;
  if (!Array.isArray(variant.featureNames) || variant.featureNames.length === 0) return false;
  if (!Array.isArray(variant.weights) || variant.weights.length !== variant.featureNames.length) return false;
  if (!variant.weights.every((w) => Number.isFinite(w))) return false;
  if (!Number.isFinite(variant.bias)) return false;
  if (!Number.isFinite(variant.calibration.a) || !Number.isFinite(variant.calibration.b)) return false;
  if (!variant.featureStats || !variant.featureNames.every((name) => {
    const s = variant.featureStats[name];
    return s && Number.isFinite(s.median) && Number.isFinite(s.mean) && Number.isFinite(s.std);
  })) return false;
  return true;
}

function loadFlipWalletShadowModel() {
  if (cached !== undefined) return cached;
  const modelPath = process.env.FLIP_WALLET_SHADOW_MODEL_PATH ? path.resolve(process.env.FLIP_WALLET_SHADOW_MODEL_PATH) : DEFAULT_MODEL_PATH;
  try {
    if (!fs.existsSync(modelPath)) { cached = null; return cached; }
    const raw = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    if (!isUsableVariant(raw.baseline) || !isUsableVariant(raw.walletEnhanced)) { cached = null; return cached; }
    const modelHash = sha256(modelPath);
    cached = {
      targetName: raw.targetName || null,
      threshold: raw.threshold ?? null,
      modelPath,
      baseline: { ...raw.baseline, modelVersion: raw.baseline.modelVersion || null, modelHash },
      walletEnhanced: { ...raw.walletEnhanced, modelVersion: raw.walletEnhanced.modelVersion || null, modelHash },
    };
  } catch (error) {
    if (!warnedOnce) { console.error(`[flipWalletShadowModelLoader] failed to load ${modelPath}, wallet shadow predictions disabled: ${error.message}`); warnedOnce = true; }
    cached = null;
  }
  return cached;
}

// Test-only: lets tests exercise both branches without touching the real
// filesystem cache or waiting for process restart.
function resetFlipWalletShadowModelCache() { cached = undefined; warnedOnce = false; }

module.exports = { loadFlipWalletShadowModel, resetFlipWalletShadowModelCache, DEFAULT_MODEL_PATH };
