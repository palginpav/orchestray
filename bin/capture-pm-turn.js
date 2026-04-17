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
const { runJanitor }               = require('./_lib/subagent-janitor');

// ── Self-test mode ────────────────────────────────────────────────────────────
// `node bin/capture-pm-turn.js --self-test` smoke-tests the extraction logic
// with a synthetic in-memory transcript and exits 0 on success.
if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

// ── Stop-hook audit trail (v2.0.21 diagnostic) ───────────────────────────────
/**
 * Append one diagnostic row per Stop-hook invocation.
 *
 * Purpose: we observed sessions where Stop fires far less often than user prompts
 * (or fires with payloads missing transcript_path), which silently breaks PM
 * telemetry refresh. This log captures what we actually receive.
 *
 * @param {string} cwd
 * @param {object} event   - Raw hook payload (may be empty {}).
 * @param {string} outcome - One of: no_transcript, disabled, path_outside_allowed,
 *                           no_extracted_usage, success, error.
 */
function logStopHookFire(cwd, event, outcome) {
  if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') return;
  try {
    const auditPath = path.join(cwd, '.orchestray', 'state', 'stop-hook.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const row = {
      ts:             new Date().toISOString(),
      session_id:     event.session_id || null,
      has_transcript: !!event.transcript_path,
      cwd_present:    !!event.cwd,
      payload_keys:   Object.keys(event || {}).sort(),
      outcome:        outcome,
    };
    fs.appendFileSync(auditPath, JSON.stringify(row) + '\n', 'utf8');
  } catch (_e) {
    // Diagnostic is best-effort; never block Stop on audit failure.
  }
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
      // v2.0.21: shared with collect-context-telemetry.js stop so SubagentStop
      // also triggers a sweep — Stop fires too rarely to be the only janitor.
      try {
        if (sessionId) {
          runJanitor(cwd, sessionId, cache);
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

// Janitor implementation lives in bin/_lib/subagent-janitor.js (extracted v2.0.21)
// so collect-context-telemetry.js stop can run it too. Imported as `runJanitor` above.

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
  let event = {};
  let cwd   = null;
  try {
    event = JSON.parse(input || '{}');
    cwd   = resolveSafeCwd(event.cwd);

    // Respect metrics kill-switch.
    if (process.env.ORCHESTRAY_METRICS_DISABLED === '1') {
      logStopHookFire(cwd, event, 'disabled');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Stop event provides transcript_path (the session agent's own transcript).
    const transcriptPath = event.transcript_path || null;
    if (!transcriptPath) {
      logStopHookFire(cwd, event, 'no_transcript');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Path containment: use shared helper (W3 / v2.0.19 — replaces inline check).
    const resolved    = safeRealpath(transcriptPath);
    const cwdResolved = safeRealpath(cwd);
    const claudeHome  = safeRealpath(path.join(os.homedir(), '.claude'));

    if (!isInsideAllowed(resolved, cwdResolved, claudeHome)) {
      process.stderr.write('[orchestray] capture-pm-turn: transcript path outside allowed dirs; skipping\n');
      logStopHookFire(cwd, event, 'path_outside_allowed');
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const extracted = extractLastAssistantUsage(transcriptPath);
    if (!extracted) {
      // No assistant message found — silent skip (first turn, empty session, etc.)
      logStopHookFire(cwd, event, 'no_extracted_usage');
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

    logStopHookFire(cwd, event, 'success');
  } catch (err) {
    // Fail-open: never block Stop on telemetry error.
    process.stderr.write('[orchestray] capture-pm-turn: error (fail-open): ' + String(err) + '\n');
    if (cwd) logStopHookFire(cwd, event, 'error');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
