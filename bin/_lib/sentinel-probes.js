'use strict';

/**
 * sentinel-probes.js — P1.4 deterministic probe primitives (v2.2.0).
 *
 * Replaces the inline-Bash patterns the PM uses for class-C deterministic
 * operations (W6 operation taxonomy). Each probe is fail-soft, sub-50ms,
 * and emits a `sentinel_probe` audit event. Callers never see a throw.
 *
 * Public API:
 *   fileExists({path})                       → {ok, exists, kind}
 *   lineCount({path, max_bytes?})            → {ok, lines, bytes, capped}
 *   gitStatus({paths?, cwd?})                → {ok, clean, modified, untracked, staged}
 *   schemaValidate({event, schema_path?})    → {ok, valid, errors, event_type}
 *   hashCompute({path, algorithm?})          → {ok, algorithm, hex, bytes}
 *   runProbe(op, args)                       → {ok, …} (router + telemetry + guard)
 *
 * Security:
 *   - Path inputs flow through `_normalizeProjectPath` which rejects raw `..`
 *     components (regex from agents/pm.md:104) and confirms containment via
 *     `bin/_lib/path-containment.js` (`safeRealpath` + `isInsideAllowed`).
 *   - `gitStatus` uses `execFileSync('git', […])` only; no shell-string interpolation.
 *   - `hashCompute` whitelists algorithms to {sha256, sha1, md5}.
 *   - Args are JSON-bounded at `MAX_INPUT_BYTES` (1 MB).
 *   - Top-level try/catch in `runProbe` makes probe-internal exceptions
 *     surface as `{ok:false, reason:'probe_internal_error'}` rather than throw.
 *   - Recursive guard: `schemaValidate` blocks calls originating in
 *     `audit-event-writer.js` (Risk R3 mitigation).
 */

const fs       = require('node:fs');
const pathMod  = require('node:path');
const crypto   = require('node:crypto');
const { execFileSync }                = require('node:child_process');
const { safeRealpath, isInsideAllowed } = require('./path-containment');
const { readFileBounded }             = require('./file-read-bounded');
const { MAX_INPUT_BYTES }             = require('./constants');
const { validateEvent }               = require('./schema-emit-validator');
const { writeEvent }                  = require('./audit-event-writer');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const _ALLOWED_OPS = Object.freeze([
  'fileExists',
  'lineCount',
  'gitStatus',
  'schemaValidate',
  'hashCompute',
]);

const _ALLOWED_ALGOS = Object.freeze(['sha256', 'sha1', 'md5']);

// Path-traversal regex — verbatim from agents/pm.md:104.
const _DOTDOT_RE = /(^|\/)\.\.(\/|$)/;

const LINECOUNT_DEFAULT_CAP = 10 * 1024 * 1024; // 10 MB — default text-file ceiling
const LINECOUNT_HARD_CAP    = 64 * 1024 * 1024; // 64 MB — caller-overridable upper bound
const HASHCOMPUTE_DEFAULT_CAP = 64 * 1024 * 1024; // 64 MB upper safety bound
const TARGET_TRUNCATE = 200;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a user-supplied path against the project root and reject
 * traversal / out-of-tree attempts. Returns the resolved absolute path on
 * success, `null` on rejection.
 *
 * @param {string} p
 * @param {string} [projectRoot]
 * @returns {string|null}
 */
function _normalizeProjectPath(p, projectRoot) {
  if (typeof p !== 'string' || p.length === 0) return null;
  // Reject raw `..` components in the *input* — same regex as agents/pm.md:104.
  if (_DOTDOT_RE.test(p)) return null;
  const root = projectRoot || process.cwd();
  let cwdAbs;
  let claudeHomeAbs;
  try {
    cwdAbs = safeRealpath(root);
    claudeHomeAbs = safeRealpath(pathMod.join(require('node:os').homedir(), '.claude'));
  } catch (_e) {
    return null;
  }
  // Resolve to absolute (relative paths anchor at projectRoot).
  const abs = pathMod.isAbsolute(p) ? p : pathMod.resolve(cwdAbs, p);
  let resolved;
  try {
    resolved = safeRealpath(abs);
  } catch (_e) {
    return null;
  }
  if (!isInsideAllowed(resolved, cwdAbs, claudeHomeAbs)) return null;
  // S-004 defense: when the path on disk is a symlink whose target does NOT
  // exist (`safeRealpath` falls back to path.resolve), `realpathSync` could
  // not chase the link, and the containment check above only inspected the
  // link's own location (which IS inside the tree). Read the link target
  // explicitly and reject if it points outside the tree — otherwise a
  // dangling outside-tree symlink leaks "this name in the tree exists" via
  // `fileExists` even though we'd never agree to follow it.
  try {
    const lst = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (lst && lst.isSymbolicLink()) {
      let linkTarget;
      try { linkTarget = fs.readlinkSync(abs); } catch (_e) { return null; }
      const targetAbs = pathMod.isAbsolute(linkTarget)
        ? linkTarget
        : pathMod.resolve(pathMod.dirname(abs), linkTarget);
      // Re-check containment against the symlink's stated target. We cannot
      // realpathSync a missing target, so use targetAbs as-is.
      if (!isInsideAllowed(targetAbs, cwdAbs, claudeHomeAbs)) return null;
    }
  } catch (_e) {
    // lstat failures fall back to the resolved-path containment result above.
  }
  return resolved;
}

