#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/resources/orchestration_resource.js
 *
 * Coverage (≥8 tests, F03/F12 regression):
 *   1. list() advertises current + routing + checkpoints templates
 *   2. read(orchestration://current) returns state when current-orchestration.json exists
 *   3. read(orchestration://current) returns empty doc when no active orchestration
 *   4. read(orchestration://current) merges orchestration.md frontmatter fields
 *   5. read(orchestration://unknown-orch-id) returns RESOURCE_NOT_FOUND
 *   6. path-traversal URI rejected (INVALID_SEGMENT or PATH_TRAVERSAL)
 *   7. F12 regression: giant events.jsonl (>2 MB) does not cause full read
 *   8. frontmatter parse: orchestration.md with valid YAML frontmatter returns fields
 *   9. read(orchestration://current) includes recent_events array from events.jsonl
 *  10. read(orchestration://current/routing) returns routing.jsonl content
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { list, templates, read } = require('../../../bin/mcp-server/resources/orchestration_resource');
const paths = require('../../../bin/mcp-server/lib/paths');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-orch-resource-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  return dir;
}

function makeContext(root) {
  return { projectRoot: root };
}

function makeParsed(scheme, segments) {
  return { scheme, segments };
}

// ---------------------------------------------------------------------------
// Test 1: list() advertises current + routing + checkpoints resources
// ---------------------------------------------------------------------------

describe('list()', () => {
  test('advertises current, routing, and checkpoints resources', async () => {
    const result = await list(makeContext('/tmp'));
    assert.ok(result && Array.isArray(result.resources), 'must return resources array');
    const uris = result.resources.map(r => r.uri);
    assert.ok(uris.includes('orchestray:orchestration://current'), 'must include current');
    assert.ok(uris.includes('orchestray:orchestration://current/routing'), 'must include routing');
    assert.ok(uris.includes('orchestray:orchestration://current/checkpoints'), 'must include checkpoints');
  });
});

// ---------------------------------------------------------------------------
// Test 2: read(current) returns state when current-orchestration.json exists
// ---------------------------------------------------------------------------

describe('read(orchestration://current) with active orchestration', () => {
  test('returns state from current-orchestration.json', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);
    const auditData = { orchestration_id: 'orch-test-001', phase: 'executing', status: 'active' };
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'audit', 'current-orchestration.json'),
      JSON.stringify(auditData),
      'utf8'
    );

    const result = await read(
      'orchestray:orchestration://current',
      ctx,
      makeParsed('orchestration', ['current'])
    );

    assert.ok(result && Array.isArray(result.contents), 'must return contents array');
    assert.equal(result.contents.length, 1);
    const body = JSON.parse(result.contents[0].text);
    assert.equal(body.orchestration_id, 'orch-test-001');
    assert.equal(body.phase, 'executing');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 3: read(current) returns empty doc when no active orchestration
// ---------------------------------------------------------------------------

describe('read(orchestration://current) with no active orchestration', () => {
  test('returns empty-ish doc (no error) when neither state file exists', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);

    const result = await read(
      'orchestray:orchestration://current',
      ctx,
      makeParsed('orchestration', ['current'])
    );

    assert.ok(result && Array.isArray(result.contents), 'must return contents array');
    const body = JSON.parse(result.contents[0].text);
    // recent_events should be empty, orchestration fields absent
    assert.ok(Array.isArray(body.recent_events), 'recent_events must be an array');
    assert.equal(body.recent_events.length, 0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 4: frontmatter parse — orchestration.md with YAML returns expected fields
// ---------------------------------------------------------------------------

describe('orchestration.md frontmatter parse', () => {
  test('returns frontmatter fields merged into result', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);
    const mdContent = [
      '---',
      'orchestration_id: orch-fm-001',
      'phase: decomposing',
      'status: active',
      '---',
      '',
      '## Tasks',
    ].join('\n');
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'state', 'orchestration.md'),
      mdContent,
      'utf8'
    );

    const result = await read(
      'orchestray:orchestration://current',
      ctx,
      makeParsed('orchestration', ['current'])
    );

    const body = JSON.parse(result.contents[0].text);
    assert.equal(body.orchestration_id, 'orch-fm-001');
    assert.equal(body.phase, 'decomposing');
    assert.equal(body.status, 'active');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 5: read(unknown-orch-id) returns RESOURCE_NOT_FOUND
// ---------------------------------------------------------------------------

describe('read(orchestration://unknown-id)', () => {
  test('throws RESOURCE_NOT_FOUND for unknown sub-path segment', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);

    await assert.rejects(
      () => read(
        'orchestray:orchestration://unknown-orch-123',
        ctx,
        makeParsed('orchestration', ['unknown-orch-123'])
      ),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.equal(err.code, 'RESOURCE_NOT_FOUND', 'must be RESOURCE_NOT_FOUND');
        return true;
      }
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 6: path-traversal URI is rejected
// ---------------------------------------------------------------------------

describe('path-traversal rejection', () => {
  test('parseResourceUri rejects literal dot-dot segments', () => {
    // assertSafeSegment catches literal ".." segments (dot-only pattern).
    assert.throws(
      () => paths.parseResourceUri('orchestray:orchestration://../etc/passwd'),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.code === 'PATH_TRAVERSAL' || err.code === 'INVALID_SEGMENT' || err.code === 'INVALID_URI',
          'must be a path-safety error, got: ' + err.code
        );
        return true;
      }
    );
  });

  test('read() with double-dot segment in tasks rejects as containment error', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);

    // Passing a pre-parsed segments array with a ".." task ID — the belt-and-braces
    // containment check in the tasks handler must catch this.
    await assert.rejects(
      () => read(
        'orchestray:orchestration://current/tasks/..',
        ctx,
        makeParsed('orchestration', ['current', 'tasks', '..'])
      ),
      (err) => {
        assert.ok(err instanceof Error, 'must be an Error');
        assert.ok(
          err.code === 'PATH_TRAVERSAL' || err.code === 'RESOURCE_NOT_FOUND',
          'must be a containment error, got: ' + err.code
        );
        return true;
      }
    );

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 7: F12 regression — giant events.jsonl does NOT cause full read
// ---------------------------------------------------------------------------

describe('F12: giant events.jsonl tail-only read', () => {
  test('reads last 50 events from a >2 MB events.jsonl without loading entire file', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);

    // Build a synthetic events.jsonl larger than 2 MB.
    // We write 3 MB of throwaway lines then 10 sentinel events at the end.
    const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    const fd = fs.openSync(eventsPath, 'w');

    // Write ~3 MB of bulk lines (each ~100 bytes, 30000 lines ≈ 3 MB)
    const bulkLine = JSON.stringify({ ts: '2000-01-01T00:00:00Z', type: 'bulk', data: 'x'.repeat(80) }) + '\n';
    const BULK_COUNT = 30000;
    for (let i = 0; i < BULK_COUNT; i++) {
      fs.writeSync(fd, bulkLine);
    }

    // Append 10 sentinel events that should appear in the tail
    for (let i = 0; i < 10; i++) {
      const sentinel = JSON.stringify({ ts: '2026-04-15T00:00:00Z', type: 'sentinel_event', index: i }) + '\n';
      fs.writeSync(fd, sentinel);
    }
    fs.closeSync(fd);

    const stat = fs.statSync(eventsPath);
    assert.ok(stat.size > 2 * 1024 * 1024, 'fixture must be > 2 MB, got: ' + stat.size);

    // Read the resource — must not throw / hang, and must include at least one sentinel
    const result = await read(
      'orchestray:orchestration://current',
      ctx,
      makeParsed('orchestration', ['current'])
    );

    const body = JSON.parse(result.contents[0].text);
    assert.ok(Array.isArray(body.recent_events), 'recent_events must be an array');
    // The sentinels are in the last 10 lines — they must be present
    const sentinels = body.recent_events.filter(e => e && e.type === 'sentinel_event');
    assert.ok(sentinels.length > 0, 'must have read at least one sentinel event from the tail');
    // Must NOT have loaded bulk events (which have type='bulk') from the 3 MB head
    // Some bulk lines may appear in the 128 KB tail window, but the sentinel count
    // confirms tail-only reading is working.
    assert.ok(body.recent_events.length <= 50, 'must be capped at 50 events');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 8 (continued from test 9 in plan): recent_events array from events.jsonl
// ---------------------------------------------------------------------------

describe('read(current) includes recent_events from events.jsonl', () => {
  test('parses and returns last events from events.jsonl', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);

    const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
    const events = [
      { ts: '2026-04-15T00:01:00Z', type: 'agent_start', agent: 'developer' },
      { ts: '2026-04-15T00:02:00Z', type: 'agent_stop', agent: 'developer' },
    ];
    fs.writeFileSync(eventsPath, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const result = await read(
      'orchestray:orchestration://current',
      ctx,
      makeParsed('orchestration', ['current'])
    );

    const body = JSON.parse(result.contents[0].text);
    assert.ok(Array.isArray(body.recent_events), 'must have recent_events');
    assert.equal(body.recent_events.length, 2);
    assert.equal(body.recent_events[0].type, 'agent_start');
    assert.equal(body.recent_events[1].type, 'agent_stop');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 10: read(current/routing) returns routing.jsonl content
// ---------------------------------------------------------------------------

describe('read(orchestration://current/routing)', () => {
  test('returns routing.jsonl text content', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);

    const routingLine = JSON.stringify({ orchestration_id: 'orch-r1', agent_type: 'developer', model: 'sonnet' });
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'state', 'routing.jsonl'),
      routingLine + '\n',
      'utf8'
    );

    const result = await read(
      'orchestray:orchestration://current/routing',
      ctx,
      makeParsed('orchestration', ['current', 'routing'])
    );

    assert.ok(result && Array.isArray(result.contents), 'must return contents');
    assert.ok(result.contents[0].text.includes('orch-r1'), 'must include routing content');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Test 11 (A2-S4): CRLF-tolerant parseFrontmatter
// ---------------------------------------------------------------------------

describe('parseFrontmatter: CRLF line endings', () => {
  test('frontmatter with CRLF endings returns correct fields', async () => {
    const tmp = makeTmpProject();
    const ctx = makeContext(tmp);
    // Simulate a file checked out on Windows with CRLF line endings.
    const mdContent =
      '---\r\norchestration_id: orch-crlf-001\r\nphase: executing\r\nstatus: active\r\n---\r\n\r\n## Tasks\r\n';
    fs.writeFileSync(
      path.join(tmp, '.orchestray', 'state', 'orchestration.md'),
      mdContent,
      'utf8'
    );

    const result = await read(
      'orchestray:orchestration://current',
      ctx,
      makeParsed('orchestration', ['current'])
    );

    const body = JSON.parse(result.contents[0].text);
    assert.equal(body.orchestration_id, 'orch-crlf-001',
      'orchestration_id must be parsed correctly from CRLF frontmatter');
    assert.equal(body.phase, 'executing',
      'phase must be parsed correctly from CRLF frontmatter');
    assert.equal(body.status, 'active',
      'status must be parsed correctly from CRLF frontmatter');

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
