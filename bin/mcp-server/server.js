#!/usr/bin/env node
'use strict';

/**
 * Orchestray MCP server — stdio JSON-RPC 2.0 loop.
 *
 * Per v2011c-stage1-plan.md §3.5 and §4. Stage 1 surface:
 *   - initialize
 *   - notifications/initialized (no-op)
 *   - tools/list        -> [ASK_USER_TOOL_DEFINITION] or [] if disabled
 *   - tools/call name=ask_user -> handleAskUser(...)
 *
 * Server-initiated `elicitation/create` requests are correlated by numeric id
 * via an in-memory `Map<id, {resolve, reject, timer}>`. Responses from the
 * client arrive on stdin with matching ids and resolve the pending promise.
 *
 * Discipline:
 *   - Line-delimited JSON. `process.stdout.write(JSON.stringify(obj) + '\n')`.
 *   - Never `console.log` — stdout is reserved for protocol frames.
 *   - Diagnostics go to stderr with `[orchestray-mcp]` prefix.
 *   - Handler exceptions become `isError: true` tool results, not JSON-RPC errors.
 *   - SIGINT/SIGTERM reject all pending elicitations and exit 0.
 */

const fs = require('node:fs');
const readline = require('node:readline');

const paths = require('./lib/paths');
const { ASK_USER_TOOL_DEFINITION } = require('./lib/schemas');
const {
  writeAuditEvent,
  buildAuditEvent,
  buildResourceAuditEvent,
  readOrchestrationId,
} = require('./lib/audit');
const { handleAskUser } = require('./elicit/ask_user');

// Stage 2 tool handlers
const patternFind = require('./tools/pattern_find');
const patternRecordApplication = require('./tools/pattern_record_application');
const historyQueryEvents = require('./tools/history_query_events');
const historyFindSimilarTasks = require('./tools/history_find_similar_tasks');
const kbSearch = require('./tools/kb_search');

// Stage 2 resource handlers
const patternResource = require('./resources/pattern_resource');
const historyResource = require('./resources/history_resource');
const kbResource = require('./resources/kb_resource');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'orchestray';
const SERVER_VERSION = '2.0.11';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function logStderr(msg) {
  try {
    process.stderr.write('[orchestray-mcp] ' + msg + '\n');
  } catch (_e) {
    // Stderr unavailable; nothing to do.
  }
}

function writeFrame(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + '\n');
  } catch (err) {
    logStderr('stdout write failed: ' + (err && err.message));
  }
}

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
    }),
  },
  pattern_find: {
    definition: patternFind.definition,
    handler: patternFind.handle,
  },
  pattern_record_application: {
    definition: patternRecordApplication.definition,
    handler: patternRecordApplication.handle,
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
});

const RESOURCE_HANDLERS = Object.freeze({
  pattern: patternResource,
  history: historyResource,
  kb: kbResource,
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

function toolResultError(text) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
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
let nextElicitationId = 1;

function sendElicitation(params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextElicitationId++;
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

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;
// MCP resource not found: https://modelcontextprotocol.io/specification (code -32002).
const MCP_RESOURCE_NOT_FOUND = -32002;

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeFrame({ jsonrpc: '2.0', id: id == null ? null : id, error });
}

function sendResult(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

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
    const capabilities = { tools: { listChanged: false } };
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
      for (const [name, entry] of Object.entries(TOOL_TABLE)) {
        if (isToolEnabled(config, name)) tools.push(entry.definition);
      }
    }
    sendResult(id, { tools });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (!isServerEnabled(config)) {
      sendResult(id, toolResultError('server disabled'));
      return;
    }

    const entry = TOOL_TABLE[name];
    if (!entry) {
      // Per §3.5: unknown tool name returns a tool-result error, not JSON-RPC.
      sendResult(id, toolResultError('unknown tool: ' + String(name)));
      return;
    }

    if (!isToolEnabled(config, name)) {
      sendResult(id, toolResultError('tool disabled: ' + name));
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
      result = toolResultError(
        name + ': ' + (err && err.message ? err.message : String(err))
      );
      outcome = 'error';
    }

    // Central audit for non-ask_user tools. The ask_user handler emits its
    // own richer audit events (with form_fields_count, timeout/cancelled
    // outcomes) via context.auditSink, so skip the generic emission for it
    // to avoid double-logging. B4 cleanup: route through buildAuditEvent so
    // event shape + outcome validation stay in a single place.
    if (name !== 'ask_user') {
      try {
        writeAuditEvent(buildAuditEvent({
          tool: name,
          outcome,
          duration_ms: Date.now() - startedAt,
          form_fields_count: 0,
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
    for (const [scheme, handler] of Object.entries(RESOURCE_HANDLERS)) {
      try {
        const res = await handler.list(ctx);
        if (res && Array.isArray(res.resources)) {
          for (const r of res.resources) aggregated.push(r);
        }
      } catch (err) {
        logStderr('resources/list ' + scheme + ' failed: ' + (err && err.message));
      }
    }
    sendResult(id, { resources: aggregated });
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
    let scheme;
    try {
      ({ scheme } = paths.parseResourceUri(uri));
    } catch (err) {
      // B5: no `startedAt` here — the parse happens inside this branch, so
      // subtracting Date.now() from itself was always 0. Match the unknown-
      // handler branch below by emitting a literal 0.
      emitResourceAudit(uri, 'error', 0);
      sendError(id, JSONRPC_INVALID_PARAMS, 'resources/read: ' + (err && err.message));
      return;
    }

    const handler = RESOURCE_HANDLERS[scheme];
    if (!handler) {
      emitResourceAudit(uri, 'error', 0);
      sendError(id, JSONRPC_INVALID_PARAMS, 'unknown resource scheme: ' + scheme);
      return;
    }

    const ctx = buildResourceContext(config);
    const startedAt = Date.now();
    try {
      const result = await handler.read(uri, ctx);
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
      } else if (code === 'PATH_TRAVERSAL') {
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

function isResponse(msg) {
  return msg && (msg.result !== undefined || msg.error !== undefined);
}

async function handleLine(config, line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    logStderr('parse error: ' + (err && err.message) + ' line=' + trimmed.slice(0, 200));
    // Per JSON-RPC, a parse error has null id.
    sendError(null, JSONRPC_PARSE_ERROR, 'Parse error');
    return;
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    sendError(null, JSONRPC_INVALID_REQUEST, 'Invalid Request');
    return;
  }

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

  rl.on('close', () => {
    rejectAllPendingElicitations('stdin closed');
    process.exit(0);
  });

  const onSignal = (sig) => {
    logStderr('received ' + sig + ', shutting down');
    rejectAllPendingElicitations(sig);
    try { rl.close(); } catch (_e) { /* swallow */ }
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  logStderr('orchestray-mcp server ready (protocol ' + PROTOCOL_VERSION + ')');
}

if (require.main === module) {
  main();
}

module.exports = { main };
