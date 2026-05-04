#!/usr/bin/env node
'use strict';

/**
 * Orchestray MCP server — stdio JSON-RPC 2.0 loop.
 *
 * See CHANGELOG.md §2.0.11 (Stage 1 MCP surface) for design context. Stage 1 surface:
 *   - initialize
 *   - notifications/initialized (no-op)
 *   - tools/list        -> [ASK_USER_TOOL_DEFINITION] or [] if disabled
 *   - tools/call name=ask_user -> handleAskUser(...)
 *
 * Server-initiated `elicitation/create` requests are correlated by a
 * random hex-string id (8 bytes from `crypto.randomBytes`) via an in-memory
 * `Map<id, {resolve, reject, timer}>`. Responses from the client arrive on
 * stdin with matching ids and resolve the pending promise.
 *
 * Discipline:
 *   - Line-delimited JSON. `process.stdout.write(JSON.stringify(obj) + '\n')`.
 *   - Never `console.log` — stdout is reserved for protocol frames.
 *   - Diagnostics go to stderr with `[orchestray-mcp]` prefix.
 *   - Handler exceptions become `isError: true` tool results, not JSON-RPC errors.
 *   - SIGINT/SIGTERM reject all pending elicitations and exit 0.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');

const paths = require('./lib/paths');
const { ASK_USER_TOOL_DEFINITION } = require('./lib/schemas');
const {
  writeAuditEvent,
  buildAuditEvent,
  buildResourceAuditEvent,
  readOrchestrationId,
} = require('./lib/audit');
const {
  CODES,
  logStderr,
  writeFrame,
  sendError,
  sendResult,
  isResponse,
  parseLine,
} = require('./lib/rpc');
const { handleAskUser } = require('./elicit/ask_user');
const { toolError } = require('./lib/tool-result');
const { recordDegradation } = require('../_lib/degraded-journal');
const { verifyManifestOnBoot } = require('../_lib/install-manifest');
const toolRegistry = require('./lib/tool-registry');

// Plugin-loader instantiation + dual-path notify wire-in.
// createPluginLoader wires the MCP tool overlay at runtime. When the loader
// instantiates successfully, tools/list merges core + plugin tools automatically
// and tools/list_changed notifications flow to MCP stdout via opts.notifySink.
// Kill switches: config.plugin_loader.enabled (master), .notify_list_changed,
// .restart_flag_check, .dry_run. All default true/false per config-defaults.js.
//
// ajv is deferred-required here as a defense-in-depth guard for future install
// regressions (install.js copies ajv alongside zod).
const { writeEvent: writePluginAuditEvent } = require('../_lib/audit-event-writer');

// Stage 2 tool handlers
const patternDeprecate = require('./tools/pattern_deprecate');
const patternFind = require('./tools/pattern_find');
const patternRead = require('./tools/pattern_read');
const patternRecordApplication = require('./tools/pattern_record_application');
const patternRecordSkipReason = require('./tools/pattern_record_skip_reason');
const costBudgetCheck = require('./tools/cost_budget_check');
const historyQueryEvents = require('./tools/history_query_events');
const historyFindSimilarTasks = require('./tools/history_find_similar_tasks');
const kbSearch = require('./tools/kb_search');
const kbWrite = require('./tools/kb_write');
const specialistSave = require('./tools/specialist_save');
const routingLookup = require('./tools/routing_lookup');
const costBudgetReserve = require('./tools/cost_budget_reserve');
const metricsQuery = require('./tools/metrics_query');
const curatorTombstone = require('./tools/curator_tombstone');
const schemaGet = require('./tools/schema_get');
const spawnAgent = require('./tools/spawn_agent');

// Stage 2 resource handlers
const patternResource = require('./resources/pattern_resource');
const historyResource = require('./resources/history_resource');
const kbResource = require('./resources/kb_resource');
const orchestrationResource = require('./resources/orchestration_resource');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'orchestray';

// Module-scope loader instance; null = disabled or bringup failed.
let pluginLoader = null;
// Idempotency guard: first signal/close wins; prevents double-shutdown on SIGINT.
let shutdownStarted = false;

/**
 * Resolve the server version. The MCP server runs in two layouts:
 *   - Source / dev: <repo>/bin/mcp-server/server.js — repo root has package.json.
 *   - Installed:   ~/.claude/orchestray/bin/mcp-server/server.js — install root
 *                  has VERSION (written by install.js) but NO package.json
 *                  (install.js does not copy it).
 * Prior to v2.0.21 the server only tried `../../package.json`, which crashed at
 * startup in the installed layout — visible to users as "MCP server failed".
 * Read VERSION first (works installed), fall back to package.json (works in
 * source for tests + dev).
 */
