#!/usr/bin/env node
'use strict';

/**
 * Integration tests for bin/mcp-server/server.js — spawn the server as a real
 * subprocess and drive JSON-RPC 2.0 stdio end-to-end.
 *
 * Per v2011c-stage2-plan.md §13 (integration-tests subsection). These tests
 * are the last test step before G6 review: they validate that G3's tool and
 * resource dispatch is wired together correctly.
 *
 * Test coverage groups:
 *   A. Protocol handshake (initialize / notifications / method-not-found)
 *   B. tools/list (with and without per-tool config overrides)
 *   C. tools/call pattern_find
 *   D. tools/call pattern_record_application
 *   E. tools/call history_query_events
 *   F. tools/call history_find_similar_tasks
 *   G. tools/call kb_search
 *   H. tools/call ask_user (elicitation round-trip)
 *   I. resources/list
 *   J. resources/templates/list
 *   K. resources/read (incl. not-found and path-traversal error cases)
 *   L. orchestray:history://audit/live read
 *
 * Each test spawns its own server so per-test config and fixtures are fully
 * isolated. The subprocess is killed in a finally block and the tmpdir is
 * removed before the test returns.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Paths & package metadata
// ---------------------------------------------------------------------------

const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(PLUGIN_ROOT, 'bin', 'mcp-server', 'server.js');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
const EXPECTED_SERVER_VERSION = PKG_JSON.version;
const PROTOCOL_VERSION = '2024-11-05';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-integ-'));
  fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  return dir;
}

function writeConfig(tmp, cfg) {
  fs.writeFileSync(
    path.join(tmp, '.orchestray', 'config.json'),
    JSON.stringify(cfg, null, 2)
  );
}

function writePattern(tmp, slug, frontmatter, body) {
  const dir = path.join(tmp, '.orchestray', 'patterns');
  fs.mkdirSync(dir, { recursive: true });
  const fmLines = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content =
    '---\n' + fmLines + '\n---\n\n' + (body || `# Pattern: ${slug}\n\nBody text for ${slug}.\n`);
  fs.writeFileSync(path.join(dir, slug + '.md'), content);
}

function writeLiveAudit(tmp, lines) {
  const dir = path.join(tmp, '.orchestray', 'audit');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeArchiveEvents(tmp, orchId, lines) {
  const dir = path.join(tmp, '.orchestray', 'history', orchId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function writeArchiveTask(tmp, orchId, taskId, title, body) {
  const dir = path.join(tmp, '.orchestray', 'history', orchId, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  const content = `# ${title}\n\n${body || 'Task body.'}\n`;
  fs.writeFileSync(path.join(dir, taskId + '.md'), content);
}

function writeKbFile(tmp, section, slug, title, body) {
  const dir = path.join(tmp, '.orchestray', 'kb', section);
  fs.mkdirSync(dir, { recursive: true });
  const content = `# ${title}\n\n${body || 'Body text.'}\n`;
  fs.writeFileSync(path.join(dir, slug + '.md'), content);
}

// ---------------------------------------------------------------------------
// JSON-RPC client over spawned server subprocess
// ---------------------------------------------------------------------------

/**
 * Spawn the server as a subprocess rooted in `tmp`. Returns a small client
 * object whose shape is:
 *   { child, send(frame), sendAndReceive(request), onRequest(handler),
 *     close() }
 *
 * The client owns one readline over stdout. Every incoming frame is parsed
 * and routed:
 *   - If it has `method`, it is a server-initiated request; dispatched to
 *     the current `onRequest` handler (only used by the ask_user test).
 *   - Otherwise it is a response keyed by `id`; we resolve the pending
 *     promise stored in `pending`.
 *
 * Stderr is drained into a buffer so we can include it in assertion
 * messages if something goes wrong.
 */
function spawnServer(tmp) {
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: tmp,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ORCHESTRAY_PLUGIN_ROOT: PLUGIN_ROOT },
  });

  const stderrChunks = [];
  child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const pending = new Map(); // id -> { resolve, reject }
  let nextId = 1;
  let requestHandler = null; // for server-initiated requests

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      // Unparseable — leave on stderr for debugging.
      stderrChunks.push(Buffer.from('[test-client] unparseable frame: ' + trimmed + '\n'));
      return;
    }
    // Server-initiated request (has method, has id, is not a response).
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null &&
        msg.result === undefined && msg.error === undefined) {
      if (requestHandler) {
        Promise.resolve(requestHandler(msg)).catch(() => { /* swallow */ });
      }
      return;
    }
    // Notification from server — no id. Nothing to route.
    if (msg.id === undefined || msg.id === null) return;
    // Response to a client-initiated request.
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });

  function send(frame) {
    child.stdin.write(JSON.stringify(frame) + '\n');
  }

  function sendAndReceive(requestWithoutId) {
    const id = nextId++;
    const request = { jsonrpc: '2.0', id, ...requestWithoutId };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send(request);
    });
  }

  // Convenience: send a notification (no id, no response expected).
  function sendNotification(method, params) {
    const frame = { jsonrpc: '2.0', method };
    if (params !== undefined) frame.params = params;
    child.stdin.write(JSON.stringify(frame) + '\n');
  }

  function onRequest(fn) { requestHandler = fn; }

  async function close() {
    try { rl.close(); } catch (_e) { /* swallow */ }
    if (!child.killed) {
      child.kill('SIGTERM');
    }
    try { await once(child, 'exit'); } catch (_e) { /* swallow */ }
  }

  function stderrText() { return Buffer.concat(stderrChunks).toString('utf8'); }

  return { child, send, sendAndReceive, sendNotification, onRequest, close, stderrText };
}

