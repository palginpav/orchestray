'use strict';

/**
 * models.js — Known-model table for Orchestray context statusbar (W3 / v2.0.19).
 *
 * Single source of truth for short-name, display-name, and context-window mapping.
 * Used by context-telemetry-cache.js (writers) and statusline.js (renderer).
 */

const MODELS = {
  'claude-opus-4-7':   { short: 'opu-4-7', display: 'Opus 4.7',   window_default: 200000, window_1m: 1000000 },
  'claude-opus-4-6':   { short: 'opu-4-6', display: 'Opus 4.6',   window_default: 200000, window_1m: 1000000 },
  'claude-sonnet-4-6': { short: 'son-4-6', display: 'Sonnet 4.6', window_default: 200000 },
  'claude-haiku-4-5':  { short: 'hai-4-5', display: 'Haiku 4.5',  window_default: 200000 },
};

// MODEL_UNKNOWN includes window_1m so the observed-tokens bump (statusline.js
// `bumpWindowIfObservedExceeds`) can rescue render correctness when a fresh
// Claude model ships before this table is updated. Better to bump to 1M and
// be wrong by ~2x for a hypothetical 500K-context model than to render an
// impossible >100% fill that the user will assume is a bug.
const MODEL_UNKNOWN = { short: '?', display: 'unknown', window_default: 200000, window_1m: 1000000 };

/**
 * Look up model metadata by full model ID string.
 * Returns the metadata entry if known, or MODEL_UNKNOWN for unrecognized IDs.
 *
 * Strips a trailing `[1m]` suffix (e.g. "claude-opus-4-6[1m]") before table
 * lookup so the 1M-context variant resolves to the same metadata entry as the
 * base model. The suffix is the signal for window_1m selection, handled in
 * resolveContextWindow.
 *
 * @param {string|null} modelId - e.g. "claude-opus-4-6" or "claude-opus-4-6[1m]"
 * @returns {{ short: string, display: string, window_default: number, window_1m?: number }}
 */
function lookupModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return MODEL_UNKNOWN;
  const baseId = modelId.replace(/\[1m\]$/i, '');
  return MODELS[baseId] || MODELS[modelId] || MODEL_UNKNOWN;
}

/**
 * Determine the effective context window size for a model.
 *
 * For Opus 4.6, two signals indicate the 1M-context variant:
 *   1. A `[1m]` suffix on the model ID (e.g. "claude-opus-4-6[1m]").
 *   2. A display name that contains a 1M reference (e.g. "Opus 4.6 (1M context)",
 *      "with 1M context", etc.) — matched case-insensitively via /\b1\s*M\b/.
 *
 * Either signal alone is sufficient; both are checked to handle whichever the
 * Claude Code runtime provides.
 *
 * @param {string|null} modelId      - Full model ID, e.g. "claude-opus-4-6" or "claude-opus-4-6[1m]".
 * @param {string|null} displayName  - Human-readable name from statusLine stdin, e.g. "Opus 4.6 (1M context)".
 * @returns {number} Token count of the context window.
 */
function resolveContextWindow(modelId, displayName) {
  const meta = lookupModel(modelId);
  if (meta.window_1m) {
    const viaSuffix  = /\[1m\]$/i.test(modelId || '');
    const viaDisplay = /\b1\s*M\b/i.test(displayName || '');
    if (viaSuffix || viaDisplay) return meta.window_1m;
  }
  return meta.window_default;
}

/**
 * Derive a short display name for a model ID.
 * @param {string|null} modelId
 * @returns {string}
 */
function modelShort(modelId) {
  return lookupModel(modelId).short;
}

module.exports = { MODELS, MODEL_UNKNOWN, lookupModel, resolveContextWindow, modelShort };
