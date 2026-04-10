#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/lib/paths.js Stage 2 extensions.
 *
 * Per v2011c-stage2-plan.md §9 (URI parsing lives in lib/paths.js) and §13.
 *
 * Contract under test — new Stage 2 exports:
 *   parseResourceUri(uri) -> { scheme, segments: string[] }
 *   assertSafeSegment(segment) -> void (throws on unsafe)
 *   resolvePatternFile(slug) -> absolute path (throws on miss/traversal)
 *   resolveHistoryArchive(orchId) -> absolute path
 *   resolveHistoryTaskFile(orchId, taskId) -> absolute path
 *   resolveKbFile(section, slug) -> absolute path
 *   getPatternsDir() / getHistoryDir() / getKbDir()
 *
 * Errors must carry `code` property: 'PATH_TRAVERSAL' or 'RESOURCE_NOT_FOUND'.
 *
 * Path resolvers walk up from process.cwd() to find the project root
 * (same convention as Stage 1 paths.js), so tests set process.cwd to a
 * tmpdir that contains a .orchestray/ fixture.
 *
 * Missing archive dir -> RESOURCE_NOT_FOUND (will map to JSON-RPC -32002
 * at the resource-handler layer, per v2011c-stage2-plan.md §9 error
 * code mapping).
 *
 * RED PHASE: new exports do not yet exist; tests must fail at destructure time.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  parseResourceUri,
  assertSafeSegment,
  resolvePatternFile,
  resolveHistoryArchive,
  resolveHistoryTaskFile,
  resolveKbFile,
  getPatternsDir,
  getHistoryDir,
  getKbDir,
} = require('../../../bin/mcp-server/lib/paths.js');

function makeTmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-paths-test-'));
  fs.mkdirSync(path.join(dir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'history'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'facts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'decisions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'kb', 'artifacts'), { recursive: true });
  return dir;
}

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

// ---------------------------------------------------------------------------
// parseResourceUri
// ---------------------------------------------------------------------------