/**
 * Bound argument bytes by their JSON serialization size.
 *
 * @param {object} args
 * @returns {boolean}
 */
function _capArgsBytes(args) {
  try {
    const serialized = JSON.stringify(args);
    if (typeof serialized !== 'string') return false;
    return Buffer.byteLength(serialized, 'utf8') <= MAX_INPUT_BYTES;
  } catch (_e) {
    return false;
  }
}

/**
 * Truncate a target identifier to TARGET_TRUNCATE chars for telemetry.
 */
function _truncateTarget(t) {
  if (typeof t !== 'string') return '';
  if (t.length <= TARGET_TRUNCATE) return t;
  return t.slice(0, TARGET_TRUNCATE);
}

/**
 * Map a probe result object to a stable categorical for telemetry.
 */
function _classifyResult(result) {
  if (!result || typeof result !== 'object') return 'fail_soft';
  if (result.ok === true) return 'ok';
  const reason = result.reason;
  if (reason === 'invalid_path') return 'invalid_path';
  if (reason === 'file_too_large' || reason === 'args_too_large') return 'over_cap';
  return 'fail_soft';
}

/**
 * Emit one `sentinel_probe` audit row. Never throws.
 */
function _emitProbeEvent({ op, target, duration_ms, result_type, source }) {
  try {
    writeEvent({
      type: 'sentinel_probe',
      version: 1,
      op,
      target: _truncateTarget(target || ''),
      duration_ms: Math.max(0, Math.floor(duration_ms || 0)),
      result_type,
      source: source || 'require',
    });
  } catch (_e) { /* fail-open by writeEvent contract */ }
}

/**
 * Detect whether the call originated from inside audit-event-writer.js.
 * Used by `schemaValidate` to break the validate→emit→validate recursion
 * (Risk R3 in the W2 design).
 *
 * Forward-looking defense: as of v2.2.0 no current call path triggers this
 * guard — `audit-event-writer.js` calls `validateEvent` from
 * `schema-emit-validator.js` directly, not `schemaValidate` from this module.
 * Retained for the case where audit-event-writer adds a `schemaValidate`
 * call in a future release (per W5 F-006).
 */
