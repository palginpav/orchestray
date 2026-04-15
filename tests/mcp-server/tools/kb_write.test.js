#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/mcp-server/tools/kb_write.js
 *
 * Per v2015-architect-mcp-design.md §W6 and DEV-4-kb-write.md §Test coverage.
 *
 * Coverage:
 *   A — happy path: write artifact + index entry atomically
 *   B — overwrite=true: replace existing file and update index entry
 *   C — id collision rejected when overwrite=false
 *   D — file exists rejected when overwrite=false
 *   E — path traversal attempt rejected
 *   F — index.json corruption returns isError:true (not crash)
 *   G — concurrent writes: both succeed sequentially, no interleaving
 *   H — bucket enum rejects unknown values
 *   I — absolute path rejected
 *   J — missing required field rejected
 *   K — definition shape (for integration wiring check)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle, definition } = require('../../../bin/mcp-server/tools/kb_write.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-kb-write-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  return dir;
}

function makeContext(tmp) {
  return { projectRoot: tmp, config: {}, logger: () => {} };
}

function readIndex(tmp) {
  const p = path.join(tmp, '.orchestray', 'kb', 'index.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function baseInput(overrides = {}) {
  return {
    id: 'test-artifact-1',
    bucket: 'artifacts',
    path: '.orchestray/kb/artifacts/test-artifact-1.md',
    author: 'test-agent',
    topic: 'test-topic',
    content: '# Test\n\nContent here.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// A. Happy path
// ---------------------------------------------------------------------------

describe('A. happy path', () => {

  test('creates artifact file and index entry', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(baseInput(), ctx);

      assert.equal(result.isError, false, 'should not be an error');
      const sc = result.structuredContent;
      assert.equal(sc.id, 'test-artifact-1');
      assert.equal(sc.bucket, 'artifacts');
      assert.ok(sc.bytes_written > 0, 'bytes_written should be > 0');
      assert.ok(typeof sc.index_entry_total === 'number');
      assert.deepEqual(sc.warnings, []);

      // Verify file on disk.
      const filePath = path.join(tmp, '.orchestray', 'kb', 'artifacts', 'test-artifact-1.md');
      assert.ok(fs.existsSync(filePath), 'artifact file should exist on disk');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.equal(content, '# Test\n\nContent here.');

      // Verify index.json updated.
      const index = readIndex(tmp);
      assert.ok(Array.isArray(index.artifacts), 'index.artifacts must be an array');
      const entry = index.artifacts.find((e) => e.id === 'test-artifact-1');
      assert.ok(entry, 'index entry must exist');
      assert.equal(entry.author, 'test-agent');
      assert.equal(entry.topic, 'test-topic');
      assert.ok(entry.path.includes('test-artifact-1.md'), 'path must point to the artifact');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('accepts bare filename (no bucket prefix)', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(
        baseInput({ id: 'bare-file', path: 'bare-file.md' }),
        ctx
      );
      assert.equal(result.isError, false);
      const filePath = path.join(tmp, '.orchestray', 'kb', 'artifacts', 'bare-file.md');
      assert.ok(fs.existsSync(filePath));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stores optional task and orchestration_id in index entry', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(
        baseInput({ id: 'with-meta', path: 'with-meta.md', task: 'DEV-4', orchestration_id: 'orch-123' }),
        ctx
      );
      assert.equal(result.isError, false);
      const index = readIndex(tmp);
      const entry = index.artifacts.find((e) => e.id === 'with-meta');
      assert.ok(entry);
      assert.equal(entry.task, 'DEV-4');
      assert.equal(entry.orchestration_id, 'orch-123');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('appends to existing index (preserves prior entries)', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      // Write a seed index with an existing artifact entry.
      const seedIndex = {
        version: '1.0',
        created_at: '2026-01-01T00:00:00Z',
        entries: [],
        artifacts: [{ id: 'prior-entry', path: '.orchestray/kb/artifacts/prior.md', author: 'pm', topic: 'old' }],
      };
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'kb', 'index.json'),
        JSON.stringify(seedIndex, null, 2) + '\n'
      );

      const result = await handle(baseInput({ id: 'new-entry', path: 'new-entry.md' }), ctx);
      assert.equal(result.isError, false);

      const index = readIndex(tmp);
      assert.ok(index.artifacts.find((e) => e.id === 'prior-entry'), 'prior entry preserved');
      assert.ok(index.artifacts.find((e) => e.id === 'new-entry'), 'new entry appended');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// B. Overwrite=true
// ---------------------------------------------------------------------------

describe('B. overwrite=true', () => {

  test('overwrites existing file and replaces index entry', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      // First write.
      const r1 = await handle(baseInput({ content: 'original' }), ctx);
      assert.equal(r1.isError, false);

      // Overwrite.
      const r2 = await handle(baseInput({ content: 'updated', overwrite: true }), ctx);
      assert.equal(r2.isError, false, r2.content && r2.content[0] && r2.content[0].text);

      // File should have updated content.
      const filePath = path.join(tmp, '.orchestray', 'kb', 'artifacts', 'test-artifact-1.md');
      const content = fs.readFileSync(filePath, 'utf8');
      assert.equal(content, 'updated');

      // Index should have exactly one entry with the same id.
      const index = readIndex(tmp);
      const entries = index.artifacts.filter((e) => e.id === 'test-artifact-1');
      assert.equal(entries.length, 1, 'must not duplicate index entry');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// C. ID collision rejected when overwrite=false
// ---------------------------------------------------------------------------

describe('C. id collision rejection', () => {

  test('rejects second write with same id and overwrite=false', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      // Seed an index entry with a conflicting id but a different path.
      const seedIndex = {
        version: '1.0',
        created_at: '2026-01-01T00:00:00Z',
        entries: [],
        artifacts: [{ id: 'test-artifact-1', path: '.orchestray/kb/artifacts/other.md', author: 'pm', topic: 'x' }],
      };
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'kb', 'index.json'),
        JSON.stringify(seedIndex, null, 2) + '\n'
      );

      const result = await handle(baseInput({ overwrite: false }), ctx);
      assert.equal(result.isError, true, 'should error on id collision');
      assert.ok(
        result.content[0].text.includes('test-artifact-1'),
        'error message should name the conflicting id'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// D. File exists rejected when overwrite=false
// ---------------------------------------------------------------------------

describe('D. file-exists rejection', () => {

  test('rejects when file already exists and overwrite=false', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      // Pre-create the artifact file.
      const filePath = path.join(tmp, '.orchestray', 'kb', 'artifacts', 'test-artifact-1.md');
      fs.writeFileSync(filePath, 'pre-existing content');

      const result = await handle(baseInput(), ctx);
      assert.equal(result.isError, true, 'should error when file exists and overwrite=false');
      assert.ok(
        result.content[0].text.includes('already exists'),
        'error should mention file already exists'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// E. Path traversal rejection
// ---------------------------------------------------------------------------

describe('E. path traversal rejection', () => {

  test('rejects path with .. segment', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(
        baseInput({ path: '../../../etc/passwd' }),
        ctx
      );
      assert.equal(result.isError, true, 'must reject path traversal');
      assert.ok(
        result.content[0].text.toLowerCase().includes('path') ||
        result.content[0].text.toLowerCase().includes('traversal') ||
        result.content[0].text.toLowerCase().includes('unsafe') ||
        result.content[0].text.toLowerCase().includes('escapes'),
        'error message must reference the path issue'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects absolute path', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(
        baseInput({ path: '/etc/passwd' }),
        ctx
      );
      assert.equal(result.isError, true, 'must reject absolute path');
      assert.ok(
        result.content[0].text.toLowerCase().includes('absolute') ||
        result.content[0].text.toLowerCase().includes('path'),
        'error must mention absolute path'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects path that escapes kb bucket root after resolution', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      // Use a crafted path that resolves outside the bucket even without ".."
      // but where the bucket prefix is correct then traversal happens.
      const result = await handle(
        baseInput({ path: '.orchestray/kb/artifacts/../../../outside.md' }),
        ctx
      );
      assert.equal(result.isError, true, 'must reject traversal via bucket-prefix then ../');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// F. Corrupt index.json
// ---------------------------------------------------------------------------

describe('F. corrupt index.json', () => {

  test('returns isError:true with guidance when index.json is corrupt JSON', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      // Write corrupt JSON.
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'kb', 'index.json'),
        '{ this is not valid json }'
      );

      const result = await handle(baseInput(), ctx);
      assert.equal(result.isError, true, 'should error on corrupt index.json');
      assert.ok(
        result.content[0].text.includes('corrupt') ||
        result.content[0].text.includes('repair') ||
        result.content[0].text.includes('index'),
        'error message should mention corrupt index or repair guidance'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('creates fresh index when index.json does not exist', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      // Ensure no index.json exists.
      const indexPath = path.join(tmp, '.orchestray', 'kb', 'index.json');
      if (fs.existsSync(indexPath)) fs.unlinkSync(indexPath);

      const result = await handle(baseInput(), ctx);
      assert.equal(result.isError, false, 'should succeed even when index.json missing');
      assert.ok(fs.existsSync(indexPath), 'index.json should be created');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// G. Lock contention — two concurrent writes
// ---------------------------------------------------------------------------

describe('G. lock contention', () => {

  test('two concurrent kb_write calls both succeed, index has both entries', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const input1 = baseInput({ id: 'concurrent-1', path: 'concurrent-1.md', content: 'A' });
      const input2 = baseInput({ id: 'concurrent-2', path: 'concurrent-2.md', content: 'B' });

      // Fire both concurrently.
      const [r1, r2] = await Promise.all([
        handle(input1, ctx),
        handle(input2, ctx),
      ]);

      assert.equal(r1.isError, false, 'concurrent write 1 should succeed: ' +
        (r1.content && r1.content[0] && r1.content[0].text));
      assert.equal(r2.isError, false, 'concurrent write 2 should succeed: ' +
        (r2.content && r2.content[0] && r2.content[0].text));

      // Both files on disk.
      assert.ok(fs.existsSync(path.join(tmp, '.orchestray', 'kb', 'artifacts', 'concurrent-1.md')));
      assert.ok(fs.existsSync(path.join(tmp, '.orchestray', 'kb', 'artifacts', 'concurrent-2.md')));

      // Both entries in index.
      const index = readIndex(tmp);
      const ids = index.artifacts.map((e) => e.id);
      assert.ok(ids.includes('concurrent-1'), 'index must contain concurrent-1');
      assert.ok(ids.includes('concurrent-2'), 'index must contain concurrent-2');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// H. Bucket enum rejection
// ---------------------------------------------------------------------------

describe('H. bucket enum rejection', () => {

  test('rejects unknown bucket value', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(
        baseInput({ bucket: 'invalid-bucket' }),
        ctx
      );
      assert.equal(result.isError, true, 'must reject invalid bucket');
      assert.ok(
        result.content[0].text.includes('bucket') ||
        result.content[0].text.includes('invalid-bucket') ||
        result.content[0].text.includes('enum'),
        'error must reference the invalid bucket'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// I. Absolute path rejection (covered in E above, but explicit test)
// ---------------------------------------------------------------------------

describe('I. invalid id rejection', () => {

  test('rejects id starting with a dot', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(
        baseInput({ id: '.bad-id', path: 'good.md' }),
        ctx
      );
      assert.equal(result.isError, true, 'must reject id starting with dot');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects id containing a slash', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const result = await handle(
        baseInput({ id: 'bad/id', path: 'good.md' }),
        ctx
      );
      assert.equal(result.isError, true, 'must reject id containing slash');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// J. Missing required field
// ---------------------------------------------------------------------------

describe('J. missing required field', () => {

  test('rejects input missing content', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const { content: _c, ...noContent } = baseInput();
      const result = await handle(noContent, ctx);
      assert.equal(result.isError, true, 'must error when content is missing');
      assert.ok(
        result.content[0].text.includes('content') || result.content[0].text.includes('required'),
        'error must mention missing field'
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects input missing id', async () => {
    const tmp = makeTmpProject();
    try {
      const ctx = makeContext(tmp);
      const { id: _i, ...noId } = baseInput();
      const result = await handle(noId, ctx);
      assert.equal(result.isError, true, 'must error when id is missing');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// K. Definition shape
// ---------------------------------------------------------------------------

describe('K. definition shape', () => {

  test('definition has correct name and inputSchema', () => {
    assert.equal(definition.name, 'kb_write');
    assert.ok(definition.description && definition.description.length > 10, 'description must be non-trivial');
    assert.ok(definition.inputSchema, 'inputSchema must be present');
    assert.equal(definition.inputSchema.type, 'object');
    assert.ok(Array.isArray(definition.inputSchema.required), 'required must be an array');
    assert.ok(definition.inputSchema.required.includes('id'), 'id must be required');
    assert.ok(definition.inputSchema.required.includes('bucket'), 'bucket must be required');
    assert.ok(definition.inputSchema.required.includes('content'), 'content must be required');
    // Verify bucket enum.
    const bucketSchema = definition.inputSchema.properties && definition.inputSchema.properties.bucket;
    assert.ok(bucketSchema, 'bucket property must be defined');
    assert.deepEqual(bucketSchema.enum, ['artifacts', 'facts', 'decisions']);
  });

});
