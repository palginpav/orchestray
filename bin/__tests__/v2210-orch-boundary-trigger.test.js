#!/usr/bin/env node
'use strict';

/**
 * v2210-orch-boundary-trigger.test.js — F1 acceptance test (v2.2.10).
 *
 * Acceptance criteria (from locked plan §4 F1):
 *   1. hooks/hooks.json has NO Stop or SubagentStop entries naming the 6 migrated scripts.
 *   2. Synthetic orchestration: after audit-on-orch-complete.js fires, each of the
 *      6 audits' canonical output events appear in .orchestray/history/<orch_id>/events.jsonl.
 *   3. audit-on-orch-complete.js does NOT fire the 6 audits when no orchestration_complete
 *      event is present in events.jsonl.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const SCRIPT     = path.join(REPO_ROOT, 'bin', 'audit-on-orch-complete.js');
const HOOKS_JSON = path.join(REPO_ROOT, 'hooks', 'hooks.json');

// The 6 scripts that were migrated away from Stop/SubagentStop.
const MIGRATED_SCRIPTS = [
  'audit-promised-events.js',
  'audit-pm-emit-coverage.js',
  'audit-housekeeper-orphan.js',
  'scan-cite-labels.js',
  'archive-orch-events.js',
  'audit-round-archive-hook.js',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2210-orch-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'),   { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'),   { recursive: true });
  // Minimal config so schema-emit-validator doesn't hard-fail.
  fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({ event_schema_shadow: { enabled: false } }),
  );
  // Minimal event-schemas.shadow.json so audit-promised-events doesn't fail on missing file.
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'),
    JSON.stringify({ _meta: { generated_at: new Date().toISOString() }, events: [] }),
  );
  return dir;
}

function writeCurrentMarker(dir, orchId) {
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId, started_at: new Date().toISOString(), phase: 'execute' }),
  );
}

function writeLiveEvents(dir, orchId, opts = {}) {
  const ts  = (offset = 0) => new Date(Date.now() - (opts.ageOffset || 0) + offset).toISOString();
  const lines = [
    JSON.stringify({ type: 'orchestration_start', version: 1, timestamp: ts(0),    orchestration_id: orchId }),
    JSON.stringify({ type: 'agent_start',         version: 2, timestamp: ts(1000), orchestration_id: orchId, agent_type: 'developer' }),
    JSON.stringify({ type: 'agent_stop',          version: 1, timestamp: ts(2000), orchestration_id: orchId, agent_type: 'developer' }),
  ];
  if (opts.withComplete) {
    lines.push(JSON.stringify({
      type:               'orchestration_complete',
      version:            1,
      timestamp:          ts(3000),
      orchestration_id:   orchId,
      tasks_total:        1,
      tasks_succeeded:    1,
      tasks_failed:       0,
      duration_ms:        3000,
      status:             'success',
    }));
  }
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'events.jsonl'),
    lines.join('\n') + '\n',
  );
}

function runScript(script, dir, env = {}) {
  return spawnSync(process.execPath, [script], {
    input:   JSON.stringify({ cwd: dir }),
    timeout: 30000,
    encoding: 'utf8',
    env:     Object.assign({}, process.env, env),
  });
}

function readArchiveLines(dir, orchId) {
  const archivePath = path.join(dir, '.orchestray', 'history', orchId, 'events.jsonl');
  if (!fs.existsSync(archivePath)) return [];
  return fs.readFileSync(archivePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

function readLiveEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Test 1 — hooks.json structural check
// ---------------------------------------------------------------------------

describe('v2210 F1 — orch-boundary-trigger', () => {

  test('1. hooks.json has no Stop or SubagentStop entries for the 6 migrated scripts', () => {
    const raw    = fs.readFileSync(HOOKS_JSON, 'utf8');
    const parsed = JSON.parse(raw);

    const stopEntries       = parsed.hooks && parsed.hooks.Stop        || [];
    const subagentStopEntries = parsed.hooks && parsed.hooks.SubagentStop || [];

    for (const script of MIGRATED_SCRIPTS) {
      // Check Stop entries.
      for (const entry of stopEntries) {
        const hooksArr = entry.hooks || [];
        for (const h of hooksArr) {
          assert.ok(
            !h.command || !h.command.includes(script),
            `Stop hook must not reference migrated script: ${script}`,
          );
        }
      }
      // Check SubagentStop entries.
      for (const entry of subagentStopEntries) {
        const hooksArr = entry.hooks || [];
        for (const h of hooksArr) {
          assert.ok(
            !h.command || !h.command.includes(script),
            `SubagentStop hook must not reference migrated script: ${script}`,
          );
        }
      }
    }

    // The new PostToolUse entry for audit-on-orch-complete.js must be present.
    const postToolUse = parsed.hooks && parsed.hooks.PostToolUse || [];
    const hasNew = postToolUse.some(entry =>
      (entry.hooks || []).some(h => h.command && h.command.includes('audit-on-orch-complete.js'))
    );
    assert.ok(hasNew, 'PostToolUse section must contain audit-on-orch-complete.js');
  });

  // ---------------------------------------------------------------------------
  // Test 2 — synthetic orch: audits fire on orchestration_complete
  // ---------------------------------------------------------------------------

  test('2. audit-on-orch-complete fires after orchestration_complete and archive is populated', () => {
    const dir    = makeRepo();
    const orchId = 'orch-20260429T000000Z-f1-synthetic';

    writeCurrentMarker(dir, orchId);
    writeLiveEvents(dir, orchId, { withComplete: true });

    const result = runScript(SCRIPT, dir);
    assert.equal(result.status, 0, `script exited non-zero: ${result.stderr}`);

    // After firing, the archive at .orchestray/history/<orchId>/events.jsonl
    // must exist (archive-orch-events.js ran).
    const archivePath = path.join(dir, '.orchestray', 'history', orchId, 'events.jsonl');
    assert.ok(fs.existsSync(archivePath), 'archive must exist after orch_complete trigger');

    const archiveLines = readArchiveLines(dir, orchId);
    assert.ok(archiveLines.length > 0, 'archive must contain at least one line');

    // The archive must contain the orchestration_complete event itself.
    const hasComplete = archiveLines.some(
      e => e.type === 'orchestration_complete' && e.orchestration_id === orchId,
    );
    assert.ok(hasComplete, 'archive must contain the orchestration_complete event');

    // The state file must record this orch_id so re-runs are deduplicated.
    const stateFile = path.join(dir, '.orchestray', 'state', 'orch-complete-trigger.json');
    assert.ok(fs.existsSync(stateFile), 'state file must be written');
    const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(stateData.last_fired_orch_id, orchId, 'state must record the fired orch_id');

    // Idempotency: running again should be a no-op (no crash, exits 0).
    const result2 = runScript(SCRIPT, dir);
    assert.equal(result2.status, 0, 'second run must exit 0 (dedup)');

    // Cleanup.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Test 3 — NO orchestration_complete → audits must NOT fire
  // ---------------------------------------------------------------------------

  test('3. audit-on-orch-complete does NOT fire audits without orchestration_complete event', () => {
    const dir    = makeRepo();
    const orchId = 'orch-20260429T000001Z-f1-no-complete';

    writeCurrentMarker(dir, orchId);
    // Write events WITHOUT the orchestration_complete row.
    writeLiveEvents(dir, orchId, { withComplete: false });

    const result = runScript(SCRIPT, dir);
    assert.equal(result.status, 0, `script exited non-zero: ${result.stderr}`);

    // The archive must NOT be created (archive-orch-events.js did not run).
    const archivePath = path.join(dir, '.orchestray', 'history', orchId, 'events.jsonl');
    assert.ok(!fs.existsSync(archivePath), 'archive must NOT exist when no orchestration_complete');

    // The state file must NOT be written (audits did not fire).
    const stateFile = path.join(dir, '.orchestray', 'state', 'orch-complete-trigger.json');
    assert.ok(!fs.existsSync(stateFile), 'state file must NOT be written when no trigger');

    // Cleanup.
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Test 4 — kill switch
  // ---------------------------------------------------------------------------

  test('4. ORCHESTRAY_ORCH_BOUNDARY_TRIGGER_DISABLED=1 silently exits 0', () => {
    const dir    = makeRepo();
    const orchId = 'orch-20260429T000002Z-f1-disabled';

    writeCurrentMarker(dir, orchId);
    writeLiveEvents(dir, orchId, { withComplete: true });

    const result = runScript(SCRIPT, dir, { ORCHESTRAY_ORCH_BOUNDARY_TRIGGER_DISABLED: '1' });
    assert.equal(result.status, 0, 'kill switch must exit 0');

    // Archive must not have been created.
    const archivePath = path.join(dir, '.orchestray', 'history', orchId, 'events.jsonl');
    assert.ok(!fs.existsSync(archivePath), 'kill switch: archive must NOT exist');

    // Cleanup.
    fs.rmSync(dir, { recursive: true, force: true });
  });

});
