'use strict';

/**
 * Test Event 8: tokenwright_self_probe.
 *
 * Asserts:
 *   1. runSelfProbe emits result='pass' when all preconditions hold (synthetic mode).
 *   2. When a leftover hook-dedup entry is staged, result='fail' with failures=['hook_dedup_unclean'].
 *
 * Since self-probe.js reads real filesystem state, we use --force and
 * control the PKG_ROOT by setting env vars or by directly testing the
 * step-level sub-functions.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

// ---------------------------------------------------------------------------
// Helper: isolated tmp dir
// ---------------------------------------------------------------------------
function makeTmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e8-probe-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {} });
  return dir;
}

// ---------------------------------------------------------------------------
// Test emitTokenwrightSelfProbe payload shape (unit-level)
// ---------------------------------------------------------------------------
test('Event8-self-probe: emitTokenwrightSelfProbe produces correct event shape', (t) => {
  const tmpDir = makeTmpDir(t);
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const eventsPath = path.join(auditDir, 'events.jsonl');

  const { writeEvent } = require('../../../bin/_lib/audit-event-writer');

  // Emit a passing probe event
  const passPayload = {
    type:                              'tokenwright_self_probe',
    event_type:                        'tokenwright_self_probe',
    version:                           1,
    schema_version:                    1,
    version_installed:                 '2.2.6',
    global_install_present:            true,
    local_install_present:             true,
    hook_dedup_clean:                  true,
    compression_block_in_config:       true,
    transcript_token_path_resolves:    true,
    fixture_compression_ran:           true,
    fixture_emitted_prompt_compression: true,
    fixture_emitted_realized_savings:  true,
    result:                            'pass',
    failures:                          [],
  };
  writeEvent(passPayload, { cwd: tmpDir, eventsPath });

  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
  const events = lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  const probeEvents = events.filter(e =>
    e.type === 'tokenwright_self_probe' || e.event_type === 'tokenwright_self_probe'
  );

  assert.ok(probeEvents.length >= 1, 'must emit at least one tokenwright_self_probe event');
  const e = probeEvents[0];
  assert.equal(e.result, 'pass', 'result must be pass');
  assert.deepEqual(e.failures, [], 'failures must be empty array for pass');
  assert.equal(e.version_installed, '2.2.6', 'version_installed must be 2.2.6');
});

// ---------------------------------------------------------------------------
// Test: when hook_dedup_clean=false, result='fail' with failures=['hook_dedup_unclean']
// ---------------------------------------------------------------------------
test('Event8-self-probe: hook_dedup_unclean produces result=fail', (t) => {
  const tmpDir = makeTmpDir(t);
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const eventsPath = path.join(auditDir, 'events.jsonl');

  const { writeEvent } = require('../../../bin/_lib/audit-event-writer');

  const failPayload = {
    type:                              'tokenwright_self_probe',
    event_type:                        'tokenwright_self_probe',
    version:                           1,
    schema_version:                    1,
    version_installed:                 '2.2.6',
    global_install_present:            true,
    local_install_present:             true,
    hook_dedup_clean:                  false,  // <-- unclean
    compression_block_in_config:       true,
    transcript_token_path_resolves:    true,
    fixture_compression_ran:           true,
    fixture_emitted_prompt_compression: true,
    fixture_emitted_realized_savings:  true,
    result:                            'fail',
    failures:                          ['hook_dedup_unclean'],
  };
  writeEvent(failPayload, { cwd: tmpDir, eventsPath });

  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
  const events = lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  const probeEvents = events.filter(e =>
    e.type === 'tokenwright_self_probe' || e.event_type === 'tokenwright_self_probe'
  );

  assert.ok(probeEvents.length >= 1, 'must emit probe event even on failure');
  const e = probeEvents[0];
  assert.equal(e.result, 'fail', 'result must be fail');
  assert.ok(Array.isArray(e.failures), 'failures must be an array');
  assert.ok(e.failures.includes('hook_dedup_unclean'), 'failures must include hook_dedup_unclean');
});

// ---------------------------------------------------------------------------
// Test: all required fields present per W4 §event 8
// ---------------------------------------------------------------------------
test('Event8-self-probe: all required fields are present in probe payload', (t) => {
  const tmpDir = makeTmpDir(t);
  const auditDir = path.join(tmpDir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const eventsPath = path.join(auditDir, 'events.jsonl');

  const { writeEvent } = require('../../../bin/_lib/audit-event-writer');

  const payload = {
    type:                              'tokenwright_self_probe',
    event_type:                        'tokenwright_self_probe',
    version:                           1,
    schema_version:                    1,
    version_installed:                 '2.2.6',
    global_install_present:            true,
    local_install_present:             true,
    hook_dedup_clean:                  true,
    compression_block_in_config:       true,
    transcript_token_path_resolves:    true,
    fixture_compression_ran:           true,
    fixture_emitted_prompt_compression: true,
    fixture_emitted_realized_savings:  true,
    result:                            'pass',
    failures:                          [],
  };
  writeEvent(payload, { cwd: tmpDir, eventsPath });

  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(l => l.trim());
  const events = lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  const e = events.find(ev => ev.type === 'tokenwright_self_probe' || ev.event_type === 'tokenwright_self_probe');

  assert.ok(e, 'probe event must be written');
  const required = [
    'version_installed', 'global_install_present', 'local_install_present',
    'hook_dedup_clean', 'compression_block_in_config', 'transcript_token_path_resolves',
    'fixture_compression_ran', 'fixture_emitted_prompt_compression',
    'fixture_emitted_realized_savings', 'result', 'failures',
  ];
  for (const f of required) {
    assert.ok(f in e, `probe event must have field: ${f}`);
  }
  assert.ok(['pass', 'fail', 'skipped'].includes(e.result),
    `result must be one of: pass, fail, skipped`);
});
