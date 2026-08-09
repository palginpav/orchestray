#!/usr/bin/env node
'use strict';

/**
 * v2.3.23 Item 6 — wire the R-SHDW-EMIT dev-time gate into `npm test`.
 *
 * `bin/_tools/audit-emit-sites.js` was documented (bin/_lib/audit-event-writer.js:9)
 * as enforcing the events.jsonl-gateway rule "at dev-time" but was invoked by
 * nothing -- not package.json, not CI, not any test. This wires it in and proves
 * it has teeth: run clean (exit 0), inject a real bypass site, confirm it fails
 * (exit 1), then remove the injected file and confirm the repo is back to clean.
 *
 * The script derives its own scan root from `__dirname` (not `process.cwd()`), so
 * a violation must be planted as a real file under the repo's `bin/` tree -- it
 * cannot be sandboxed via a temp cwd. The planted file is pure text (the auditor
 * only regex-scans file contents, never requires/executes them) and is always
 * removed in a `finally`, with existence re-checked afterward.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'bin', '_tools', 'audit-emit-sites.js');
const NODE = process.execPath;

// Scratch file planted under bin/ (scanned dir) then always removed.
const SCRATCH_PATH = path.join(REPO_ROOT, 'bin', '_tools', '_scratch-v2323-emit-violation.js');
const SCRATCH_CONTENT =
  "'use strict';\n" +
  "// Deliberate bypass for v2323-audit-emit-sites-gate.test.js -- does not import\n" +
  "// audit-event-writer.js, so this is a real (uncaught-by-exception-list) hit.\n" +
  "atomicAppendJsonl('.orchestray/audit/events.jsonl', { type: 'test' });\n";

function runGate() {
  return cp.spawnSync(NODE, [SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' });
}

describe('R-SHDW-EMIT: audit-emit-sites.js gate is wired into npm test', () => {
  test('clean repo: gate exits 0 and reports all sites routed through the gateway', () => {
    const result = runGate();
    assert.equal(result.status, 0, 'expected exit 0 on a clean repo:\n' + result.stdout + result.stderr);
    assert.match(result.stdout, /All events\.jsonl emit sites route through audit-event-writer/);
  });

  test('planted bypass site: gate exits 1 and names the offending file', () => {
    assert.ok(!fs.existsSync(SCRATCH_PATH), 'scratch file already exists -- leftover from a prior failed run');
    try {
      fs.writeFileSync(SCRATCH_PATH, SCRATCH_CONTENT);
      const result = runGate();
      assert.equal(result.status, 1, 'expected exit 1 with a planted bypass site:\n' + result.stdout + result.stderr);
      assert.match(result.stderr, /R-SHDW-EMIT bypass sites found/);
      assert.match(result.stderr, /_scratch-v2323-emit-violation\.js/);
    } finally {
      fs.rmSync(SCRATCH_PATH, { force: true });
    }
    assert.ok(!fs.existsSync(SCRATCH_PATH), 'scratch file must be removed after the test');
  });

  test('after cleanup, gate is clean again', () => {
    const result = runGate();
    assert.equal(result.status, 0, 'expected exit 0 after scratch file removal:\n' + result.stdout + result.stderr);
  });
});
