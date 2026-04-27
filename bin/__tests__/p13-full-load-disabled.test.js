#!/usr/bin/env node
'use strict';

/**
 * P1.3 D-8 enforcement: event_schemas.full_load_disabled (v2.2.0).
 *
 * Asserts the day-1 D-8 contract:
 *   - getChunk('unknown_event_type') returns {found:false, error:'event_type_unknown'}
 *     and never reads the full source file.
 *   - The mechanical guarantee: getChunk does NOT read more than the [start,end]
 *     line range from the source on a hit, and does NOT read the source AT ALL
 *     on a miss.
 *   - The kill switch (full_load_disabled === false) does NOT cause getChunk
 *     to fall back to a full Read — getChunk is always chunked. The flag
 *     governs the dispatch table behaviour, not the verb.
 *   - Telemetry: a tier2_index_lookup event with found:false is emitted by
 *     schema_get on a miss.
 *   - emit-tier2-load.js emits event_schemas_full_load_blocked when a Read
 *     hits event-schemas.md while full_load_disabled is true.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { buildIndex, getChunk } = require(path.join(REPO_ROOT, 'bin', '_lib', 'tier2-index.js'));
const SCHEMAS_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const EMIT_BIN     = path.join(REPO_ROOT, 'bin', 'emit-tier2-load.js');

function makeTmpClone(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-d8-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.copyFileSync(SCHEMAS_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  buildIndex({ cwd: dir });
  // Optionally write a config with full_load_disabled.
  if (opts && typeof opts.full_load_disabled === 'boolean') {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ event_schemas: { full_load_disabled: opts.full_load_disabled } }),
    );
  }
  return dir;
}

function readEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

describe('P1.3 D-8 enforcement: full_load_disabled', () => {
  test('miss returns {found:false, error:event_type_unknown} and never reads the full source', () => {
    const cwd = makeTmpClone({ full_load_disabled: true });

    // Spy on fs.readFileSync — count reads on the source path during the miss.
    const origRead = fs.readFileSync;
    const sourcePath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md');
    let sourceReadCount = 0;
    fs.readFileSync = function(p, ...rest) {
      if (typeof p === 'string' && path.resolve(p) === sourcePath) {
        sourceReadCount++;
      }
      return origRead.call(this, p, ...rest);
    };
    let r;
    try {
      r = getChunk('totally_made_up_slug', { cwd });
    } finally {
      fs.readFileSync = origRead;
    }
    assert.equal(r.found, false);
    assert.equal(r.error, 'event_type_unknown');
    assert.equal(sourceReadCount, 0,
      'D-8: miss must not read the full source file at all. observed reads=' + sourceReadCount);
  });

  test('hit reads the source ONCE (for the slice) — not as a full-file load pattern', () => {
    const cwd = makeTmpClone({ full_load_disabled: true });
    const r = getChunk('tier2_load', { cwd });
    assert.equal(r.found, true);
    // The chunk byte length must be substantially smaller than the source
    // byte length — otherwise we have effectively done a full load.
    const srcBytes = fs.statSync(path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md')).size;
    const chunkBytes = Buffer.byteLength(r.chunk, 'utf8');
    assert.ok(chunkBytes < srcBytes / 4,
      'chunk byte length must be << source bytes (chunk=' + chunkBytes + ', src=' + srcBytes + ')');
  });

  test('full_load_disabled:false does NOT make getChunk fall back to full Read', () => {
    // The flag governs the PM dispatch-table behaviour, not getChunk itself.
    // getChunk always returns chunked output regardless of the flag.
    const cwd = makeTmpClone({ full_load_disabled: false });
    const r = getChunk('definitely_unknown_slug', { cwd });
    assert.equal(r.found, false,
      'getChunk must still return found:false on miss even when full_load_disabled is false');
    assert.equal(r.error, 'event_type_unknown');
  });

  test('telemetry: schema_get verb emits tier2_index_lookup with found:false on miss', async () => {
    const cwd = makeTmpClone({ full_load_disabled: true });
    const schemaGet = require(path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools', 'schema_get.js'));
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      await schemaGet.handle({ event_type: 'totally_unknown_slug' }, { projectRoot: cwd });
    } finally {
      process.chdir(origCwd);
    }
    const events = readEvents(cwd);
    const lookup = events.find(e => e.type === 'tier2_index_lookup');
    assert.ok(lookup, 'tier2_index_lookup event must be emitted on miss');
    assert.equal(lookup.found, false);
    assert.equal(lookup.event_type, 'totally_unknown_slug');
  });

  test('emit-tier2-load.js emits event_schemas_full_load_blocked when full_load_disabled', () => {
    const cwd = makeTmpClone({ full_load_disabled: true });
    const filePath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md');
    const r = spawnSync('node', [EMIT_BIN], {
      input: JSON.stringify({
        cwd,
        tool_name: 'Read',
        tool_input: { file_path: filePath },
        agent_type: 'pm',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 0, 'emit-tier2-load.js must exit 0 (fail-open). stderr=' + r.stderr);
    const events = readEvents(cwd);
    const blocked = events.find(e => e.type === 'event_schemas_full_load_blocked');
    assert.ok(blocked, 'must emit event_schemas_full_load_blocked when full_load_disabled is true');
    assert.equal(blocked.agent_role, 'pm');
  });

  test('emit-tier2-load.js does NOT emit event_schemas_full_load_blocked when flag is false', () => {
    const cwd = makeTmpClone({ full_load_disabled: false });
    const filePath = path.join(cwd, 'agents', 'pm-reference', 'event-schemas.md');
    const r = spawnSync('node', [EMIT_BIN], {
      input: JSON.stringify({
        cwd,
        tool_name: 'Read',
        tool_input: { file_path: filePath },
        agent_type: 'pm',
      }),
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(r.status, 0);
    const events = readEvents(cwd);
    const blocked = events.find(e => e.type === 'event_schemas_full_load_blocked');
    assert.equal(blocked, undefined,
      'must NOT emit event_schemas_full_load_blocked when full_load_disabled is false');
  });
});