describe('parseResourceUri', () => {

  test('extracts scheme and segments for pattern://', () => {
    const result = parseResourceUri('orchestray:pattern://my-slug');
    assert.equal(result.scheme, 'pattern');
    assert.deepEqual(result.segments, ['my-slug']);
  });

  test('extracts scheme and segments for history:// with nested path', () => {
    const result = parseResourceUri('orchestray:history://orch/orch-1744197600/tasks/T1');
    assert.equal(result.scheme, 'history');
    assert.deepEqual(result.segments, ['orch', 'orch-1744197600', 'tasks', 'T1']);
  });

  test('extracts scheme and segments for kb:// with section and slug', () => {
    const result = parseResourceUri('orchestray:kb://facts/repo-map');
    assert.equal(result.scheme, 'kb');
    assert.deepEqual(result.segments, ['facts', 'repo-map']);
  });

  test('rejects ".." segment with PATH_TRAVERSAL error code', () => {
    assert.throws(
      () => parseResourceUri('orchestray:pattern://..'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects ".." in nested history segment', () => {
    assert.throws(
      () => parseResourceUri('orchestray:history://orch/../escape'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects malformed URI (no scheme prefix)', () => {
    assert.throws(
      () => parseResourceUri('pattern://my-slug'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects malformed URI (totally garbage)', () => {
    assert.throws(
      () => parseResourceUri('not-a-uri-at-all'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects null byte in segment', () => {
    assert.throws(
      () => parseResourceUri('orchestray:pattern://bad\u0000slug'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects segment longer than 200 chars', () => {
    const longSeg = 'a'.repeat(201);
    assert.throws(
      () => parseResourceUri('orchestray:pattern://' + longSeg),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

});

// ---------------------------------------------------------------------------
// assertSafeSegment
// ---------------------------------------------------------------------------

describe('assertSafeSegment', () => {

  test('accepts a normal slug', () => {
    assert.doesNotThrow(() => assertSafeSegment('my-pattern-slug'));
  });

  test('accepts an alphanumeric id', () => {
    assert.doesNotThrow(() => assertSafeSegment('orch-1744197600'));
  });

  test('rejects empty segment', () => {
    assert.throws(
      () => assertSafeSegment(''),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects "." segment', () => {
    assert.throws(
      () => assertSafeSegment('.'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects ".." segment', () => {
    assert.throws(
      () => assertSafeSegment('..'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects "..." segment (dots-only)', () => {
    assert.throws(
      () => assertSafeSegment('...'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects forward slash in segment', () => {
    assert.throws(
      () => assertSafeSegment('a/b'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects backslash in segment', () => {
    assert.throws(
      () => assertSafeSegment('a\\b'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects null byte in segment', () => {
    assert.throws(
      () => assertSafeSegment('a\u0000b'),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

  test('rejects segment longer than 200 chars', () => {
    assert.throws(
      () => assertSafeSegment('a'.repeat(201)),
      (err) => err.code === 'PATH_TRAVERSAL'
    );
  });

});

// ---------------------------------------------------------------------------
// resolvePatternFile
// ---------------------------------------------------------------------------

describe('resolvePatternFile', () => {

  test('returns absolute path for valid slug with existing file', () => {
    const tmp = makeTmpProject();
    try {
      const slug = 'valid-pattern';
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'patterns', slug + '.md'),
        '---\nname: valid-pattern\n---\n\n# Body\n'
      );
      const resolved = withCwd(tmp, () => resolvePatternFile(slug));
      assert.ok(path.isAbsolute(resolved));
      assert.ok(resolved.endsWith(slug + '.md'));
      assert.ok(fs.existsSync(resolved));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws RESOURCE_NOT_FOUND for missing file', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolvePatternFile('nonexistent-slug'),
          (err) => err.code === 'RESOURCE_NOT_FOUND'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws PATH_TRAVERSAL for ".." slug', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolvePatternFile('..'),
          (err) => err.code === 'PATH_TRAVERSAL'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws PATH_TRAVERSAL for slug containing "/"', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolvePatternFile('evil/../etc/passwd'),
          (err) => err.code === 'PATH_TRAVERSAL'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('resolved path stays under patterns root', () => {
    const tmp = makeTmpProject();
    try {
      const slug = 'belt-and-braces';
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'patterns', slug + '.md'),
        ''
      );
      const resolved = withCwd(tmp, () => resolvePatternFile(slug));
      const patternsRoot = path.join(tmp, '.orchestray', 'patterns');
      assert.ok(path.resolve(resolved).startsWith(path.resolve(patternsRoot)),
        'resolved path must be under patterns root');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// resolveHistoryArchive
// ---------------------------------------------------------------------------

describe('resolveHistoryArchive', () => {

  test('returns absolute path for existing archive dir', () => {
    const tmp = makeTmpProject();
    try {
      const orchId = 'orch-1744197600';
      fs.mkdirSync(path.join(tmp, '.orchestray', 'history', orchId), { recursive: true });
      const resolved = withCwd(tmp, () => resolveHistoryArchive(orchId));
      assert.ok(path.isAbsolute(resolved));
      assert.ok(resolved.endsWith(orchId));
      assert.ok(fs.existsSync(resolved));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws RESOURCE_NOT_FOUND for missing archive dir', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolveHistoryArchive('orch-does-not-exist'),
          (err) => err.code === 'RESOURCE_NOT_FOUND'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws PATH_TRAVERSAL for ".." orchId', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolveHistoryArchive('..'),
          (err) => err.code === 'PATH_TRAVERSAL'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// resolveHistoryTaskFile
// ---------------------------------------------------------------------------

describe('resolveHistoryTaskFile', () => {

  test('returns absolute path for existing task file', () => {
    const tmp = makeTmpProject();
    try {
      const orchId = 'orch-1';
      const taskId = 'T1';
      fs.mkdirSync(path.join(tmp, '.orchestray', 'history', orchId, 'tasks'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'history', orchId, 'tasks', taskId + '.md'),
        '# Task\n'
      );
      const resolved = withCwd(tmp, () => resolveHistoryTaskFile(orchId, taskId));
      assert.ok(path.isAbsolute(resolved));
      assert.ok(resolved.endsWith(taskId + '.md'));
      assert.ok(fs.existsSync(resolved));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws RESOURCE_NOT_FOUND when archive is missing', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolveHistoryTaskFile('orch-missing', 'T1'),
          (err) => err.code === 'RESOURCE_NOT_FOUND'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws RESOURCE_NOT_FOUND when task file is missing but archive exists', () => {
    const tmp = makeTmpProject();
    try {
      fs.mkdirSync(path.join(tmp, '.orchestray', 'history', 'orch-1'), { recursive: true });
      withCwd(tmp, () => {
        assert.throws(
          () => resolveHistoryTaskFile('orch-1', 'T-missing'),
          (err) => err.code === 'RESOURCE_NOT_FOUND'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// resolveKbFile
// ---------------------------------------------------------------------------

describe('resolveKbFile', () => {

  test('returns path for valid facts/<slug>', () => {
    const tmp = makeTmpProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'kb', 'facts', 'repo-map.md'),
        '# Repo map\n'
      );
      const resolved = withCwd(tmp, () => resolveKbFile('facts', 'repo-map'));
      assert.ok(path.isAbsolute(resolved));
      assert.ok(resolved.endsWith('repo-map.md'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns path for valid decisions/<slug>', () => {
    const tmp = makeTmpProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'kb', 'decisions', 'some-decision.md'),
        '# Decision\n'
      );
      const resolved = withCwd(tmp, () => resolveKbFile('decisions', 'some-decision'));
      assert.ok(resolved.endsWith('some-decision.md'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns path for valid artifacts/<slug>', () => {
    const tmp = makeTmpProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'kb', 'artifacts', 'some-artifact.md'),
        '# Artifact\n'
      );
      const resolved = withCwd(tmp, () => resolveKbFile('artifacts', 'some-artifact'));
      assert.ok(resolved.endsWith('some-artifact.md'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects unknown section', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolveKbFile('rumors', 'some-slug'),
          (err) => err.code === 'RESOURCE_NOT_FOUND'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws PATH_TRAVERSAL for ".." slug', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolveKbFile('facts', '..'),
          (err) => err.code === 'PATH_TRAVERSAL'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('throws RESOURCE_NOT_FOUND for missing file', () => {
    const tmp = makeTmpProject();
    try {
      withCwd(tmp, () => {
        assert.throws(
          () => resolveKbFile('facts', 'not-here'),
          (err) => err.code === 'RESOURCE_NOT_FOUND'
        );
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Directory getters
// ---------------------------------------------------------------------------

describe('getPatternsDir / getHistoryDir / getKbDir', () => {

  test('getPatternsDir returns <project>/.orchestray/patterns', () => {
    const tmp = makeTmpProject();
    try {
      const dir = withCwd(tmp, () => getPatternsDir());
      assert.ok(path.isAbsolute(dir));
      assert.equal(
        path.resolve(dir),
        path.resolve(path.join(tmp, '.orchestray', 'patterns'))
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('getHistoryDir returns <project>/.orchestray/history', () => {
    const tmp = makeTmpProject();
    try {
      const dir = withCwd(tmp, () => getHistoryDir());
      assert.equal(
        path.resolve(dir),
        path.resolve(path.join(tmp, '.orchestray', 'history'))
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('getKbDir returns <project>/.orchestray/kb', () => {
    const tmp = makeTmpProject();
    try {
      const dir = withCwd(tmp, () => getKbDir());
      assert.equal(
        path.resolve(dir),
        path.resolve(path.join(tmp, '.orchestray', 'kb'))
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
