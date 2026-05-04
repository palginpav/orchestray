'use strict';

/**
 * plugin-loader.js — Wave 2 broker lifecycle/spawn/handshake/dispatch backbone
 *                    for the v2.3.0 MCP-broker plugin loader.
 *
 * This module is the consumer of the Wave 1 foundations (manifest schema,
 * input-schema validator, namespace builder, redactor, layered tool registry).
 * It implements the lifecycle FSM, child-process spawn, MCP handshake,
 * tool-call forwarding, and stdout-cap protection — the things that turn
 * the broker from a config object into a thing that can actually load and
 * proxy a sub-plugin.
 *
 * W-items implemented in this file (cited inline at each implementation site):
 *
 *   W-LOAD-1  8-state lifecycle FSM (unknown → discovered → consented →
 *             loading → ready ↔ degraded → dead → unloaded). Restart backoff
 *             [1s, 5s, 30s] with 5-minute reset window.
 *   W-LOAD-2  child_process.spawn integration with detached process group
 *             (W-SEC-17) and env-strip allowlist (W-SEC-16).
 *   W-LOAD-3  MCP handshake (initialize + tools/list) and manifest
 *             reconciliation (declared tools must exactly match runtime tools);
 *             on divergence: dead reason=manifest_divergence.
 *   W-LOAD-4  callTool path: state-check + declared-tool-check + W-SEC-9
 *             schema validation + forward + per-call timeout (60s default).
 *   W-LOAD-5  Per-line + total-backlog cap on plugin stdout parser
 *             (1 MB / 16 MB; W-SEC-23) — kill plugin on overflow with
 *             plugin_dead reason=protocol_dos.
 *   W-SEC-1   Symlink rejection at scan AND spawn time (lstat-based).
 *   W-SEC-2   Path-shadow detection across scan paths (first wins; second
 *             emits plugin_install_rejected reason=path_shadow).
 *   W-SEC-9   Strict input-schema validation via compileToolInputSchema()
 *             before forwarding tool-call arguments.
 *   W-SEC-16  Env-strip: spawned process env built from a short allowlist,
 *             never inherited wholesale.
 *   W-SEC-17  Process-group SIGTERM on broker shutdown (detached:true +
 *             SIGTERM to -pid). Grandchildren are killed too.
 *   W-SEC-23  Stdout cap (1 MB per-line, 16 MB total backlog) with kill on
 *             overflow.
 *
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { _register, _unregister, _isCoreTool } = require('../mcp-server/lib/tool-registry');
const { parseManifest }                       = require('./plugin-manifest-schema');
const { compileToolInputSchema }              = require('./plugin-input-schema-validator');
const { buildNamespacedName, parseNamespacedName } = require('./plugin-namespace');
const { redactArgs }                          = require('./plugin-redact');
const { writeEvent }                          = require('./audit-event-writer');
const { isInsideAllowed, safeRealpath }       = require('./path-containment');

// Same kebab-case regex used by plugin-manifest-schema. Filters plugin-controlled
// tool names before they reach audit fields, and bounds plugin-derived error strings
// before they flow into mcpError / audit log.
const _PLUGIN_NAME_RE = /^[a-z][a-z0-9-]{1,47}$/;
const _PLUGIN_STRING_MAX = 256;
function _safePluginName(s) {
  return (typeof s === 'string' && _PLUGIN_NAME_RE.test(s)) ? s : '<invalid_name>';
}
function _clampPluginString(s, maxLen = _PLUGIN_STRING_MAX) {
  if (typeof s !== 'string') return String(s);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

// ---------------------------------------------------------------------------
// W-SEC-7: manifest+entrypoint fingerprint
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON canonicalizer. Sorts object keys alphabetically; arrays
 * preserve order. Used as the manifest input to the SHA-256 fingerprint so
 * identical-by-value manifests produce identical fingerprints regardless of
 * key insertion order.
 *
 * @param {*} value
 * @returns {string}
 */
function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalizeJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalizeJson(value[k])).join(',') + '}';
}

/**
 * W-SEC-7: SHA-256 fingerprint covering BOTH the manifest AND the entrypoint
 * file bytes. Length-prefixed concat — uint32-BE manifest length || canonical
 * JSON bytes || uint32-BE entrypoint length || raw entrypoint bytes — prevents
 * field-boundary ambiguity (a fingerprint cannot collide by smearing manifest
 * bytes into entrypoint bytes).
 *
 * Closes the v2.3.0 G0 C2 gap left by Wave 2 (which trusted the on-disk
 * manifest verbatim with no integrity binding to the executable).
 *
 * @param {object} manifest    - already parseManifest-validated
 * @param {string} entrypointAbs - absolute path to plugin entrypoint
 * @returns {string} hex SHA-256 digest
 */
