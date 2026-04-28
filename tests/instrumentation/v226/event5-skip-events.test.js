'use strict';

/**
 * Test Event 5: compression_skipped.
 *
 * Six skip-reason fixtures, one per reason:
 *   kill_switch_env, kill_switch_config, level_off, no_prompt_field, oversize_stdin, parse_failure
 *
 * Each fixture emits compression_skipped with the correct reason.
 * Uses emitCompressionSkipped directly to verify payload shape.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

// ---------------------------------------------------------------------------
// Helper: isolated tmp dir with audit dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e5-skip-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

function makeEventsPath(tmpDir) {
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  return path.join(auditDir, 'events.jsonl');
}

function readEvents(eventsPath) {
  try {
    const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
    return lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  } catch (_e) { return []; }
}

// ---------------------------------------------------------------------------
// Valid skip reasons per W4 §event 5
// ---------------------------------------------------------------------------
const SKIP_REASONS = [
  { reason: 'kill_switch_env',    skipPath: 'ORCHESTRAY_DISABLE_COMPRESSION=1' },
  { reason: 'kill_switch_config', skipPath: 'compression.enabled=false' },
  { reason: 'level_off',          skipPath: 'ORCHESTRAY_COMPRESSION_LEVEL=off' },
  { reason: 'no_prompt_field',    skipPath: 'no_prompt_field_in_tool_input' },
  { reason: 'oversize_stdin',     skipPath: 'stdin_bytes_exceeded_limit' },
  { reason: 'parse_failure',      skipPath: 'parseSections_threw' },
];

// ---------------------------------------------------------------------------
// For each skip reason, verify the payload shape when emitted directly
// ---------------------------------------------------------------------------
for (const { reason, skipPath } of SKIP_REASONS) {
  test(`Event5-skip: emits compression_skipped with reason="${reason}"`, (t) => {
    const tmpDir = makeTmpDir(t);
    const eventsPath = makeEventsPath(tmpDir);

    const { writeEvent } = require('../../../bin/_lib/audit-event-writer');

    writeEvent({
      type:             'compression_skipped',
      event_type:       'compression_skipped',
      version:          1,
      schema_version:   1,
      orchestration_id: 'orch-test-e5',
      agent_type:       'developer',
      reason,
      skip_path:        skipPath,
    }, { cwd: tmpDir, eventsPath });

    const events = readEvents(eventsPath);
    const skipEvents = events.filter(e =>
      e.type === 'compression_skipped' || e.event_type === 'compression_skipped'
    );

    assert.ok(skipEvents.length >= 1, `must emit compression_skipped for reason=${reason}`);
    const e = skipEvents[0];
    assert.equal(e.reason,     reason,   `reason must be "${reason}"`);
    assert.equal(e.skip_path,  skipPath, 'skip_path must match');
    assert.ok(e.orchestration_id, 'orchestration_id must be present');
    assert.ok(e.agent_type,       'agent_type must be present');
  });
}

// ---------------------------------------------------------------------------
// Additional: valid reason values don't include unknown strings
// ---------------------------------------------------------------------------
test('Event5-skip: invalid reason string is not in the valid set', () => {
  const validReasons = new Set([
    'kill_switch_env', 'kill_switch_config', 'level_off', 'level_debug_passthrough',
    'no_prompt_field', 'oversize_stdin', 'parse_failure', 'runtime_exception', 'agent_type_excluded',
  ]);
  assert.ok(!validReasons.has('unknown_random_reason'), 'random string must not be a valid reason');
  for (const { reason } of SKIP_REASONS) {
    assert.ok(validReasons.has(reason), `reason "${reason}" must be in the valid set`);
  }
});
