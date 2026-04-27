#!/usr/bin/env node
'use strict';

/**
 * P1.3 schema_get MCP verb (v2.2.0).
 *
 * Asserts that schemaGet.handle:
 *   - returns {found:true, event_type, chunk, line_range} on a known slug
 *   - chunk content begins with `### \`<slug>\` event` and ends before next ### header
 *   - returns {found:false, error:'event_type_unknown'} on an unknown slug
 *   - rejects malformed event_type input
 *   - emits a `schema_get_call` audit event AND a `tier2_index_lookup` event
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { buildIndex } = require(path.join(REPO_ROOT, 'bin', '_lib', 'tier2-index.js'));
const schemaGet = require(path.join(REPO_ROOT, 'bin', 'mcp-server', 'tools', 'schema_get.js'));

const SCHEMAS_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const SHADOW_PATH  = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');

function makeTmpClone() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p13-schema-get-'));
  fs.mkdirSync(path.join(dir, 'agents', 'pm-reference'), { recursive: true });
  fs.copyFileSync(SCHEMAS_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.md'));
  // Copy shadow JSON so audit-event-writer's validator finds the canonical
  // event-type list. Without this, schema_get_call is treated as unknown
  // and gets the schema_shadow_validation_block surrogate.
  if (fs.existsSync(SHADOW_PATH)) {
    fs.copyFileSync(SHADOW_PATH, path.join(dir, 'agents', 'pm-reference', 'event-schemas.shadow.json'));
  }
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  buildIndex({ cwd: dir });
  return dir;
}

function readEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch (_e) { return null; }
  }).filter(Boolean);
}

describe('P1.3 schema_get MCP verb', () => {
  test('hit: schemaGet.handle({event_type: tier2_load}) returns chunk + line_range', async () => {
    const cwd = makeTmpClone();
    // Audit writer reads orchestration_id from process.cwd path. Set cwd-aware paths
    // by overriding process.cwd to the tmp root for this call.
    const origCwd = process.cwd();
    process.chdir(cwd);
    let r;
    try {
      r = await schemaGet.handle({ event_type: 'tier2_load' }, { projectRoot: cwd });
    } finally {
      process.chdir(origCwd);
    }
    assert.ok(r && r.content && r.content[0] && r.content[0].text,
      'tool result must be in MCP content envelope');
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.found, true);
    assert.equal(payload.event_type, 'tier2_load');
    assert.ok(payload.chunk.includes('### `tier2_load` event'),
      'chunk must contain the section heading');
    assert.ok(Array.isArray(payload.line_range) && payload.line_range.length === 2);
    assert.equal(payload.source, 'mcp_schema_get');
  });

  test('miss: unknown slug returns {found:false, error:event_type_unknown}', async () => {
    const cwd = makeTmpClone();
    const origCwd = process.cwd();
    process.chdir(cwd);
    let r;
    try {
      r = await schemaGet.handle({ event_type: 'definitely_not_a_real_slug' }, { projectRoot: cwd });
    } finally {
      process.chdir(origCwd);
    }
    const payload = JSON.parse(r.content[0].text);
    assert.equal(payload.found, false);
    assert.equal(payload.error, 'event_type_unknown');
    assert.equal(payload.event_type, 'definitely_not_a_real_slug');
  });

  test('input validation: rejects bad case + bad chars', async () => {
    const cwd = makeTmpClone();
    const r1 = await schemaGet.handle({ event_type: 'BadCase' }, { projectRoot: cwd });
    // either toolError envelope or rejection — both are acceptable; we assert
    // that the response is NOT a found:true success.
    const text1 = r1 && r1.content && r1.content[0] && r1.content[0].text;
    assert.ok(text1, 'tool must always return a content envelope');
    let parsed1;
    try { parsed1 = JSON.parse(text1); } catch (_e) { parsed1 = null; }
    if (parsed1) {
      assert.notEqual(parsed1.found, true, 'BadCase must not produce a hit');
    } else {
      // toolError path returns a plain string error message — that's fine
      assert.ok(/event_type|pattern/i.test(text1));
    }

    const r2 = await schemaGet.handle({ event_type: '../../etc/passwd' }, { projectRoot: cwd });
    const text2 = r2 && r2.content && r2.content[0] && r2.content[0].text;
    let parsed2;
    try { parsed2 = JSON.parse(text2); } catch (_e) { parsed2 = null; }
    if (parsed2) {
      assert.notEqual(parsed2.found, true);
    }
  });

  test('audit emission: schema_get_call and tier2_index_lookup events are written', async () => {
    const cwd = makeTmpClone();
    const origCwd = process.cwd();
    process.chdir(cwd);
    try {
      await schemaGet.handle({ event_type: 'tier2_load' }, { projectRoot: cwd });
    } finally {
      process.chdir(origCwd);
    }
    const events = readEvents(cwd);
    const types = events.map(e => e && e.type);
    assert.ok(types.includes('schema_get_call'),
      'audit must contain schema_get_call event; found: ' + JSON.stringify(types));
    assert.ok(types.includes('tier2_index_lookup'),
      'audit must contain tier2_index_lookup event; found: ' + JSON.stringify(types));
    const lookup = events.find(e => e.type === 'tier2_index_lookup');
    assert.equal(lookup.found, true);
    assert.equal(lookup.event_type, 'tier2_load');
    assert.equal(lookup.source, 'mcp_schema_get');
    assert.ok(lookup.full_file_bytes_avoided > 0);
  });

  test('chunk is bounded — does NOT contain the next section header', async () => {
    const cwd = makeTmpClone();
    const origCwd = process.cwd();
    process.chdir(cwd);
    let payload;
    try {
      const r = await schemaGet.handle({ event_type: 'tier2_load' }, { projectRoot: cwd });
      payload = JSON.parse(r.content[0].text);
    } finally {
      process.chdir(origCwd);
    }
    // The chunk should start with the heading and NOT contain a subsequent
    // `### `<other slug>` event` header — that is the boundary check that
    // proves we sliced rather than read the full file.
    const headingMatches = (payload.chunk.match(/^### `[a-z][a-z0-9_.-]*` event/mg) || []);
    assert.equal(headingMatches.length, 1,
      'chunk must contain exactly one ### header (the slug we requested)');
  });
});
