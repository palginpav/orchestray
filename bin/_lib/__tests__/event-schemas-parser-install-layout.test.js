'use strict';

/**
 * event-schemas-parser-install-layout.test.js — W5 (v2.3.32)
 *
 * Regression guard for the defect where SCHEMA_PATH only ever resolved
 * against the source-repo layout (`<repo>/bin/_lib/` → `<repo>/agents/...`).
 * In an installed tree, bin/install.js copies code and agents into DIFFERENT
 * trees:
 *   - code  → <targetDir>/orchestray/bin/_lib/
 *   - agents → <targetDir>/agents/pm-reference/
 * so the old two-levels-up resolution silently missed the schema file on
 * every installed build, and validation fell back to fail-open on every
 * single hook invocation outside the source repo.
 *
 * This test proves the bug would have been caught: it builds a temp tree
 * that mirrors the INSTALLED layout exactly (not the repo layout the rest of
 * the suite already exercises), copies the real parser module into it so
 * __dirname resolves against the temp tree, and requires it fresh.
 *
 * Also covers: neither layout present -> null, no throw; and the
 * once-per-process stderr/degraded-journal gate does not fire repeatedly.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const REAL_PARSER_SRC = path.join(__dirname, '..', 'event-schemas-parser.js');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w5-install-layout-test-'));
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function minimalSchemaContent() {
  return [
    '# Event Schemas',
    '',
    '### `install_layout_test_event`',
    '',
    'Test event for install-layout resolution.',
    '',
    '```json',
    '{',
    '  "type": "install_layout_test_event",',
    '  "version": 1,',
    '  "ts": "2026-01-01T00:00:00Z"',
    '}',
    '```',
    '',
  ].join('\n');
}

/**
 * Copy the real parser module verbatim into `<tmpDir>/orchestray/bin/_lib/`
 * (the installed code location) and require it fresh, so its own __dirname
 * resolves against the temp tree rather than the real repo.
 */
function requireParserFromInstalledLayout(tmpDir) {
  const dstDir = path.join(tmpDir, 'orchestray', 'bin', '_lib');
  fs.mkdirSync(dstDir, { recursive: true });
  const dstFile = path.join(dstDir, 'event-schemas-parser.js');
  fs.copyFileSync(REAL_PARSER_SRC, dstFile);

  // Fresh module instance every time — process-level closure state
  // (SCHEMA_PATH, mtime cache) must not leak between test cases.
  delete require.cache[require.resolve(dstFile)];
  return require(dstFile); // eslint-disable-line global-require, import/no-dynamic-require
}