/**
 * Initialize the server and return the full initialize result. Most tests
 * call this before doing anything else.
 */
async function initialize(client) {
  const resp = await client.sendAndReceive({
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '0.0.0' },
    },
  });
  if (resp.error) throw new Error('initialize failed: ' + JSON.stringify(resp.error));
  // Fire the initialized notification per protocol; server must not respond.
  client.sendNotification('notifications/initialized', {});
  return resp.result;
}

/**
 * Scaffold: create a tmp project, spawn a server, run `body(tmp, client)`,
 * then clean up reliably. Returns whatever `body` returns.
 */
async function withServer(setup, body) {
  const tmp = makeTmpProject();
  if (typeof setup === 'function') setup(tmp);
  const client = spawnServer(tmp);
  try {
    return await body(tmp, client);
  } finally {
    await client.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const TEST_TIMEOUT = 10000;

// ===========================================================================
// A. Protocol handshake
// ===========================================================================

describe('A. protocol handshake', () => {

  test('initialize returns protocolVersion, capabilities, serverInfo',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        const result = await initialize(client);
        assert.equal(result.protocolVersion, PROTOCOL_VERSION);
        assert.ok(result.capabilities, 'capabilities must be present');
        assert.ok(result.capabilities.tools, 'capabilities.tools must be present');
        assert.equal(result.capabilities.tools.listChanged, false);
        assert.ok(result.capabilities.resources, 'capabilities.resources must be present (Stage 2 addition)');
        assert.equal(result.capabilities.resources.listChanged, false);
        assert.equal(result.capabilities.resources.subscribe, false);
        assert.ok(result.capabilities.elicitation !== undefined,
          'capabilities.elicitation must be present');
        assert.deepEqual(result.capabilities.elicitation, {});
        assert.ok(result.serverInfo, 'serverInfo must be present');
        assert.equal(result.serverInfo.name, 'orchestray');
        assert.equal(result.serverInfo.version, EXPECTED_SERVER_VERSION);
      });
    }
  );

  test('notifications/initialized is a no-op (no response frame)',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client); // also sends notifications/initialized
        // If the server had replied, the readline loop would have no
        // pending id to match and would silently drop the frame — but then
        // the next request would still succeed. Send one more request to
        // prove the server is still alive and not confused.
        const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
        assert.ok(resp.result && Array.isArray(resp.result.tools));
      });
    }
  );

  test('unknown method returns -32601 with method name in data',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({ method: 'foo/bar', params: {} });
        assert.ok(resp.error, 'unknown method must produce a JSON-RPC error');
        assert.equal(resp.error.code, -32601);
        assert.ok(resp.error.data && resp.error.data.method === 'foo/bar',
          'error.data.method must echo the unknown method');
      });
    }
  );

  test('notification-shape frame (no id) with unknown method does not produce a response',
    { timeout: TEST_TIMEOUT },
    async () => {
      // Regression guard: Stage 1 §M1 fix. A notification-shaped frame with
      // an unknown method must be silently ignored, never echoed as an
      // error frame with null id.
      await withServer(null, async (_tmp, client) => {
        await initialize(client);

        // We can't directly assert "no frame produced", so instead we use
        // a sentinel: send a notification, then a real request. If the
        // server had replied to the notification with a null-id error frame,
        // our client router would drop it (no pending id), but the server
        // would still respond to the next request. So the real check is:
        // stderr must NOT contain anything indicating an error frame was
        // emitted for the notification, AND the follow-up request must
        // succeed. The stderr check is best-effort; the key guarantee is
        // that the server does not crash and continues to serve.
        client.sendNotification('notification/typo', {});
        // Give the server a moment to (not) respond. Use a microtask round
        // trip via a real request instead of a real sleep.
        const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
        assert.ok(resp.result && Array.isArray(resp.result.tools),
          'follow-up request must still succeed after notification-shape no-op');
      });
    }
  );

});

// ===========================================================================
// B. tools/list
// ===========================================================================