function _resolveServerVersion() {
  try {
    const v = fs.readFileSync(path.join(__dirname, '..', '..', 'VERSION'), 'utf8').trim();
    if (v) return v;
  } catch (_e) { /* fall through */ }
  try {
    return require('../../package.json').version;
  } catch (_e) { /* fall through */ }
  return 'unknown';
}
const SERVER_VERSION = _resolveServerVersion();

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/**
 * Load the server-side config from `.orchestray/config.json`. Returns a
 * permissive default if the file is missing or malformed — the server should
 * still run so it can respond to protocol methods.
 */
function loadConfig() {
  try {
    const p = paths.getConfigPath();
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    logStderr('config load failed: ' + (err && err.message) + ' (using defaults)');
    recordDegradation({
      kind: 'config_load_failed',
      severity: 'warn',
      detail: {
        error_message: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
        config_path: paths.getConfigPath(),
        dedup_key: 'config_load_failed',
      },
    });
  }
  return {};
}

function isServerEnabled(config) {
  if (!config || !config.mcp_server) return true;
  return config.mcp_server.enabled !== false;
}

/**
 * Generic per-tool enabled check. Supports both the arch §7 shorthand
 * (`"pattern_find": true`) and the Stage 2 nested form
 * (`"pattern_find": { "enabled": true }`). Default-enabled when the key
 * is missing entirely.
 */
