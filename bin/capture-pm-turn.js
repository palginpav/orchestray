#!/usr/bin/env node
'use strict';

/**
 * Stop hook — capture PM-turn usage from the session transcript.
 *
 * On every Stop event (session agent turn ends), this hook reads the last
 * assistant message's `usage` block from the session transcript JSONL and
 * appends a `pm_turn` row to `.orchestray/metrics/agent_metrics.jsonl`.
 *
 * Without this, PM cache-hit and token cost are entirely unmeasured
 * (subagent SubagentStop fires for delegated agents only — never the PM itself).
 *
 * Design spec: v2017-design.md §4.2 (PM-turn capture) / §9 G1 T3.
 * Fail-open contract: any error → log stderr → exit 0 (never block Stop).
 * Respects ORCHESTRAY_METRICS_DISABLED=1.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { resolveSafeCwd }           = require('./_lib/resolve-project-cwd');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { MAX_INPUT_BYTES }          = require('./_lib/constants');
const { appendJsonlWithRotation }  = require('./_lib/jsonl-rotate');
const { extractLastAssistantUsage } = require('./_lib/transcript-usage');
const { safeRealpath, isInsideAllowed, encodeProjectPath } = require('./_lib/path-containment');
const { updateCache }              = require('./_lib/context-telemetry-cache');
const { lookupModel, resolveContextWindow } = require('./_lib/models');

// ── Self-test mode ────────────────────────────────────────────────────────────
// `node bin/capture-pm-turn.js --self-test` smoke-tests the extraction logic
// with a synthetic in-memory transcript and exits 0 on success.
if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

// ── Transcript parsing ────────────────────────────────────────────────────────
// extractLastAssistantUsage is now provided by bin/_lib/transcript-usage.js (W3 / v2.0.19).
// The import at the top of this file replaces the former inline definition.
// The self-test below still exercises the shared helper end-to-end.

// ── Session telemetry side-effect ─────────────────────────────────────────────
/**
 * Update the context-telemetry cache with the latest PM session token counts.
 * Also runs the janitor pass to reap stale subagent rows and recover lost ones.
 *
 * Called from the Stop hook main body after the pm_turn metrics row is written.
 * Fail-open: any error is swallowed so the metrics write is never blocked.
 *
 * @param {string} cwd            - Absolute project root.
 * @param {object} extracted      - Result from extractLastAssistantUsage.
 * @param {object} event          - Raw hook payload (session_id, transcript_path).
 */
function updateSessionTelemetry(cwd, extracted, event) {
  try {
    const sessionId = event.session_id || null;

    updateCache(cwd, (cache) => {
      // Update session token counts.
      const u = extracted.usage;
      cache.session = Object.assign({}, cache.session || {}, {
        model:          extracted.model_used || (cache.session && cache.session.model) || null,
        model_display:  null, // Populated by renderer from models.js at render time.
        context_window: resolveContextWindow(extracted.model_used, null),
        tokens: {
          input:          u.input_tokens,
          output:         u.output_tokens,
          cache_read:     u.cache_read_input_tokens,
          cache_creation: u.cache_creation_input_tokens,
          total_prompt:   u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
        },
        last_turn_at: extracted.timestamp,
      });

      // Janitor: walk the subagents directory and self-heal.
      // Runs on every Stop tick (~10-60s cadence).
      try {
        if (sessionId) {
          _janitorPass(cwd, sessionId, cache);
        }
      } catch (_e) {
        // Janitor is best-effort; never block the cache write.
      }

      return cache;
    });
  } catch (err) {
    process.stderr.write('[orchestray] capture-pm-turn: updateSessionTelemetry failed (fail-open): ' + String(err) + '\n');
  }
}

/**
 * Janitor pass: reconcile active_subagents[] with the .meta.json files on disk.
 *
 * 1. Adds any agent-<id> whose .jsonl was mtime-touched in the last 60s but is
 *    missing from active_subagents[] (recovers from lost SubagentStart events).
 * 2. Removes any row in active_subagents[] whose .jsonl mtime is older than 60s
 *    AND whose last_seen_at is older than 60s (recovers from lost SubagentStop events).
 *
 * Mutates `cache.active_subagents` in place.
 *
 * @param {string} cwd
 * @param {string} sessionId
 * @param {object} cache  - Cache object (mutated in place).
 */