describe('B. tools/list', () => {

  test('default config returns all 13 tools',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
        assert.equal(resp.error, undefined, 'tools/list must not error');
        const names = resp.result.tools.map((t) => t.name).sort();
        assert.deepEqual(names, [
          'ask_user',
          'cost_budget_check',
          'cost_budget_reserve',
          'history_find_similar_tasks',
          'history_query_events',
          'kb_search',
          'kb_write',
          'metrics_query',
          'pattern_deprecate',
          'pattern_find',
          'pattern_record_application',
          'pattern_record_skip_reason',
          'routing_lookup',
        ]);
      });
    }
  );

  test('config with shorthand pattern_find=false omits pattern_find',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => writeConfig(tmp, { mcp_server: { tools: { pattern_find: false } } }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
          const names = resp.result.tools.map((t) => t.name);
          assert.equal(names.length, 12);
          assert.ok(!names.includes('pattern_find'),
            'pattern_find must be absent when disabled via shorthand');
          assert.ok(names.includes('pattern_record_skip_reason'),
            'new 2.0.14 tool pattern_record_skip_reason must still be present when unrelated tool is disabled');
          assert.ok(names.includes('cost_budget_check'),
            'new 2.0.14 tool cost_budget_check must still be present when unrelated tool is disabled');
          assert.ok(names.includes('kb_write'),
            'kb_write must still be present when unrelated tool is disabled');
          assert.ok(names.includes('pattern_deprecate'),
            'new 2.0.16 tool pattern_deprecate must still be present when unrelated tool is disabled');
        }
      );
    }
  );

  test('config with nested kb_search.enabled=false omits kb_search',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => writeConfig(tmp, { mcp_server: { tools: { kb_search: { enabled: false } } } }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
          const names = resp.result.tools.map((t) => t.name);
          assert.equal(names.length, 12);
          assert.ok(!names.includes('kb_search'),
            'kb_search must be absent when disabled via nested form');
          assert.ok(names.includes('pattern_record_skip_reason'),
            'new 2.0.14 tool pattern_record_skip_reason must still be present when unrelated tool is disabled');
          assert.ok(names.includes('cost_budget_check'),
            'new 2.0.14 tool cost_budget_check must still be present when unrelated tool is disabled');
          assert.ok(names.includes('kb_write'),
            'kb_write must still be present when unrelated tool is disabled');
          assert.ok(names.includes('pattern_deprecate'),
            'new 2.0.16 tool pattern_deprecate must still be present when unrelated tool is disabled');
        }
      );
    }
  );

  test('mcp_server.enabled=false returns empty tools and omits elicitation/resources capabilities',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => writeConfig(tmp, { mcp_server: { enabled: false } }),
        async (_tmp, client) => {
          const initResult = await initialize(client);
          // Capabilities: elicitation and resources must be absent.
          assert.equal(initResult.capabilities.elicitation, undefined,
            'elicitation capability must be absent when server disabled');
          assert.equal(initResult.capabilities.resources, undefined,
            'resources capability must be absent when server disabled');
          // tools/list returns empty array.
          const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
          assert.deepEqual(resp.result, { tools: [] });
        }
      );
    }
  );

});

// ===========================================================================
// C. tools/call pattern_find
// ===========================================================================

describe('C. tools/call pattern_find', () => {

  test('returns matches from fixture patterns',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          writePattern(tmp, 'reviewer-scan-scoping', {
            name: 'reviewer-scan-scoping',
            category: 'anti-pattern',
            confidence: 0.8,
            times_applied: 2,
            description: 'Reviewer subagents hit turn caps on whole-codebase scans; scope to changed files only',
          });
          writePattern(tmp, 'unrelated-routing', {
            name: 'unrelated-routing',
            category: 'routing',
            confidence: 0.5,
            times_applied: 0,
            description: 'Pick haiku for cheap exploration tasks',
          });
        },
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'pattern_find',
              arguments: {
                task_summary: 'Refactor reviewer to scan only changed files',
                agent_role: 'reviewer',
              },
            },
          });
          assert.equal(resp.error, undefined);
          assert.equal(resp.result.isError, false);
          const body = resp.result.structuredContent;
          assert.ok(body, 'structuredContent must be present');
          assert.ok(Array.isArray(body.matches));
          assert.ok(body.matches.length >= 1);
          assert.equal(body.matches[0].slug, 'reviewer-scan-scoping');
          assert.equal(body.considered, 2);
        }
      );
    }
  );

  test('returns empty matches when patterns dir is missing',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({
          method: 'tools/call',
          params: {
            name: 'pattern_find',
            arguments: { task_summary: 'anything at all' },
          },
        });
        assert.equal(resp.result.isError, false);
        const body = resp.result.structuredContent;
        assert.deepEqual(body, { matches: [], considered: 0, filtered_out: 0 });
      });
    }
  );

});

// ===========================================================================
// D. tools/call pattern_record_application
// ===========================================================================

describe('D. tools/call pattern_record_application', () => {

  test('increments times_applied and updates last_applied on disk',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          writePattern(tmp, 'sample', {
            name: 'sample',
            category: 'decomposition',
            confidence: 0.7,
            times_applied: 0,
            last_applied: '2026-01-01T00:00:00Z',
          });
        },
        async (tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'pattern_record_application',
              arguments: {
                slug: 'sample',
                orchestration_id: 'orch-integ-test-1',
                outcome: 'applied-success',
              },
            },
          });
          assert.equal(resp.error, undefined);
          assert.equal(resp.result.isError, false);
          const body = resp.result.structuredContent;
          assert.equal(body.slug, 'sample');
          assert.equal(body.times_applied, 1);
          assert.ok(typeof body.last_applied === 'string' && body.last_applied.length > 0);
          // Verify it parses as a Date and differs from the seed.
          assert.ok(!Number.isNaN(new Date(body.last_applied).getTime()));
          assert.notEqual(body.last_applied, '2026-01-01T00:00:00Z');

          // Verify disk was updated.
          const raw = fs.readFileSync(
            path.join(tmp, '.orchestray', 'patterns', 'sample.md'), 'utf8'
          );
          assert.ok(raw.includes('times_applied: 1'));
          assert.ok(!raw.includes('times_applied: 0'));
        }
      );
    }
  );

  test('unknown slug returns isError:true with "pattern not found"',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => fs.mkdirSync(path.join(tmp, '.orchestray', 'patterns'), { recursive: true }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'pattern_record_application',
              arguments: {
                slug: 'does-not-exist',
                orchestration_id: 'orch-integ-test-2',
                outcome: 'applied',
              },
            },
          });
          assert.equal(resp.error, undefined);
          assert.equal(resp.result.isError, true);
          const text = resp.result.content[0].text.toLowerCase();
          assert.ok(text.includes('pattern not found'), 'error text must mention "pattern not found"');
        }
      );
    }
  );

});

