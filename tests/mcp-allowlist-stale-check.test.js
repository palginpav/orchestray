#!/usr/bin/env node
'use strict';

/**
 * Wiring coverage for `runMcpAllowlistStaleCheckIfNeeded`
 * (bin/post-upgrade-sweep.js, v2.3.19 E3 dark-event triage).
 *
 * The unit-level parsing/diffing logic (parseToolTable, parsePmAllowlist,
 * diffAllowlist) is already covered by
 * bin/__tests__/anti-pattern-mcp-allowlist-parity.test.js. This file covers
 * the *wiring* those functions are called from: sentinel consumption, the
 * writeEvent call on a stale hit, and the unlink-on-completion contract —
 * gaps flagged by the F7 orchestration review (no test referenced the
 * sentinel, the function, or the runtime event).
 *
 * `runMcpAllowlistStaleCheckIfNeeded` reads `agents/pm.md` and
 * `bin/mcp-server/server.js` relative to its own install location
 * (`__dirname`), not `cwd` — by design, since those files ship with the
 * plugin, not the project. To exercise the stale branch without mutating
 * the real repo files, these tests inject synthetic fixtures via the
 * `ORCHESTRAY_TEST_MCP_ALLOWLIST_SERVER_PATH` / `..._PM_MD_PATH` env-var
 * overrides added alongside the F8 fix, mirroring the existing
 * `ORCHESTRAY_TEST_EVENTS_PATH` pattern in audit-event-writer.js.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/post-upgrade-sweep.js');

const SYNTH_SERVER_NO_RETIRED = `
'use strict';
const TOOL_TABLE = Object.freeze({
  ask_user: { definition: ASK, handler: handleAskUser },
  pattern_find: { definition: PF, handler: handlePF },
});
`;

const SYNTH_PM_WITH_RETIRED = `---
name: pm
tools: Read, mcp__orchestray__ask_user, mcp__orchestray__pattern_find, mcp__orchestray__totally_retired_tool
---
`;

const SYNTH_PM_NO_RETIRED = `---
name: pm
tools: Read, mcp__orchestray__ask_user, mcp__orchestray__pattern_find
---
`;

const cleanup = [];

afterEach(() => {
  for (const p of cleanup.splice(0)) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_e) {}
  }
});

/** Isolated project dir with the mcp-allowlist-check-needed sentinel pre-seeded. */
function makeDirWithSentinel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-allowlist-'));
  cleanup.push(dir);
  const stateDir = path.join(dir, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'mcp-allowlist-check-needed'),
    JSON.stringify({ created: new Date().toISOString(), version: '0.0.0-test' }) + '\n',
    'utf8'
  );
  return { dir, stateDir, sentinelPath: path.join(stateDir, 'mcp-allowlist-check-needed') };
}

/** Write synthetic server.js/pm.md fixtures to a temp dir; returns their paths. */
function writeFixtures({ serverSrc, pmSrc }) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-allowlist-fixtures-'));
  cleanup.push(fixtureDir);
  const serverPath = path.join(fixtureDir, 'server.js');
  const pmMdPath = path.join(fixtureDir, 'pm.md');
  fs.writeFileSync(serverPath, serverSrc, 'utf8');
  fs.writeFileSync(pmMdPath, pmSrc, 'utf8');
  return { serverPath, pmMdPath };
}

/**
 * Run post-upgrade-sweep.js against an isolated project dir, with optional
 * fixture overrides for the plugin-root file reads.
 */
function run(dir, { serverPath, pmMdPath } = {}) {
  const sessionId = 'mcp-allowlist-test-' + path.basename(dir);
  const lockPath = path.join(os.tmpdir(), `orchestray-sweep-${sessionId}.lock`);
  try { fs.unlinkSync(lockPath); } catch (_e) {}
  cleanup.push(lockPath);

  const env = Object.assign({}, process.env);
  if (serverPath) env.ORCHESTRAY_TEST_MCP_ALLOWLIST_SERVER_PATH = serverPath;
  if (pmMdPath) env.ORCHESTRAY_TEST_MCP_ALLOWLIST_PM_MD_PATH = pmMdPath;

  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ cwd: dir, session_id: sessionId }),
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

