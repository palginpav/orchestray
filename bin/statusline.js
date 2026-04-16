#!/usr/bin/env node
'use strict';

/**
 * statusline.js — Context status bar renderer for Claude Code's statusLine hook.
 *
 * Reads one small JSON cache file and emits a single fixed-width ASCII line.
 * Zero transcript parsing. Zero subprocess spawns.
 *
 * Stdout contract: exactly one LF-terminated line. Always exits 0.
 * On any error: prints an empty line and exits 0 (fail-open).
 *
 * W3 / v2.0.19 Pillar B. Design: .orchestray/kb/artifacts/2019-design-telemetry-statusbar.md §4.
 */

const fs   = require('fs');
const path = require('path');

const { readCache }               = require('./_lib/context-telemetry-cache');
const { lookupModel, resolveContextWindow, modelShort } = require('./_lib/models');
const { loadContextStatusbarConfig } = require('./_lib/config-schema');

// ── Stdin / CLI flags ─────────────────────────────────────────────────────────

// --dump-stdin: diagnostic helper to verify the statusLine payload shape.
const DUMP_STDIN = process.argv.includes('--dump-stdin');

const MAX_INPUT_BYTES = 256 * 1024; // 256 KB cap — far above realistic payload

// ── Formatting helpers ────────────────────────────────────────────────────────

/**
 * Format a token count as a human-readable K/M string with 1 significant decimal
 * past the thousand/million boundary. No trailing zeros.
 *
 * e.g. 356000 → "356K", 1200000 → "1.2M", 850 → "850", 19000 → "19K"
 *
 * @param {number} n
 * @returns {string}
 */
function formatTokens(n) {
  if (typeof n !== 'number' || isNaN(n) || n < 0) return '?';
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    const rounded = Math.round(m * 10) / 10;
    return (rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded)) + 'M';
  }
  if (n >= 1000) {
    const k = n / 1000;
    const rounded = Math.round(k * 10) / 10;
    return (rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded)) + 'K';
  }
  return String(Math.round(n));
}

/**
 * Compute fill percentage, capped at 99 to avoid "100%" overflowing 3 digits.
 *
 * @param {number} tokens
 * @param {number} window
 * @returns {string} e.g. "36%"
 */
function pct(tokens, window) {
  if (!window || window <= 0) return '?%';
  const p = Math.floor((tokens / window) * 100);
  return Math.min(p, 99) + '%';
}

/**
 * Pressure marker to append inside the bracket (after the model token).
 * <75%  → ''
 * 75-89% → '!'
 * 90%+  → '!!'
 *
 * @param {number} tokens
 * @param {number} window
 * @param {{ warn: number, critical: number }} thresholds
 * @returns {string}
 */
function pressureMarker(tokens, window, thresholds) {
  if (!window || window <= 0) return '';
  const p = (tokens / window) * 100;
  if (p >= thresholds.critical) return '!!';
  if (p >= thresholds.warn)     return '!';
  return '';
}

/**
 * Render a 2-char effort code.
 * low → lo, medium → md, high → hi, max → mx, null/'' → -
 *
 * @param {string|null} effort
 * @returns {string}
 */
function effortCode(effort) {
  switch ((effort || '').toLowerCase()) {
    case 'low':    return 'lo';
    case 'medium': return 'md';
    case 'high':   return 'hi';
    case 'max':    return 'mx';
    default:       return '-';
  }
}

/**
 * Render a 3-char agent type code.
 * Takes the first 3 characters of the agent_type string. Defaults to '???'.
 *
 * @param {string|null} agentType
 * @returns {string}
 */
function typeCode(agentType) {
  if (!agentType || typeof agentType !== 'string') return '???';
  return agentType.slice(0, 3).toLowerCase();
}

// ── Block renderers ───────────────────────────────────────────────────────────

/**
 * Render the parent session block.
 * Format: [ctx PCT FILL/TOTAL MODEL]
 * With pressure: [ctx PCT!  FILL/TOTAL MODEL] or [ctx PCT!! FILL/TOTAL MODEL]
 *
 * @param {object} session - cache.session
 * @param {number} contextWindow
 * @param {{ warn: number, critical: number }} thresholds
 * @param {string|null} modelId
 * @returns {string}
 */
function renderParent(session, contextWindow, thresholds, modelId) {
  const tokens  = (session && session.tokens && session.tokens.total_prompt) || 0;
  const fill    = formatTokens(tokens);
  const total   = formatTokens(contextWindow);
  const p       = pct(tokens, contextWindow);
  const marker  = pressureMarker(tokens, contextWindow, thresholds);
  const model   = modelShort(modelId || (session && session.model));

  return '[ctx ' + p + marker + ' ' + fill + '/' + total + ' ' + model + ']';
}