// ===========================================================================
// E. tools/call history_query_events
// ===========================================================================

describe('E. tools/call history_query_events', () => {

  test('returns mixed live+archive events normalized to {type}',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          writeLiveAudit(tmp, [
            // Two live rows use legacy `event:` key; one uses modern `type:`.
            { timestamp: '2026-04-05T00:00:00Z', event: 'orchestration_start', orchestration_id: 'orch-A' },
            { timestamp: '2026-04-05T00:00:01Z', type: 'agent_start', orchestration_id: 'orch-A', agent_role: 'pm' },
            { timestamp: '2026-04-05T00:00:02Z', event: 'agent_stop', orchestration_id: 'orch-A', agent_role: 'pm' },
          ]);
          writeArchiveEvents(tmp, 'orch-abc', [
            { timestamp: '2026-03-01T00:00:00Z', type: 'orchestration_complete', orchestration_id: 'orch-abc' },
          ]);
        },
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'history_query_events',
              arguments: {},
            },
          });
          assert.equal(resp.error, undefined);
          assert.equal(resp.result.isError, false);
          const body = resp.result.structuredContent;
          assert.equal(body.events.length, 4);
          assert.equal(body.total_matching, 4);
          assert.equal(body.returned, 4);
          // All events have `type` after normalization, not `event`.
          for (const ev of body.events) {
            assert.ok(typeof ev.type === 'string' && ev.type.length > 0,
              'each event must have a normalized type field');
            assert.equal(ev.event, undefined, 'legacy event field must be dropped');
            assert.ok(typeof ev.ref === 'string' && ev.ref.startsWith('orchestray:history://'),
              'each event must carry a ref URI');
          }
        }
      );
    }
  );

  test('filters by event_types correctly',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          writeLiveAudit(tmp, [
            { timestamp: '2026-04-05T00:00:00Z', type: 'orchestration_start', orchestration_id: 'orch-A' },
            { timestamp: '2026-04-05T00:00:01Z', type: 'agent_start', orchestration_id: 'orch-A' },
            { timestamp: '2026-04-05T00:00:02Z', type: 'agent_stop', orchestration_id: 'orch-A' },
          ]);
        },
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'history_query_events',
              arguments: { event_types: ['orchestration_start'] },
            },
          });
          assert.equal(resp.error, undefined);
          const body = resp.result.structuredContent;
          assert.equal(body.events.length, 1);
          assert.equal(body.events[0].type, 'orchestration_start');
          assert.equal(body.total_matching, 1);
          assert.equal(body.returned, 1);
        }
      );
    }
  );

});

// ===========================================================================
// F. tools/call history_find_similar_tasks
// ===========================================================================

describe('F. tools/call history_find_similar_tasks', () => {

  test('surfaces the matching task and assigns non-zero similarity',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          writeArchiveTask(
            tmp, 'orch-aaa', 'task-refactor-reviewer',
            'Refactor reviewer agent to scan only changed files',
            'Avoid whole-codebase scans so that the reviewer stops hitting turn caps.'
          );
          writeArchiveTask(
            tmp, 'orch-bbb', 'task-something-else',
            'Update README with installation instructions',
            'Document the install.js flow for new contributors.'
          );
        },
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'history_find_similar_tasks',
              arguments: {
                task_summary: 'refactor reviewer scan changed files',
                min_similarity: 0.05,
              },
            },
          });
          assert.equal(resp.error, undefined);
          assert.equal(resp.result.isError, false);
          const body = resp.result.structuredContent;
          assert.ok(Array.isArray(body.matches) && body.matches.length >= 1,
            'at least one similar task should be returned');
          assert.equal(body.matches[0].task_id, 'task-refactor-reviewer');
          assert.equal(body.matches[0].orch_id, 'orch-aaa');
          assert.ok(body.matches[0].similarity > 0);
          assert.ok(body.matches[0].ref.startsWith(
            'orchestray:history://orch/orch-aaa/tasks/task-refactor-reviewer'
          ));
        }
      );
    }
  );

});

// ===========================================================================
// G. tools/call kb_search
// ===========================================================================

describe('G. tools/call kb_search', () => {

  test('returns a match from artifacts when query matches the title',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          writeKbFile(
            tmp, 'artifacts', 'v2011b-architecture',
            'v2011b architecture decisions',
            'Stage 2 architecture for the Orchestray MCP server.'
          );
          writeKbFile(
            tmp, 'artifacts', 'v2011c-stage2-plan',
            'v2011c Stage 2 implementation plan',
            'Concrete plan derived from the v2011b architecture.'
          );
          writeKbFile(
            tmp, 'facts', 'unrelated-fact',
            'Unrelated trivia',
            'Paint mixes with water but oil does not.'
          );
        },
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'kb_search',
              arguments: { query: 'architecture' },
            },
          });
          assert.equal(resp.error, undefined);
          assert.equal(resp.result.isError, false);
          const body = resp.result.structuredContent;
          assert.ok(Array.isArray(body.matches) && body.matches.length >= 1);
          const hit = body.matches.find((m) => m.slug === 'v2011b-architecture');
          assert.ok(hit, 'the architecture KB file must be among the results');
          assert.equal(hit.section, 'artifacts');
          assert.ok(hit.uri.startsWith('orchestray:kb://artifacts/v2011b-architecture'));
        }
      );
    }
  );

});

