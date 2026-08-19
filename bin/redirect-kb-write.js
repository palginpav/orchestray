#!/usr/bin/env node
'use strict';

/**
 * redirect-kb-write.js — PreToolUse:Write hook (v2.2.10 M5).
 *
 * Transparent-pass KB write telemetry. When Claude Code is about to Write
 * a file under `.orchestray/kb/facts/` or `.orchestray/kb/decisions/`, this
 * hook:
 *   1. Invokes the kb_write tool handler directly for telemetry (emits 1
 *      `mcp_tool_call:kb_write` row into events.jsonl).
 *   2. Emits 1 `kb_write_redirected` event with agent context.
 *   3. Returns `{"continue": true}` — the original Write ALWAYS proceeds.
 *
 * For any other path, returns `{"continue": true}` immediately with no emits.
 *
 * Kill switch: ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED=1 → exit 0 silently.
 *
 * Fail-open contract: this hook NEVER blocks a Write. On any error, the
 * original Write still proceeds.
 *
 * Input:  Claude Code PreToolUse:Write JSON on stdin
 * Output: exit 0 always; `{"continue": true}` on stdout
 */

const fs   = require('fs');
const path = require('path');

const { MAX_INPUT_BYTES }       = require('./_lib/constants');
const { resolveSafeCwd }        = require('./_lib/resolve-project-cwd');
const { writeEvent }            = require('./_lib/audit-event-writer');
const { readHookInputRaw } = require('./_lib/hook-stdin');
const { _withAdvisoryLock } = require('./_lib/atomic-append');

// ---------------------------------------------------------------------------
// KB index auto-append (W2d)
// ---------------------------------------------------------------------------

/** Derive title from H1 in file, or humanise slug. */
function deriveTitle(filePath, slug, bucket) {
  try {
    const buf = Buffer.allocUnsafe(500);
    const fd = fs.openSync(filePath, 'r');
    const n = fs.readSync(fd, buf, 0, 500, 0);
    fs.closeSync(fd);
    const first = buf.slice(0, n).toString('utf8').split('\n').find((l) => l.trim());
    if (first && first.startsWith('# ')) return first.slice(2).trim();
  } catch (_e) { /* fall through */ }
  return (bucket + '/' + slug).replace(/[-_]/g, ' ');
}

/**
 * Auto-append entry to index.json if slug absent. Fail-open.
 *
 * Serialised via the same `index.json.lock` advisory lock kb_write.js
 * acquires (bin/mcp-server/tools/kb_write.js `_acquireLock`/`_releaseLock`,
 * both O_EXCL-create the same `<indexPath>.lock` path), reusing the shared
 * `_withAdvisoryLock` primitive from atomic-append.js (already used by
 * kb-index-validator.js) instead of a second lock implementation. This
 * closes the lost-update race documented in
 * .orchestray/kb/artifacts/v2330-kb-index-drift-diagnosis.md Finding 3 —
 * both writers now exclude each other, not just themselves.
 *
 * _withAdvisoryLock fails closed on lock-acquire timeout (skips fn, logs to
 * stderr) rather than running the read-modify-write unlocked — exactly the
 * fail-open contract this hook needs: the index append is skipped, the
 * user's Write is never touched (that happens entirely outside this
 * function). Stale locks (dead PID, or >5x the 10s threshold) are reclaimed
 * by _acquireLockFd inside the shared primitive, so a crashed holder cannot
 * wedge future writes.
 */
function autoAppendKbIndex(cwd, filePath, slug, bucket) {
  if (process.env.ORCHESTRAY_KB_INDEX_AUTO_DISABLED === '1') return;

  const indexPath = path.join(cwd, '.orchestray', 'kb', 'index.json');
  const lockPath = indexPath + '.lock';
  const SCHEMA_VERSION = 1;

  const result = _withAdvisoryLock(lockPath, () => {
    let parsed;
    try {
      const raw = fs.readFileSync(indexPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return { outcome: 'skip', reason: 'index_read_error' };
      }
      // index.json doesn't exist yet — start fresh
      parsed = { version: '1.0', created_at: new Date().toISOString(), entries: [] };
    }

    if (!Array.isArray(parsed.entries)) parsed.entries = [];

    // Idempotency check — slug already present
    const alreadyPresent = parsed.entries.some(
      (e) => (typeof e.slug === 'string' && e.slug === slug) || (typeof e.id === 'string' && e.id === slug)
    );
    if (alreadyPresent) return { outcome: 'noop' };

    const relPath = '.orchestray/kb/' + bucket + '/' + slug + '.md';
    const title = deriveTitle(filePath, slug, bucket);
    const typeMap = { facts: 'fact', decisions: 'decision', artifacts: 'artifact' };

    parsed.entries.push({
      slug,
      title,
      type: typeMap[bucket] || bucket,
      path: relPath,
      created_at: new Date().toISOString(),
    });

    // Atomic write via tmp file + rename, still under the lock.
    const tmpPath = indexPath + '.tmp.' + process.pid;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
      fs.renameSync(tmpPath, indexPath);
    } catch (writeErr) {
      try { fs.unlinkSync(tmpPath); } catch (_e) { /* ignore */ }
      return { outcome: 'skip', reason: 'index_write_error' };
    }

    return { outcome: 'updated', relPath };
  });

  if (result && result.skipped) {
    // Lock contention timeout — fail-open, the Write itself is unaffected.
    writeEvent({ type: 'kb_index_auto_skipped', slug, bucket, reason: 'lock_contention', schema_version: SCHEMA_VERSION }, { cwd });
    return;
  }
  if (!result || result.outcome === 'noop') return;
  if (result.outcome === 'skip') {
    writeEvent({ type: 'kb_index_auto_skipped', slug, bucket, reason: result.reason, schema_version: SCHEMA_VERSION }, { cwd });
    return;
  }

  writeEvent({ type: 'kb_index_auto_updated', slug, bucket, path: result.relPath, schema_version: SCHEMA_VERSION }, { cwd });
}

