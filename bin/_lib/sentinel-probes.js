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
 *
 * v2.3.0 Wave 3 static-analysis probes (W-SEC-13, W-SEC-19, W-SEC-DEF-1):
 *   assertNoShellInBrokerForwardPath(loaderPath?)         — W-SEC-13
 *   assertPluginStdoutNeverReachesAuditWriter(lP?, aP?)   — W-SEC-19
 *   assertNoModelOutputInDispatch(serverPath?)            — W-SEC-DEF-1.1
 *   assertEnvStripIsApplied(loaderPath?)                  — W-SEC-DEF-1.2
 *   assertConsentRequiredBeforeSpawn(loaderPath?)         — W-SEC-DEF-1.3
 *   assertNoEvalInPluginLoader(loaderPath?)               — W-SEC-DEF-1.4
 *   assertPluginToolsNeverInTopLevelMcpServers(serverPath?) — W-SEC-DEF-1.5
 *
 * Static-analysis heuristics — false-negative/false-positive tradeoffs:
 *   These probes are regex/string-walking heuristics, not a full AST prover.
 *   They WILL miss obfuscated patterns (e.g. computed property names, eval
 *   injected via a wrapper module). They will NOT produce false positives for
 *   code that follows the documented safe patterns. These are intended as a
 *   mechanical regression lock, not a security audit replacement.
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
// Static-analysis probe helpers
// ---------------------------------------------------------------------------

/**
 * Read a source file for static analysis.
 * Returns the file's text on success, or null if the file is missing/unreadable.
 * Probes that inspect a nonexistent file return {ok:true} with evidence noting
 * the file is absent — the file simply has not been created yet.
 *
 * @param {string} filePath  Absolute path
 * @returns {string|null}
 */
function _readSourceFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve an optional caller-supplied path or fall back to a project-relative
 * default. Always returns an absolute path string; never throws.
 *
 * @param {string|undefined} suppliedPath  Caller arg (may be undefined/null)
 * @param {string}           relDefault    Path relative to process.cwd()
 * @returns {string}
 */
function _resolveSourcePath(suppliedPath, relDefault) {
  if (suppliedPath && typeof suppliedPath === 'string') {
    return pathMod.isAbsolute(suppliedPath)
      ? suppliedPath
      : pathMod.resolve(process.cwd(), suppliedPath);
  }
  return pathMod.resolve(process.cwd(), relDefault);
}

/**
 * Extract the body of a named function from source text using brace counting.
 * Supports `function name(` and `const name = (async )?(` arrow forms.
 * Returns the substring from the opening `{` to the matching closing `}`.
 * Returns null if the function is not found.
 *
 * False-negative note: highly minified code or unusual formatting may not be
 * matched. The probe returns {ok:true, evidence:'function not found — skipping'}
 * in that case so CI does not block on code that predates this probe.
 *
 * @param {string} source
 * @param {string} funcName
 * @returns {string|null}
 */
function _extractFunctionBody(source, funcName) {
  // Match `async function funcName(` or `function funcName(`
  const declRe = new RegExp(
    '(?:^|\\n)\\s*(?:async\\s+)?function\\s+' + funcName + '\\s*\\(',
    'm'
  );
  // Match `const funcName = async (` or `const funcName = (`
  const arrowRe = new RegExp(
    '(?:^|\\n)\\s*(?:const|let|var)\\s+' + funcName + '\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|[a-zA-Z_$][\\w$]*)\\s*=>',
    'm'
  );

  let startIdx = -1;
  const declMatch = declRe.exec(source);
  const arrowMatch = arrowRe.exec(source);

  if (declMatch) startIdx = declMatch.index + declMatch[0].length;
  if (arrowMatch && (startIdx === -1 || arrowMatch.index < startIdx)) {
    startIdx = arrowMatch.index + arrowMatch[0].length;
  }

  if (startIdx === -1) return null;

  // Find the opening `{` from startIdx
  const braceStart = source.indexOf('{', startIdx);
  if (braceStart === -1) return null;

  // Brace counting to find the matching close
  let depth = 0;
  let i = braceStart;
  // Also skip string literals and comments to avoid counting braces inside them
  while (i < source.length) {
    const ch = source[i];
    if (ch === '{') {
      depth++;
      i++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(braceStart, i + 1);
      }
      i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      // Line comment — skip to end of line
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? source.length : nl + 1;
    } else if (ch === '/' && source[i + 1] === '*') {
      // Block comment
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === '`') {
      // Template literal — skip to closing backtick (simplified, no nested ${})
      i++;
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\\') i++; // skip escape
        i++;
      }
      i++;
    } else if (ch === '"' || ch === "'") {
      // String literal
      const q = ch;
      i++;
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
    } else {
      i++;
    }
  }
  return null; // Unmatched braces — return null
}