// ===========================================================================
// H. tools/call ask_user — elicitation round-trip smoke test
// ===========================================================================

describe('H. tools/call ask_user (elicitation round-trip)', () => {

  test('round-trips a fake client accept response into structuredContent.answer',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client);

        // Arm the server-initiated request handler BEFORE issuing the
        // tools/call. When the server sends elicitation/create, reply with
        // action=accept + content={answer:"test"}.
        client.onRequest((req) => {
          if (req.method === 'elicitation/create') {
            client.send({ jsonrpc: '2.0', id: req.id, result: { action: 'accept', content: { answer: 'test' } } });
          }
        });

        const resp = await client.sendAndReceive({
          method: 'tools/call',
          params: {
            name: 'ask_user',
            arguments: {
              title: 'Integration test prompt',
              question: 'Is this a test?',
              form: [
                { name: 'answer', label: 'Your answer', type: 'text', required: true },
              ],
            },
          },
        });

        assert.equal(resp.error, undefined);
        assert.equal(resp.result.isError, false);
        assert.deepEqual(resp.result.structuredContent, {
          cancelled: false,
          answer: 'test',
        });
      });
    }
  );

});

// ===========================================================================
// I. resources/list
// ===========================================================================

describe('I. resources/list', () => {

  test('aggregates entries from pattern, history, and kb handlers',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          writePattern(tmp, 'list-me', {
            name: 'list-me',
            category: 'decomposition',
            confidence: 0.6,
            times_applied: 1,
            last_applied: '2026-04-01T00:00:00Z',
            description: 'Listable pattern',
          });
          writeArchiveEvents(tmp, 'orch-listed', [
            { timestamp: '2026-03-01T00:00:00Z', type: 'orchestration_start', orchestration_id: 'orch-listed' },
          ]);
          writeKbFile(tmp, 'artifacts', 'listed-artifact', 'Listed artifact', 'Body.');
        },
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({ method: 'resources/list', params: {} });
          assert.equal(resp.error, undefined);
          const uris = resp.result.resources.map((r) => r.uri);
          assert.ok(uris.some((u) => u === 'orchestray:pattern://list-me'),
            'pattern resource must be listed');
          assert.ok(uris.some((u) => u === 'orchestray:history://audit/live'),
            'audit/live history resource must be listed');
          assert.ok(uris.some((u) => u === 'orchestray:history://orch/orch-listed'),
            'archive history resource must be listed');
          assert.ok(uris.some((u) => u === 'orchestray:kb://artifacts/listed-artifact'),
            'kb resource must be listed');
        }
      );
    }
  );

  test('server disabled returns { resources: [] }',
    { timeout: TEST_TIMEOUT },
    async () => {
      // Per server.js:378-381 the disabled branch explicitly returns an
      // empty resources array. This test pins that behavior so a reviewer
      // cannot silently change it to -32601 without updating this test.
      await withServer(
        (tmp) => writeConfig(tmp, { mcp_server: { enabled: false } }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({ method: 'resources/list', params: {} });
          assert.equal(resp.error, undefined, 'resources/list must not return a JSON-RPC error when disabled');
          assert.deepEqual(resp.result, { resources: [] });
        }
      );
    }
  );

});

// ===========================================================================
// J. resources/templates/list
// ===========================================================================

describe('J. resources/templates/list', () => {

  test('returns templates for pattern, history (two), and kb schemes',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({ method: 'resources/templates/list', params: {} });
        assert.equal(resp.error, undefined);
        const templates = resp.result.resourceTemplates;
        assert.ok(Array.isArray(templates));
        const templateUris = templates.map((t) => t.uriTemplate);
        assert.ok(templateUris.includes('orchestray:pattern://{slug}'),
          'pattern template must be present');
        assert.ok(templateUris.includes('orchestray:history://orch/{orch_id}/summary'),
          'history summary template must be present');
        assert.ok(templateUris.includes('orchestray:history://orch/{orch_id}/tasks/{task_id}'),
          'history task template must be present');
        assert.ok(templateUris.includes('orchestray:kb://{section}/{slug}'),
          'kb template must be present');
        // Pattern + 2 history + kb + orchestration = 5 templates (2.0.16 added orchestration://).
        assert.equal(templates.length, 5,
          'exactly 5 resource templates expected (1 pattern + 2 history + 1 kb + 1 orchestration)');
      });
    }
  );

});

// ===========================================================================
// K. resources/read
// ===========================================================================