function computeFingerprint(manifest, entrypointAbs) {
  const canonical = canonicalizeJson(manifest);
  const manifestBuf  = Buffer.from(canonical, 'utf8');
  const entrypointBuf = fs.readFileSync(entrypointAbs); // throws if missing — caller decides handling
  const lenBuf = Buffer.allocUnsafe(8);
  lenBuf.writeUInt32BE(manifestBuf.length, 0);
  lenBuf.writeUInt32BE(entrypointBuf.length, 4);
  return crypto.createHash('sha256')
    .update(lenBuf.slice(0, 4))
    .update(manifestBuf)
    .update(lenBuf.slice(4, 8))
    .update(entrypointBuf)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// W-SEC-DEF-2: defense-in-depth observation helpers
//
// Pure observers — none of these reject or mutate. Each maps to a single audit
// event type.
// ---------------------------------------------------------------------------

const _SENSITIVE_ARG_KEY_RE = /password|token|secret|api[_-]?key|auth/i;
const _DANGEROUS_TOOL_NAME_RE = /^(exec|run|shell|bash|spawn|eval|run_command|system|kill)/i;
const _NETWORK_HINT_RE = /\b(http|https|fetch|url|request|download|websocket|socket)\b/i;
const _RESPONSE_INJECTION_RE = /(ignore|disregard)[^.\n]{0,40}?(previous|prior|above|earlier)/i;
const _RESPONSE_INJECTION_PREFIXES = ['<|', '<|im_start', '###system', '### system'];

/**
 * Scan an args object's TOP-LEVEL keys for sensitive-name matches. Returns an
 * array of matched keys (empty if none). Top-level only (mirrors redactor's
 * coarse pass) — emit-only, never blocks.
 * @param {object|null|undefined} args
 * @returns {string[]}
 */
function _scanSensitiveArgKeys(args) {
  if (!args || typeof args !== 'object') return [];
  const matched = [];
  for (const k of Object.keys(args)) {
    // Skip __proto__ / prototype / constructor.
    if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
    if (_SENSITIVE_ARG_KEY_RE.test(k)) matched.push(k);
  }
  return matched;
}

/**
 * Inspect tool definitions reported by handshake. Returns the first tool name
 * that matches the dangerous-name pattern, or null. Caller emits one event
 * per match (we surface the FIRST match to keep the audit trail bounded).
 * @param {Array<{name: string}>} toolDecls
 * @returns {{tool: string} | null}
 */
function _findDangerousToolName(toolDecls) {
  if (!Array.isArray(toolDecls)) return null;
  for (const t of toolDecls) {
    if (t && typeof t.name === 'string' && _DANGEROUS_TOOL_NAME_RE.test(t.name)) {
      return { tool: t.name };
    }
  }
  return null;
}

/**
 * Capability-inconsistency heuristic: if the manifest's capabilities.network
 * is explicitly false, but any tool's description text suggests network use,
 * we surface that as an info-level event (warn-tier observability).
 *
 * Manifest schema does not currently require a capabilities object — Wave 1
 * `parseManifest` accepts manifests without it — so we treat absent as "no
 * claim" and emit nothing in that case.
 *
 * @param {object} manifest
 * @returns {{tool: string, hint: string} | null}
 */
/**
 * Recursively walk a JSON Schema object and return true if any property
 * declares format: "uri" or format: "url". Bounded to 4 levels of nesting.
 * @param {*} schema
 * @param {number} [depth]
 * @returns {boolean}
 */
function _schemaHasUriFormat(schema, depth) {
  if (!schema || typeof schema !== 'object' || (depth || 0) > 4) return false;
  if ((schema.format === 'uri' || schema.format === 'url') && schema.type === 'string') return true;
  if (schema.properties && typeof schema.properties === 'object') {
    for (const v of Object.values(schema.properties)) {
      if (_schemaHasUriFormat(v, (depth || 0) + 1)) return true;
    }
  }
  if (Array.isArray(schema.items) ? schema.items.some(i => _schemaHasUriFormat(i, (depth || 0) + 1)) :
      schema.items && _schemaHasUriFormat(schema.items, (depth || 0) + 1)) return true;
  return false;
}

function _findCapabilityInconsistency(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const caps = manifest.capabilities;
  if (!caps || typeof caps !== 'object') return null;
  if (caps.network !== false) return null; // not asserting "no network"
  const tools = Array.isArray(manifest.tools) ? manifest.tools : [];
  for (const t of tools) {
    if (!t) continue;
    // Check description text for network hints.
    if (typeof t.description === 'string') {
      const m = t.description.match(_NETWORK_HINT_RE);
      if (m) return { tool: t.name, hint: m[0] };
    }
    // F-29: also check inputSchema for uri/url format properties.
    if (t.inputSchema && _schemaHasUriFormat(t.inputSchema, 0)) {
      return { tool: t.name, hint: 'inputSchema:format=uri/url' };
    }
  }
  return null;
}

/**
 * Inspect a plugin tool-call response for prompt-injection markers. Pure
 * observation — never mutates the response. Returns the matched marker
 * (string) on suspicion, null otherwise.
 *
 * Heuristic only: looks at `result.content[*].text` for text-type entries.
 * @param {*} result
 * @returns {string | null}
 */
function _scanResponseForInjection(result) {
  if (!result || typeof result !== 'object') return null;
  const content = Array.isArray(result.content) ? result.content : [];
  for (const item of content) {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') continue;
    const text = item.text;
    if (text.length === 0) continue;
    // Prefix check — lossless leading-whitespace tolerance.
    const trimmedStart = text.replace(/^\s+/, '');
    for (const pfx of _RESPONSE_INJECTION_PREFIXES) {
      if (trimmedStart.startsWith(pfx)) return pfx;
    }
    const m = text.match(_RESPONSE_INJECTION_RE);
    if (m) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Defaults — config-aware-ready (Wave 4 W-CFG-1 will wire config.json into opts)
// ---------------------------------------------------------------------------

/**
 * Frozen default options. createLoader(opts) merges userOpts onto a fresh
 * shallow copy, so callers cannot mutate the defaults.
 */
const DEFAULT_OPTS = Object.freeze({
  /** Filesystem scan paths in priority order (first wins on path-shadow). */
  discoveryPaths: Object.freeze([
    process.env.ORCHESTRAY_PLUGIN_DATA
      ? path.join(process.env.ORCHESTRAY_PLUGIN_DATA, 'plugins')
      : null,
    process.env.HOME ? path.join(process.env.HOME, '.orchestray', 'plugins') : null,
    path.join(process.cwd(), '.orchestray', 'plugins'),
  ].filter(Boolean)),
  /** Optional explicit blocklist of scan paths (per-test override). */
  scanPathsBlocklist: Object.freeze([]),
  /** Per-call tool timeout (ms). */
  toolCallTimeoutMs: 60_000,
  /** Restart attempts before plugin is parked in `dead`. */
  maxRestartAttempts: 3,
  /** Restart backoff schedule (ms). attempt N uses index min(N-1, len-1). */
  restartBackoffMs: Object.freeze([1_000, 5_000, 30_000]),
  /** Window after which a plugin in `ready` resets its restart counter. */
  restartResetWindowMs: 5 * 60_000,
  /** W-SEC-23: per-line stdout cap (bytes). */
  perLineMaxBytes: 1_048_576,
  /** W-SEC-23: total backlog cap across emitted+pending stdout (bytes). */
  totalBacklogMaxBytes: 16 * 1_048_576,
  /** W-SEC-16: env allowlist — exact key OR `PREFIX_*` wildcard. */
  envAllowlist: Object.freeze(['PATH', 'HOME', 'USER', 'LANG', 'LC_*', 'NODE_OPTIONS', 'TZ']),
  /** Spawn-handshake timeout (ms). */
  spawnTimeoutMs: 10_000,
  /** Discovery cap: max plugins per scan path. */
  maxPluginsPerPath: 50,
  /** Discovery cap: max scan paths processed. */
  maxScanPaths: 3,
  /**
   * W-SEC-4 (Wave 3): when true (default), load() reads
   * plugin-consents.json under an O_EXCL advisory lock and only proceeds if a
   * consent record exists whose fingerprint matches the current
   * manifest+entrypoint fingerprint. Per feedback_default_on_shipping the
   * default is now true; legacy tests opt out by passing `requireConsent: false`.
   *
   */
  requireConsent: true,
  /**
   * W-SEC-4: explicit consent-file path override. When unset, falls
   * back to ~/.orchestray/state/plugin-consents.json (or cwd-local if HOME
   * is unset, preserving worktree isolation in CI).
   */
  consentFile: null,
  /** Override hook for tests: replaces the writeEvent dependency. */
  audit: writeEvent,
  /** Override hook for tests: replaces the tool-registry dependency. */
  registry: { _register, _unregister, _isCoreTool },
  /**
   * F-4: explicit blocklist of plugin names (from ORCHESTRAY_PLUGIN_DISABLE env).
   * Plugins in this list are rejected at load() time without spawning.
   */
  disabledPlugins: Object.freeze([]),
  /**
   * F-3: dry-run mode — discover and validate plugins but do not spawn.
   */
  dry_run: false,
  /**
   * F-22: discovery enabled flag.
   */
  discoveryEnabled: true,
  /**
   * F-22: emit tool invocation events (telemetry.emit_tool_invocation_events).
   */
  emitToolInvocationEvents: true,
  /**
   * F-22: redact args in audit events (telemetry.redact_args). Never default false.
   */
  redactArgs: true,
});

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the spawned process's environment from a short allowlist (W-SEC-16).
 * NEVER spread process.env wholesale — that leaks ANTHROPIC_API_KEY,
 * CLAUDE_CODE_*, ORCHESTRAY_* into untrusted plugin code.
 *
 * @param {readonly string[]} allowlist - exact keys or `PREFIX_*` wildcards.
 * @returns {Record<string,string>}
 */
function buildSpawnEnv(allowlist) {
  const out = Object.create(null);
  if (!allowlist || allowlist.length === 0) return out;
  // Pre-compile allowlist into exact-keys + wildcard prefixes
  const exact = new Set();
  const prefixes = [];
  for (const entry of allowlist) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (entry.endsWith('_*')) {
      prefixes.push(entry.slice(0, -1)); // keep trailing underscore
    } else if (entry.endsWith('*')) {
      prefixes.push(entry.slice(0, -1));
    } else {
      exact.add(entry);
    }
  }
  for (const k of Object.keys(process.env)) {
    if (exact.has(k)) {
      out[k] = process.env[k];
      continue;
    }
    for (const p of prefixes) {
      if (k.startsWith(p)) {
        out[k] = process.env[k];
        break;
      }
    }
  }
  return out;
}

/**
 * Standard MCP isError result envelope. Used for every callTool failure
 * path — the broker always returns a tool-error result rather than throwing,
 * matching server.js's existing `isError:true` contract.
 *
 * @param {string} message
 * @returns {{isError: true, content: Array<{type: 'text', text: string}>}}
 */
function mcpError(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(message) }],
  };
}

/**
 * Tiny promise-with-timeout. Resolves with the inner promise's value or
 * rejects with `new Error(reason)` after `ms` ms.
 *
 * @template T
 * @param {Promise<T>} p
 * @param {number} ms
 * @param {string} reason
 * @returns {Promise<T>}
 */
function withTimeout(p, ms, reason) {
  let to;
  const timeoutP = new Promise((_resolve, reject) => {
    to = setTimeout(() => reject(new Error(reason)), ms);
  });
  return Promise.race([p, timeoutP]).finally(() => clearTimeout(to));
}

// ---------------------------------------------------------------------------
// Public API: createLoader
// ---------------------------------------------------------------------------

/**
 * Create a new plugin loader instance. Each instance owns its own state map
 * and stdio resources — there is no module-level mutable state. Callers may
 * create multiple loaders for testing isolation.
 *
 * @param {Partial<typeof DEFAULT_OPTS>} [userOpts]
 * @returns {{
 *   scan:       () => Promise<Array<{plugin_name: string, scan_path: string, manifest: object, rootDir: string}>>,
 *   load:       (pluginName: string) => Promise<{state: string, plugin_name: string}>,
 *   unload:     (pluginName: string) => Promise<void>,
 *   callTool:   (namespacedName: string, args: object) => Promise<object>,
 *   shutdown:   () => Promise<void>,
 *   getState:   (pluginName: string) => string,
 *   listLoaded: () => Array<{plugin_name: string, state: string, pid: number|null, manifest: object|null}>,
 *   _internals: object
 * }}
 */