function isToolEnabled(config, toolName) {
  if (!config || !config.mcp_server) return true;
  if (config.mcp_server.enabled === false) return false;
  const tools = config.mcp_server.tools || {};
  const entry = tools[toolName];
  if (entry === undefined || entry === null) return true;
  if (typeof entry === 'boolean') return entry;
  if (typeof entry === 'object' && entry.enabled === false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Stage 2 tool + resource dispatch tables
// ---------------------------------------------------------------------------

// Master tool table. Order here determines tools/list order. The `ask_user`
// handler is wrapped so its context carries sendElicitation + auditSink +
// config; the other handlers are plain async (args, context) functions.
const TOOL_TABLE = Object.freeze({
  ask_user: {
    definition: ASK_USER_TOOL_DEFINITION,
    handler: (args, _context) => handleAskUser(args, {
      sendElicitation,
      auditSink: writeAuditEvent,
      config: _context && _context.config,
      projectRoot: _context && _context.projectRoot,
    }),
  },
  pattern_deprecate: {
    definition: patternDeprecate.definition,
    handler: patternDeprecate.handle,
  },
  pattern_find: {
    definition: patternFind.definition,
    handler: patternFind.handle,
  },
  pattern_read: {
    definition: patternRead.definition,
    handler: patternRead.handle,
  },
  pattern_record_application: {
    definition: patternRecordApplication.definition,
    handler: patternRecordApplication.handle,
  },
  pattern_record_skip_reason: {
    definition: patternRecordSkipReason.definition,
    handler: patternRecordSkipReason.handle,
  },
  cost_budget_check: {
    definition: costBudgetCheck.definition,
    handler: costBudgetCheck.handle,
  },
  history_query_events: {
    definition: historyQueryEvents.definition,
    handler: historyQueryEvents.handle,
  },
  history_find_similar_tasks: {
    definition: historyFindSimilarTasks.definition,
    handler: historyFindSimilarTasks.handle,
  },
  kb_search: {
    definition: kbSearch.definition,
    handler: kbSearch.handle,
  },
  kb_write: {
    definition: kbWrite.definition,
    handler: kbWrite.handle,
  },
  specialist_save: {
    definition: specialistSave.definition,
    handler: specialistSave.handle,
  },
  routing_lookup: {
    definition: routingLookup.definition,
    handler: routingLookup.handle,
  },
  cost_budget_reserve: {
    definition: costBudgetReserve.definition,
    handler: costBudgetReserve.handle,
  },
  metrics_query: {
    definition: metricsQuery.definition,
    handler: metricsQuery.handle,
  },
  schema_get: {
    definition: schemaGet.definition,
    handler: schemaGet.handle,
  },
  curator_tombstone: {
    definition: curatorTombstone.definition,
    handler: curatorTombstone.handle,
  },
  spawn_agent: {
    definition: spawnAgent.definition,
    handler: spawnAgent.handle,
  },
});

// Activate the layered tool registry.
toolRegistry.initCoreTools(TOOL_TABLE);

const RESOURCE_HANDLERS = Object.freeze({
  pattern: patternResource,
  history: historyResource,
  kb: kbResource,
  orchestration: orchestrationResource,
});

function buildToolContext(config) {
  let projectRoot;
  try { projectRoot = paths.getProjectRoot(); } catch (_e) { projectRoot = null; }
  return {
    sendElicitation,
    auditSink: writeAuditEvent,
    config,
    projectRoot,
    logger: logStderr,
  };
}

function buildResourceContext(config) {
  let projectRoot;
  try { projectRoot = paths.getProjectRoot(); } catch (_e) { projectRoot = null; }
  return {
    projectRoot,
    config,
    logger: logStderr,
  };
}

/**
 * Emit an `mcp_resource_read` audit event via the shared builder in
 * `lib/audit.js`. Fail-open: audit failures never block the response.
 * B4 cleanup: single source of truth for event shape.
 */
function emitResourceAudit(uri, outcome, durationMs) {
  try {
    writeAuditEvent(buildResourceAuditEvent({
      uri,
      outcome,
      duration_ms: durationMs,
    }));
  } catch (_e) { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Elicitation correlation
// ---------------------------------------------------------------------------

const pendingElicitations = new Map(); // id -> { resolve, reject, timer }

function sendElicitation(params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomBytes(8).toString('hex');
    const timer = setTimeout(() => {
      pendingElicitations.delete(id);
      const err = new Error('elicitation timed out after ' + timeoutMs + 'ms');
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);
    // Node timers stay active by default — that's fine; the stdio loop is
    // already keeping the process alive.
    pendingElicitations.set(id, { resolve, reject, timer });
    writeFrame({
      jsonrpc: '2.0',
      id,
      method: 'elicitation/create',
      params,
    });
  });
}

function handleElicitationResponse(msg) {
  const id = msg.id;
  const entry = pendingElicitations.get(id);
  if (!entry) {
    logStderr('orphan elicitation response id=' + id);
    return;
  }
  pendingElicitations.delete(id);
  clearTimeout(entry.timer);

  if (msg.error) {
    const err = new Error(
      'elicitation error: ' + (msg.error.message || 'unknown')
    );
    err.code = msg.error.code || 'ELICIT_ERROR';
    entry.reject(err);
    return;
  }
  entry.resolve(msg.result || {});
}

function rejectAllPendingElicitations(reason) {
  for (const [id, entry] of pendingElicitations.entries()) {
    clearTimeout(entry.timer);
    const err = new Error('server shutdown: ' + reason);
    err.code = 'SHUTDOWN';
    try { entry.reject(err); } catch (_e) { /* swallow */ }
    pendingElicitations.delete(id);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

const {
  JSONRPC_PARSE_ERROR,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
  MCP_RESOURCE_NOT_FOUND,
} = CODES;

async function dispatchRequest(config, msg) {
  const { id, method, params } = msg;

  // JSON-RPC 2.0 §4.1: notifications have no id; server must never respond to them.
  // Guard fires for any method so notifications/initialized and typo-variants are
  // all handled uniformly before reaching method-specific branches.
  if (id === undefined || id === null) {
    return;
  }

  if (method === 'initialize') {
    const capabilities = { tools: { listChanged: true } };
    if (isServerEnabled(config)) {
      capabilities.elicitation = {};
      // Resources are stateless reads; no push-change support.
      capabilities.resources = { listChanged: false, subscribe: false };
    }
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'tools/list') {
    const tools = [];
    if (isServerEnabled(config)) {
      for (const definition of toolRegistry.listTools({
        pluginStateAccessor: pluginLoader ? (n) => pluginLoader.getState(n) : undefined,
        maxBytes: config.plugin_loader?.lifecycle?.tools_response_max_bytes ?? 1048576,
        audit:    writePluginAuditEvent,
      })) {
        if (isToolEnabled(config, definition.name)) tools.push(definition);
      }
    }
    sendResult(id, { tools });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (!isServerEnabled(config)) {
      sendResult(id, toolError('server disabled'));
      return;
    }

    const entry = toolRegistry.resolveTool(name);
    if (!entry) {
      // Per §3.5: unknown tool name returns a tool-result error, not JSON-RPC.
      sendResult(id, toolError('unknown tool: ' + String(name)));
      return;
    }

    if (!isToolEnabled(config, name)) {
      sendResult(id, toolError('tool disabled: ' + name));
      return;
    }

    const toolContext = buildToolContext(config);
    const startedAt = Date.now();
    let result;
    let outcome = 'error';
    try {
      result = await entry.handler(args, toolContext);
      if (result && result.isError === false) outcome = 'answered';
      else if (result && result.isError === true) outcome = 'error';
      else outcome = 'answered';
    } catch (err) {
      // Handlers promise totality; this is a safety net for programmer errors.
      logStderr(name + ' handler threw: ' + (err && err.message));
      result = toolError(
        name + ': ' + (err && err.message ? err.message : String(err))
      );
      outcome = 'error';
    }

    // Central audit for non-ask_user tools (ask_user emits its own richer events).
    // T2 F4: prefer orchestration_id from tool input over readOrchestrationId()
    // — important during recovery where the filesystem marker may differ.
    if (name !== 'ask_user') {
      try {
        const orchIdOverride =
          (args && typeof args.orchestration_id === 'string' && args.orchestration_id.length > 0)
            ? args.orchestration_id
            : undefined;
        writeAuditEvent(buildAuditEvent({
          tool: name,
          outcome,
          duration_ms: Date.now() - startedAt,
          form_fields_count: 0,
          orchestration_id_override: orchIdOverride,
        }));
      } catch (_e) { /* fail-open */ }
    }

    sendResult(id, result);
    return;
  }

  if (method === 'resources/list') {
    if (!isServerEnabled(config)) {
      sendResult(id, { resources: [] });
      return;
    }
    const ctx = buildResourceContext(config);
    const aggregated = [];
    // Aggregate per-scheme truncation meta. Any scheme reporting truncation
    // flips `_truncated`; `_totalCount` sums counts from handlers that report
    // one. Currently only history_resource reports `_totalCount` (20-item cap).
    // Clients should NOT interpret it as "total resources across schemes".
    let anyTruncated = false;
    let haveTotalCount = false;
    let totalCount = 0;
    for (const [scheme, handler] of Object.entries(RESOURCE_HANDLERS)) {
      try {
        const res = await handler.list(ctx);
        if (res && Array.isArray(res.resources)) {
          for (const r of res.resources) aggregated.push(r);
        }
        if (res && res._truncated === true) anyTruncated = true;
        if (res && typeof res._totalCount === 'number') {
          haveTotalCount = true;
          totalCount += res._totalCount;
        }
      } catch (err) {
        logStderr('resources/list ' + scheme + ' failed: ' + (err && err.message));
      }
    }
    const result = { resources: aggregated };
    if (anyTruncated) result._truncated = true;
    if (haveTotalCount) result._totalCount = totalCount;
    sendResult(id, result);
    return;
  }

  if (method === 'resources/templates/list') {
    if (!isServerEnabled(config)) {
      sendResult(id, { resourceTemplates: [] });
      return;
    }
    const ctx = buildResourceContext(config);
    const aggregated = [];
    for (const [scheme, handler] of Object.entries(RESOURCE_HANDLERS)) {
      if (typeof handler.templates !== 'function') continue;
      try {
        const res = await handler.templates(ctx);
        if (res && Array.isArray(res.resourceTemplates)) {
          for (const t of res.resourceTemplates) aggregated.push(t);
        }
      } catch (err) {
        logStderr('resources/templates/list ' + scheme + ' failed: ' + (err && err.message));
      }
    }
    sendResult(id, { resourceTemplates: aggregated });
    return;
  }

  if (method === 'resources/read') {
    if (!isServerEnabled(config)) {
      sendError(id, JSONRPC_METHOD_NOT_FOUND, 'resources/read unavailable (server disabled)');
      return;
    }
    const uri = params && params.uri;
    if (typeof uri !== 'string' || uri.length === 0) {
      sendError(id, JSONRPC_INVALID_REQUEST, 'resources/read: missing uri');
      return;
    }

    // parseResourceUri throws on malformed input or unsafe segments — treat
    // those as JSON-RPC errors. Parse once and forward so downstream doesn't
    // re-run the same check.
    let parsedUri;
    try {
      parsedUri = paths.parseResourceUri(uri);
    } catch (err) {
      emitResourceAudit(uri, 'error', 0);
      sendError(id, JSONRPC_INVALID_PARAMS, 'resources/read: ' + (err && err.message));
      return;
    }
    const { scheme } = parsedUri;

    const handler = RESOURCE_HANDLERS[scheme];
    if (!handler) {
      emitResourceAudit(uri, 'error', 0);
      sendError(id, JSONRPC_INVALID_PARAMS, 'unknown resource scheme: ' + scheme);
      return;
    }

    const ctx = buildResourceContext(config);
    const startedAt = Date.now();
    try {
      const result = await handler.read(uri, ctx, parsedUri);
      emitResourceAudit(uri, 'answered', Date.now() - startedAt);
      sendResult(id, result);
    } catch (err) {
      emitResourceAudit(uri, 'error', Date.now() - startedAt);
      const code = (err && err.code) || 'READ_ERROR';
      if (code === 'RESOURCE_NOT_FOUND') {
        sendError(id, MCP_RESOURCE_NOT_FOUND, 'resource not found', {
          uri,
          message: err && err.message,
        });
      } else if (
        code === 'PATH_TRAVERSAL' ||
        code === 'INVALID_SEGMENT' ||
        code === 'INVALID_URI'
      ) {
        sendError(id, JSONRPC_INVALID_PARAMS, 'invalid resource uri', {
          uri,
          message: err && err.message,
        });
      } else {
        logStderr('resources/read ' + scheme + ' threw: ' + (err && err.message));
        sendError(id, JSONRPC_INTERNAL_ERROR, 'resources/read failed', {
          uri,
          message: err && err.message,
        });
      }
    }
    return;
  }

  // Unsupported request method (id non-null; notification guard handled null ids above).
  sendError(id, JSONRPC_METHOD_NOT_FOUND, 'Method not found', { method });
}

// ---------------------------------------------------------------------------
// Stdin loop
// ---------------------------------------------------------------------------

async function handleLine(config, line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  const parsed = parseLine(line);
  if (!parsed.ok) {
    sendError(null, parsed.code, parsed.message);
    return;
  }
  const msg = parsed.msg;

  // Responses to server-initiated `elicitation/create` requests.
  if (isResponse(msg) && typeof msg.id !== 'undefined' && msg.method === undefined) {
    handleElicitationResponse(msg);
    return;
  }

  // Requests/notifications from the client.
  try {
    await dispatchRequest(config, msg);
  } catch (err) {
    logStderr('dispatch error: ' + (err && err.message));
    sendError(msg.id != null ? msg.id : null, JSONRPC_INTERNAL_ERROR, 'Internal error', {
      message: err && err.message,
    });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Validate plugin root at startup — fatal if missing.
  try {
    paths.getPluginRoot();
  } catch (err) {
    logStderr('fatal: ' + (err && err.message));
    process.exit(1);
  }

  const config = loadConfig();

  // F-6: apply env variable overrides that were previously dead code.
  // Option A: splice env flags directly onto the loaded config so all
  // downstream consumers (plugin-loader, discovery gate) see them.
  if (!config.plugin_loader) config.plugin_loader = {};
  if (process.env.ORCHESTRAY_PLUGIN_LOADER_DISABLED === '1') {
    config.plugin_loader.enabled = false;
  }
  if (process.env.ORCHESTRAY_PLUGIN_DISCOVERY_DISABLED === '1') {
    if (!config.plugin_loader.discovery) config.plugin_loader.discovery = {};
    config.plugin_loader.discovery.enabled = false;
  }
  if (process.env.ORCHESTRAY_PLUGIN_LOADER_DRY_RUN === '1') {
    config.plugin_loader.dry_run = true;
  }
  // ORCHESTRAY_PLUGIN_DISABLE is a CSV list; store parsed array for createPluginLoader.
  if (process.env.ORCHESTRAY_PLUGIN_DISABLE) {
    config.plugin_loader._disabledPlugins = process.env.ORCHESTRAY_PLUGIN_DISABLE
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Instantiate plugin loader iff enabled (default: true). Fail-open: bringup
  // exceptions are logged; pluginLoader stays null and server serves core tools.
  if (config.plugin_loader?.enabled !== false) {
    const pl = config.plugin_loader || {};
    const lc = pl.lifecycle || {};
    try {
      const { createLoader: createPluginLoader } = require('../_lib/plugin-loader');
      const discovery = pl.discovery || {};
      const consent   = pl.consent   || {};
      const telemetry = pl.telemetry || {};
      pluginLoader = createPluginLoader({
        audit:              writePluginAuditEvent,
        projectRoot:        process.cwd(),
        registry:           toolRegistry,
        notifySink:         writeFrame,
        notify_list_changed: pl.notify_list_changed !== false,
        restart_flag_check:  pl.restart_flag_check  !== false,
        dry_run:             !!pl.dry_run,
        ...(pl._disabledPlugins && pl._disabledPlugins.length > 0 && { disabledPlugins: pl._disabledPlugins }),
        discoveryEnabled: discovery.enabled !== false,
        ...(discovery.scan_paths != null && { discoveryPaths: discovery.scan_paths }),
        ...(consent.require_explicit_grant != null && { requireConsent: consent.require_explicit_grant }),
        emitToolInvocationEvents: telemetry.emit_tool_invocation_events !== false,
        redactArgs:               telemetry.redact_args !== false,
        // Lifecycle tuning from config (mirrors DEFAULT_OPTS keys).
        ...(lc.max_restart_attempts  != null && { maxRestartAttempts:    lc.max_restart_attempts }),
        ...(lc.restart_backoff_ms    != null && { restartBackoffMs:      lc.restart_backoff_ms }),
        ...(lc.restart_reset_window_ms != null && { restartResetWindowMs: lc.restart_reset_window_ms }),
        ...(lc.tool_call_timeout_ms  != null && { toolCallTimeoutMs:     lc.tool_call_timeout_ms }),
        ...(lc.spawn_timeout_ms      != null && { spawnTimeoutMs:        lc.spawn_timeout_ms }),
      });
    } catch (err) {
      logStderr('plugin-loader bringup failed: ' + (err && err.message));
    }
  }

  // Fail-open install-integrity verify (non-fatal). Drift is journaled to
  // .orchestray/state/degraded.jsonl and surfaced via /orchestray:doctor --deep.
  try {
    const pluginRoot = paths.getPluginRoot();
    verifyManifestOnBoot({
      rootDir:     pluginRoot,
      fileRootDir: path.dirname(pluginRoot),
      projectRoot: process.cwd(),
    });
  } catch (_e) {
    // MUST NEVER THROW. Defensive swallow.
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
    crlfDelay: Infinity, // Handle CRLF line endings from Windows clients.
  });

  rl.on('line', (line) => {
    // Fire-and-forget; dispatch handles its own errors.
    handleLine(config, line).catch((err) => {
      logStderr('unexpected handleLine error: ' + (err && err.message));
    });
  });

  rl.on('close', async () => {
    rejectAllPendingElicitations('stdin closed');
    // Shut down loader; shutdownStarted guards against double-invocation.
    if (!shutdownStarted && pluginLoader) {
      shutdownStarted = true;
      // Race against 5s — a hung plugin must not block MCP server exit forever.
      await Promise.race([
        pluginLoader.shutdown(),
        new Promise((resolve) => setTimeout(() => {
          logStderr('plugin-loader shutdown timed out (5s), forcing exit');
          resolve();
        }, 5000)),
      ]).catch((err) => logStderr('plugin-loader shutdown error: ' + (err && err.message)));
    }
    process.exit(0);
  });

  const onSignal = async (sig) => {
    logStderr('received ' + sig + ', shutting down');
    rejectAllPendingElicitations(sig);
    if (!shutdownStarted && pluginLoader) {
      shutdownStarted = true;
      await Promise.race([
        pluginLoader.shutdown(),
        new Promise((resolve) => setTimeout(() => {
          logStderr('plugin-loader shutdown timed out (5s), forcing exit');
          resolve();
        }, 5000)),
      ]).catch((err) => logStderr('plugin-loader shutdown error: ' + (err && err.message)));
    }
    try { rl.close(); } catch (_e) { /* swallow */ }
    process.exit(0);
  };
  process.on('SIGINT',  () => onSignal('SIGINT').catch((e) => logStderr('SIGINT handler error: ' + (e && e.message))));
  process.on('SIGTERM', () => onSignal('SIGTERM').catch((e) => logStderr('SIGTERM handler error: ' + (e && e.message))));

  logStderr('orchestray-mcp server ready (protocol ' + PROTOCOL_VERSION + ')');

  // Fire-and-forget discovery scan on startup. NEVER auto-load — loading
  // requires explicit user consent via the slash-command CLI.
  if (pluginLoader && config.plugin_loader?.discovery?.enabled !== false) {
    pluginLoader.scan().catch((err) => logStderr('plugin scan failed: ' + (err && err.message)));
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