describe('K. resources/read', () => {

  test('reads a pattern resource and returns markdown contents',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => writePattern(tmp, 'readable', {
          name: 'readable',
          category: 'decomposition',
          confidence: 0.6,
          times_applied: 0,
          description: 'Readable pattern body',
        }, '# Pattern: readable\n\nUnique-body-marker-42\n'),
        async (tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'resources/read',
            params: { uri: 'orchestray:pattern://readable' },
          });
          assert.equal(resp.error, undefined);
          assert.ok(Array.isArray(resp.result.contents) && resp.result.contents.length === 1);
          const item = resp.result.contents[0];
          assert.equal(item.uri, 'orchestray:pattern://readable');
          assert.equal(item.mimeType, 'text/markdown');
          const onDisk = fs.readFileSync(
            path.join(tmp, '.orchestray', 'patterns', 'readable.md'), 'utf8'
          );
          assert.equal(item.text, onDisk);
          assert.ok(item.text.includes('Unique-body-marker-42'));
        }
      );
    }
  );

  test('reads a KB resource (orchestray:kb://artifacts/<slug>)',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => writeKbFile(tmp, 'artifacts', 'read-me', 'Read me title', 'KB body content here.'),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'resources/read',
            params: { uri: 'orchestray:kb://artifacts/read-me' },
          });
          assert.equal(resp.error, undefined);
          assert.equal(resp.result.contents[0].mimeType, 'text/markdown');
          assert.ok(resp.result.contents[0].text.includes('Read me title'));
          assert.ok(resp.result.contents[0].text.includes('KB body content here.'));
        }
      );
    }
  );

  test('missing pattern returns JSON-RPC error with not-found code',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => fs.mkdirSync(path.join(tmp, '.orchestray', 'patterns'), { recursive: true }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'resources/read',
            params: { uri: 'orchestray:pattern://does-not-exist' },
          });
          assert.ok(resp.error, 'missing resource must return JSON-RPC error');
          // MCP "resource not found" per plan §9 / arch §3.3.
          assert.equal(resp.error.code, -32002);
          assert.ok(resp.error.message.toLowerCase().includes('not found'));
          assert.ok(resp.error.data && resp.error.data.uri === 'orchestray:pattern://does-not-exist');
        }
      );
    }
  );

  test('path-traversal attempt returns JSON-RPC error with invalid-params code',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({
          method: 'resources/read',
          params: { uri: 'orchestray:pattern://../etc/passwd' },
        });
        assert.ok(resp.error, 'path traversal must return JSON-RPC error');
        // JSON-RPC 2.0 "invalid params" per plan §9 / arch §3.3.
        assert.equal(resp.error.code, -32602);
        assert.ok(resp.error.message.length > 0);
      });
    }
  );

});

// ===========================================================================
// L. orchestray:history://audit/live
// ===========================================================================

// ===========================================================================
// M. tools/call kb_write
// ===========================================================================

describe('M. tools/call kb_write', () => {

  test('kb_write appears in tools/list with correct schema',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(null, async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
        assert.equal(resp.error, undefined);
        const tool = resp.result.tools.find((t) => t.name === 'kb_write');
        assert.ok(tool, 'kb_write must appear in tools/list');
        assert.ok(tool.description && tool.description.length > 0, 'description must be non-empty');
        assert.ok(tool.inputSchema, 'inputSchema must be present');
        assert.deepEqual(tool.inputSchema.type, 'object');
        assert.ok(Array.isArray(tool.inputSchema.required));
        assert.ok(tool.inputSchema.required.includes('id'));
        assert.ok(tool.inputSchema.required.includes('bucket'));
        assert.ok(tool.inputSchema.required.includes('content'));
        const bucketSchema = tool.inputSchema.properties && tool.inputSchema.properties.bucket;
        assert.ok(bucketSchema, 'bucket property must be in schema');
        assert.deepEqual(bucketSchema.enum, ['artifacts', 'facts', 'decisions']);
      });
    }
  );

  test('kb_write happy path: writes file and index entry',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => {
          fs.mkdirSync(path.join(tmp, '.orchestray', 'kb', 'artifacts'), { recursive: true });
        },
        async (tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'kb_write',
              arguments: {
                id: 'integ-test-artifact',
                bucket: 'artifacts',
                path: 'integ-test-artifact.md',
                author: 'integ-test',
                topic: 'integration-test',
                content: '# Integration Test\n\nHello from kb_write integration test.',
              },
            },
          });
          assert.equal(resp.error, undefined, 'must not produce a JSON-RPC error');
          assert.equal(resp.result.isError, false, 'tool result must not be an error');
          const sc = resp.result.structuredContent;
          assert.equal(sc.id, 'integ-test-artifact');
          assert.equal(sc.bucket, 'artifacts');
          assert.ok(sc.bytes_written > 0);
          assert.ok(typeof sc.index_entry_total === 'number');
          // Verify the file was actually written to disk.
          const filePath = path.join(tmp, '.orchestray', 'kb', 'artifacts', 'integ-test-artifact.md');
          assert.ok(fs.existsSync(filePath), 'artifact file must exist on disk after write');
          // Verify the index was updated.
          const indexPath = path.join(tmp, '.orchestray', 'kb', 'index.json');
          assert.ok(fs.existsSync(indexPath), 'index.json must exist after write');
          const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
          const entry = (index.artifacts || []).find((e) => e.id === 'integ-test-artifact');
          assert.ok(entry, 'index must contain the written entry');
        }
      );
    }
  );

  test('kb_write disabled via config returns tool-result error',
    { timeout: TEST_TIMEOUT },
    async () => {
      await withServer(
        (tmp) => writeConfig(tmp, { mcp_server: { tools: { kb_write: false } } }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'kb_write',
              arguments: {
                id: 'should-fail',
                bucket: 'artifacts',
                path: 'should-fail.md',
                author: 'test',
                topic: 'test',
                content: 'nope',
              },
            },
          });
          assert.equal(resp.error, undefined, 'must not be a JSON-RPC error');
          assert.equal(resp.result.isError, true, 'must be a tool-result error when disabled');
          assert.ok(
            resp.result.content[0].text.includes('disabled'),
            'error message must mention disabled'
          );
        }
      );
    }
  );

});

// ===========================================================================
// L. orchestray:history://audit/live
// ===========================================================================

