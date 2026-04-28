#!/usr/bin/env node
'use strict';

/**
 * context-pin.test.js — Item 8 (v2.2.8) --context <file> pin injection.
 *
 * Tests:
 *   T1. loadOrchestrationPins: returns null when pins file absent.
 *   T2. loadOrchestrationPins: returns null for unknown orchestration_id.
 *   T3. loadOrchestrationPins: returns pin entry for known orchestration_id.
 *   T4. buildPinnedFilesBlock: returns '' when no pins configured.
 *   T5. buildPinnedFilesBlock: returns annotated block with [pinned: <path>] header.
 *   T6. buildPinnedFilesBlock: emits context_pin_applied audit event.
 *   T7. buildPinnedFilesBlock: warns on missing file but does not throw.
 *   T8. buildPinnedFilesBlock: soft_cap_exceeded=true when total_bytes > 8192.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const {
  loadOrchestrationPins,
  buildPinnedFilesBlock,
} = require(path.join(REPO_ROOT, 'bin', 'compose-block-a'));

// ---------------------------------------------------------------------------
// Test repo factory
// ---------------------------------------------------------------------------

function makeRepo(opts) {
  opts = opts || {};
  const dir   = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-pin-'));
  const state = path.join(dir, '.orchestray', 'state');
  const audit = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(audit, { recursive: true });

  fs.writeFileSync(
    path.join(audit, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: opts.orchId || 'orch-pin-001' })
  );
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'config.json'),
    JSON.stringify({ block_a_zone_caching: { enabled: true } })
  );

  if (opts.pinsData) {
    fs.writeFileSync(
      path.join(state, 'orchestration-pins.json'),
      JSON.stringify(opts.pinsData)
    );
  }

  return { dir, state, audit };
}

function readEvents(audit) {
  const eventsPath = path.join(audit, 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

describe('Context-pin injection (Item 8, v2.2.8)', () => {

  test('T1: loadOrchestrationPins returns null when pins file absent', () => {
    const { state } = makeRepo({});
    const result = loadOrchestrationPins(state, 'orch-x');
    assert.strictEqual(result, null);
  });

  test('T2: loadOrchestrationPins returns null for unknown orchestration_id', () => {
    const { state } = makeRepo({
      pinsData: { 'orch-other': { pinned_files: ['/tmp/foo.md'], total_bytes: 10, soft_cap_warned: false } },
    });
    const result = loadOrchestrationPins(state, 'orch-x');
    assert.strictEqual(result, null);
  });

  test('T3: loadOrchestrationPins returns entry for known orchestration_id', () => {
    const { state } = makeRepo({
      pinsData: { 'orch-pin-001': { pinned_files: ['/tmp/foo.md'], total_bytes: 42, soft_cap_warned: false } },
    });
    const result = loadOrchestrationPins(state, 'orch-pin-001');
    assert.ok(result, 'should return the pin entry');
    assert.deepStrictEqual(result.pinned_files, ['/tmp/foo.md']);
  });

  test('T4: buildPinnedFilesBlock returns empty string when no pins configured', () => {
    const { dir } = makeRepo({ orchId: 'orch-nopins' });
    const result = buildPinnedFilesBlock(dir, 'orch-nopins', {});
    assert.strictEqual(result, '');
  });

  test('T5: buildPinnedFilesBlock returns annotated block with [pinned: <path>] header', () => {
    // Create a real temp file to pin
    const tmpFile = path.join(os.tmpdir(), 'pin-test-' + Date.now() + '.md');
    fs.writeFileSync(tmpFile, '# Pinned file content\n\nHello world.\n');

    const { dir } = makeRepo({
      orchId: 'orch-pin-t5',
      pinsData: {
        'orch-pin-t5': {
          pinned_files: [tmpFile],
          total_bytes:  fs.statSync(tmpFile).size,
          soft_cap_warned: false,
        },
      },
    });

    try {
      const result = buildPinnedFilesBlock(dir, 'orch-pin-t5', {});
      assert.ok(result.length > 0, 'should return non-empty block');
      assert.ok(result.includes('[pinned: ' + tmpFile + ']'), 'should include [pinned: <path>] annotation');
      assert.ok(result.includes('# Pinned file content'), 'should include file content');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_e) {}
    }
  });

  test('T6: buildPinnedFilesBlock emits context_pin_applied audit event', () => {
    const tmpFile = path.join(os.tmpdir(), 'pin-test-ev-' + Date.now() + '.md');
    fs.writeFileSync(tmpFile, 'event test content\n');

    const { dir, audit } = makeRepo({
      orchId: 'orch-pin-t6',
      pinsData: {
        'orch-pin-t6': {
          pinned_files: [tmpFile],
          total_bytes:  fs.statSync(tmpFile).size,
          soft_cap_warned: false,
        },
      },
    });

    try {
      buildPinnedFilesBlock(dir, 'orch-pin-t6', {});
      const events = readEvents(audit);
      const ev = events.find(e => e.type === 'context_pin_applied');
      assert.ok(ev, 'context_pin_applied event should be emitted');
      assert.ok(Array.isArray(ev.pinned_files));
      assert.ok(ev.pinned_files.includes(tmpFile));
      assert.strictEqual(typeof ev.total_bytes, 'number');
      assert.strictEqual(ev.soft_cap_exceeded, false);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_e) {}
    }
  });

  test('T7: buildPinnedFilesBlock warns on missing file but does not throw', () => {
    const missingPath = path.join(os.tmpdir(), 'does-not-exist-' + Date.now() + '.md');
    const { dir } = makeRepo({
      orchId: 'orch-pin-t7',
      pinsData: {
        'orch-pin-t7': {
          pinned_files: [missingPath],
          total_bytes:  0,
          soft_cap_warned: false,
        },
      },
    });

    let result;
    assert.doesNotThrow(() => {
      result = buildPinnedFilesBlock(dir, 'orch-pin-t7', {});
    });
    assert.strictEqual(result, '', 'should return empty string when all pins are missing');
  });

  test('T8: soft_cap_exceeded=true when total_bytes > 8192', () => {
    // Create a file larger than 8 KB
    const bigContent = 'x'.repeat(9000);
    const tmpFile = path.join(os.tmpdir(), 'pin-big-' + Date.now() + '.md');
    fs.writeFileSync(tmpFile, bigContent);

    const { dir, audit } = makeRepo({
      orchId: 'orch-pin-t8',
      pinsData: {
        'orch-pin-t8': {
          pinned_files: [tmpFile],
          total_bytes:  bigContent.length,
          soft_cap_warned: false,
        },
      },
    });

    try {
      buildPinnedFilesBlock(dir, 'orch-pin-t8', {});
      const events = readEvents(audit);
      const ev = events.find(e => e.type === 'context_pin_applied');
      assert.ok(ev, 'context_pin_applied should fire even over soft cap');
      assert.strictEqual(ev.soft_cap_exceeded, true, 'soft_cap_exceeded should be true');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_e) {}
    }
  });

});