// ---------------------------------------------------------------------------
// Path matcher — intercept facts/, decisions/, and artifacts/ under .orchestray/kb/
// Also intercepts the top-level .orchestray/kb/index.json index file, which
// bypassed the original regex (that only matched subfolder .md writes).
// ---------------------------------------------------------------------------

const KB_INTERCEPT_RE = /[/\\]\.orchestray[/\\]kb[/\\](facts|decisions|artifacts)[/\\][^/\\]+\.md$/;
const KB_INDEX_RE     = /[/\\]\.orchestray[/\\]kb[/\\]index\.json$/;

function isKbPath(filePath) {
  if (typeof filePath !== 'string') return false;
  return KB_INTERCEPT_RE.test(filePath) || KB_INDEX_RE.test(filePath);
}

// ---------------------------------------------------------------------------
// Stdin reader — only runs when invoked directly as the hook CLI (hooks.json
// wiring), not when required as a library (tests import autoAppendKbIndex).
// ---------------------------------------------------------------------------

if (require.main === module) {
  let _input = '';
  _input = readHookInputRaw();
  if (_input.length > MAX_INPUT_BYTES) exitContinue();
  setImmediate(() => {
    try {
      const event = JSON.parse(_input);
      main(event).catch(() => exitContinue());
    } catch (_e) {
      exitContinue();
    }
  });
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function exitContinue() {
  try {
    process.stdout.write(JSON.stringify({ continue: true }), () => process.exit(0));
  } catch (_e) {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(hookEvent) {
  // Kill switch
  if (process.env.ORCHESTRAY_KB_WRITE_REDIRECT_DISABLED === '1') {
    exitContinue();
    return;
  }

  const cwd = resolveSafeCwd(hookEvent && hookEvent.cwd);

  // Extract file_path from PreToolUse:Write payload
  const toolInput = (hookEvent && hookEvent.tool_input) || {};
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;

  // Non-matching path — pass through silently
  if (!filePath || !isKbPath(filePath)) {
    exitContinue();
    return;
  }

  try {
    await runTelemetry(cwd, filePath, toolInput, hookEvent);
  } catch (err) {
    // Fail-open: never block the Write
    try {
      writeEvent({
        type: 'kb_write_redirected',
        target_path: filePath,
        phase: 'transparent-pass-v2210',
        error: (err && err.message ? err.message : String(err)).slice(0, 200),
      }, { cwd });
    } catch (_e) { /* double-fail-open */ }
  }

  exitContinue();
}

// ---------------------------------------------------------------------------
// Telemetry runner
// ---------------------------------------------------------------------------

async function runTelemetry(cwd, filePath, toolInput, hookEvent) {
  // Determine agent_id from hook event context
  const agentId =
    (hookEvent && hookEvent.agent_id) ||
    (hookEvent && hookEvent.tool_input && hookEvent.tool_input.agent_id) ||
    'unknown';

  const t0 = Date.now();
  let outcome = 'error';

  // Derive bucket from path.
  // index.json lives at the kb root (no subfolder), so it gets its own label.
  const bucketMatch = filePath.match(/[/\\]\.orchestray[/\\]kb[/\\](facts|decisions|artifacts)[/\\]/);
  const bucket = bucketMatch ? bucketMatch[1] : (KB_INDEX_RE.test(filePath) ? 'index' : 'facts');

  // Build a minimal kb_write input from the Write payload for telemetry.
  // We do NOT actually call kb_write.handle() here because that would perform
  // a real file write (with lock + index update) which is redundant since the
  // original Write proceeds. Instead we emit the mcp_tool_call telemetry row
  // directly, mirroring what prefetch-mcp-grounding.js does for other tools.
  const fileName = path.basename(filePath, '.md');
  const kbWriteInput = {
    id: fileName.replace(/[^a-zA-Z0-9_.-]/g, '-').replace(/^[^a-zA-Z0-9]/, 'k') || 'kb-entry',
    bucket,
    path: filePath,
    author: agentId,
    topic: fileName,
    content: typeof toolInput.content === 'string' ? toolInput.content.slice(0, 100) : '',
  };

  const duration_ms = Date.now() - t0;
  outcome = 'answered';

  // Emit mcp_tool_call:kb_write (mirrors prefetch-mcp-grounding.js shape)
  writeEvent({
    type: 'mcp_tool_call',
    tool: 'kb_write',
    duration_ms,
    outcome,
    form_fields_count: Object.keys(kbWriteInput).length,
    source: 'redirect',
    bucket,
    target_path: filePath,
  }, { cwd });

  // Emit kb_write_redirected
  writeEvent({
    type: 'kb_write_redirected',
    agent_id: agentId,
    target_path: filePath,
    phase: 'transparent-pass-v2210',
    bucket,
  }, { cwd });

  // Auto-append to index.json for .md KB writes (W2d)
  if (KB_INTERCEPT_RE.test(filePath)) {
    const slug = path.basename(filePath, '.md');
    autoAppendKbIndex(cwd, filePath, slug, bucket);
  }
}

// Exported for tests only — hooks.json always invokes this file directly
// (require.main === module), so these exports have no effect on hook runtime.
module.exports = { autoAppendKbIndex, isKbPath };