function createLoader(userOpts) {
  const opts = Object.assign({}, DEFAULT_OPTS, userOpts || {});

  // Sanitize discoveryPaths against blocklist + cap.
  const blocklist = new Set((opts.scanPathsBlocklist || []).map(p => path.resolve(p)));
  const filteredScanPaths = (opts.discoveryPaths || [])
    .filter(p => p && !blocklist.has(path.resolve(p)))
    .slice(0, opts.maxScanPaths);

  const audit    = typeof opts.audit === 'function' ? opts.audit : writeEvent;
  const registry = opts.registry || { _register, _unregister, _isCoreTool };

  /**
   * Per-plugin state record.
   * @typedef {Object} PluginState
   * @property {string}   plugin_name
   * @property {string}   state                          // FSM state
   * @property {string}   scan_path
   * @property {string}   rootDir
   * @property {object|null} manifest
   * @property {import('child_process').ChildProcess|null} proc
   * @property {Map<string, Function>} compiledValidators // toolName → ajv validator
   * @property {Map<number, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} pendingCalls
   * @property {number}   nextRpcId
   * @property {string}   stdoutBuffer
   * @property {number}   stdoutBufferBytes
   * @property {number}   stdoutTotalEmittedBytes
   * @property {number}   restartAttempts
   * @property {number}   readySinceMs
   * @property {Set<string>} registeredToolNames
   * @property {string}   fingerprint                    // W-SEC-7 SHA-256 hex; '' until scan computes it
   */

  /** @type {Map<string, PluginState>} */
  const state = new Map();

  // -------------------------------------------------------------------------
  // W-LISTCH-1: tools/list_changed dual-path emission
  //
  //   Path A: notifications/tools/list_changed JSON-RPC notification via
  //           opts.notifySink — Claude Code may pick this up and re-fetch
  //           tools/list mid-session.
  //   Path B: .orchestray/state/plugin-tools-changed.flag file — written so
  //           bin/check-plugin-tools-changed-flag.js (W-LISTCH-2 hook) can
  //           surface a "Restart Claude Code" hint on the next session start.
  //           This is the FALLBACK for cases where Claude Code does NOT
  //           reliably re-fetch on the notification.
  //
  // Both paths fire after every successful overlay mutation (post-load
  // handshake, post-unload).
  //   opts.notify_list_changed === false → skip Path A
  //   opts.restart_flag_check  === false → skip Path B
  //
  // _postOverlayMutation() is invoked after each
  // registry._register/registry._unregister callsite (post-handshake load,
  // unload, dead-state cleanup); notifySink is wired via server.js.
  // -------------------------------------------------------------------------
  function _emitListChanged() {
    if (opts.notify_list_changed === false) return;
    if (typeof opts.notifySink !== 'function') return;
    try {
      opts.notifySink({
        jsonrpc: '2.0',
        method:  'notifications/tools/list_changed',
        params:  {},
      });
    } catch (err) {
      audit({ type: 'plugin_notify_failed', error: _clampPluginString(String(err && err.message || err)) });
    }
  }

  function _writeListChangedFlag() {
    if (opts.restart_flag_check === false) return;
    try {
      const root = opts.projectRoot || process.cwd();
      const flagDir = path.join(root, '.orchestray', 'state');
      fs.mkdirSync(flagDir, { recursive: true });
      fs.writeFileSync(
        path.join(flagDir, 'plugin-tools-changed.flag'),
        new Date().toISOString() + '\n'
      );
    } catch (err) {
      // Non-fatal — Path A notification may still work.
      audit({ type: 'plugin_flag_write_failed', error: _clampPluginString(String(err && err.message || err)) });
    }
  }

  function _postOverlayMutation() {
    _emitListChanged();
    _writeListChangedFlag();
  }

  // -------------------------------------------------------------------------
  // FSM helpers (W-LOAD-1)
  //
  // Allowed transitions (G2 §5):
  //   unknown → discovered
  //   discovered → consented
  //   consented → loading
  //   loading → ready
  //   loading → dead
  //   ready → degraded
  //   degraded → ready
  //   ready → dead
  //   degraded → dead
  //   dead → loading       (auto-restart, budget-permitting)
  //   dead → unloaded      (terminal)
  //   ready → unloaded
  //   degraded → unloaded
  // -------------------------------------------------------------------------

  // user-initiated unload() may force any non-terminal state straight to
  // 'unloaded' — including 'unknown' and 'loading'. Listing those edges here
  // keeps every state mutation grep-able through transition() instead of
  // hidden direct ps.state= assignments.
  const ALLOWED_TRANSITIONS = Object.freeze({
    unknown:    new Set(['discovered', 'unloaded']),
    // W-SEC-4: consent-required / fingerprint-mismatch-consent /
    // consent-lock-error all transition discovered → dead before any spawn.
    discovered: new Set(['consented', 'dead', 'unloaded']),
    consented:  new Set(['loading', 'unloaded']),
    loading:    new Set(['ready', 'dead', 'unloaded']),
    ready:      new Set(['degraded', 'dead', 'unloaded']),
    degraded:   new Set(['ready', 'dead', 'unloaded']),
    dead:       new Set(['loading', 'unloaded']),
    unloaded:   new Set([]),     // terminal — sticky
  });

  /**
   * Apply an FSM transition, throwing on invalid moves so test fixtures
   * surface bugs loudly.
   * @param {PluginState} ps
   * @param {string} next
   */
  function transition(ps, next) {
    const allowed = ALLOWED_TRANSITIONS[ps.state];
    if (!allowed || !allowed.has(next)) {
      throw new Error(
        `plugin-loader: invalid FSM transition for "${ps.plugin_name}": ${ps.state} → ${next}`
      );
    }
    ps.state = next;
    if (next === 'ready') {
      ps.readySinceMs = Date.now();
    }
  }

  /**
   * Schedule a restart-counter reset when a plugin has been ready for >= the
   * reset window. Called whenever we observe a successful tool call.
   * @param {PluginState} ps
   */
  function maybeResetRestartCounter(ps) {
    if (ps.state === 'ready'
        && ps.readySinceMs > 0
        && Date.now() - ps.readySinceMs >= opts.restartResetWindowMs) {
      ps.restartAttempts = 0;
    }
  }

  // -------------------------------------------------------------------------
  // W-SEC-4: consent file read/write under O_EXCL advisory lock.
  // W-SEC-6: atomic write via temp+rename.
  //
  // Lock semantics: <consentFile>.lock created via fs.openSync('wx'); held
  // only across read+parse+close (NOT across plugin spawn). Failing to acquire
  // the lock fails closed (throws lock_contention).
  // -------------------------------------------------------------------------

  function _consentFilePath() {
    if (opts.consentFile) return opts.consentFile;
    const home = process.env.HOME || os.homedir();
    if (home) return path.join(home, '.orchestray', 'state', 'plugin-consents.json');
    return path.join(process.cwd(), '.orchestray', 'state', 'plugin-consents.json');
  }

  /**
   * Resolve and validate the consent directory: realpath must exist and must
   * be inside the project cwd or the user's claude/orchestray homes. Returns
   * the resolved directory string, or null if the directory does not yet
   * exist (caller treats as "no consents recorded").
   *
   * @returns {string | null}
   */
  function _consentDirSafe(consentPath) {
    const dir = path.dirname(consentPath);
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // F-24: when opts.consentFile is set and the directory doesn't exist
        // yet (first-time write path), return the raw dir so _writeConsent can
        // mkdirSync it. For the default (non-overridden) path, return null so
        // _loadConsent treats the absent dir as "no consents recorded".
        if (opts.consentFile) return dir;
        return null;
      }
      throw err;
    }
    // safeRealpath / isInsideAllowed defense-in-depth. When the caller did
    // NOT override the consent path (production default → ~/.orchestray/state),
    // require the realpath to resolve inside cwd, HOME, or ~/.claude. When the
    // caller DID override (test fixtures pass per-tmpdir consent files,
    // /orchestray:plugin approve-rooted), trust the explicit choice — the
    // file at least had a successful realpath, so it is not an arbitrary
    // attacker-supplied symlink target.
    //
    if (opts.consentFile) {
      // Caller-supplied path: accept after realpath success. The caller owns
      // the trust boundary in this branch.
      return realDir;
    }
    const cwdAbs = safeRealpath(process.cwd());
    const home   = process.env.HOME || os.homedir() || '';
    const allowedRoots = [cwdAbs];
    if (home) {
      allowedRoots.push(safeRealpath(home));
      allowedRoots.push(path.join(safeRealpath(home), '.claude'));
    }
    for (const root of allowedRoots) {
      if (!root) continue;
      if (realDir === root || realDir.startsWith(root + path.sep)) return realDir;
    }
    // Fall back to isInsideAllowed for compatibility with the shared util.
    if (home && isInsideAllowed(realDir, cwdAbs, safeRealpath(path.join(home, '.claude')))) {
      return realDir;
    }
    throw new Error(`plugin-consents.json path outside allowed roots: ${realDir}`);
  }

  /**
   * Acquire the consent-file advisory lock by creating <path>.lock with O_EXCL.
   * @param {string} consentPath
   * @returns {number} fd — caller MUST close in finally.
   * @throws Error('plugin-consents.json lock contention') on EEXIST.
   */
  function _acquireConsentLock(consentPath) {
    const lockPath = consentPath + '.lock';
    try {
      // Ensure dir exists for the lock file itself.
      fs.mkdirSync(path.dirname(consentPath), { recursive: true });
    } catch (_e) { /* swallow */ }
    try {
      return fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        // Stale-lock recovery. Hold time is microseconds (read+parse+close);
        // a lock older than 10s implies a crashed prior holder. Mirrors
        // the bin/_lib/atomic-append.js pattern. Without this, a single Node
        // crash mid-lock breaks ALL subsequent plugin loads until manual
        // `rm <consentPath>.lock`.
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 10_000) {
            try { fs.unlinkSync(lockPath); } catch (_e) { /* ignore */ }
            try { return fs.openSync(lockPath, 'wx'); }
            catch (retryErr) {
              if (retryErr && retryErr.code === 'EEXIST') {
                throw new Error(
                  `plugin-consents.json lock contention at ${lockPath} — ` +
                  'another orchestray process appears to be holding the lock; ' +
                  'if no other orchestray is running, delete the .lock file manually'
                );
              }
              throw retryErr;
            }
          }
        } catch (statErr) {
          if (statErr && statErr.code === 'ENOENT') {
            // Lock disappeared between EEXIST and statSync — race resolved itself; retry.
            try { return fs.openSync(lockPath, 'wx'); }
            catch (_e) { /* fall through to throw below */ }
          }
        }
        throw new Error(
          `plugin-consents.json lock contention at ${lockPath} — ` +
          'another orchestray process appears to be holding the lock; ' +
          'if no other orchestray is running, delete the .lock file manually'
        );
      }
      throw err;
    }
  }

  function _releaseConsentLock(consentPath, fd) {
    try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    try { fs.unlinkSync(consentPath + '.lock'); } catch (_e) { /* ignore */ }
  }

  /**
   * Read the consent record for `pluginName` under the advisory lock.
   * Returns null if no consent file, no record, or revoked.
   *
   * @param {string} pluginName
   * @returns {{approved_at: string, fingerprint: string, revoked?: boolean} | null}
   */
  function _loadConsent(pluginName) {
    const consentPath = _consentFilePath();
    const safeDir = _consentDirSafe(consentPath);
    if (safeDir === null) return null; // dir absent — no consents recorded
    if (!fs.existsSync(consentPath)) return null;

    const fd = _acquireConsentLock(consentPath);
    try {
      let raw;
      try {
        raw = fs.readFileSync(consentPath, 'utf8');
      } catch (_e) { return null; }
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (_e) { return null; } // corrupt file → fail closed (treat as no consent)
      if (!parsed || typeof parsed !== 'object') return null;
      // Wave 1 plugin-manifest scrubPrototype convention — refuse __proto__ keys.
      if (Object.prototype.hasOwnProperty.call(parsed, '__proto__')) return null;
      const rec = parsed[pluginName];
      if (!rec || typeof rec !== 'object') return null;
      if (rec.revoked === true) return null;
      return rec;
    } finally {
      _releaseConsentLock(consentPath, fd);
    }
  }

  /**
   * Write a consent record atomically: read current map under the lock,
   * splice in the new entry, write to a sibling temp file, then rename
   * (W-SEC-6). Merges with existing entries — does NOT overwrite other
   * plugins' consents.
   *
   * @param {string} pluginName
   * @param {string} fingerprint
   * @returns {{approved_at: string, fingerprint: string, revoked: boolean}}
   */
  function _writeConsent(pluginName, fingerprint, extraFields = {}) {
    const consentPath = _consentFilePath();
    _consentDirSafe(consentPath);
    fs.mkdirSync(path.dirname(consentPath), { recursive: true });

    const fd = _acquireConsentLock(consentPath);
    try {
      let current = {};
      if (fs.existsSync(consentPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(consentPath, 'utf8'));
          if (parsed && typeof parsed === 'object'
              && !Object.prototype.hasOwnProperty.call(parsed, '__proto__')) {
            current = parsed;
          }
        } catch (_e) { current = {}; }
      }
      const record = Object.assign(
        { approved_at: new Date().toISOString(), fingerprint, revoked: false },
        extraFields  // applied LAST so callers can override defaults
      );
      current[pluginName] = record;
      const tmpPath = consentPath + '.tmp.' + process.pid + '.' + Date.now() + '.' + Math.floor(Math.random() * 1e9);
      // fsync the temp file BEFORE rename so a system crash between write and
      // rename cannot leave a renamed-but-zero-byte consent file. POSIX rename
      // is atomic for the directory entry, but the temp file's data may still
      // be in page cache. Cost is one disk-sync per consent grant — infrequent.
      const tmpFd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeSync(tmpFd, JSON.stringify(current, null, 2));
        try { fs.fsyncSync(tmpFd); } catch (_e) { /* fsync may fail on some FS; rename still proceeds */ }
      } finally {
        fs.closeSync(tmpFd);
      }
      fs.renameSync(tmpPath, consentPath);
      return record;
    } finally {
      _releaseConsentLock(consentPath, fd);
    }
  }

  // -------------------------------------------------------------------------
  // Discovery (W-SEC-1, W-SEC-2)
  // -------------------------------------------------------------------------

  /**
   * Scan all configured discovery paths, collect every plugin manifest that
   * passes the symlink-rejection (W-SEC-1) and path-shadow (W-SEC-2) checks.
   * The first scan path that contains a given plugin name wins; subsequent
   * matches emit `plugin_install_rejected reason=path_shadow`.
   *
   * @returns {Promise<Array<{plugin_name: string, scan_path: string, manifest: object, rootDir: string}>>}
   */
  async function scan() {
    // F-22: discovery.enabled kill switch.
    if (opts.discoveryEnabled === false) return [];

    const seenPluginNames = new Map(); // plugin_name → scan_path
    const out = [];

    for (const scanPath of filteredScanPaths) {
      let entries;
      try {
        entries = fs.readdirSync(scanPath, { withFileTypes: true });
      } catch (_err) {
        // ENOENT and friends are non-fatal — scan path may not exist on this host.
        continue;
      }

      let perPathCount = 0;
      for (const ent of entries) {
        if (perPathCount >= opts.maxPluginsPerPath) break;

        // W-SEC-1 part 1: reject symlinked plugin directories (lstat, not stat).
        if (ent.isSymbolicLink()) {
          audit({
            type: 'plugin_install_rejected',
            plugin_name: ent.name,
            scan_path: scanPath,
            reason: 'symlink',
          });
          continue;
        }
        if (!ent.isDirectory()) continue;

        const pluginRoot   = path.join(scanPath, ent.name);
        const manifestPath = path.join(pluginRoot, 'orchestray-plugin.json');

        // W-SEC-1 part 2: reject symlinked manifest files (TOCTOU defense at
        // discovery time; we re-check at spawn time as well).
        let mlst;
        try {
          mlst = fs.lstatSync(manifestPath);
        } catch (_err) {
          continue; // no manifest in this directory
        }
        if (mlst.isSymbolicLink()) {
          audit({
            type: 'plugin_install_rejected',
            plugin_name: ent.name,
            scan_path: scanPath,
            reason: 'manifest_symlink',
          });
          continue;
        }
        if (!mlst.isFile()) continue;

        // Read + parse manifest. parseManifest() handles W-SEC-10 proto-strip
        // and W-SEC-11 unicode rejection; throws ZodError on invalid manifests.
        let manifest;
        try {
          const raw = fs.readFileSync(manifestPath, 'utf8');
          manifest = parseManifest(JSON.parse(raw));
        } catch (err) {
          audit({
            type: 'plugin_install_rejected',
            plugin_name: ent.name,
            scan_path: scanPath,
            reason: 'invalid_manifest',
            error: _clampPluginString(String(err && err.message ? err.message : err)),
          });
          continue;
        }

        // W-SEC-2: first-wins on duplicate plugin name across scan paths.
        if (seenPluginNames.has(manifest.name)) {
          audit({
            type: 'plugin_install_rejected',
            plugin_name: manifest.name,
            scan_path: scanPath,
            first_seen_in: seenPluginNames.get(manifest.name),
            reason: 'path_shadow',
          });
          continue;
        }
        seenPluginNames.set(manifest.name, scanPath);

        // W-SEC-7: compute manifest+entrypoint fingerprint at discovery time.
        // The fingerprint is re-computed at spawn time and any drift transitions
        // the plugin to dead with reason=entrypoint_mismatch. If the entrypoint
        // file is missing the plugin is rejected here — load() would fail later
        // anyway, but failing fast surfaces the operator-visible reason.
        const entrypointAbs = path.join(pluginRoot, manifest.entrypoint);
        let fingerprint;
        try {
          fingerprint = computeFingerprint(manifest, entrypointAbs);
        } catch (err) {
          audit({
            type: 'plugin_install_rejected',
            plugin_name: manifest.name,
            scan_path: scanPath,
            reason: 'entrypoint_unreadable',
            error: _clampPluginString(String(err && err.message ? err.message : err)),
          });
          continue;
        }

        // Materialize/refresh the FSM record.
        let ps = state.get(manifest.name);
        if (!ps) {
          ps = createPluginRecord(manifest.name);
          state.set(manifest.name, ps);
        }
        ps.scan_path = scanPath;
        ps.rootDir   = pluginRoot;
        ps.manifest  = manifest;
        ps.fingerprint = fingerprint;
        if (ps.state === 'unknown') {
          transition(ps, 'discovered');
          audit({
            type: 'plugin_discovered',
            plugin_name: manifest.name,
            plugin_version: manifest.version,
            scan_path: scanPath,
            // Truncated for log brevity. Full fingerprint stays in ps for
            // the spawn-time re-verification compare.
            fingerprint: fingerprint.slice(0, 16),
          });
        }

        out.push({
          plugin_name: manifest.name,
          scan_path: scanPath,
          manifest,
          rootDir: pluginRoot,
        });
        perPathCount += 1;
      }
    }

    return out;
  }

  /**
   * Allocate a fresh PluginState record in `unknown` state.
   * @param {string} name
   * @returns {PluginState}
   */
  function createPluginRecord(name) {
    return {
      plugin_name: name,
      state: 'unknown',
      scan_path: '',
      rootDir: '',
      manifest: null,
      proc: null,
      compiledValidators: new Map(),
      pendingCalls: new Map(),
      nextRpcId: 1,
      stdoutBuffer: '',
      stdoutBufferBytes: 0,
      stdoutTotalEmittedBytes: 0,
      restartAttempts: 0,
      readySinceMs: 0,
      registeredToolNames: new Set(),
      fingerprint: '',
    };
  }

  // -------------------------------------------------------------------------
  // Load: spawn + handshake (W-LOAD-2, W-LOAD-3)
  // -------------------------------------------------------------------------

  /**
   * Load a plugin: gates on consent (Wave 2 stub), spawns the entrypoint,
   * runs the MCP handshake, reconciles tools/list against the manifest, and
   * registers each declared tool in the layered overlay.
   *
   * @param {string} pluginName
   * @returns {Promise<{state: string, plugin_name: string}>}
   */
  async function load(pluginName) {
    const ps = state.get(pluginName);
    if (!ps) throw new Error(`plugin-loader.load: unknown plugin "${pluginName}"`);

    // Env-disabled list check: reject before any spawn.
    if (opts.disabledPlugins && opts.disabledPlugins.includes(pluginName)) {
      audit({ type: 'plugin_install_rejected', plugin_name: pluginName, reason: 'env_disabled' });
      if (ps.state !== 'dead' && ps.state !== 'unloaded') {
        try { transition(ps, 'dead'); } catch (_e) { /* invalid transition tolerated */ }
      }
      return { state: ps.state, plugin_name: pluginName };
    }

    // W-SEC-4 + W-SEC-7: consent gate. When opts.requireConsent (default true),
    // read plugin-consents.json under the O_EXCL advisory lock and require the
    // consent record's fingerprint to match the currently-discovered
    // manifest+entrypoint fingerprint.
    if (ps.state === 'discovered') {
      if (!opts.requireConsent) {
        // Explicit-opt-out path (tests, dev). Still emit an audit event
        // so the bypass is observable in the trail.
        transition(ps, 'consented');
        audit({
          type: 'plugin_consent_granted',
          plugin_name: pluginName,
          granted_via: 'require_consent_disabled',
        });
      } else {
        let record;
        try {
          record = _loadConsent(pluginName);
        } catch (err) {
          // Lock contention or path-containment failure — fail closed.
          audit({
            type: 'plugin_install_rejected',
            plugin_name: pluginName,
            reason: 'consent_lock_error',
            error: _clampPluginString(String(err && err.message ? err.message : err)),
          });
          transitionDead(ps, 'consent_lock_error',
            _clampPluginString(String(err && err.message ? err.message : err)));
          return { state: ps.state, plugin_name: pluginName };
        }
        if (!record) {
          audit({
            type: 'plugin_install_rejected',
            plugin_name: pluginName,
            reason: 'consent_required',
          });
          transitionDead(ps, 'consent_required', 'no consent record in plugin-consents.json');
          return { state: ps.state, plugin_name: pluginName };
        }
        if (record.fingerprint !== ps.fingerprint) {
          audit({
            type: 'plugin_install_rejected',
            plugin_name: pluginName,
            reason: 'fingerprint_mismatch_consent',
            consent_fingerprint: typeof record.fingerprint === 'string'
              ? record.fingerprint.slice(0, 16) : '<invalid>',
            current_fingerprint: ps.fingerprint.slice(0, 16),
          });
          transitionDead(ps, 'fingerprint_mismatch_consent',
            'consent fingerprint does not match current manifest+entrypoint');
          return { state: ps.state, plugin_name: pluginName };
        }
        transition(ps, 'consented');
        audit({
          type: 'plugin_consent_granted',
          plugin_name: pluginName,
          granted_via: 'consent_file',
          fingerprint: ps.fingerprint.slice(0, 16),
        });
      }
    }

    if (ps.state !== 'consented' && ps.state !== 'dead') {
      // Not in a state from which load() makes sense.
      return { state: ps.state, plugin_name: pluginName };
    }

    // When state=dead from a prior consent failure, the restart timer in
    // transitionDead can re-enter load() with state=dead. The discovered-only
    // consent gate above doesn't re-fire, which would let the dead→loading→spawn
    // path proceed WITHOUT consent. Re-validate consent here. If still invalid,
    // exhaust the restart budget so the loader does not keep retrying. If consent
    // was granted between fail and restart, the plugin proceeds normally.
    if (ps.state === 'dead' && opts.requireConsent) {
      let record;
      try {
        record = _loadConsent(pluginName);
      } catch (err) {
        audit({
          type: 'plugin_install_rejected',
          plugin_name: pluginName,
          reason: 'consent_lock_error',
          error: _clampPluginString(String(err && err.message ? err.message : err)),
        });
        ps.restartAttempts = opts.maxRestartAttempts;  // exhaust budget; stop retrying
        return { state: ps.state, plugin_name: pluginName };
      }
      if (!record) {
        audit({
          type: 'plugin_install_rejected',
          plugin_name: pluginName,
          reason: 'consent_required',
        });
        ps.restartAttempts = opts.maxRestartAttempts;
        return { state: ps.state, plugin_name: pluginName };
      }
      if (record.fingerprint !== ps.fingerprint) {
        audit({
          type: 'plugin_install_rejected',
          plugin_name: pluginName,
          reason: 'fingerprint_mismatch_consent',
          consent_fingerprint: typeof record.fingerprint === 'string'
            ? record.fingerprint.slice(0, 16) : '<invalid>',
          current_fingerprint: ps.fingerprint.slice(0, 16),
        });
        ps.restartAttempts = opts.maxRestartAttempts;
        return { state: ps.state, plugin_name: pluginName };
      }
      // Consent valid now (granted between fail and restart). Audit recovery.
      audit({
        type: 'plugin_consent_granted',
        plugin_name: pluginName,
        granted_via: 'consent_file_after_dead',
        fingerprint: ps.fingerprint.slice(0, 16),
      });
    }

    // dry_run gate — discover/validate but do not spawn.
    if (opts.dry_run) {
      audit({ type: 'plugin_dry_run', plugin_name: pluginName, action: 'would_load' });
      return { state: 'discovered', plugin_name: pluginName };
    }

    transition(ps, 'loading');

    try {
      await spawnAndHandshake(ps);
      // Manifest reconciliation done inside spawnAndHandshake; if successful
      // we are now in `ready`.
      audit({
        type: 'plugin_loaded',
        plugin_name: pluginName,
        plugin_version: ps.manifest.version,
        pid: ps.proc ? ps.proc.pid : null,
        tool_count: ps.registeredToolNames.size,
      });
      return { state: ps.state, plugin_name: pluginName };
    } catch (err) {
      // F-25: clear stale pendingCalls left by sendRpc when the outer
      // spawnTimeoutMs fires before the inner toolCallTimeoutMs. Without
      // this, the inner timer fires ~50s later as the only cleanup.
      for (const [id, p] of ps.pendingCalls) {
        try { clearTimeout(p.timer); } catch (_e) { /* ignore */ }
        ps.pendingCalls.delete(id);
      }
      transitionDead(ps, err && err._reason ? err._reason : 'load_failed', _clampPluginString(String(err && err.message ? err.message : err)));
      return { state: ps.state, plugin_name: pluginName };
    }
  }

  /**
   * Spawn the entrypoint and run the MCP handshake. Sets ps.proc on success.
   * Throws an Error with a `_reason` prop on any deterministic failure path
   * (manifest_divergence, invalid_input_schema, spawn_timeout, …).
   *
   * @param {PluginState} ps
   */
  async function spawnAndHandshake(ps) {
    // Clear dead-proc reference before spawning so stale listeners
    // cannot double-fire if this is a restart attempt.
    if (ps.proc) {
      try { ps.proc.removeAllListeners(); } catch (_e) { /* ignore */ }
      ps.proc = null;
    }

    const entrypointAbs = path.join(ps.rootDir, ps.manifest.entrypoint);

    // W-SEC-1 part 3: re-check entrypoint at spawn time (TOCTOU). The scan
    // already lstat'd the manifest; re-check the entrypoint right before
    // spawn so an attacker who races the symlink in after consent is caught.
    let elst;
    try {
      elst = fs.lstatSync(entrypointAbs);
    } catch (err) {
      const e = new Error(`entrypoint not found: ${entrypointAbs}`);
      e._reason = 'entrypoint_missing';
      throw e;
    }
    if (elst.isSymbolicLink()) {
      const e = new Error(`entrypoint is a symlink (W-SEC-1): ${entrypointAbs}`);
      e._reason = 'symlink_at_spawn';
      throw e;
    }

    // W-SEC-7a: re-compute the manifest+entrypoint fingerprint right before
    // spawn and compare against the value captured at discovery time. Any drift
    // means the manifest or entrypoint was modified between consent and spawn —
    // refuse to spawn and transition dead with a discrete reason.
    if (ps.fingerprint) {
      let liveFingerprint;
      try {
        liveFingerprint = computeFingerprint(ps.manifest, entrypointAbs);
      } catch (err) {
        const e = new Error(`fingerprint recompute failed: ${err.message}`);
        e._reason = 'entrypoint_unreadable';
        throw e;
      }
      if (liveFingerprint !== ps.fingerprint) {
        audit({
          type: 'plugin_install_rejected',
          plugin_name: ps.plugin_name,
          reason: 'entrypoint_mismatch',
          discovered_fingerprint: ps.fingerprint.slice(0, 16),
          live_fingerprint: liveFingerprint.slice(0, 16),
        });
        const e = new Error('manifest or entrypoint changed between consent and spawn');
        e._reason = 'entrypoint_mismatch';
        throw e;
      }
    }

    // W-LOAD-2: spawn in detached process group with env-strip (W-SEC-16).
    // detached:true creates a new process group whose negative-pid receives
    // SIGTERM en masse on shutdown (W-SEC-17), killing grandchildren too.
    const spawnArgs = (() => {
      // Use process.execPath for node runtime; for python, rely on python3;
      // for `any`, trust the entrypoint shebang.
      if (ps.manifest.runtime === 'node') {
        return { command: process.execPath, args: [entrypointAbs] };
      }
      if (ps.manifest.runtime === 'python') {
        return { command: 'python3', args: [entrypointAbs] };
      }
      return { command: entrypointAbs, args: [] };
    })();

    const childEnv = buildSpawnEnv(opts.envAllowlist);
    const proc = spawn(spawnArgs.command, spawnArgs.args, {
      cwd: ps.rootDir,
      detached: true,                         // W-SEC-17 process group
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv,                          // W-SEC-16
      windowsHide: true,
    });

    ps.proc = proc;

    // Drain stderr so the OS pipe buffer does not fill and stall the plugin.
    proc.stderr.on('data', () => { /* drained — plugin stderr is not logged */ });

    // Stdout line parser with caps (W-LOAD-5 / W-SEC-23).
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => onStdoutChunk(ps, chunk));

    // W-SEC-17 part 2: child process exit handling.
    let exited = false;
    proc.on('exit', (code, signal) => {
      exited = true;
      // Reject any in-flight RPC calls.
      for (const [, pending] of ps.pendingCalls) {
        try { clearTimeout(pending.timer); } catch (_e) { /* ignore */ }
        pending.reject(new Error(`plugin "${ps.plugin_name}" exited mid-call (code=${code}, signal=${signal})`));
      }
      ps.pendingCalls.clear();
      if (ps.state === 'loading' || ps.state === 'ready' || ps.state === 'degraded') {
        transitionDead(ps, 'process_exit', `exit code=${code}, signal=${signal}`);
      }
    });
    proc.on('error', err => {
      if (!exited && (ps.state === 'loading' || ps.state === 'ready' || ps.state === 'degraded')) {
        transitionDead(ps, 'spawn_error', _clampPluginString(String(err && err.message ? err.message : err)));
      }
    });

    // -------------------------------------------------------------------------
    // Handshake (W-LOAD-3): initialize → tools/list, then manifest reconciliation.
    // -------------------------------------------------------------------------
    try {
      await withTimeout(
        sendRpc(ps, 'initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'orchestray-broker', version: '2.3.0' },
        }),
        opts.spawnTimeoutMs,
        `handshake initialize timeout ${opts.spawnTimeoutMs}ms`
      );
    } catch (err) {
      const e = new Error(`initialize failed: ${err.message}`);
      e._reason = 'handshake_initialize_failed';
      throw e;
    }

    let toolsListResult;
    try {
      toolsListResult = await withTimeout(
        sendRpc(ps, 'tools/list', {}),
        opts.spawnTimeoutMs,
        `handshake tools/list timeout ${opts.spawnTimeoutMs}ms`
      );
    } catch (err) {
      const e = new Error(`tools/list failed: ${err.message}`);
      e._reason = 'handshake_tools_list_failed';
      throw e;
    }

    const runtimeTools = (toolsListResult && Array.isArray(toolsListResult.tools))
      ? toolsListResult.tools
      : [];

    // Manifest reconciliation: every runtime tool MUST be declared in the
    // manifest (and vice versa). Divergence transitions to dead.
    const declaredToolNames = new Set(ps.manifest.tools.map(t => t.name));
    const runtimeToolNames  = new Set(runtimeTools.map(t => t && t.name).filter(Boolean));

    const divergent = (
      runtimeToolNames.size !== declaredToolNames.size
      || [...runtimeToolNames].some(n => !declaredToolNames.has(n))
      || [...declaredToolNames].some(n => !runtimeToolNames.has(n))
    );

    if (divergent) {
      // Plugin-controlled `actual_tools` names go through _safePluginName
      // so a malicious plugin can't inject oversized or bidi codepoints
      // into the audit log.
      audit({
        type: 'plugin_manifest_divergence',
        plugin_name: ps.plugin_name,
        expected_tools: [...declaredToolNames],
        actual_tools: [...runtimeToolNames].map(_safePluginName),
      });
      const e = new Error('manifest divergence between declared and runtime tools');
      e._reason = 'manifest_divergence';
      throw e;
    }

    // W-SEC-DEF-2: defense-in-depth observation. Pure observers, never reject.
    const dangerous = _findDangerousToolName(ps.manifest.tools);
    if (dangerous) {
      audit({
        type: 'plugin_dangerous_name',
        plugin_name: ps.plugin_name,
        tool: _safePluginName(dangerous.tool),
      });
    }
    const capInconsistency = _findCapabilityInconsistency(ps.manifest);
    if (capInconsistency) {
      audit({
        type: 'plugin_capability_inconsistency',
        plugin_name: ps.plugin_name,
        tool: _safePluginName(capInconsistency.tool),
        hint: _clampPluginString(capInconsistency.hint, 64),
        manifest_capability: 'network=false',
      });
    }

    // Compile each declared input schema (W-SEC-9). Failure transitions dead.
    for (const decl of ps.manifest.tools) {
      try {
        const validator = compileToolInputSchema(decl.inputSchema);
        ps.compiledValidators.set(decl.name, validator);
      } catch (err) {
        const e = new Error(`invalid inputSchema for tool "${decl.name}": ${err.message}`);
        e._reason = 'invalid_input_schema';
        throw e;
      }
    }

    // Register tools in the overlay. Build namespaced names; each handler is
    // a closure over (ps, declaredToolName) that delegates to callTool() so
    // every dispatch flows through the same validation+timeout+telemetry path.
    for (const decl of ps.manifest.tools) {
      const namespacedName = buildNamespacedName(ps.manifest.name, decl.name);
      // Defense-in-depth — _register itself rejects core-collisions.
      const handler = async (args) => callTool(namespacedName, args || {});
      registry._register({
        name: namespacedName,
        // Pass plugin_name through so listTools() can call
        // pluginStateAccessor(plugin_name) to annotate degraded plugins with
        // '[DEGRADED] ' and suppress dead/unloaded plugins from tools/list.
        plugin_name: ps.plugin_name,
        definition: {
          name: namespacedName,
          description: decl.description,
          inputSchema: decl.inputSchema,
        },
        handler,
      });
      ps.registeredToolNames.add(namespacedName);
    }
    // Emit tools/list_changed ONCE per plugin load, not once per tool.
    _postOverlayMutation();

    transition(ps, 'ready');
  }

  // -------------------------------------------------------------------------
  // Stdout parser (W-LOAD-5 / W-SEC-23)
  // -------------------------------------------------------------------------

  /**
   * Append a stdout chunk to the plugin's line buffer, emit any complete
   * lines, and enforce the per-line + total-backlog caps. On overflow we
   * kill the plugin with reason=protocol_dos.
   *
   * @param {PluginState} ps
   * @param {string|Buffer} chunk
   */
  function onStdoutChunk(ps, chunk) {
    if (ps.state !== 'loading' && ps.state !== 'ready' && ps.state !== 'degraded') return;
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    ps.stdoutBuffer += s;
    ps.stdoutBufferBytes = Buffer.byteLength(ps.stdoutBuffer, 'utf8');

    // W-SEC-23: total-backlog cap — emitted bytes + currently-buffered bytes.
    if (ps.stdoutBufferBytes + ps.stdoutTotalEmittedBytes > opts.totalBacklogMaxBytes) {
      killForProtocolDos(ps, 'total_backlog_exceeded');
      return;
    }

    // Drain complete lines (newline-terminated).
    let nlIdx;
    while ((nlIdx = ps.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = ps.stdoutBuffer.slice(0, nlIdx);
      ps.stdoutBuffer = ps.stdoutBuffer.slice(nlIdx + 1);

      const lineBytes = Buffer.byteLength(line, 'utf8');
      ps.stdoutBufferBytes = Buffer.byteLength(ps.stdoutBuffer, 'utf8');

      // W-SEC-23: per-line cap (1 MB default).
      if (lineBytes > opts.perLineMaxBytes) {
        killForProtocolDos(ps, 'per_line_exceeded');
        return;
      }
      ps.stdoutTotalEmittedBytes += lineBytes;

      onPluginLine(ps, line);
    }

    // Even with no newlines yet, the in-progress line itself can exceed the
    // per-line cap. Enforce that here so a plugin that streams 2 MB without
    // a newline is killed promptly.
    if (ps.stdoutBufferBytes > opts.perLineMaxBytes) {
      killForProtocolDos(ps, 'per_line_exceeded');
      return;
    }
  }

  /**
   * Kill a plugin in response to a stdout-cap overflow. Transitions to dead
   * with reason=protocol_dos, then sends SIGKILL to its process group.
   * @param {PluginState} ps
   * @param {string} subReason
   */
  function killForProtocolDos(ps, subReason) {
    transitionDead(ps, 'protocol_dos', `stdout cap: ${subReason}`);
    if (ps.proc && ps.proc.pid) {
      try { process.kill(-ps.proc.pid, 'SIGKILL'); }
      catch (e) {
        if (!e || e.code !== 'ESRCH') {
          try { ps.proc.kill('SIGKILL'); } catch (_e) { /* ignore */ }
        }
      }
    }
  }

  /**
   * Handle a single line from the plugin's stdout. Only valid JSON-RPC
   * frames are routed; malformed lines transition the plugin to `degraded`
   * but the broker keeps reading (per G2 §10).
   *
   * @param {PluginState} ps
   * @param {string} line
   */
  function onPluginLine(ps, line) {
    if (line.length === 0) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (_err) {
      // Malformed — drop the line, mark degraded. Recovery on next valid
      // call (G2 §10).
      if (ps.state === 'ready') {
        transition(ps, 'degraded');
        audit({ type: 'plugin_degraded', plugin_name: ps.plugin_name, reason: 'protocol_violation', error_count_in_window: 1 });
      }
      return;
    }
    if (!frame || typeof frame !== 'object') return;

    // Response frame (has `id`).
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const pending = ps.pendingCalls.get(frame.id);
      if (!pending) return; // unsolicited response
      ps.pendingCalls.delete(frame.id);
      try { clearTimeout(pending.timer); } catch (_e) { /* ignore */ }
      if (frame.error) {
        // Clamp plugin-controlled error messages before they can flow into our
        // audit log via plugin_tool_failure or escape into mcpError responses.
        pending.reject(new Error(
          frame.error.message
            ? `${frame.error.code || ''} ${_clampPluginString(frame.error.message)}`.trim()
            : 'plugin returned JSON-RPC error'
        ));
      } else {
        pending.resolve(frame.result);
      }
      return;
    }

    // Notifications (no id) — logged and dropped; list_changed notifications
    // from plugins are not handled.
  }

  /**
   * Send a JSON-RPC request to the plugin and return a promise that resolves
   * with `result` or rejects with the error.
   *
   * @param {PluginState} ps
   * @param {string} method
   * @param {object} params
   * @returns {Promise<object>}
   */
  function sendRpc(ps, method, params) {
    if (!ps.proc || !ps.proc.stdin || ps.proc.stdin.destroyed) {
      return Promise.reject(new Error('plugin process stdin not writable'));
    }
    const id = ps.nextRpcId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ps.pendingCalls.delete(id);
        reject(new Error(`rpc timeout: method=${method}`));
      }, opts.toolCallTimeoutMs);
      ps.pendingCalls.set(id, { resolve, reject, timer });
      try {
        ps.proc.stdin.write(frame);
      } catch (err) {
        ps.pendingCalls.delete(id);
        try { clearTimeout(timer); } catch (_e) { /* ignore */ }
        reject(err);
      }
    });
  }

  // -------------------------------------------------------------------------
  // callTool (W-LOAD-4)
  // -------------------------------------------------------------------------

  /**
   * Dispatch a brokered tool call. Validates the namespaced name, looks up
   * the plugin, checks state, validates args against the compiled input
   * schema (W-SEC-9), forwards via JSON-RPC tools/call with the per-call
   * timeout, and emits redacted audit events.
   *
   * Audit-event hygiene: only redacted args ever reach the audit writer
   * (W-SEC-19 pre-condition).
   *
   * @param {string} namespacedName
   * @param {object} args
   * @returns {Promise<object>} MCP tool result (or isError envelope)
   */
  async function callTool(namespacedName, args) {
    const parsed = parseNamespacedName(namespacedName);
    if (!parsed) return mcpError(`not a plugin tool: ${namespacedName}`);

    const ps = state.get(parsed.pluginName);
    if (!ps) return mcpError(`plugin not loaded: ${parsed.pluginName}`);

    if (ps.state !== 'ready' && ps.state !== 'degraded') {
      return mcpError(`plugin "${parsed.pluginName}" not ready (state=${ps.state})`);
    }

    const decl = ps.manifest.tools.find(t => t.name === parsed.toolName);
    if (!decl) return mcpError(`tool not declared in manifest: ${parsed.toolName}`);

    const validator = ps.compiledValidators.get(parsed.toolName);
    if (!validator) return mcpError(`no compiled validator for ${parsed.toolName}`);
    const ok = validator(args);
    if (!ok) {
      return mcpError(`input validation failed: ${JSON.stringify(validator.errors || [])}`);
    }

    // W-SEC-DEF-2: observe sensitive-arg names BEFORE forwarding.
    // The redactor already scrubs values; this signal records the FACT that a
    // sensitive-named arg was passed.
    const sensitiveKeys = _scanSensitiveArgKeys(args);
    if (sensitiveKeys.length > 0) {
      audit({
        type: 'plugin_sensitive_arg_detected',
        plugin_name: parsed.pluginName,
        tool: parsed.toolName,
        matched_keys: sensitiveKeys,
      });
    }

    // Gate tool-invocation events on emitToolInvocationEvents opt.
    if (opts.emitToolInvocationEvents !== false) {
      audit({
        type: 'plugin_tool_invoked',
        plugin_name: parsed.pluginName,
        tool_name: parsed.toolName,
        // redactArgs defaults true; must never be false per threat model.
        args_redacted: opts.redactArgs !== false ? redactArgs(args) : {},
      });
    }

    const startMs = Date.now();
    try {
      const result = await withTimeout(
        sendRpc(ps, 'tools/call', { name: parsed.toolName, arguments: args }),
        opts.toolCallTimeoutMs,
        `tool call timeout ${opts.toolCallTimeoutMs}ms`
      );
      // W-SEC-DEF-2 (Wave 3): scan response for prompt-injection markers.
      // Pure observation — never alter the response. Emit-only.
      // Implemented: Wave 4 W-EVT-1: plugin_response_injection_suspected registered.
      const inj = _scanResponseForInjection(result);
      if (inj) {
        audit({
          type: 'plugin_response_injection_suspected',
          plugin_name: parsed.pluginName,
          tool: parsed.toolName,
          marker: _clampPluginString(inj, 64),
        });
      }
      // Recovery: a degraded plugin that produces a successful call returns
      // to ready (G2 §10).
      if (ps.state === 'degraded') {
        transition(ps, 'ready');
      }
      maybeResetRestartCounter(ps);
      return result;
    } catch (err) {
      // Stay in degraded (or transition to degraded) — process exit handler
      // owns the dead transition.
      if (ps.state === 'ready') {
        transition(ps, 'degraded');
        audit({ type: 'plugin_degraded', plugin_name: parsed.pluginName, reason: 'tool_failure', error_count_in_window: 1 });
      }
      audit({
        type: 'plugin_tool_failure',
        plugin_name: parsed.pluginName,
        tool_name: parsed.toolName,
        error: _clampPluginString(String(err && err.message ? err.message : err)),
        duration_ms: Date.now() - startMs,
      });
      return mcpError(_clampPluginString(String(err && err.message ? err.message : err)));
    }
  }

  // -------------------------------------------------------------------------
  // Death + restart (W-LOAD-1 backoff schedule)
  // -------------------------------------------------------------------------

  /**
   * Transition a plugin to `dead` and (if budget remains) schedule a
   * backed-off restart attempt. Restart attempts:
   *   attempt 1 → 1 s, attempt 2 → 5 s, attempt 3 → 30 s, attempt ≥4 → STOP.
   * If the plugin had been `ready` for ≥ restartResetWindowMs, the counter
   * is treated as fresh (resets at the next ready transition).
   *
   * @param {PluginState} ps
   * @param {string} reason
   * @param {string} [detail]
   */
  function transitionDead(ps, reason, detail) {
    // Unregister overlay tools so callers see them disappear.
    for (const name of ps.registeredToolNames) {
      try { registry._unregister(name); } catch (_e) { /* ignore */ }
    }
    _postOverlayMutation();
    ps.registeredToolNames.clear();
    ps.compiledValidators.clear();

    if (ps.state === 'unloaded') return; // sticky terminal

    if (ps.state !== 'dead') {
      try { transition(ps, 'dead'); }
      catch (_e) { /* invalid transition — already at terminal-ish */ return; }
    }

    audit({
      type: 'plugin_dead',
      plugin_name: ps.plugin_name,
      reason,
      detail: detail || '',
    });

    // Restart budget.
    if (ps.restartAttempts >= opts.maxRestartAttempts) {
      return; // stay dead until manual reload
    }
    const backoffIdx = Math.min(ps.restartAttempts, opts.restartBackoffMs.length - 1);
    const backoffMs  = opts.restartBackoffMs[backoffIdx];
    ps.restartAttempts += 1;

    audit({
      type: 'plugin_restart_attempted',
      plugin_name: ps.plugin_name,
      attempt_number: ps.restartAttempts,
      backoff_ms: backoffMs,
    });

    const t = setTimeout(() => {
      // Re-load from `dead` (allowed transition: dead → loading via load()).
      load(ps.plugin_name).catch(() => { /* error already audited */ });
    }, backoffMs);
    // Don't keep the event loop alive solely for restarts.
    if (typeof t.unref === 'function') t.unref();
  }

  // -------------------------------------------------------------------------
  // Unload + shutdown (W-SEC-17)
  // -------------------------------------------------------------------------

  /**
   * Gracefully unload a plugin: send SIGTERM to its process group, wait up
   * to 5 s, then SIGKILL. Removes overlay entries and parks the plugin in
   * the terminal `unloaded` state.
   *
   * @param {string} pluginName
   * @returns {Promise<void>}
   */
  async function unload(pluginName) {
    const ps = state.get(pluginName);
    if (!ps) return;

    // Unregister overlay tools first so concurrent callers fail fast.
    for (const name of ps.registeredToolNames) {
      try { registry._unregister(name); } catch (_e) { /* ignore */ }
    }
    _postOverlayMutation();
    ps.registeredToolNames.clear();
    ps.compiledValidators.clear();

    // Reject all in-flight calls.
    for (const [, pending] of ps.pendingCalls) {
      try { clearTimeout(pending.timer); } catch (_e) { /* ignore */ }
      pending.reject(new Error(`plugin "${pluginName}" unloaded`));
    }
    ps.pendingCalls.clear();

    if (ps.proc && ps.proc.pid) {
      // If the child has already exited (e.g. killForProtocolDos beat us
      // here), skip the wait — node's `exit` event has already fired and
      // re-attaching `once('exit', ...)` would never resolve.
      const alreadyDead = ps.proc.exitCode !== null || ps.proc.signalCode !== null;
      if (!alreadyDead) {
        // W-SEC-17: SIGTERM to negative pid kills the process group.
        try { process.kill(-ps.proc.pid, 'SIGTERM'); }
        catch (e) {
          if (!e || e.code !== 'ESRCH') {
            try { ps.proc.kill('SIGTERM'); } catch (_e) { /* ignore */ }
          }
        }
        // Wait up to 5 s for graceful exit, then SIGKILL.
        const exitedCleanly = await new Promise(resolve => {
          let done = false;
          const t = setTimeout(() => { if (!done) { done = true; resolve(false); } }, 5_000);
          if (typeof t.unref === 'function') t.unref();
          ps.proc.once('exit', () => { if (!done) { done = true; clearTimeout(t); resolve(true); } });
        });
        if (!exitedCleanly && ps.proc && ps.proc.pid) {
          try { process.kill(-ps.proc.pid, 'SIGKILL'); }
          catch (e) {
            if (!e || e.code !== 'ESRCH') {
              try { ps.proc.kill('SIGKILL'); } catch (_e) { /* ignore */ }
            }
          }
        }
      }
    }

    // Wave 2 closeout (reviewer F-03): use transition() with the now-extended
    // ALLOWED_TRANSITIONS table. Every state mutation flows through transition()
    // so the FSM contract is grep-able from a single source of truth.
    if (ps.state !== 'unloaded') {
      transition(ps, 'unloaded');
      audit({ type: 'plugin_unloaded', plugin_name: pluginName });
    }
  }

  /**
   * Shut down all loaded plugins. Sends process-group SIGTERM (W-SEC-17) to
   * every spawned plugin in parallel.
   *
   * @returns {Promise<void>}
   */
  async function shutdown() {
    const names = [...state.keys()];
    await Promise.all(names.map(n => unload(n)));
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  /** @param {string} pluginName */
  function getState(pluginName) {
    const ps = state.get(pluginName);
    return ps ? ps.state : 'unknown';
  }

  function listLoaded() {
    return [...state.values()].map(ps => ({
      plugin_name: ps.plugin_name,
      state: ps.state,
      pid: ps.proc ? ps.proc.pid : null,
      manifest: ps.manifest,
    }));
  }

  return {
    scan,
    load,
    unload,
    callTool,
    shutdown,
    getState,
    listLoaded,
    _internals: {
      // Test-only access to internals. Do NOT use in production code.
      state,
      transition,
      transitionDead,
      buildSpawnEnv,
      ALLOWED_TRANSITIONS,
      // Wave 3 W-SEC-4 / W-SEC-6 / W-SEC-7 surface for tests.
      _loadConsent,
      _writeConsent,
      _consentFilePath,
      _acquireConsentLock,
      _releaseConsentLock,
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createLoader,
  DEFAULT_OPTS,
  // Exposed for unit-testing the env-strip helper directly without spinning
  // up a full loader instance.
  _buildSpawnEnv: buildSpawnEnv,
  // Wave 3 W-SEC-7 fingerprint helpers exposed for direct unit testing.
  _computeFingerprint: computeFingerprint,
  _canonicalizeJson: canonicalizeJson,
};