describe('runMcpAllowlistStaleCheckIfNeeded (bin/post-upgrade-sweep.js, F7 coverage)', () => {

  test('sentinel is consumed on first run and stays gone on a second run', () => {
    const { dir, sentinelPath } = makeDirWithSentinel();
    const { serverPath, pmMdPath } = writeFixtures({
      serverSrc: SYNTH_SERVER_NO_RETIRED,
      pmSrc: SYNTH_PM_NO_RETIRED,
    });

    assert.ok(fs.existsSync(sentinelPath), 'sentinel must exist before the first run');

    const first = run(dir, { serverPath, pmMdPath });
    assert.equal(first.status, 0, 'first run failed: ' + first.stderr);
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel must be consumed after the first run');

    // Second run: sentinel absent → existsSilent short-circuit, no crash, no re-read.
    const second = run(dir, { serverPath, pmMdPath });
    assert.equal(second.status, 0, 'second run failed: ' + second.stderr);
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel remains absent on the second run');
  });

  test('stale branch is reachable end-to-end and emits a valid event row', () => {
    const { dir, sentinelPath } = makeDirWithSentinel();
    const { serverPath, pmMdPath } = writeFixtures({
      serverSrc: SYNTH_SERVER_NO_RETIRED,
      pmSrc: SYNTH_PM_WITH_RETIRED,
    });

    const result = run(dir, { serverPath, pmMdPath });
    assert.equal(result.status, 0, 'run failed: ' + result.stderr);
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel must still be consumed on the stale path');

    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    assert.ok(fs.existsSync(eventsPath), 'events.jsonl must exist after a stale hit');

    const rows = fs.readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const warnRow = rows.find((r) => r.type === 'mcp_allowlist_stale_entry_warn');

    assert.ok(warnRow, 'mcp_allowlist_stale_entry_warn row must be present: ' + JSON.stringify(rows));
    assert.equal(warnRow.schema_version, 1);
    assert.deepEqual(warnRow.stale_slugs, ['totally_retired_tool']);
    assert.ok(typeof warnRow.timestamp === 'string' && warnRow.timestamp.length > 0,
      'writeEvent autofill must stamp a timestamp');
  });

  test('no stale entries → sentinel consumed, no warn event emitted', () => {
    const { dir, sentinelPath } = makeDirWithSentinel();
    const { serverPath, pmMdPath } = writeFixtures({
      serverSrc: SYNTH_SERVER_NO_RETIRED,
      pmSrc: SYNTH_PM_NO_RETIRED,
    });

    const result = run(dir, { serverPath, pmMdPath });
    assert.equal(result.status, 0, 'run failed: ' + result.stderr);
    assert.ok(!fs.existsSync(sentinelPath), 'sentinel must be consumed even with no stale entries');

    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const rows = fs.readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(
        !rows.some((r) => r.type === 'mcp_allowlist_stale_entry_warn'),
        'no warn event should be emitted when parity holds'
      );
    }
  });

  test('no sentinel present → no-op, no fixture files touched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-allowlist-nosentinel-'));
    cleanup.push(dir);
    fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });

    const { serverPath, pmMdPath } = writeFixtures({
      serverSrc: SYNTH_SERVER_NO_RETIRED,
      pmSrc: SYNTH_PM_WITH_RETIRED, // would be stale IF read — must not be read
    });

    const result = run(dir, { serverPath, pmMdPath });
    assert.equal(result.status, 0, 'run failed: ' + result.stderr);

    const eventsPath = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
    if (fs.existsSync(eventsPath)) {
      const rows = fs.readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.ok(
        !rows.some((r) => r.type === 'mcp_allowlist_stale_entry_warn'),
        'no warn event when the sentinel was never present'
      );
    }
  });

});
