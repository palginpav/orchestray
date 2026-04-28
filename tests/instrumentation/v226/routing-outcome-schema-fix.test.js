'use strict';

/**
 * W4: routing_outcome schema drift fix.
 *
 * Root cause: Variant C emit in collect-agent-metrics.js was missing the
 * required fields `version`, `tool_name`, and `description` that the canonical
 * routing_outcome schema section requires. The schema-emit-validator checks
 * key presence (not value non-null), so passing null sentinels satisfies the
 * contract for Variant C where those values are unavailable at stop-time.
 *
 * Tests:
 *   1. Emit with all required fields present → single event, no validation block.
 *   2. Emit missing one required field → validation block is produced (guards the contract).
 *   3. routing_outcome exists in schema shadow with r >= 7 (version + timestamp +
 *      orchestration_id + agent_type + tool_name + description + source).
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const { writeEvent }     = require('../../../bin/_lib/audit-event-writer');
const { clearCache }     = require('../../../bin/_lib/schema-emit-validator');
const { loadShadow }     = require('../../../bin/_lib/load-schema-shadow');

const PKG_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Create a temp dir that includes an agents/ copy so the schema file is
 * resolvable by the emit validator.
 */
function makeTempCwd() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  // Copy only the schema file (not the full agents tree) to keep it light.
  const schemaRelPath = path.join('agents', 'pm-reference', 'event-schemas.md');
  const schemaDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.copyFileSync(
    path.join(PKG_ROOT, schemaRelPath),
    path.join(tmpDir, schemaRelPath)
  );
  return tmpDir;
}

function readEvents(tmpDir) {
  const eventsPath = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Test 1: Variant C with all required fields → clean emit, no validation block
// ---------------------------------------------------------------------------
test('routing-outcome-schema-fix: emit with all required fields lands without validation block', () => {
  clearCache();
  const tmpDir = makeTempCwd();
  try {
    writeEvent({
      type: 'routing_outcome',
      version: 1,
      timestamp: new Date().toISOString(),
      orchestration_id: 'orch-smoke-test',
      agent_type: 'developer',
      tool_name: null,         // null sentinel — valid for Variant C
      description: null,       // null sentinel — valid for Variant C
      model_assigned: null,
      result: 'success',
      turns_used: 3,
      input_tokens: 50,
      output_tokens: 200,
      source: 'subagent_stop',
    }, { cwd: tmpDir });

    const events = readEvents(tmpDir);
    assert.equal(events.length, 1, 'exactly one event should be written');
    assert.equal(events[0].type, 'routing_outcome', 'event type must be routing_outcome');
    assert.equal(events[0].source, 'subagent_stop', 'source must be subagent_stop');
    assert.equal(events[0].version, 1, 'version must be 1');

    const blockEvents = events.filter(e => e.type === 'schema_shadow_validation_block');
    assert.equal(blockEvents.length, 0, 'no schema_shadow_validation_block should be emitted');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearCache();
  }
});

// ---------------------------------------------------------------------------
// Test 2: Variant C missing required field → validation block is produced
// ---------------------------------------------------------------------------
test('routing-outcome-schema-fix: emit missing required field produces schema_shadow_validation_block', () => {
  clearCache();
  const tmpDir = makeTempCwd();
  try {
    // Emit without `version`, `tool_name`, `description` — the old bug shape
    writeEvent({
      type: 'routing_outcome',
      timestamp: new Date().toISOString(),
      orchestration_id: 'orch-smoke-test',
      agent_type: 'developer',
      model_assigned: null,
      result: 'success',
      turns_used: 3,
      input_tokens: 50,
      output_tokens: 200,
      source: 'subagent_stop',
    }, { cwd: tmpDir });

    const events = readEvents(tmpDir);
    const blockEvents = events.filter(e => e.type === 'schema_shadow_validation_block');
    assert.equal(blockEvents.length, 1, 'one schema_shadow_validation_block must be emitted when required fields are missing');

    const block = blockEvents[0];
    assert.equal(block.blocked_event_type, 'routing_outcome', 'block must name routing_outcome');

    const missingFields = block.errors.map(e => {
      const m = e.match(/missing required field "([^"]+)"/);
      return m ? m[1] : null;
    }).filter(Boolean);

    assert.ok(missingFields.includes('version'), 'version must be listed as missing');
    assert.ok(missingFields.includes('tool_name'), 'tool_name must be listed as missing');
    assert.ok(missingFields.includes('description'), 'description must be listed as missing');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    clearCache();
  }
});

// ---------------------------------------------------------------------------
// Test 3: routing_outcome shadow entry has r >= 7 required fields
// ---------------------------------------------------------------------------
test('routing-outcome-schema-fix: routing_outcome shadow has r >= 7 required fields', () => {
  const shadow = loadShadow(PKG_ROOT);
  assert.ok(shadow !== null, 'schema shadow must be loadable');

  const entry = shadow['routing_outcome'];
  assert.ok(entry, 'routing_outcome must exist in shadow');
  assert.ok(typeof entry.r === 'number', 'routing_outcome shadow must have numeric r field');
  assert.ok(
    entry.r >= 7,
    `routing_outcome shadow r=${entry.r} must be >= 7 (version + timestamp + orchestration_id + agent_type + tool_name + description + source)`
  );
});