/**
 * Render one subagent block.
 * Format: [TYPE3 PCT FILL/TOTAL MODEL3 EFFORT2]
 *
 * @param {object} agent
 * @param {{ warn: number, critical: number }} thresholds
 * @returns {string}
 */
function renderSubagent(agent, thresholds) {
  const tokens = (agent.tokens && agent.tokens.total_prompt) || 0;
  const window = agent.context_window || 200000;
  const fill   = formatTokens(tokens);
  const total  = formatTokens(window);
  const p      = pct(tokens, window);
  const marker = pressureMarker(tokens, window, thresholds);
  const model  = modelShort(agent.model);
  const type   = typeCode(agent.agent_type);
  const effort = effortCode(agent.effort);

  return '[' + type + ' ' + p + marker + ' ' + fill + '/' + total + ' ' + model + ' ' + effort + ']';
}

/**
 * Truncate a string to `maxLen` characters, appending '...' if truncated.
 *
 * @param {string} s
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(s, maxLen) {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

// ── Main render ───────────────────────────────────────────────────────────────

/**
 * Render the full status line from cache data and parsed stdin payload.
 *
 * @param {object} cache     - Context telemetry cache object.
 * @param {object} payload   - Parsed statusLine stdin payload.
 * @param {object} config    - Context statusbar config.
 * @returns {string}         - Single line, no trailing LF.
 */
function render(cache, payload, config) {
  if (!config.enabled) return '';

  // Session ID check: if cache is for a different session, show stale marker.
  const cacheSessionId   = cache.session_id;
  const payloadSessionId = payload.session_id || null;
  const stale = payloadSessionId && cacheSessionId && cacheSessionId !== payloadSessionId;

  // Resolve model info from payload (preferred) or cache.
  const payloadModel   = (payload.model && payload.model.id) || null;
  const payloadDisplay = (payload.model && payload.model.display_name) || null;
  const sessionModel   = payloadModel || (cache.session && cache.session.model) || null;
  const contextWindow  = resolveContextWindow(sessionModel, payloadDisplay);

  const thresholds = config.pressure_thresholds || { warn: 75, critical: 90 };
  const widthCap   = config.width_cap || 120;

  // Parent block.
  let line;
  if (stale) {
    line = '[ctx (other-session)]';
  } else {
    line = renderParent(cache.session, contextWindow, thresholds, sessionModel);
  }

  // Subagent blocks (only when not stale and there are active subagents).
  const subagents = (!stale && Array.isArray(cache.active_subagents) && cache.active_subagents.length > 0)
    ? cache.active_subagents
    : [];

  if (subagents.length > 0) {
    const parts = subagents.map((a) => renderSubagent(a, thresholds));
    const combined = line + ' > ' + parts.join(' ');
    line = truncate(combined, widthCap);
  } else {
    line = truncate(line, widthCap);
  }

  return line;
}

// ── Entry point ───────────────────────────────────────────────────────────────

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write('\n');
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    // Stdin too large — fail-open.
    process.stderr.write('[statusline] stdin exceeded limit\n');
    process.stdout.write('\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    // Parse stdin payload.
    let payload = {};
    try { payload = JSON.parse(input || '{}'); } catch (_e) { /* treat as empty */ }

    // --dump-stdin: write the parsed payload to stderr for diagnostic use.
    if (DUMP_STDIN) {
      process.stderr.write('[statusline] stdin payload: ' + JSON.stringify(payload, null, 2) + '\n');
    }

    // Resolve project dir: prefer CLAUDE_PROJECT_DIR env, then payload.cwd.
    const projectDir = process.env.CLAUDE_PROJECT_DIR || payload.cwd || process.cwd();

    // Load config (fail-open to defaults).
    let config;
    try { config = loadContextStatusbarConfig(projectDir); } catch (_e) {
      config = { enabled: true, unicode: false, color: false, width_cap: 120, pressure_thresholds: { warn: 75, critical: 90 } };
    }

    // Read the telemetry cache (fail-open to skeleton).
    let cache;
    try { cache = readCache(projectDir); } catch (_e) {
      cache = { session_id: null, session: null, active_subagents: [] };
    }

    const line = render(cache, payload, config);
    process.stdout.write(line + '\n');
  } catch (_err) {
    // Strict fail-open: never a stack trace, never multi-line.
    process.stdout.write('\n');
  }
  process.exit(0);
});
