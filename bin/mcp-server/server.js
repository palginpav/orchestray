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
const { writeAuditEvent } = require('./lib/audit');
const { handleAskUser } = require('./handlers/ask_user');

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

function isAskUserEnabled(config) {
  if (!config || !config.mcp_server) return true;
  if (config.mcp_server.enabled === false) return false;
  const t = config.mcp_server.tools && config.mcp_server.tools.ask_user;
  if (t && t.enabled === false) return false;
  return true;
}

function isServerEnabled(config) {
  if (!config || !config.mcp_server) return true;
  return config.mcp_server.enabled !== false;
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
const JSONRPC_INTERNAL_ERROR = -32603;

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

  if (method === 'initialize') {
    const capabilities = { tools: { listChanged: false } };
    if (isServerEnabled(config)) capabilities.elicitation = {};
    sendResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'tools/list') {
    const tools = [];
    if (isServerEnabled(config) && isAskUserEnabled(config)) {
      tools.push(ASK_USER_TOOL_DEFINITION);
    }
    sendResult(id, { tools });
    return;
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};

    if (name !== 'ask_user') {
      // Per §3.5: unknown tool name returns a tool-result error, not JSON-RPC.
      sendResult(id, {
        isError: true,
        content: [{ type: 'text', text: 'unknown tool: ' + String(name) }],
      });
      return;
    }

    try {
      const result = await handleAskUser(args, {
        sendElicitation,
        auditSink: writeAuditEvent,
        config,
      });
      sendResult(id, result);
    } catch (err) {
      // Handler promised totality; this is a safety net for programmer errors.
      logStderr('ask_user handler threw: ' + (err && err.message));
      sendResult(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'ask_user: ' + (err && err.message ? err.message : String(err)),
          },
        ],
      });
    }
    return;
  }

  // Notifications and unsupported methods.
  if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
    // No response per JSON-RPC notification semantics.
    return;
  }

  // JSON-RPC 2.0 §5: a request without an id is a notification; never reply.
  // Guards against typo-variant notifications (e.g. `notification/initialized`)
  // that miss the startsWith check above and would otherwise produce a
  // spec-violating null-id error frame.
  if (id === undefined || id === null) return;

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