function _isCalledFromAuditWriter() {
  const e = new Error();
  const stack = (e.stack || '').split('\n');
  for (const line of stack) {
    if (line.includes('audit-event-writer.js')) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * fileExists({path}) — returns existence + kind for `path` under project root.
 *
 * @param {{path:string}} args
 * @returns {{ok:boolean, exists?:boolean, kind?:string|null, reason?:string}}
 */
function fileExists(args) {
  if (!args || typeof args !== 'object') return { ok: false, reason: 'invalid_input' };
  const normalized = _normalizeProjectPath(args.path);
  if (normalized === null) {
    // Distinguish "path-traversal / outside-tree" (rejection) from "missing"
    // (a successful negative answer). Anything that fails normalization
    // because of `..` or out-of-tree resolution must report invalid_path;
    // a path that simply doesn't exist still normalizes via safeRealpath's
    // path.resolve fallback.
    return { ok: false, reason: 'invalid_path' };
  }
  try {
    const st = fs.lstatSync(normalized, { throwIfNoEntry: false });
    if (!st) return { ok: true, exists: false, kind: null };
    let kind = 'other';
    if (st.isSymbolicLink()) kind = 'symlink';
    else if (st.isDirectory()) kind = 'dir';
    else if (st.isFile()) kind = 'file';
    return { ok: true, exists: true, kind };
  } catch (_e) {
    return { ok: false, reason: 'invalid_path' };
  }
}

/**
 * lineCount({path, max_bytes?}) — counts lines using POSIX text-file
 * convention (`count('\n') + 1` when last byte is not '\n').
 *
 * @param {{path:string, max_bytes?:number}} args
 */
function lineCount(args) {
  if (!args || typeof args !== 'object') return { ok: false, reason: 'invalid_input' };
  const normalized = _normalizeProjectPath(args.path);
  if (normalized === null) return { ok: false, reason: 'invalid_path' };
  // Use lineCount's own hard ceiling (not hashCompute's) so a future change
  // to either probe's safety bound does not cross-pollute (W5 F-010).
  const cap = (typeof args.max_bytes === 'number' && args.max_bytes > 0)
    ? Math.min(args.max_bytes, LINECOUNT_HARD_CAP)
    : LINECOUNT_DEFAULT_CAP;
  const r = readFileBounded(normalized, cap);
  if (!r.ok) {
    if (r.reason === 'file_too_large') {
      return { ok: false, reason: 'file_too_large', size_hint: r.size_hint };
    }
    return { ok: false, reason: 'read_failed' };
  }
  const text = r.content;
  const bytes = Buffer.byteLength(text, 'utf8');
  if (text.length === 0) return { ok: true, lines: 0, bytes, capped: false };
  const newlines = (text.match(/\n/g) || []).length;
  // POSIX text-file convention: count('\n') + 1 unless file ends with '\n'.
  const lines = text.endsWith('\n') ? newlines : newlines + 1;
  return { ok: true, lines, bytes, capped: false };
}

/**
 * gitStatus({paths?, cwd?}) — fail-soft wrapper around `git status --porcelain=v1 -z`.
 *
 * @param {{paths?:string[], cwd?:string}} args
 */
function gitStatus(args) {
  args = args || {};
  if (typeof args !== 'object') return { ok: false, reason: 'invalid_input' };
  const cwd = args.cwd ? _normalizeProjectPath(args.cwd) : process.cwd();
  if (cwd === null) return { ok: false, reason: 'invalid_path' };

  const cmd = ['status', '--porcelain=v1', '-z'];
  if (Array.isArray(args.paths) && args.paths.length > 0) {
    cmd.push('--');
    for (const p of args.paths) {
      if (typeof p !== 'string') return { ok: false, reason: 'invalid_path' };
      // Full project-root containment check (W5 F-005). Other path-taking
      // probes (fileExists/lineCount/hashCompute) reject out-of-tree paths
      // with `invalid_path`; do the same here so callers get a precise
      // structured failure instead of a generic `git_failed`.
      const norm = _normalizeProjectPath(p, cwd);
      if (norm === null) return { ok: false, reason: 'invalid_path' };
      cmd.push(p);
    }
  }

  let raw;
  try {
    raw = execFileSync('git', cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const stderr = (err && err.stderr) ? String(err.stderr) : '';
    if (/not a git repository/i.test(stderr)) {
      return { ok: false, reason: 'not_a_git_repo' };
    }
    return { ok: false, reason: 'git_failed' };
  }

  const modified = [];
  const untracked = [];
  const staged = [];
  const entries = raw.split('\0').filter(Boolean);
  // With `git status -z`, rename/copy records are encoded as TWO consecutive
  // NUL-separated entries: first `R<X> <new-path>`, then a bare `<old-path>`
  // with NO leading status bytes. Iterate with an index so we can consume
  // the source-path entry without mis-decoding it as a status record.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 3) continue;
    const X = entry[0];
    const Y = entry[1];
    const file = entry.slice(3);
    if (X === '?' && Y === '?') {
      untracked.push(file);
      continue;
    }
    if (X !== ' ' && X !== '?') staged.push(file);
    if (Y !== ' ' && Y !== '?') modified.push(file);
    // Rename/copy records consume an extra NUL-separated entry for the
    // source path; skip it so its bytes are not mis-decoded as a status.
    if (X === 'R' || X === 'C') i += 1;
  }
  return {
    ok: true,
    clean: modified.length === 0 && untracked.length === 0 && staged.length === 0,
    modified,
    untracked,
    staged,
  };
}

/**
 * schemaValidate({event, schema_path?}) — validates an event payload against
 * `agents/pm-reference/event-schemas.md`. Reuses `schema-emit-validator`'s
 * cached parser.
 *
 * @param {{event:object, schema_path?:string}} args
 */
function schemaValidate(args) {
  if (!args || typeof args !== 'object') return { ok: false, reason: 'invalid_input' };
  if (!args.event || typeof args.event !== 'object') {
    return { ok: false, reason: 'invalid_input' };
  }
  // Recursion guard (Risk R3): if an audit-event-writer frame is on the
  // stack, refuse — the writer already validates on emit.
  if (_isCalledFromAuditWriter()) {
    return { ok: false, reason: 'recursive_call_blocked' };
  }
  // schema_path is currently advisory; the validator anchors at process.cwd().
  // We accept the arg for forward-compat but ignore it (documented).
  let cwd = process.cwd();
  if (args.schema_path) {
    const norm = _normalizeProjectPath(args.schema_path);
    if (norm === null) return { ok: false, reason: 'invalid_path' };
    // Use the directory two levels up from agents/pm-reference/event-schemas.md
    // so validateEvent can find it via its own SCHEMA_REL_PATH heuristic.
    cwd = pathMod.dirname(pathMod.dirname(pathMod.dirname(norm)));
  }
  let result;
  try {
    result = validateEvent(cwd, args.event);
  } catch (_e) {
    return { ok: false, reason: 'shadow_unavailable' };
  }
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'shadow_unavailable' };
  }
  // validateEvent returns valid:false with errors[0] starting "unknown event type"
  // for unknown types — surface that as the structured failure reason.
  if (result.valid === false) {
    const firstErr = (result.errors && result.errors[0]) || '';
    if (/unknown event type/i.test(firstErr) && !result.event_type) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (/unknown event type/i.test(firstErr)) {
      return { ok: false, reason: 'unknown_event_type' };
    }
    return {
      ok: true,
      valid: false,
      errors: result.errors || [],
      event_type: result.event_type || null,
    };
  }
  return {
    ok: true,
    valid: true,
    errors: [],
    event_type: result.event_type || null,
  };
}

