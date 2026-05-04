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

// W-LISTCH-1 (Wave 4): plugin-loader instantiation + dual-path notify wire-in.
// createPluginLoader wires the MCP tool overlay at runtime. When the loader
// instantiates successfully, tools/list merges core + plugin tools automatically
// and tools/list_changed notifications flow to MCP stdout via opts.notifySink.
// Kill switches: config.plugin_loader.enabled (master), .notify_list_changed,
// .restart_flag_check, .dry_run. All default true/false per config-defaults.js.
//
// ajv is now copied by install.js alongside zod (W-DEPS-1 follow-up); the
// deferred require remains here as a defense-in-depth guard for future install
// regressions, not as a hard requirement.
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

// W-LISTCH-1: module-scope plugin-loader instance. Declared here so rl.on('close')
// and SIGINT/SIGTERM handlers can call pluginLoader?.shutdown() without closures
// over main()'s local scope. null = loader disabled or bringup failed.
let pluginLoader = null;
// Idempotency guard: first signal/close wins; prevents double-shutdown on SIGINT
// (which triggers rl.close(), which would fire rl.on('close') a second time).
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

// Activate the layered tool registry with the canonical TOOL_TABLE.
// After this call, toolRegistry.listTools() and toolRegistry.resolveTool()
// reflect the full core set. The overlay is empty until Wave 2+ plugins load.
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

  // JSON-RPC 2.0 §4.1: a message without an id is a notification. The server
  // must never send a response to a notification, even an error. Route the
  // known `notifications/*` namespace silently, ignore everything else. This
  // guard sits at the top so it fires for any method (tools/call,
  // resources/read, typo-variants) rather than only the method-not-found
  // fallthrough. B10 cleanup from the full-codebase audit.
  if (id === undefined || id === null) {
    // The only notification we care about today is `notifications/initialized`,
    // which is already a no-op — so there is nothing to do here beyond the
    // silent return. New notification handlers can branch on `method` above
    // this return when needed.
    return;
  }

  if (method === 'initialize') {
    const capabilities = { tools: { listChanged: true } };
    if (isServerEnabled(config)) {
      capabilities.elicitation = {};
      // Stage 2: advertise resources capability when the server is enabled.
      // listChanged/subscribe are both false — resources are stateless reads
      // of filesystem artifacts; the server does not push change notices.
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
      // Route through the layered registry so plugin overlays (Wave 2+) are
      // included automatically. listTools() returns core-first, overlay-second
      // in insertion order — identical to the old Object.entries(TOOL_TABLE)
      // loop when the overlay is empty (v2.3.0 GA).
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

    // Central audit for non-ask_user tools. The ask_user handler emits its
    // own richer audit events (with form_fields_count, timeout/cancelled
    // outcomes) via context.auditSink, so skip the generic emission for it
    // to avoid double-logging. B4 cleanup: route through buildAuditEvent so
    // event shape + outcome validation stay in a single place.
    //
    // T2 F4: prefer orchestration_id from tool input (when supplied) over
    // readOrchestrationId() — important during recovery or cross-orchestration
    // scenarios where the filesystem marker may differ from the PM's intent.
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
    // Aggregate per-scheme truncation meta so the client can tell when a
    // handler capped its results. Any scheme reporting truncation flips the
    // top-level `_truncated` flag, and `_totalCount` sums across handlers
    // that reported one. Handlers that don't report meta contribute nothing
    // to `_totalCount` (no false "0" rows). MCP permits extra fields on
    // resources/list responses; clients that ignore them see the old shape.
    //
    // As of 2.0.11 only `history_resource` reports `_totalCount` (the 20-item
    // archive cap), so `_totalCount` is currently history-specific. If other
    // handlers grow similar caps and start reporting, this loop's summing
    // behavior will combine them — clients should NOT interpret `_totalCount`
    // as "total resources across schemes" until all three handlers adopt it.
    // The field name is accurate for history alone; it's advisory, not a
    // content-length guarantee.
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
      // Consistent with resources/list + templates/list empty-array behavior
      // when disabled: advertise the endpoint as absent rather than exposing
      // an internal-error surface. Clients see the same "feature not present"
      // signal across all three resources/* methods.
      sendError(id, JSONRPC_METHOD_NOT_FOUND, 'resources/read unavailable (server disabled)');
      return;
    }
    const uri = params && params.uri;
    if (typeof uri !== 'string' || uri.length === 0) {
      sendError(id, JSONRPC_INVALID_REQUEST, 'resources/read: missing uri');
      return;
    }

    // Parse the URI scheme to route to the right handler. paths.parseResourceUri
    // throws on malformed input or unsafe segments — treat those as JSON-RPC
    // errors (they indicate a malformed client request, not a tool-call failure).
    // B6: parse the URI once and forward the result to the resource handler
    // so downstream doesn't re-run parseResourceUri() + assertSafeSegment.
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
        // m2 taxonomy split: all three codes surface at the wire as
        // JSON-RPC invalid-params. Only the audit-log semantics differ.
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

  // Unsupported request method — id is guaranteed non-null because the
  // notification guard at the top of this function already returned for
  // notification-shape messages.
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

  // W-LISTCH-1: instantiate plugin loader iff enabled (default: true).
  // Fail-open: any exception during bringup is logged and pluginLoader stays
  // null. The server continues to serve core tools in that degraded state.
  // Require is deferred here (not at module top) because plugin-loader.js
  // transitively requires 'ajv', which install.js does not copy. See comment
  // above near writePluginAuditEvent for rationale.
  if (config.plugin_loader?.enabled !== false) {
    const pl = config.plugin_loader || {};
    const lc = pl.lifecycle || {};
    try {
      const { createLoader: createPluginLoader } = require('../_lib/plugin-loader');
      pluginLoader = createPluginLoader({
        audit:              writePluginAuditEvent,
        projectRoot:        process.cwd(),
        registry:           toolRegistry,
        // Path A wire-in: thread writeFrame so notifications/tools/list_changed
        // reaches MCP stdout on every successful overlay mutation.
        notifySink:         writeFrame,
        notify_list_changed: pl.notify_list_changed !== false,
        restart_flag_check:  pl.restart_flag_check  !== false,
        dry_run:             !!pl.dry_run,
        // Lifecycle tuning from config (mirrors DEFAULT_OPTS keys).
        ...(lc.max_restart_attempts  != null && { maxRestartAttempts:    lc.max_restart_attempts }),
        ...(lc.restart_backoff_ms    != null && { restartBackoffMs:      lc.restart_backoff_ms }),
        ...(lc.restart_reset_window_ms != null && { restartResetWindowMs: lc.restart_reset_window_ms }),
        ...(lc.tool_call_timeout_ms  != null && { toolCallTimeoutMs:     lc.tool_call_timeout_ms }),
        ...(lc.spawn_timeout_ms      != null && { spawnTimeoutMs:        lc.spawn_timeout_ms }),
      });
    } catch (err) {
      logStderr('plugin-loader bringup failed: ' + (err && err.message));
      // pluginLoader remains null; server serves core tools only.
    }
  }

  // Fail-open install-integrity verify (non-fatal; runs inline before the
  // ready banner). Drift (if any) is journaled to .orchestray/state/degraded.jsonl
  // and surfaced via /orchestray:doctor --deep. The outer try/catch is
  // belt-and-suspenders: verifyManifestOnBoot itself must never throw, but a
  // bug in it must not kill the MCP server.
  try {
    const pluginRoot = paths.getPluginRoot();
    verifyManifestOnBoot({
      rootDir:     pluginRoot,
      fileRootDir: path.dirname(pluginRoot),
      projectRoot: process.cwd(),
    });
    // Return value intentionally ignored — journal has the record.
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
    // W-LISTCH-1: shut down loader before exit. shutdownStarted guards against
    // double-invocation when SIGINT triggers both onSignal and rl.on('close').
    if (!shutdownStarted && pluginLoader) {
      shutdownStarted = true;
      // Race against 5 s — a hung plugin must not block MCP server exit forever.
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
    // W-LISTCH-1: shut down loader; first caller wins via shutdownStarted flag.
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

  // W-LISTCH-1: fire-and-forget discovery scan on startup (default-on per
  // feedback_default_on_shipping). NEVER auto-load — loading requires explicit
  // user consent via the slash-command CLI. Skip if discovery is disabled.
  if (pluginLoader && config.plugin_loader?.discovery?.enabled !== false) {
    pluginLoader.scan().catch((err) => logStderr('plugin scan failed: ' + (err && err.message)));
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