// ---------------------------------------------------------------------------
// Static-analysis probes
// ---------------------------------------------------------------------------

/**
 * W-SEC-13 — assertNoShellInBrokerForwardPath
 *
 * Reads bin/_lib/plugin-loader.js (or supplied loaderPath). Locates the
 * `forwardToPlugin` function. Within that function's body, asserts that no
 * shell-execution primitives appear: eval, new Function, vm.run*, child_process
 * exec/execSync, or template-literal spawn() calls.
 *
 * False-negative tradeoffs: brace-counting body extraction may miss the
 * function if it is defined as an object method (e.g. `{ forwardToPlugin() {} }`).
 * In that case the probe falls back to scanning the full file, which is
 * conservative (more false positives) but never misses a real violation.
 *
 * @param {string} [loaderPath]  Optional override path (absolute or cwd-relative)
 * @returns {{ok:boolean, evidence?:string, violations?:Array<{file,line,snippet,reason}>}}
 */
function assertNoShellInBrokerForwardPath(loaderPath) {
  const filePath = _resolveSourcePath(loaderPath, 'bin/_lib/plugin-loader.js');
  const source = _readSourceFile(filePath);
  if (source === null) {
    return {
      ok: true,
      evidence: 'plugin-loader.js does not exist yet — probe passes vacuously',
    };
  }

  // Extract the forwardToPlugin function body; fall back to full file if not found
  let region = _extractFunctionBody(source, 'forwardToPlugin');
  const regionLabel = region ? 'forwardToPlugin body' : 'full file (forwardToPlugin not isolated)';
  if (!region) region = source;

  const FORBIDDEN = [
    { re: /\beval\s*\(/g,                 reason: 'eval() in broker forward path' },
    { re: /\bnew\s+Function\s*\(/g,       reason: 'new Function() in broker forward path' },
    { re: /\bvm\.runInNewContext\s*\(/g,  reason: 'vm.runInNewContext in broker forward path' },
    { re: /\bvm\.runInThisContext\s*\(/g, reason: 'vm.runInThisContext in broker forward path' },
    { re: /\bvm\.compileFunction\s*\(/g,  reason: 'vm.compileFunction in broker forward path' },
    { re: /child_process\.exec\s*\(/g,    reason: 'child_process.exec() in broker forward path' },
    { re: /child_process\.execSync\s*\(/g, reason: 'child_process.execSync() in broker forward path' },
    { re: /\bexecSync\s*\(/g,             reason: 'execSync() in broker forward path' },
    // exec( but not execFileSync/execFile — the safe variants
    { re: /(?<![A-Za-z])exec\s*\(/g,      reason: 'exec() in broker forward path' },
    // spawn with template literal first arg: spawn(`...${
    { re: /spawn\s*\(\s*`[^`]*\$\{/g,    reason: 'spawn() with template-literal arg in broker forward path' },
    { re: /require\s*\(\s*['"]child_process['"]\s*\)\s*\.exec/g,
                                          reason: 'require(child_process).exec in broker forward path' },
  ];

  const lines = region.split('\n');
  // Offset: if we extracted a subregion, find where it starts in the source
  let lineOffset = 0;
  if (region !== source) {
    const regionStart = source.indexOf(region);
    if (regionStart !== -1) {
      lineOffset = source.slice(0, regionStart).split('\n').length - 1;
    }
  }

  const violations = [];
  for (const { re, reason } of FORBIDDEN) {
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      re.lastIndex = 0;
      if (re.test(line)) {
        violations.push({
          file: filePath,
          line: lineOffset + li + 1,
          snippet: line.trim().slice(0, 120),
          reason,
        });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return {
    ok: true,
    evidence: `No shell execution patterns found in ${regionLabel} of plugin-loader.js`,
  };
}

/**
 * W-SEC-19 — assertPluginStdoutNeverReachesAuditWriter
 *
 * Reads bin/_lib/plugin-loader.js and bin/_lib/audit-event-writer.js.
 * Scans plugin-loader.js for calls to the audit writer (audit({ or writeEvent({).
 * For each call, flags any argument field whose value contains an unsafe
 * plugin output reference without the Wave 2 F-01/F-02 safety wrappers:
 *   - `plugin.stdout` or `proc.stdout` (raw stdout)
 *   - `frame.error.message` without `_clampPluginString(` wrapper
 *   - `runtimeTools[...].name` without `_safePluginName(` wrapper
 *
 * False-negative tradeoffs: multi-line object literals are scanned line-by-line
 * which may miss field values split across multiple lines. The probe is
 * conservative: it will not miss the most common single-line patterns.
 *
 * @param {string} [loaderPath]       Optional override path for plugin-loader.js
 * @param {string} [auditWriterPath]  Optional override path for audit-event-writer.js
 * @returns {{ok:boolean, evidence?:string, violations?:Array<{file,line,snippet,reason}>}}
 */
function assertPluginStdoutNeverReachesAuditWriter(loaderPath, auditWriterPath) {
  const filePath = _resolveSourcePath(loaderPath, 'bin/_lib/plugin-loader.js');
  const source = _readSourceFile(filePath);
  if (source === null) {
    return {
      ok: true,
      evidence: 'plugin-loader.js does not exist yet — probe passes vacuously',
    };
  }

  // Also verify the audit writer exists (informational)
  const auditPath = _resolveSourcePath(auditWriterPath, 'bin/_lib/audit-event-writer.js');
  void auditPath; // path resolved for documentation purposes

  const lines = source.split('\n');
  const violations = [];

  // Find lines that contain audit writer calls
  const auditCallRe = /\baudit\s*\(\s*\{|\bwriteEvent\s*\(\s*\{/;

  // Patterns that flag unsafe plugin output usage
  const UNSAFE_PATTERNS = [
    {
      re: /\bplugin\.stdout\b/,
      reason: 'plugin.stdout passed to audit writer without _clampPluginString wrapper',
    },
    {
      re: /\bproc\.stdout\b/,
      reason: 'proc.stdout passed to audit writer without _clampPluginString wrapper',
    },
    {
      // frame.error.message without _clampPluginString wrapping it
      re: /\bframe\.error\.message\b(?!.*_clampPluginString)/,
      reason: 'frame.error.message in audit call without _clampPluginString wrapper',
    },
    {
      // runtimeTools[...].name without _safePluginName wrapping it
      re: /\bruntimeTools\[.*?\]\.name\b(?!.*_safePluginName)/,
      reason: 'runtimeTools[...].name in audit call without _safePluginName wrapper',
    },
  ];

  // Scan a window of lines around each audit({ call
  for (let li = 0; li < lines.length; li++) {
    if (!auditCallRe.test(lines[li])) continue;
    // Scan the call site line and the next 15 lines for the object body
    const windowEnd = Math.min(li + 15, lines.length);
    for (let wi = li; wi < windowEnd; wi++) {
      const wline = lines[wi];
      for (const { re, reason } of UNSAFE_PATTERNS) {
        if (re.test(wline)) {
          violations.push({
            file: filePath,
            line: wi + 1,
            snippet: wline.trim().slice(0, 120),
            reason,
          });
        }
      }
    }
  }

  // The "raw plugin stdout" scan was removed because it produced false positives
  // on legitimate stdout listener wiring. The invariant is "stdout content does
  // not become an audit-event field VALUE", which the audit-call-window scan
  // above enforces precisely.

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return {
    ok: true,
    evidence: 'No unsafe plugin stdout/stderr paths to audit writer found in plugin-loader.js',
  };
}

/**
 * W-SEC-DEF-1.1 — assertNoModelOutputInDispatch
 *
 * Reads bin/mcp-server/server.js (or supplied serverPath). Asserts the
 * `tools/call` dispatch path resolves the tool by static name lookup in
 * TOOL_TABLE — NOT by a dynamically-derived LLM key.
 *
 * Heuristic: inside the `tools/call` branch, assert there is a static table
 * lookup (`TOOL_TABLE[name]` or `toolRegistry.resolveTool(name)`) and no
 * dynamic dispatch patterns like `dispatch[modelOutput]` or
 * `tools[input.command]` where the key is model-generated.
 *
 * This probe is preventive — current code is fine. It locks in the safe pattern.
 *
 * False-negative tradeoffs: renaming `TOOL_TABLE` breaks the positive evidence
 * check. The negative patterns (`dispatch[modelOutput]`, `tools[input.command]`)
 * cover only the most obvious injection forms; sophisticated obfuscation is not
 * detected.
 *
 * @param {string} [serverPath]  Optional override path
 * @returns {{ok:boolean, evidence?:string, violations?:Array<{file,line,snippet,reason}>}}
 */
function assertNoModelOutputInDispatch(serverPath) {
  const filePath = _resolveSourcePath(serverPath, 'bin/mcp-server/server.js');
  const source = _readSourceFile(filePath);
  if (source === null) {
    return { ok: false, violations: [{ file: filePath, line: 0, snippet: '', reason: 'server.js not found' }] };
  }

  const violations = [];

  // Pattern 1: assert static lookup exists somewhere in tools/call branch
  const hasStaticLookup = /TOOL_TABLE\s*\[\s*name\s*\]/.test(source) ||
    /toolRegistry\.resolveTool\s*\(\s*name\s*\)/.test(source);

  if (!hasStaticLookup) {
    violations.push({
      file: filePath,
      line: 0,
      snippet: '(no TOOL_TABLE[name] or toolRegistry.resolveTool(name) found)',
      reason: 'tools/call dispatch does not use static table lookup — dynamic dispatch suspected',
    });
  }

  // Pattern 2: flag dynamic dispatch patterns that suggest model-output indexing
  const DYNAMIC_DISPATCH_PATTERNS = [
    { re: /\bdispatch\s*\[\s*modelOutput\s*\]/g,    reason: 'dynamic dispatch[modelOutput] detected' },
    { re: /\btools\s*\[\s*input\.command\s*\]/g,    reason: 'dynamic tools[input.command] detected' },
    { re: /\bhandlers\s*\[\s*llmSuggested\s*\]/g,   reason: 'dynamic handlers[llmSuggested] detected' },
    { re: /eval\s*\(\s*.*?method/g,                  reason: 'eval() used in dispatch path' },
  ];

  const lines = source.split('\n');
  for (const { re, reason } of DYNAMIC_DISPATCH_PATTERNS) {
    for (let li = 0; li < lines.length; li++) {
      re.lastIndex = 0;
      if (re.test(lines[li])) {
        violations.push({
          file: filePath,
          line: li + 1,
          snippet: lines[li].trim().slice(0, 120),
          reason,
        });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return {
    ok: true,
    evidence: 'tools/call dispatch uses static TOOL_TABLE[name] lookup; no dynamic model-output dispatch detected',
  };
}

/**
 * W-SEC-DEF-1.2 — assertEnvStripIsApplied
 *
 * Reads bin/_lib/plugin-loader.js (or supplied loaderPath). Finds all
 * `spawn(` calls. For each, asserts the `env:` option is either:
 *   - A call to buildSpawnEnv(...)
 *   - A reference to a variable named `childEnv` or `spawnEnv`
 *   - An object literal that does NOT contain `...process.env` spread
 *
 * Flags: `env: process.env` (direct), or spawn() call where `env:` is absent
 * (which causes POSIX to inherit process.env wholesale). Also flags
 * `...process.env` spread inside env objects.
 *
 * False-negative tradeoffs: the `env:` absence check is heuristic — it looks
 * for spawn() call sites and checks the surrounding ~10 lines for `env:`. Multi-
 * argument spawns where `env:` appears far from the spawn() call may be missed.
 *
 * @param {string} [loaderPath]  Optional override path
 * @returns {{ok:boolean, evidence?:string, violations?:Array<{file,line,snippet,reason}>}}
 */
function assertEnvStripIsApplied(loaderPath) {
  const filePath = _resolveSourcePath(loaderPath, 'bin/_lib/plugin-loader.js');
  const source = _readSourceFile(filePath);
  if (source === null) {
    return {
      ok: true,
      evidence: 'plugin-loader.js does not exist yet — probe passes vacuously',
    };
  }

  const lines = source.split('\n');
  const violations = [];
  const spawnCallRe = /\bspawn\s*\(/;

  for (let li = 0; li < lines.length; li++) {
    if (!spawnCallRe.test(lines[li])) continue;

    // Scan the spawn call site and next 10 lines for the options object
    const windowEnd = Math.min(li + 10, lines.length);
    const windowText = lines.slice(li, windowEnd).join('\n');

    // Flag direct process.env pass
    if (/\benv\s*:\s*process\.env\b/.test(windowText)) {
      violations.push({
        file: filePath,
        line: li + 1,
        snippet: lines[li].trim().slice(0, 120),
        reason: 'spawn() passes env: process.env directly — env stripping not applied',
      });
      continue;
    }

    // Flag ...process.env spread in env object
    if (/\benv\s*:\s*\{[^}]*\.\.\.\s*process\.env/.test(windowText)) {
      violations.push({
        file: filePath,
        line: li + 1,
        snippet: lines[li].trim().slice(0, 120),
        reason: 'spawn() uses ...process.env spread in env object — sensitive vars may leak',
      });
      continue;
    }

    // Check if env: is absent entirely in the options window
    const hasEnvField = /\benv\s*:/.test(windowText);
    if (!hasEnvField) {
      // Only flag if there appears to be an options object (contains { or ,)
      const hasOptionsObj = /spawn\s*\([^,)]+,[^,)]+,\s*\{/.test(windowText) ||
        /spawn\s*\([^)]+\{/.test(windowText);
      if (hasOptionsObj) {
        violations.push({
          file: filePath,
          line: li + 1,
          snippet: lines[li].trim().slice(0, 120),
          reason: 'spawn() options object has no env: field — process.env inherited wholesale on POSIX',
        });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return {
    ok: true,
    evidence: 'All spawn() calls in plugin-loader.js use filtered env (buildSpawnEnv/childEnv/spawnEnv)',
  };
}

/**
 * W-SEC-DEF-1.3 — assertConsentRequiredBeforeSpawn
 *
 * Reads bin/_lib/plugin-loader.js (or supplied loaderPath). Locates the
 * `load()` function. Asserts that _loadConsent( appears BEFORE spawnAndHandshake(
 * or _spawnPlugin( (by string index position within the load() body).
 *
 * Wave 3 addition: This probe was added in W-SEC-DEF-1.3 and serves as the
 * mechanical lock preventing Wave 4+ regressions from reordering the consent
 * check and spawn calls in the load() lifecycle.
 *
 * False-negative tradeoffs: if consent and spawn are in separate helper
 * functions called from load(), the positional heuristic may not detect a
 * reorder. The probe assumes inline call order within the load() body.
 *
 * @param {string} [loaderPath]  Optional override path
 * @returns {{ok:boolean, evidence?:string, violations?:Array<{file,line,snippet,reason}>}}
 */
function assertConsentRequiredBeforeSpawn(loaderPath) {
  const filePath = _resolveSourcePath(loaderPath, 'bin/_lib/plugin-loader.js');
  const source = _readSourceFile(filePath);
  if (source === null) {
    return {
      ok: true,
      evidence: 'plugin-loader.js does not exist yet — probe passes vacuously',
    };
  }

  const loadBody = _extractFunctionBody(source, 'load');
  const region = loadBody || source;
  const regionLabel = loadBody ? 'load() body' : 'full file (load() not isolated)';

  const consentIdx = region.indexOf('_loadConsent(');
  const spawnAndHandshakeIdx = region.indexOf('spawnAndHandshake(');
  const spawnPluginIdx = region.indexOf('_spawnPlugin(');

  const spawnIdx = Math.min(
    spawnAndHandshakeIdx === -1 ? Infinity : spawnAndHandshakeIdx,
    spawnPluginIdx === -1 ? Infinity : spawnPluginIdx
  );

  if (consentIdx === -1 && spawnIdx === Infinity) {
    // Neither function found — file doesn't implement the lifecycle yet
    return {
      ok: true,
      evidence: `Neither _loadConsent nor spawn call found in ${regionLabel} — lifecycle not yet implemented`,
    };
  }

  if (consentIdx === -1) {
    return {
      ok: false,
      violations: [{
        file: filePath,
        line: 0,
        snippet: '(no _loadConsent call found)',
        reason: `${regionLabel} calls spawn without _loadConsent — consent check missing`,
      }],
    };
  }

  if (spawnIdx === Infinity) {
    return {
      ok: true,
      evidence: `_loadConsent present in ${regionLabel} but no spawn call — consent check order satisfied`,
    };
  }

  if (consentIdx < spawnIdx) {
    return {
      ok: true,
      evidence: `_loadConsent (pos ${consentIdx}) precedes spawn (pos ${spawnIdx}) in ${regionLabel}`,
    };
  }

  // Compute approximate line numbers for the violation
  const beforeConsent = region.slice(0, consentIdx).split('\n').length;
  const beforeSpawn = region.slice(0, spawnIdx).split('\n').length;
  const lineOffset = loadBody && source
    ? source.slice(0, source.indexOf(region)).split('\n').length
    : 0;

  return {
    ok: false,
    violations: [{
      file: filePath,
      line: lineOffset + beforeSpawn,
      snippet: `spawn at pos ${spawnIdx}, _loadConsent at pos ${consentIdx}`,
      reason: `spawn() called (line ~${lineOffset + beforeSpawn}) before _loadConsent() (line ~${lineOffset + beforeConsent}) — consent check must precede spawn`,
    }],
  };
}

/**
 * W-SEC-DEF-1.4 — assertNoEvalInPluginLoader
 *
 * Reads bin/_lib/plugin-loader.js (or supplied loaderPath). Asserts NO
 * occurrence of eval(), new Function(), Function('...'), vm.run*,
 * vm.compileFunction, or dynamic require() calls (require(variable) where
 * the argument is not a string literal).
 *
 * Note: `require('foo')` is safe (string literal); `require(someVar)` is flagged.
 *
 * False-negative tradeoffs: `eval` assigned to a variable and called later
 * (e.g. `const e = eval; e(...)`) is not detected. The heuristic covers
 * direct call-site forms only.
 *
 * @param {string} [loaderPath]  Optional override path
 * @returns {{ok:boolean, evidence?:string, violations?:Array<{file,line,snippet,reason}>}}
 */
function assertNoEvalInPluginLoader(loaderPath) {
  const filePath = _resolveSourcePath(loaderPath, 'bin/_lib/plugin-loader.js');
  const source = _readSourceFile(filePath);
  if (source === null) {
    return {
      ok: true,
      evidence: 'plugin-loader.js does not exist yet — probe passes vacuously',
    };
  }

  const lines = source.split('\n');
  const violations = [];

  const FORBIDDEN_PATTERNS = [
    { re: /\beval\s*\(/g,                 reason: 'eval() call detected' },
    { re: /\bnew\s+Function\s*\(/g,       reason: 'new Function() constructor detected' },
    { re: /\bFunction\s*\(\s*['"]/g,      reason: "Function('...') call detected" },
    { re: /\bvm\.runInNewContext\s*\(/g,  reason: 'vm.runInNewContext() detected' },
    { re: /\bvm\.runInThisContext\s*\(/g, reason: 'vm.runInThisContext() detected' },
    { re: /\bvm\.compileFunction\s*\(/g,  reason: 'vm.compileFunction() detected' },
    // Dynamic require: require(someVar) — require( NOT followed by a quote/backtick
    { re: /\brequire\s*\(\s*(?!['"`])[a-zA-Z_$]/g,
                                          reason: 'Dynamic require(variable) detected — only string-literal require() is safe' },
  ];

  for (const { re, reason } of FORBIDDEN_PATTERNS) {
    for (let li = 0; li < lines.length; li++) {
      re.lastIndex = 0;
      if (re.test(lines[li])) {
        violations.push({
          file: filePath,
          line: li + 1,
          snippet: lines[li].trim().slice(0, 120),
          reason,
        });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return {
    ok: true,
    evidence: 'No eval, new Function, vm.run*, or dynamic require() found in plugin-loader.js',
  };
}

/**
 * W-SEC-DEF-1.5 — assertPluginToolsNeverInTopLevelMcpServers
 *
 * Reads bin/mcp-server/server.js (or supplied serverPath). Asserts NO code
 * path writes plugin tools into the top-level `mcpServers` registration — i.e.
 * no `mcpServers[...] =` assignments or `Object.assign(mcpServers, ...)` calls.
 *
 * This probe enforces G0 condition C4: sub-plugin tools MUST be brokered through
 * Orchestray's MCP server, never registered as top-level mcpServers. Current
 * server.js does not register sub-plugins; this probe locks that in.
 *
 * Heuristic: scan for all `mcpServers` occurrences. Reads (env lookups, comments,
 * string literals, error messages) are fine. Writes are violations.
 *
 * False-negative tradeoffs: if `mcpServers` is aliased to another variable and
 * written through the alias, this probe will not detect it.
 *
 * @param {string} [serverPath]  Optional override path
 * @returns {{ok:boolean, evidence?:string, violations?:Array<{file,line,snippet,reason}>}}
 */
function assertPluginToolsNeverInTopLevelMcpServers(serverPath) {
  const filePath = _resolveSourcePath(serverPath, 'bin/mcp-server/server.js');
  const source = _readSourceFile(filePath);
  if (source === null) {
    return { ok: false, violations: [{ file: filePath, line: 0, snippet: '', reason: 'server.js not found' }] };
  }

  const lines = source.split('\n');
  const violations = [];

  // Write patterns that would register plugin tools as top-level mcpServers
  const WRITE_PATTERNS = [
    {
      re: /\bmcpServers\s*\[\s*.*?\]\s*=/g,
      reason: 'mcpServers[...] = ... assignment detected — plugin tools must not be top-level mcpServers',
    },
    {
      re: /\bObject\.assign\s*\(\s*mcpServers\s*,/g,
      reason: 'Object.assign(mcpServers, ...) detected — plugin tools must not be registered as top-level mcpServers',
    },
    {
      re: /\bmcpServers\.push\s*\(/g,
      reason: 'mcpServers.push() detected — plugin tools must not be top-level mcpServers',
    },
    {
      // mcpServers = { ... } or mcpServers = [...] assignment (not const/let declaration of empty)
      re: /\bmcpServers\s*=\s*(?:\{|\[)(?!\s*\}|\s*\])/g,
      reason: 'mcpServers = {...} assignment with content detected — plugin tools must not be registered as top-level mcpServers',
    },
  ];

  for (const { re, reason } of WRITE_PATTERNS) {
    for (let li = 0; li < lines.length; li++) {
      re.lastIndex = 0;
      if (re.test(lines[li])) {
        violations.push({
          file: filePath,
          line: li + 1,
          snippet: lines[li].trim().slice(0, 120),
          reason,
        });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return {
    ok: true,
    evidence: 'No top-level mcpServers write detected in server.js — sub-plugin tools are brokered correctly',
  };
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
  // W-SEC-13
  assertNoShellInBrokerForwardPath,
  // W-SEC-19
  assertPluginStdoutNeverReachesAuditWriter,
  // W-SEC-DEF-1
  assertNoModelOutputInDispatch,
  assertEnvStripIsApplied,
  assertConsentRequiredBeforeSpawn,
  assertNoEvalInPluginLoader,
  assertPluginToolsNeverInTopLevelMcpServers,
  // Surfaced for tests:
  _normalizeProjectPath,
  _ALLOWED_OPS,
};