/**
 * hashCompute({path, algorithm?}) — streamed hash of file contents.
 *
 * @param {{path:string, algorithm?:string}} args
 */
function hashCompute(args) {
  if (!args || typeof args !== 'object') return { ok: false, reason: 'invalid_input' };
  const algo = (args.algorithm || 'sha256').toLowerCase();
  if (!_ALLOWED_ALGOS.includes(algo)) {
    return { ok: false, reason: 'unsupported_algo' };
  }
  const normalized = _normalizeProjectPath(args.path);
  if (normalized === null) return { ok: false, reason: 'invalid_path' };
  let bytes = 0;
  let hex;
  try {
    const hash = crypto.createHash(algo);
    const fd = fs.openSync(normalized, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      // Read in 64KB chunks; stops at EOF (bytesRead === 0).
      // Guard with an upper-bound read counter so a runaway stream cannot
      // burn the perf budget without bound.
      while (true) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        hash.update(buf.subarray(0, n));
        bytes += n;
        if (bytes > HASHCOMPUTE_DEFAULT_CAP) {
          return { ok: false, reason: 'file_too_large', size_hint: bytes };
        }
      }
    } finally {
      try { fs.closeSync(fd); } catch (_e) { /* swallow */ }
    }
    hex = hash.digest('hex');
  } catch (_e) {
    return { ok: false, reason: 'read_failed' };
  }
  return { ok: true, algorithm: algo, hex, bytes };
}

// ---------------------------------------------------------------------------
// runProbe — top-level dispatcher with telemetry + guards
// ---------------------------------------------------------------------------

/**
 * Run a named probe with arg-cap, timing, and audit-event emission.
 *
 * @param {string} op
 * @param {object} args
 * @param {{source?:string}} [meta]
 * @returns {object}
 */
function runProbe(op, args, meta) {
  const source = (meta && meta.source) || 'require';
  const start = Date.now();

  if (!_ALLOWED_OPS.includes(op)) {
    const result = { ok: false, reason: 'unknown_op' };
    _emitProbeEvent({
      op: String(op || 'unknown'),
      target: '',
      duration_ms: Date.now() - start,
      result_type: 'fail_soft',
      source,
    });
    return result;
  }

  if (!_capArgsBytes(args || {})) {
    const result = { ok: false, reason: 'args_too_large' };
    _emitProbeEvent({
      op,
      target: '',
      duration_ms: Date.now() - start,
      result_type: 'over_cap',
      source,
    });
    return result;
  }

  let result;
  try {
    switch (op) {
      case 'fileExists':     result = fileExists(args || {}); break;
      case 'lineCount':      result = lineCount(args || {}); break;
      case 'gitStatus':      result = gitStatus(args || {}); break;
      case 'schemaValidate': result = schemaValidate(args || {}); break;
      case 'hashCompute':    result = hashCompute(args || {}); break;
      /* istanbul ignore next */
      default:               result = { ok: false, reason: 'unknown_op' };
    }
  } catch (_e) {
    result = { ok: false, reason: 'probe_internal_error' };
  }

  // Compose a target string for telemetry.
  let target = '';
  if (args && typeof args === 'object') {
    if (typeof args.path === 'string') target = args.path;
    else if (Array.isArray(args.paths)) target = 'multi:' + args.paths.length;
    else if (args.event && typeof args.event === 'object' && typeof args.event.type === 'string') {
      target = args.event.type;
    }
  }

  _emitProbeEvent({
    op,
    target,
    duration_ms: Date.now() - start,
    result_type: _classifyResult(result),
    source,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fileExists,
  lineCount,
  gitStatus,
  schemaValidate,
  hashCompute,
  runProbe,
  // Surfaced for tests:
  _normalizeProjectPath,
  _ALLOWED_OPS,
};