describe('L. orchestray:history://audit/live', () => {

  test('reads the live events.jsonl file verbatim',
    { timeout: TEST_TIMEOUT },
    async () => {
      const lines = [
        { timestamp: '2026-04-05T00:00:00Z', type: 'orchestration_start', orchestration_id: 'orch-L' },
        { timestamp: '2026-04-05T00:00:01Z', type: 'agent_start', orchestration_id: 'orch-L', agent_role: 'pm' },
      ];
      await withServer(
        (tmp) => writeLiveAudit(tmp, lines),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'resources/read',
            params: { uri: 'orchestray:history://audit/live' },
          });
          assert.equal(resp.error, undefined);
          const item = resp.result.contents[0];
          assert.equal(item.uri, 'orchestray:history://audit/live');
          // Per history_resource.read the mimeType is application/x-ndjson
          // and the text is the file contents verbatim (JSONL, not a JSON
          // array). The v2011c-stage2-plan.md §13 test description calling
          // this "application/json" that parses to an array is incorrect;
          // the actual code returns raw JSONL text as-is.
          assert.equal(item.mimeType, 'application/x-ndjson');
          // Note: we cannot compare item.text to the on-disk file after
          // the call, because the server emits an mcp_resource_read audit
          // event to the same file between the read returning and the
          // test reading the disk. Instead, parse the returned text and
          // assert it contains exactly the two seed rows we wrote.
          const parsed = item.text.trim().split('\n').map((l) => JSON.parse(l));
          assert.equal(parsed.length, 2,
            'only the two seed rows must appear (the post-read audit event is appended later)');
          assert.equal(parsed[0].type, 'orchestration_start');
          assert.equal(parsed[0].orchestration_id, 'orch-L');
          assert.equal(parsed[1].type, 'agent_start');
          assert.equal(parsed[1].orchestration_id, 'orch-L');
        }
      );
    }
  );

});

// ===========================================================================
// N. tools/list with unknown config tool key (T3 T1)
// ===========================================================================

describe('N. tools/list with unknown config tool key', () => {

  test('unknown key in mcp_server.tools does not contaminate tools/list',
    { timeout: TEST_TIMEOUT },
    async () => {
      // T3 T1: set an unknown tool key in the config and assert tools/list is
      // identical to the no-config case — the unknown key must neither appear
      // in the list nor remove any known tool.
      await withServer(
        (tmp) => writeConfig(tmp, {
          mcp_server: {
            tools: {
              some_unknown_key: true,
              another_made_up_tool: { enabled: true },
            },
          },
        }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
          assert.equal(resp.error, undefined, 'tools/list must not error');
          const names = resp.result.tools.map((t) => t.name).sort();
          // Must be exactly the known 13 tools — unknown keys neither added nor removed.
          assert.deepEqual(names, [
            'ask_user',
            'cost_budget_check',
            'cost_budget_reserve',
            'history_find_similar_tasks',
            'history_query_events',
            'kb_search',
            'kb_write',
            'metrics_query',
            'pattern_deprecate',
            'pattern_find',
            'pattern_record_application',
            'pattern_record_skip_reason',
            'routing_lookup',
          ], 'unknown config keys must not contaminate tools/list');
          // Verify neither unknown key name leaked into the tool list.
          assert.ok(!names.includes('some_unknown_key'),
            'some_unknown_key must not appear in tools/list');
          assert.ok(!names.includes('another_made_up_tool'),
            'another_made_up_tool must not appear in tools/list');
        }
      );
    }
  );

  test('unknown key alongside disabled known tool still produces correct list',
    { timeout: TEST_TIMEOUT },
    async () => {
      // T3 T1 variant: mix of unknown key + known tool disabled.
      await withServer(
        (tmp) => writeConfig(tmp, {
          mcp_server: {
            tools: {
              pattern_find: false,        // known — should be excluded
              some_unknown_key: true,     // unknown — should be silently ignored
            },
          },
        }),
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({ method: 'tools/list', params: {} });
          assert.equal(resp.error, undefined);
          const names = resp.result.tools.map((t) => t.name);
          assert.equal(names.length, 12, 'only one known tool removed, unknown key ignored');
          assert.ok(!names.includes('pattern_find'), 'pattern_find must be absent (disabled)');
          assert.ok(!names.includes('some_unknown_key'), 'unknown key must not appear');
        }
      );
    }
  );

});

// ===========================================================================
// O. pattern_record_skip_reason audit event end-to-end (T3 T2)
// ===========================================================================

