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

// ── Self-test mode ────────────────────────────────────────────────────────────
// `node bin/capture-pm-turn.js --self-test` smoke-tests the extraction logic
// with a synthetic in-memory transcript and exits 0 on success.
if (process.argv.includes('--self-test')) {
  runSelfTest();
  process.exit(0);
}

// ── Transcript parsing ────────────────────────────────────────────────────────
/**
 * Read the last assistant message's `usage` block from a session transcript JSONL.
 *
 * Strategy: read the file tail-first (last 64 KB covers the final few turns),
 * split into lines, iterate in reverse, return the first assistant usage found.
 * Falls back to a full read if the tail yields no match.
 *
 * @param {string} transcriptPath - Absolute path to transcript JSONL.
 * @returns {{ usage: object, model_used: string|null, timestamp: string }|null}
 */
function extractLastAssistantUsage(transcriptPath) {
  const TAIL_BYTES = 64 * 1024; // 64 KB — covers several large PM turns

  let content;
  try {
    const stat = fs.statSync(transcriptPath);
    if (stat.size === 0) return null;

    if (stat.size <= TAIL_BYTES) {
      content = fs.readFileSync(transcriptPath, 'utf8');
    } else {
      // Read only the tail to avoid loading a large transcript into memory.
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(TAIL_BYTES);
      const offset = stat.size - TAIL_BYTES;
      fs.readSync(fd, buf, 0, TAIL_BYTES, offset);
      fs.closeSync(fd);
      content = buf.toString('utf8');
    }
  } catch (_e) {
    return null;
  }

  const lines = content.split('\n');

  // Iterate in reverse — find the most recent assistant usage block.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let entry;
    try { entry = JSON.parse(line); } catch (_e) { continue; }

    // Claude Code transcript JSONL entries have several shapes:
    //   { role: "assistant", content: [...], usage: {...} }
    //   { type: "assistant", message: { role: "assistant", usage: {...} } }
    const role = entry.role || entry.type || (entry.message && entry.message.role);
    if (role !== 'assistant') continue;

    const usage = entry.usage || (entry.message && entry.message.usage);
    if (!usage) continue;

    // model may appear at entry.model or entry.message.model
    const model = entry.model || (entry.message && entry.message.model) || null;

    // timestamp: prefer entry-level, fall back to now
    const timestamp = entry.timestamp || (entry.message && entry.message.timestamp) || new Date().toISOString();

    return {
      usage: {
        input_tokens:                  Number(usage.input_tokens)                  || 0,
        output_tokens:                 Number(usage.output_tokens)                 || 0,
        cache_read_input_tokens:       Number(usage.cache_read_input_tokens)       || 0,
        cache_creation_input_tokens:   Number(usage.cache_creation_input_tokens)   || 0,
      },
      model_used: model,
      timestamp,
    };
  }

  return null;
}

// ── Self-test ─────────────────────────────────────────────────────────────────
function runSelfTest() {
  // Build a synthetic two-entry transcript (user then assistant).
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

    // Path containment: only allow reads from project dir or ~/.claude/.
    const safeRealpath = (p) => {
      try { return fs.realpathSync(p); } catch (_e) { return path.resolve(p); }
    };
    const resolved     = safeRealpath(transcriptPath);
    const cwdResolved  = safeRealpath(cwd);
    const claudeHome   = safeRealpath(path.join(os.homedir(), '.claude'));
    const allowed =
      resolved === cwdResolved ||
      resolved.startsWith(cwdResolved + path.sep) ||
      resolved === claudeHome ||
      resolved.startsWith(claudeHome + path.sep);

    if (!allowed) {
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

  } catch (err) {
    // Fail-open: never block Stop on telemetry error.
    process.stderr.write('[orchestray] capture-pm-turn: error (fail-open): ' + String(err) + '\n');
  }

  process.stdout.write(JSON.stringify({ continue: true }));
  process.exit(0);
});