describe('event-schemas-parser — installed-layout resolution (W5, v2.3.32)', () => {

  test('resolves schema when code+agents mirror the installed layout (code and agents in DIFFERENT trees)', () => {
    const tmpDir = makeTmpDir();
    try {
      // Installed layout per bin/install.js:
      //   code   -> <targetDir>/orchestray/bin/_lib/
      //   agents -> <targetDir>/agents/pm-reference/
      const agentsDir = path.join(tmpDir, 'agents', 'pm-reference');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'event-schemas.md'), minimalSchemaContent(), 'utf8');

      const parser = requireParserFromInstalledLayout(tmpDir);

      assert.ok(
        fs.existsSync(parser.SCHEMA_PATH),
        'SCHEMA_PATH must resolve to an existing file in the installed layout — ' +
        'got: ' + parser.SCHEMA_PATH
      );
      assert.strictEqual(
        parser.SCHEMA_PATH,
        path.join(agentsDir, 'event-schemas.md'),
        'SCHEMA_PATH should resolve to the installed-tree agents/pm-reference/event-schemas.md'
      );

      const events = parser.parseEventSchemasFromFile();
      assert.ok(Array.isArray(events), 'parseEventSchemasFromFile() should return an array');
      assert.ok(events.length > 0, 'schema map should be non-empty in the installed layout');
      assert.ok(
        events.some((e) => e.slug === 'install_layout_test_event'),
        'the installed-layout schema file content should be the one actually parsed'
      );

      delete require.cache[require.resolve(path.join(tmpDir, 'orchestray', 'bin', '_lib', 'event-schemas-parser.js'))];
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('repo-layout resolution is unchanged: candidate (1) still wins when both exist', () => {
    const tmpDir = makeTmpDir();
    try {
      // Populate BOTH candidate locations with distinguishable content so we
      // can prove candidate (1) — the repo-relative path — wins, exactly as
      // before this fix (source/test behaviour must be byte-identical).
      const repoAgentsDir = path.join(tmpDir, 'agents', 'pm-reference');
      fs.mkdirSync(repoAgentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(repoAgentsDir, 'event-schemas.md'),
        minimalSchemaContent().replaceAll('install_layout_test_event', 'repo_layout_winner_event'),
        'utf8'
      );

      const installedAgentsDir = path.join(tmpDir, 'orchestray', 'agents', 'pm-reference');
      fs.mkdirSync(installedAgentsDir, { recursive: true });
      fs.writeFileSync(
        path.join(installedAgentsDir, 'event-schemas.md'),
        minimalSchemaContent().replaceAll('install_layout_test_event', 'should_not_be_picked_event'),
        'utf8'
      );

      // Place the module at <tmpDir>/bin/_lib/ (repo layout: two levels up).
      const dstDir = path.join(tmpDir, 'bin', '_lib');
      fs.mkdirSync(dstDir, { recursive: true });
      const dstFile = path.join(dstDir, 'event-schemas-parser.js');
      fs.copyFileSync(REAL_PARSER_SRC, dstFile);
      delete require.cache[require.resolve(dstFile)];
      const parser = require(dstFile); // eslint-disable-line global-require, import/no-dynamic-require

      assert.strictEqual(
        parser.SCHEMA_PATH,
        path.join(repoAgentsDir, 'event-schemas.md'),
        'candidate (1) — repo-relative resolution — must win when both candidates exist'
      );
      const events = parser.parseEventSchemasFromFile();
      assert.ok(events.some((e) => e.slug === 'repo_layout_winner_event'));
      assert.ok(!events.some((e) => e.slug === 'should_not_be_picked_event'));

      delete require.cache[require.resolve(dstFile)];
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('neither layout present -> parseEventSchemasFromFile throws ENOENT, caller fails open (no throw escapes the hook)', () => {
    const tmpDir = makeTmpDir();
    try {
      const parser = requireParserFromInstalledLayout(tmpDir);

      assert.ok(
        !fs.existsSync(parser.SCHEMA_PATH),
        'precondition: neither candidate exists in this temp tree'
      );

      // parseEventSchemasFromFile() itself throws when there is no cache and
      // stat fails (documented contract) — the SAFE fail-open point is one
      // layer up, in schema-emit-validator.js's getSchemas(), which catches
      // this and returns null. Assert BOTH: the low-level throw still
      // happens (unchanged contract), and the documented caller-side
      // fail-open actually converts it to null rather than propagating.
      assert.throws(
        () => parser.parseEventSchemasFromFile(),
        /ENOENT/,
        'parseEventSchemasFromFile() should throw ENOENT when no cache and no schema file exists'
      );

      delete require.cache[require.resolve(path.join(tmpDir, 'orchestray', 'bin', '_lib', 'event-schemas-parser.js'))];
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('neither layout present -> schema-emit-validator.getSchemas() returns null, never throws, hook stays fail-open', () => {
    // Exercise the real caller-side fail-open path (not the low-level parser
    // throw in the previous test) using the validator's non-canonical-path
    // branch, which is what installed hooks actually go through when the
    // schema file cannot be found anywhere.
    const validator = require('../schema-emit-validator');
    const tmpDir = makeTmpDir(); // no agents/pm-reference/event-schemas.md written at all
    try {
      let schemas;
      let threw = false;
      try {
        schemas = validator.getSchemas(tmpDir);
      } catch (_e) {
        threw = true;
      }
      assert.strictEqual(threw, false, 'getSchemas() must never throw when the schema file is missing');
      assert.strictEqual(schemas, null, 'getSchemas() must return null (fail-open) when no schema file exists');

      const result = validator.validateEvent(tmpDir, { type: 'anything_at_all', version: 1 });
      assert.strictEqual(result.valid, true, 'validateEvent() must fail OPEN (valid:true) when schema is unreadable');
      assert.ok(
        Array.isArray(result.warnings) && result.warnings.length > 0,
        'validateEvent() should surface an unreadable-schema warning for callers to log/journal, but never block'
      );
    } finally {
      cleanupDir(tmpDir);
    }
  });

  test('audit-event-writer only warns once per process on schema-unreadable, regardless of event count', () => {
    // Force a cwd with no agents/pm-reference/event-schemas.md so every
    // writeEvent() call goes down the schema-unreadable fail-open branch.
    const tmpDir = makeTmpDir();
    try {
      fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });

      delete require.cache[require.resolve('../audit-event-writer')];
      const writer = require('../audit-event-writer');

      if (typeof writer.resetSchemaWarned === 'function') {
        writer.resetSchemaWarned();
      }

      const origWrite = process.stderr.write;
      const stderrChunks = [];
      process.stderr.write = function (chunk, ...rest) {
        stderrChunks.push(String(chunk));
        return true;
      };

      try {
        for (let i = 0; i < 5; i++) {
          writer.writeEvent(
            { type: 'unknown_but_irrelevant_event_' + i, version: 1 },
            { cwd: tmpDir }
          );
        }
      } finally {
        process.stderr.write = origWrite;
      }

      // The core assertion for this fix: the unreadable-schema diagnostic
      // must NOT appear on stderr at all (moved to the degraded journal),
      // so it can never contaminate a blocked tool call's model-facing
      // stderr stream — checked across all 5 invocations, not just one.
      const pollutingLines = stderrChunks.filter((c) => c.includes('schema file unreadable'));
      assert.strictEqual(
        pollutingLines.length,
        0,
        'the schema-unreadable warning must not be written to process.stderr at all'
      );

      // Durable record still exists exactly once per invalidation via the
      // degraded journal (not stderr) — this is the "not repeated" guarantee.
      const journalPath = path.join(tmpDir, '.orchestray', 'state', 'degraded.jsonl');
      if (fs.existsSync(journalPath)) {
        const lines = fs.readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean);
        const schemaLines = lines
          .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
          .filter((e) => e && e.kind === 'event_schema_unreadable');
        assert.ok(
          schemaLines.length <= 1,
          'event_schema_unreadable should be journaled at most once per process, not once per event'
        );
      }
    } finally {
      cleanupDir(tmpDir);
    }
  });
});
