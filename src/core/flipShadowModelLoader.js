'use strict';

const fs = require('fs');
const path = require('path');
const { FLIP_TIERS } = require('./flipBaseline');

/**
 * Loads baseline-model.json (train-flip-baseline.js's output) once, caches
 * it in memory, and NEVER throws — this is meant to be called from
 * tokenScanner.js's hot path (see the flipShadowPrediction attachment in
 * that file), and a missing/malformed model file must never be able to
 * affect a live alert decision. Every failure mode here degrades to
 * "no shadow prediction attached this run," logged once, not a thrown
 * error — mirrors the try/catch already wrapping buildLiveTokenEvidence's
 * call site in tokenScanner.js, just pushed one level down so that call
 * site doesn't need its own extra try/catch for this specific feature.
 *
 * Path is configurable via FLIP_SHADOW_MODEL_PATH so a deployment can point
 * at whichever baseline-model.json it actually trusts (e.g. the 72h,
 * fully-passing one from this session's investigation) without a code
 * change; defaults to the same relative path train-flip-baseline.js's own
 * --output default writes to.
 */

const DEFAULT_MODEL_PATH = path.resolve(process.cwd(), 'exports/flip-dataset/splits/baseline/baseline-model.json');

let cached; // undefined = not yet attempted, null = attempted and failed/absent, object = loaded
let warnedOnce = false;

function loadFlipShadowModel() {
  if (cached !== undefined) return cached;
  const modelPath = process.env.FLIP_SHADOW_MODEL_PATH ? path.resolve(process.env.FLIP_SHADOW_MODEL_PATH) : DEFAULT_MODEL_PATH;
  try {
    if (!fs.existsSync(modelPath)) { cached = null; return cached; }
    const raw = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    const tierModels = {};
    for (const tier of FLIP_TIERS) if (raw.tiers?.[tier]) tierModels[tier] = raw.tiers[tier];
    if (Object.keys(tierModels).length === 0) { cached = null; return cached; }
    cached = { modelVersion: raw.modelVersion, tierModels, modelPath };
  } catch (error) {
    if (!warnedOnce) { console.error(`[flipShadowModelLoader] failed to load ${modelPath}, shadow predictions disabled: ${error.message}`); warnedOnce = true; }
    cached = null;
  }
  return cached;
}

// Test-only: lets tests exercise both branches without touching the real
// filesystem cache or waiting for process restart.
function resetFlipShadowModelCache() { cached = undefined; warnedOnce = false; }

module.exports = { loadFlipShadowModel, resetFlipShadowModelCache, DEFAULT_MODEL_PATH };