function _janitorPass(cwd, sessionId, cache) {
  const subDir = path.join(os.homedir(), '.claude', 'projects',
    '-' + encodeProjectPath(cwd),
    sessionId, 'subagents');

  let entries;
  try {
    entries = fs.readdirSync(subDir);
  } catch (_e) {
    return; // Subagents dir does not exist yet — nothing to do.
  }

  const now = Date.now();
  const STALE_MS = 60000; // 60 seconds

  // Build a set of active agent_ids for O(1) lookup.
  if (!Array.isArray(cache.active_subagents)) cache.active_subagents = [];
  const activeIds = new Set(cache.active_subagents.map((r) => r.agent_id));

  // 1. Recover lost SubagentStart: .jsonl mtime-touched in last 60s but not in active_subagents.
  for (const entry of entries) {
    const match = entry.match(/^agent-([^.]+)\.jsonl$/);
    if (!match) continue;
    const agentId = match[1];
    if (activeIds.has(agentId)) continue;

    const jsonlPath = path.join(subDir, entry);
    let mtime;
    try { mtime = fs.statSync(jsonlPath).mtimeMs; } catch (_e) { continue; }
    if (now - mtime > STALE_MS) continue; // Not recently active — skip.

    // Recover: read .meta.json for type info.
    const metaPath = path.join(subDir, 'agent-' + agentId + '.meta.json');
    const meta = (() => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_e) { return null; } })();

    cache.active_subagents.push({
      agent_id:        agentId,
      agent_type:      (meta && meta.agentType) || 'unknown',
      description:     (meta && meta.description) || null,
      model:           (meta && meta.model) || null,
      effort:          null,
      context_window:  resolveContextWindow((meta && meta.model) || null, null),
      tokens:          null,
      started_at:      new Date(mtime).toISOString(),
      last_seen_at:    new Date(mtime).toISOString(),
      transcript_path: jsonlPath,
    });
    activeIds.add(agentId);
  }

  // 2. Reap stale rows: both .jsonl mtime AND last_seen_at older than 60s.
  cache.active_subagents = cache.active_subagents.filter((row) => {
    const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (now - lastSeen <= STALE_MS) return true; // Recently seen — keep.

    // Check .jsonl mtime.
    const tPath = row.transcript_path;
    if (tPath) {
      try {
        const mtime = fs.statSync(tPath).mtimeMs;
        if (now - mtime <= STALE_MS) return true; // File recently touched — keep.
      } catch (_e) { /* file gone — fall through to reap */ }
    }
    return false; // Both stale — remove.
  });
}

// ── Self-test ─────────────────────────────────────────────────────────────────
function runSelfTest() {
  // Build a synthetic two-entry transcript (user then assistant).
  // extractLastAssistantUsage is now from bin/_lib/transcript-usage.js (W3 / v2.0.19).
  const synthetic = [
    JSON.stringify({ role: 'user', content: 'ping' }),
    JSON.stringify({
      role: 'assistant',
      content: 'pong',
      model: 'claude-sonnet-4-6',
      timestamp: '2026-01-01T00:00:00.000Z',
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 800,
        cache_creation_input_tokens: 0,
      },
    }),
  ].join('\n') + '\n';

  const tmpFile = path.join(os.tmpdir(), `capture-pm-turn-selftest-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, synthetic, 'utf8');
    const result = extractLastAssistantUsage(tmpFile);
    if (!result) throw new Error('extractLastAssistantUsage returned null');
    if (result.usage.input_tokens !== 1000) throw new Error(`input_tokens mismatch: ${result.usage.input_tokens}`);
    if (result.usage.cache_read_input_tokens !== 800) throw new Error(`cache_read mismatch`);
    if (result.model_used !== 'claude-sonnet-4-6') throw new Error(`model_used mismatch: ${result.model_used}`);
    process.stdout.write('[capture-pm-turn] self-test PASS\n');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_e) { /* ignore */ }
  }
}

// ── Main hook ─────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => {
  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) {
    process.stderr.write('[orchestray] capture-pm-turn: hook stdin exceeded limit; aborting\n');
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }
});
process.stdin.on('end', () => {
  try {
    // Respect metrics kill-switch.
    if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const event = JSON.parse(input || '{}');
    const cwd   = resolveSafeCwd(event.cwd);

    // Stop event provides transcript_path (the session agent's own transcript).
    const transcriptPath = event.transcript_path || null;
    if (!transcriptPath) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Path containment: use shared helper (W3 / v2.0.19 — replaces inline check).
    const resolved    = safeRealpath(transcriptPath);
    const cwdResolved = safeRealpath(cwd);
    const claudeHome  = safeRealpath(path.join(os.homedir(), '.claude'));

    if (!isInsideAllowed(resolved, cwdResolved, claudeHome)) {
      process.stderr.write('[orchestray] capture-pm-turn: transcript path outside allowed dirs; skipping\n');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const extracted = extractLastAssistantUsage(transcriptPath);
    if (!extracted) {
      // No assistant message found — silent skip (first turn, empty session, etc.)
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Resolve orchestration_id from current-orchestration.json (best-effort).
    let orchestrationId = null;
    try {
      const orchFile = getCurrentOrchestrationFile(cwd);
      const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
      orchestrationId = orchData.orchestration_id || null;
    } catch (_e) { /* no active orchestration or file missing — that's fine */ }

    const row = {
      row_type:         'pm_turn',
      schema_version:   1,
      timestamp:        extracted.timestamp,
      orchestration_id: orchestrationId,
      session_id:       event.session_id || null,
      model_used:       extracted.model_used,
      usage:            extracted.usage,
    };

    const metricsPath = path.join(cwd, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    appendJsonlWithRotation(metricsPath, row);

    // Side-effect: update the context-telemetry cache with PM session token counts.
    // Fail-open: errors inside updateSessionTelemetry do not propagate here.
    updateSessionTelemetry(cwd, extracted, event);

  } catch (err) {
    // Fail-open: never block Stop on telemetry error.
    process.stderr.write('[orchestray] capture-pm-turn: error (fail-open): ' + String(err) + '\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
