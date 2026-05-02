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
 * Wave-3+ deferrals explicitly acknowledged here (per
 * feedback_no_close_out_deferral — every deferred item carries its W-id
 * for grep-ability):
 *
 *   TODO Wave 3 W-SEC-4   Consent-file lock (plugin-consents.lock via
 *                         fs.openSync('wx')). Wave 2 stub: when load() is
 *                         called for a `discovered` plugin we transition
 *                         discovered → consented in-process, no consent-file
 *                         read. Replaced in Wave 3.
 *   TODO Wave 3 W-SEC-7   Manifest+entrypoint fingerprint hashing. Wave 2
 *                         stub: no fingerprint computed; load() trusts the
 *                         on-disk manifest verbatim. Replaced in Wave 3.
 *   TODO Wave 3 W-SEC-13  Sentinel probe assertNoShellInBrokerForwardPath
 *                         (AST walk). Wave 2: forwardToPlugin uses only
 *                         JSON.stringify + plugin.stdin.write — no shell —
 *                         so the probe is pre-satisfied; the AST walk that
 *                         enforces it is a Wave 3 deliverable.
 *   TODO Wave 3 W-SEC-19  Sentinel probe assertPluginStdoutNeverReachesAuditWriter.
 *                         Wave 2: this loader emits audit events with
 *                         redacted tool-call args via redactArgs() and never
 *                         derives an audit-event field from plugin.stdout
 *                         data — so the probe is pre-satisfied; AST enforcement
 *                         lands in Wave 3.
 *   TODO Wave 4 W-CLI-1   Slash-command CLI (/orchestray:plugin {list, approve,
 *                         disable, reload}). No CLI binding in Wave 2.
 *   TODO Wave 4 W-CFG-1   Wire .orchestray/config.json into opts. Wave 2:
 *                         opts is the only config surface; createLoader(opts)
 *                         is config-aware-ready.
 */

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const { _register, _unregister, _isCoreTool } = require('../mcp-server/lib/tool-registry');
const { parseManifest }                       = require('./plugin-manifest-schema');
const { compileToolInputSchema }              = require('./plugin-input-schema-validator');
const { buildNamespacedName, parseNamespacedName } = require('./plugin-namespace');
const { redactArgs }                          = require('./plugin-redact');
const { writeEvent }                          = require('./audit-event-writer');

// Wave 2 closeout (reviewer F-01, F-02): the same kebab-case regex used by
// plugin-manifest-schema. Used here to filter plugin-controlled tool names
// before they reach audit fields, and to bound plugin-derived error strings
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
  /** Wave 2 stub for W-SEC-4 (Wave 3 wires this to plugin-consents.json). */
  requireConsent: false,
  /** Override hook for tests: replaces the writeEvent dependency. */
  audit: writeEvent,
  /** Override hook for tests: replaces the tool-registry dependency. */
  registry: { _register, _unregister, _isCoreTool },
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
   */

  /** @type {Map<string, PluginState>} */
  const state = new Map();

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

  // Wave 2 closeout (reviewer F-03): user-initiated unload() may force any
  // non-terminal state straight to 'unloaded' — including 'unknown' and
  // 'loading' which previously required the unload() bypass at the call site.
  // Listing those edges here keeps every state mutation grep-able through
  // transition() instead of hidden direct ps.state= assignments.
  const ALLOWED_TRANSITIONS = Object.freeze({
    unknown:    new Set(['discovered', 'unloaded']),
    discovered: new Set(['consented', 'unloaded']),
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

        // Materialize/refresh the FSM record.
        let ps = state.get(manifest.name);
        if (!ps) {
          ps = createPluginRecord(manifest.name);
          state.set(manifest.name, ps);
        }
        ps.scan_path = scanPath;
        ps.rootDir   = pluginRoot;
        ps.manifest  = manifest;
        if (ps.state === 'unknown') {
          transition(ps, 'discovered');
          audit({
            type: 'plugin_discovered',
            plugin_name: manifest.name,
            plugin_version: manifest.version,
            scan_path: scanPath,
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

    // TODO Wave 3 W-SEC-4: gate this transition on plugin-consents.json read
    // with file lock. For Wave 2 we accept opts.requireConsent=false as the
    // explicit "test-only" stub. When Wave 3 lands, this branch reads the
    // consent file (with safeRealpath + fs.openSync('wx') lock) and only
    // transitions if the fingerprint matches a consented entry.
    if (ps.state === 'discovered') {
      if (opts.requireConsent) {
        return { state: ps.state, plugin_name: pluginName };
      }
      transition(ps, 'consented');
      audit({
        type: 'plugin_consent_granted',
        plugin_name: pluginName,
        granted_via: 'wave2_stub_auto_consent',
      });
    }

    if (ps.state !== 'consented' && ps.state !== 'dead') {
      // Not in a state from which load() makes sense.
      return { state: ps.state, plugin_name: pluginName };
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

    // W-LOAD-2: spawn in detached process group with env-strip (W-SEC-16).
    // detached:true creates a new process group whose negative-pid receives
    // SIGTERM en masse on shutdown (W-SEC-17), killing grandchildren too.
    const spawnArgs = (() => {
      // For runtime=node we use the entrypoint script directly under the
      // current node process (interpreter required); for python we rely on
      // the entrypoint being executable; for `any` we trust the entrypoint
      // shebang. This Wave 2 keeps it simple: use process.execPath for node,
      // and the entrypoint itself otherwise. The fixture runtime is "node"
      // throughout the smoke tests.
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

    // Wire stderr to the void for now (Wave 2 has no per-plugin stderr log;
    // Wave 5 docs/jsonl-rotate will wire it). Drain it so the OS pipe buffer
    // does not fill and stall the plugin.
    proc.stderr.on('data', () => { /* drained — plugin stderr is unused in Wave 2 */ });

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
      // Wave 2 closeout F-01: plugin-controlled `actual_tools` names go
      // through _safePluginName so a malicious plugin can't inject 64KB or
      // bidi codepoints into the audit log.
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
        definition: {
          name: namespacedName,
          description: decl.description,
          inputSchema: decl.inputSchema,
        },
        handler,
      });
      ps.registeredToolNames.add(namespacedName);
    }

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
      if (ps.state === 'ready') transition(ps, 'degraded');
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
        // Wave 2 closeout F-02: clamp plugin-controlled error messages before
        // they can flow into our audit log via plugin_tool_failure or escape
        // into mcpError responses returned to Claude Code.
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

    // Notifications (no id) — Wave 2 logs and drops them. Wave 4+ may handle
    // notifications/tools/list_changed pushed by the plugin.
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

    audit({
      type: 'plugin_tool_invoked',
      plugin_name: parsed.pluginName,
      tool_name: parsed.toolName,
      args_redacted: redactArgs(args),
    });

    const startMs = Date.now();
    try {
      const result = await withTimeout(
        sendRpc(ps, 'tools/call', { name: parsed.toolName, arguments: args }),
        opts.toolCallTimeoutMs,
        `tool call timeout ${opts.toolCallTimeoutMs}ms`
      );
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
};
