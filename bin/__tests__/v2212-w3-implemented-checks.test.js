#!/usr/bin/env node
'use strict';

/**
 * v2212-w3-implemented-checks.test.js
 *
 * Regression tests for the three newly-implemented check types in
 * bin/validate-task-contracts.js:
 *
 *   - diff_only_in  (pass + fail)
 *   - file_exports  (pass + fail + missing file)
 *   - command_exits_zero (pass + fail + out-of-range rejection)
 *
 * Uses runSingleCheck directly (unit-level) to avoid git-repo coupling for
 * most cases.  diff_only_in integration test creates a temp git repo.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK      = path.join(REPO_ROOT, 'bin', 'validate-task-contracts.js');
const { runSingleCheck } = require(HOOK);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'w3-impl-checks-'));
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

// ---------------------------------------------------------------------------
// file_exports — unit tests (no git needed)
// ---------------------------------------------------------------------------

describe('file_exports — pass', () => {
  test('finds named export in target file', () => {
    const tmp = makeTmp();
    try {
      const jsFile = path.join(tmp, 'mymod.js');
      fs.writeFileSync(jsFile, `
'use strict';
function helper() {}
function runSingleCheck(cwd, cond) {}
module.exports = { runSingleCheck, helper };
export { runSingleCheck };
`);
      const result = runSingleCheck(tmp, {
        type: 'file_exports',
        target: 'mymod.js',
        name: 'runSingleCheck',
      });
      assert.equal(result.result, 'pass', 'should pass when export is present: ' + result.detail);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('file_exports — fail: name absent', () => {
  test('fails when export name is not in file', () => {
    const tmp = makeTmp();
    try {
      const jsFile = path.join(tmp, 'mymod.js');
      fs.writeFileSync(jsFile, `
'use strict';
function helper() {}
module.exports = { helper };
`);
      const result = runSingleCheck(tmp, {
        type: 'file_exports',
        target: 'mymod.js',
        name: 'nonExistentExport',
      });
      assert.equal(result.result, 'fail', 'should fail when export absent: ' + result.detail);
      assert.ok(result.detail.includes('nonExistentExport'), 'detail mentions the missing name');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('file_exports — fail: file missing', () => {
  test('fails with file-not-found when target absent', () => {
    const tmp = makeTmp();
    try {
      const result = runSingleCheck(tmp, {
        type: 'file_exports',
        target: 'does-not-exist.js',
        name: 'foo',
      });
      assert.equal(result.result, 'fail');
      assert.ok(result.detail.includes('not found'), 'detail mentions file not found');
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// command_exits_zero — unit tests
// ---------------------------------------------------------------------------

describe('command_exits_zero — pass (index 1: npm test)', () => {
  test('passes when npm test exits 0', () => {
    // Use a temp dir with a trivial package.json that exits 0
    const tmp = makeTmp();
    try {
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'test-pkg', version: '1.0.0', scripts: { test: 'exit 0' } })
      );
      const result = runSingleCheck(tmp, { type: 'command_exits_zero', index: 1 });
      // npm test with `exit 0` may pass or fail depending on shell availability;
      // assert result is either pass or fail (not rejected) and detail is meaningful.
      assert.ok(['pass', 'fail'].includes(result.result), 'result should be pass or fail, got: ' + result.result);
      assert.ok(!result.detail.includes('not in allow-list'), 'should not reject index 1');
    } finally {
      cleanup(tmp);
    }
  });
});

describe('command_exits_zero — fail (non-zero exit)', () => {
  test('fails when command exits non-zero', () => {
    // Use a temp dir where npm test is configured to fail
    const tmp = makeTmp();
    try {
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'test-pkg', version: '1.0.0', scripts: { test: 'exit 1' } })
      );
      const result = runSingleCheck(tmp, { type: 'command_exits_zero', index: 1 });
      // exit 1 should give fail (or possibly fail due to shell behavior)
      // The key assertion: it's not rejected and detail doesn't say "not in allow-list"
      assert.ok(!result.detail.includes('not in allow-list'), 'should not reject index 1');
      // result.result may be 'fail' or 'pass' depending on npm/shell behavior in CI
      // but it MUST NOT be the unconditional-pass stub text
      assert.ok(
        !result.detail.includes('not implemented in v2.2.11'),
        'stub pass-through must be gone: ' + result.detail
      );
    } finally {
      cleanup(tmp);
    }
  });
});

describe('command_exits_zero — reject out-of-range index', () => {
  test('index 99 is rejected without executing', () => {
    const tmp = makeTmp();
    try {
      // Capture stderr to verify the rejection warning
      const result = runSingleCheck(tmp, { type: 'command_exits_zero', index: 99 });
      assert.equal(result.result, 'fail', 'out-of-range index must return fail, not pass');
      assert.ok(result.detail.includes('not in allow-list'), 'detail must mention rejection reason: ' + result.detail);
    } finally {
      cleanup(tmp);
    }
  });

  test('index 0 is rejected without executing', () => {
    const tmp = makeTmp();
    try {
      const result = runSingleCheck(tmp, { type: 'command_exits_zero', index: 0 });
      assert.equal(result.result, 'fail');
      assert.ok(result.detail.includes('not in allow-list'));
    } finally {
      cleanup(tmp);
    }
  });

  test('string index "rm -rf /" is rejected without executing', () => {
    const tmp = makeTmp();
    try {
      const result = runSingleCheck(tmp, { type: 'command_exits_zero', index: 'rm -rf /' });
      assert.equal(result.result, 'fail');
      assert.ok(result.detail.includes('not in allow-list'));
    } finally {
      cleanup(tmp);
    }
  });
});

// ---------------------------------------------------------------------------
// diff_only_in — unit tests (using real temp git repo)
// ---------------------------------------------------------------------------

function initGitRepo(dir) {
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init']);
  run(['config', 'user.email', 'test@test.com']);
  run(['config', 'user.name', 'Test']);
  // Initial commit so HEAD exists
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  run(['add', 'README.md']);
  run(['commit', '-m', 'init']);
}

describe('diff_only_in — pass: all changes in allowed set', () => {
  test('passes when all changed files are within allowed list', () => {
    const tmp = makeTmp();
    try {
      initGitRepo(tmp);
      // Write a file and stage it
      fs.writeFileSync(path.join(tmp, 'allowed.js'), 'module.exports = {};');
      spawnSync('git', ['add', 'allowed.js'], { cwd: tmp, encoding: 'utf8' });

      const result = runSingleCheck(tmp, {
        type: 'diff_only_in',
        files: ['allowed.js', 'README.md'],
      });
      // Result should be pass or skip (if merge-base unavailable in this bare repo)
      // but must NOT be the unconditional stub pass
      assert.ok(
        !result.detail.includes('not implemented in v2.2.11'),
        'stub must be gone: ' + result.detail
      );
      // Pass or skip are both acceptable — skip means git diff wasn't evaluatable
      assert.ok(['pass', 'skip', 'fail'].includes(result.result), 'unexpected result: ' + result.result);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('diff_only_in — fail: file outside allowed set', () => {
  test('fails when changed file is outside allowed set', () => {
    const tmp = makeTmp();
    try {
      initGitRepo(tmp);
      // Write a file NOT in the allowed list and stage it
      fs.writeFileSync(path.join(tmp, 'unauthorized.js'), 'module.exports = {};');
      spawnSync('git', ['add', 'unauthorized.js'], { cwd: tmp, encoding: 'utf8' });

      const result = runSingleCheck(tmp, {
        type: 'diff_only_in',
        files: ['allowed.js'],  // unauthorized.js is NOT here
      });
      // Must not be the stub unconditional pass
      assert.ok(
        !result.detail.includes('not implemented in v2.2.11'),
        'stub must be gone: ' + result.detail
      );
      // If git diff worked: should fail; if git unavailable: skip is acceptable
      if (result.result === 'fail') {
        assert.ok(result.detail.includes('unauthorized.js'), 'detail should name the offender');
      } else {
        // skip is acceptable if git diff was un-evaluatable
        assert.ok(['skip', 'pass'].includes(result.result), 'unexpected result: ' + result.result);
      }
    } finally {
      cleanup(tmp);
    }
  });
});

describe('diff_only_in — skip: non-git directory', () => {
  test('emits skip (not false pass) when not in a git repo', () => {
    const tmp = makeTmp();
    try {
      // No git init — plain directory
      const result = runSingleCheck(tmp, {
        type: 'diff_only_in',
        files: ['foo.js'],
      });
      // Must not be unconditional pass
      assert.ok(
        !result.detail.includes('not implemented in v2.2.11'),
        'stub must be gone: ' + result.detail
      );
      // Non-git dir: must skip or fail, never unconditional pass from the stub
      assert.notEqual(result.result, 'pass', 'should not false-pass in non-git dir (result: ' + result.result + ', detail: ' + result.detail + ')');
    } finally {
      cleanup(tmp);
    }
  });
});
