'use strict';

/**
 * JSON-RPC 2.0 wire-protocol plumbing for the Orchestray MCP stdio server.
 *
 * Discipline:
 *   - Line-delimited JSON. `process.stdout.write(JSON.stringify(obj) + '\n')`.
 *   - Never `console.log` — stdout is reserved for protocol frames.
 *   - Diagnostics go to stderr with `[orchestray-mcp]` prefix.
 */

// ---------------------------------------------------------------------------
// Error code constants
// ---------------------------------------------------------------------------

const CODES = Object.freeze({
  JSONRPC_PARSE_ERROR: -32700,
  JSONRPC_INVALID_REQUEST: -32600,
  JSONRPC_METHOD_NOT_FOUND: -32601,
  JSONRPC_INVALID_PARAMS: -32602,
  JSONRPC_INTERNAL_ERROR: -32603,
  // MCP resource not found: https://modelcontextprotocol.io/specification (code -32002).
  MCP_RESOURCE_NOT_FOUND: -32002,
});

// ---------------------------------------------------------------------------
// Logging and wire I/O
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

// ---------------------------------------------------------------------------
// JSON-RPC response helpers
// ---------------------------------------------------------------------------

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  writeFrame({ jsonrpc: '2.0', id: id == null ? null : id, error });
}

function sendResult(id, result) {
  writeFrame({ jsonrpc: '2.0', id, result });
}

// ---------------------------------------------------------------------------
// Message classification
// ---------------------------------------------------------------------------

function isResponse(msg) {
  return msg && (msg.result !== undefined || msg.error !== undefined);
}

// ---------------------------------------------------------------------------
// Line parsing
//
// Returns { ok: true, msg } on success, or { ok: false, code, message } on
// failure. The caller decides how to respond (e.g. sendError(null, ...)).
// parseLine never calls sendError directly — it is a pure transform.
// ---------------------------------------------------------------------------

function parseLine(line) {
  const trimmed = line.trim();

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch (err) {
    logStderr('parse error: ' + (err && err.message) + ' line=' + trimmed.slice(0, 200));
    return { ok: false, code: CODES.JSONRPC_PARSE_ERROR, message: 'Parse error' };
  }

  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return { ok: false, code: CODES.JSONRPC_INVALID_REQUEST, message: 'Invalid Request' };
  }

  return { ok: true, msg };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  CODES,
  logStderr,
  writeFrame,
  sendError,
  sendResult,
  isResponse,
  parseLine,
};