describe('O. pattern_record_skip_reason audit event end-to-end', () => {

  test('tools/call pattern_record_skip_reason appends mcp_tool_call audit row',
    { timeout: TEST_TIMEOUT },
    async () => {
      // T3 T2: spawn the server, call pattern_record_skip_reason, and verify
      // an mcp_tool_call audit row is appended to events.jsonl.
      await withServer(
        (tmp) => {
          // Pre-create the audit dir so events.jsonl has a known location.
          fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
          // Seed a current-orchestration.json so the audit event gets an orch id.
          fs.writeFileSync(
            path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json'),
            JSON.stringify({ orchestration_id: 'orch-skip-reason-integ-test' })
          );
          // Seed an empty events.jsonl.
          fs.writeFileSync(
            path.join(tmp, '.orchestray', 'audit', 'events.jsonl'),
            ''
          );
        },
        async (tmp, client) => {
          await initialize(client);

          const before = new Date().toISOString();

          const resp = await client.sendAndReceive({
            method: 'tools/call',
            params: {
              name: 'pattern_record_skip_reason',
              arguments: {
                orchestration_id: 'orch-skip-reason-integ-test',
                reason: 'all-irrelevant',
                notes: 'none of the patterns matched this task type',
              },
            },
          });

          const after = new Date().toISOString();

          assert.equal(resp.error, undefined, 'must not produce a JSON-RPC error');
          assert.equal(resp.result.isError, false, 'tool result must not be an error');
          // Tool handler returns recorded: true
          const sc = resp.result.structuredContent;
          assert.equal(sc.recorded, true, 'pattern_record_skip_reason must return recorded:true');

          // Give the server a moment to flush the async audit write.
          await new Promise((resolve) => setTimeout(resolve, 200));

          // Read events.jsonl and find the mcp_tool_call row for this tool.
          const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
          const lines = fs.readFileSync(eventsPath, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l));

          const auditRow = lines.find(
            (e) => e.type === 'mcp_tool_call' && e.tool === 'pattern_record_skip_reason'
          );
          assert.ok(auditRow, 'mcp_tool_call audit row for pattern_record_skip_reason must exist');

          // Verify the full event shape.
          assert.ok(
            typeof auditRow.timestamp === 'string' && auditRow.timestamp.endsWith('Z'),
            'audit event timestamp must be an ISO UTC string'
          );
          assert.equal(auditRow.orchestration_id, 'orch-skip-reason-integ-test',
            'audit event must carry the orchestration_id');
          assert.ok(
            typeof auditRow.outcome === 'string' && auditRow.outcome.length > 0,
            'audit event must have a non-empty outcome field'
          );
          assert.ok(
            typeof auditRow.duration_ms === 'number' && auditRow.duration_ms >= 0,
            'audit event must have a non-negative duration_ms'
          );
        }
      );
    }
  );

});

// ===========================================================================
// P. orchestray:history://orch/<id>/summary resource (T3 T3)
// ===========================================================================

describe('P. orchestray:history://orch/<id>/summary resource', () => {

  test('resources/read with summary URI returns orchestration.md contents',
    { timeout: TEST_TIMEOUT },
    async () => {
      // T3 T3: stage a minimal orchestration.md under a temp archive directory,
      // send a resources/read for the summary URI, and assert the response
      // contains the expected content with correct mimeType.
      const ORCH_ID = 'orch-summary-integ-001';
      const EXPECTED_CONTENT = '# Orchestration: ' + ORCH_ID + '\n\nStatus: complete\n\nUnique-summary-marker-9182\n';

      await withServer(
        (tmp) => {
          const archiveDir = path.join(tmp, '.orchestray', 'history', ORCH_ID);
          fs.mkdirSync(archiveDir, { recursive: true });
          fs.writeFileSync(path.join(archiveDir, 'orchestration.md'), EXPECTED_CONTENT);
        },
        async (_tmp, client) => {
          await initialize(client);

          const uri = 'orchestray:history://orch/' + ORCH_ID + '/summary';
          const resp = await client.sendAndReceive({
            method: 'resources/read',
            params: { uri },
          });

          assert.equal(resp.error, undefined, 'summary read must not produce a JSON-RPC error');
          assert.ok(
            Array.isArray(resp.result.contents) && resp.result.contents.length === 1,
            'result must have exactly one content item'
          );
          const item = resp.result.contents[0];
          assert.equal(item.uri, uri, 'returned uri must match requested uri');
          assert.equal(item.mimeType, 'text/markdown',
            'summary resource must have mimeType text/markdown');
          assert.ok(
            item.text.includes('Unique-summary-marker-9182'),
            'returned text must contain the expected marker from orchestration.md'
          );
          assert.equal(item.text, EXPECTED_CONTENT,
            'returned text must exactly match orchestration.md content');
        }
      );
    }
  );

  test('resources/read for summary of non-existent orchestration returns not-found error',
    { timeout: TEST_TIMEOUT },
    async () => {
      // T3 T3 error path: missing orchestration directory → RESOURCE_NOT_FOUND.
      await withServer(null, async (_tmp, client) => {
        await initialize(client);
        const resp = await client.sendAndReceive({
          method: 'resources/read',
          params: { uri: 'orchestray:history://orch/orch-does-not-exist/summary' },
        });
        assert.ok(resp.error, 'missing summary must return a JSON-RPC error');
        assert.equal(resp.error.code, -32002,
          'error code must be -32002 (resource not found)');
        assert.ok(resp.error.message.toLowerCase().includes('not found'),
          'error message must mention not found');
      });
    }
  );

  test('resources/read for summary with existing orch dir but missing orchestration.md returns not-found error',
    { timeout: TEST_TIMEOUT },
    async () => {
      // T3 T3 partial fixture: dir exists but orchestration.md absent.
      const ORCH_ID = 'orch-summary-no-md';
      await withServer(
        (tmp) => {
          // Create the directory but NOT the orchestration.md file.
          fs.mkdirSync(path.join(tmp, '.orchestray', 'history', ORCH_ID), { recursive: true });
        },
        async (_tmp, client) => {
          await initialize(client);
          const resp = await client.sendAndReceive({
            method: 'resources/read',
            params: { uri: 'orchestray:history://orch/' + ORCH_ID + '/summary' },
          });
          assert.ok(resp.error, 'missing orchestration.md must return a JSON-RPC error');
          assert.equal(resp.error.code, -32002);
        }
      );
    }
  );

});
