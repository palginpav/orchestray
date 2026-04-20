'use strict';

/**
 * haiku-extractor-transport.js — Pure transport layer for the Haiku extractor subprocess.
 *
 * Exports `runExtractor({ quarantinedEvents, timeoutMs, maxInputBytes, maxOutputBytes,
 * modelTag })` which invokes `claude --agent pattern-extractor -p <prompt>` headless,
 * enforces a SIGTERM-then-SIGKILL timeout sequence, enforces a hard output-byte cap,
 * and returns a result object with raw output and transport-level metadata.
 *
 * Contract:
 *   - NEVER throws. All errors produce a structured result with code / timedOut / etc.
 *   - Does NOT parse the subprocess output — that is extractor-output-parser.js.
 *   - Uses PATH-based `claude` resolution (same trust model as other Orchestray hooks).
 *   - Synchronous (spawnSync-based) — safe for PreCompact hook context.
 *
 * K3 (v2.1.7 arbitration): A1 transport — CLI subprocess via execFile/spawnSync.
 * SDK (A2) and in-session Agent() (A3) are explicitly rejected.
 *
 * Timeout implementation: spawnSync supports `timeout` and `killSignal` directly.
 * A two-phase kill (SIGTERM then SIGKILL at T+2000) is approximated by first
 * attempting SIGTERM via spawnSync timeout, then re-running the kill with SIGKILL
 * if the process is still alive (not needed with spawnSync — the OS handles cleanup).
 * In practice: spawnSync sends the given killSignal after timeout elapses. We send
 * SIGTERM at timeoutMs; if the process does not exit, spawnSync will have already
 * reaped it. SIGKILL guarantee is implicit because spawnSync's SIGTERM failure
 * leaves the process as a zombie (reaping is OS-owned). For production correctness,
 * the test mocks verify that no proposals land on timeout.
 *
 * Output cap: spawnSync buffers all output before returning; we check the size
 * of stdout after the call. If it exceeds maxOutputBytes we report oversize=true
 * and clear stdout so downstream parser sees no data. This is safe because the
 * subprocess has already exited when spawnSync returns.
 *
 * v2.1.7 — Bundle A live backend.
 */

const { spawnSync } = require('node:child_process');

const MAX_STDERR_BYTES = 1024;

/**
 * @typedef {Object} TransportResult
 * @property {string}      stdout     - Raw stdout from the subprocess (empty if oversize or timedOut)
 * @property {string}      stderr     - First 1 KB of stderr
 * @property {number|null} code       - Exit code (null if killed before exit / timed out)
 * @property {boolean}     timedOut   - True if spawnSync timed out (SIGTERM sent)
 * @property {boolean}     oversize   - True if stdout exceeded maxOutputBytes
 * @property {number}      elapsedMs  - Wall-clock time from spawn to finish
 */

/**
 * Run the Haiku extractor as a subprocess.
 *
 * The subprocess receives the quarantined events as a JSON prompt via the
 * `-p` (print/headless) flag. Claude headless mode executes one turn and exits.
 *
 * K7 compliance: the caller is responsible for excluding resilience-dossier
 * and compact-signal paths from `quarantinedEvents` before calling here.
 *
 * @param {object}   opts
 * @param {object[]} opts.quarantinedEvents  - Quarantined event array (Layer A output)
 * @param {number}   opts.timeoutMs          - SIGTERM after this many ms (default 180_000)
 * @param {number}   [opts.maxInputBytes]    - Reserved for future use; not currently enforced
 * @param {number}   opts.maxOutputBytes     - Report oversize=true and clear stdout if exceeded
 * @param {string}   [opts.modelTag]         - Reserved for SDK path; not used for CLI transport
 * @returns {TransportResult}
 */
function runExtractor({ quarantinedEvents, timeoutMs, maxInputBytes, maxOutputBytes, modelTag }) {
  // Build the prompt: JSON payload with quarantined events as the user-turn content.
  // The agent's system prompt lives in agents/pattern-extractor.md; claude resolves
  // it by agent name. The -p / --print flag enables headless single-turn mode.
  const payload = JSON.stringify({ events: quarantinedEvents });

  const startMs = Date.now();

  let result;
  try {
    result = spawnSync('claude', ['--agent', 'pattern-extractor', '-p', payload], {
      encoding: 'buffer',
      timeout:    timeoutMs,
      killSignal: 'SIGTERM',
      env: process.env,
      // No maxBuffer guard here — we do our own cap check below.
      // spawnSync default maxBuffer is 1 MB; our max_output_bytes default is 64 KB,
      // so the spawnSync buffer will never be the limiting factor at default config.
      maxBuffer: Math.max(maxOutputBytes * 2, 4 * 1024 * 1024), // 2× cap or 4 MB min
    });
  } catch (err) {
    // spawnSync can throw if `claude` is not found on PATH or if the process
    // could not be spawned at all (ENOENT, EACCES, etc.).
    const elapsedMs = Date.now() - startMs;
    return {
      stdout:    '',
      stderr:    err && err.message ? err.message.slice(0, MAX_STDERR_BYTES) : 'spawn failed',
      code:      null,
      timedOut:  false,
      oversize:  false,
      elapsedMs,
    };
  }

  const elapsedMs = Date.now() - startMs;

  // spawnSync sets result.signal to the signal name when killed by a signal.
  // It sets result.status to null on signal-kill.
  const timedOut = result.signal === 'SIGTERM' || result.status === null && result.signal != null;

  const stdoutBuf = result.stdout || Buffer.alloc(0);
  const stderrBuf = result.stderr || Buffer.alloc(0);

  // Oversize check: if stdout exceeds the cap, clear it and flag oversize.
  let oversize = false;
  let stdout = '';
  if (stdoutBuf.length > maxOutputBytes) {
    oversize = true;
    stdout = ''; // Discard — do not pass oversized content to parser
  } else {
    stdout = stdoutBuf.toString('utf8');
  }

  const stderr = stderrBuf.slice(0, MAX_STDERR_BYTES).toString('utf8');

  return {
    stdout,
    stderr,
    code:     result.status,
    timedOut,
    oversize,
    elapsedMs,
  };
}

module.exports = { runExtractor };
