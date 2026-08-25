#!/usr/bin/env node
'use strict';

/**
 * schema-emit-validator-foreign-cwd.test.js — v2.3.33 W1
 *
 * Regression guard for the defect where schema validation NEVER ran outside
 * the Orchestray repo itself: getSchemas(cwd) built a project-relative path
 * (`<cwd>/agents/pm-reference/event-schemas.md`) that only ever matched the
 * parser's SCHEMA_PATH when cwd WAS this repo's own root. For every other
 * cwd (an installed project, a test tmpDir), the direct-read branch ran
 * against a path that doesn't exist and getSchemas() silently returned null
 * — validation fail-opened everywhere outside this repo.
 *
 * v2.3.32 fixed SCHEMA_PATH so installed builds can locate their OWN schema.
 * That did not fix this: the mismatch is BETWEEN the two paths, not in
 * either one. This test file guards the fallback that closes that gap.
 *
 * Cases:
 *   1. Foreign cwd, no project-local schema -> falls back to the schema
 *      shipped alongside the running code (SCHEMA_PATH) -> non-empty map.
 *      This test FAILS against pre-fix code (returns null there).
 *   2. Foreign cwd WITH a project-local schema -> project-local wins,
 *      proven via differing contents (a slug only the local file declares).
 *   3. Neither project-local nor SCHEMA_PATH reachable -> null, no throw.
 *   4. mtime-aware cache still behaves as before for the canonical path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const validator = require(path.join(REPO_ROOT, 'bin', '_lib', 'schema-emit-validator'));
const parser = require(path.join(REPO_ROOT, 'bin', '_lib', 'event-schemas-parser'));

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const LOCAL_SCHEMA_MD = [
  '### `local_only_event`',
  '',
  '```json',
  '{',
  '  "type": "local_only_event",',
  '  "version": 1,',
  '  "foo": "bar"',
  '}',
  '```',
  '',
].join('\n');

describe('v2.3.33 W1 — schema validation runs for a foreign cwd', () => {

  test('Test 1: foreign cwd with no project-local schema falls back to the code-relative schema (non-empty map)', () => {
    const tmp = makeTmpDir('schema-foreign-');
    const map = validator.getSchemas(tmp);

    assert.ok(map !== null, 'getSchemas() must not return null for a foreign cwd — this is the core regression');
    assert.ok(map.size > 0, 'fallback schema map must be non-empty');

    // Sanity: the fallback content should match parsing SCHEMA_PATH directly.
    const expected = parser.parseEventSchemasFromFile();
    assert.equal(map.size, expected.length, 'fallback map size must match the code-relative schema event count');
  });

  test('Test 2: project-local schema wins over the code-relative fallback (proven by differing contents)', () => {
    const tmp = makeTmpDir('schema-local-');
    const dir = path.join(tmp, 'agents', 'pm-reference');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'event-schemas.md'), LOCAL_SCHEMA_MD);

    const map = validator.getSchemas(tmp);
    assert.ok(map !== null, 'getSchemas() must return a map when a project-local schema exists');

    // The project-local file declares exactly one event, "local_only_event",
    // which does not exist in this repo's real event-schemas.md. If the
    // fallback had won instead, this slug would be absent and the map would
    // be ~370 entries instead of 1.
    assert.ok(map.has('local_only_event'), 'project-local slug must be present — proves local content was used, not the fallback');
    assert.equal(map.size, 1, 'project-local map must contain exactly the one event the local file declares, not the fallback schema set');

    const fallbackMap = validator.getSchemas(makeTmpDir('schema-foreign-control-'));
    assert.notEqual(map.size, fallbackMap.size, 'project-local map must differ in size from the code-relative fallback map');
  });

  test('Test 3: neither project-local nor code-relative schema reachable -> null, no throw', () => {
    // Run in a subprocess with fs.readFileSync/statSync monkey-patched to
    // throw for any event-schemas.md path, so both the project-local read
    // AND the SCHEMA_PATH fallback fail — the only way to genuinely exercise
    // the "neither present" branch without deleting this repo's own schema
    // file. The subprocess asserts the null return itself and prints a
    // sentinel line so the parent test can make a real assertion (not just
    // "did not throw").
    const tmp = makeTmpDir('schema-neither-');
    const script = `
      const fs = require('fs');
      const origReadFileSync = fs.readFileSync;
      const origStatSync = fs.statSync;
      fs.readFileSync = function (p, ...rest) {
        if (typeof p === 'string' && p.includes('event-schemas.md')) {
          const e = new Error('ENOENT (simulated)');
          e.code = 'ENOENT';
          throw e;
        }
        return origReadFileSync.call(fs, p, ...rest);
      };
      fs.statSync = function (p, ...rest) {
        if (typeof p === 'string' && p.includes('event-schemas.md')) {
          const e = new Error('ENOENT (simulated)');
          e.code = 'ENOENT';
          throw e;
        }
        return origStatSync.call(fs, p, ...rest);
      };
      const validator = require(${JSON.stringify(path.join(REPO_ROOT, 'bin', '_lib', 'schema-emit-validator'))});
      let threw = false;
      let result;
      try {
        result = validator.getSchemas(${JSON.stringify(tmp)});
      } catch (e) {
        threw = true;
      }
      process.stdout.write(JSON.stringify({ threw, isNull: result === null }));
    `;
    const proc = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
    assert.equal(proc.status, 0, `subprocess must exit 0, stderr: ${proc.stderr}`);
    const out = JSON.parse(proc.stdout.trim());
    assert.equal(out.threw, false, 'getSchemas must never throw even when no schema is reachable anywhere');
    assert.equal(out.isNull, true, 'getSchemas must return null (not a Map, not undefined) when neither schema is reachable — fail-open contract');
  });

  test('Test 4: mtime-aware cache still applies for the canonical (in-repo) path', () => {
    validator.clearCache();
    parser.clearFileCache();

    const first = validator.getSchemas(REPO_ROOT);
    assert.ok(first !== null, 'canonical path must resolve to a non-null map');
    const second = validator.getSchemas(REPO_ROOT);
    assert.ok(second !== null, 'second call must also resolve to a non-null map');
    assert.equal(first.size, second.size, 'repeated calls without file changes must return equal-sized maps (cache stable)');
  });

});
