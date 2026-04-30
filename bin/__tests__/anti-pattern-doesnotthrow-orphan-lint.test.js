#!/usr/bin/env node
'use strict';

/**
 * anti-pattern-doesnotthrow-orphan-lint.test.js — C-01 lint unit tests
 * (v2.2.15 P1-02).
 *
 * Verifies `bin/_lib/lint-doesnotthrow-orphan.js` correctly identifies tests
 * whose only assertion is `assert.doesNotThrow` (the anti-pattern) and does
 * NOT flag tests that pair `doesNotThrow` with a value-equality assertion.
 *
 * Telemetry-first ramp: v2.2.15 ships warn-only (test currently does NOT
 * fail the suite when real-source orphans are found — the lint runs as a
 * diagnostic over `bin/__tests__/` and outputs findings via stdout). v2.2.16
 * promotes the real-source scan to a hard assertion.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');

const lint = require('../_lib/lint-doesnotthrow-orphan');

// ---------------------------------------------------------------------------
// Synthetic fixtures
// ---------------------------------------------------------------------------

const FIXTURE_ORPHAN = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('only doesNotThrow', () => {
  assert.doesNotThrow(() => bar());
});
`;

const FIXTURE_FOLLOWED_BY_DEEP_STRICT_EQUAL = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('doesNotThrow + deepStrictEqual', () => {
  assert.doesNotThrow(() => bar());
  assert.deepStrictEqual(bar(), 42);
});
`;

const FIXTURE_FOLLOWED_BY_MATCH_REGEX = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('doesNotThrow + match regex', () => {
  assert.doesNotThrow(() => bar());
  assert.match(result, /^valid$/);
});
`;

const FIXTURE_NO_DOESNOTTHROW = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('no doesNotThrow at all', () => {
  const e = captureStderr(() => bar());
  assert.match(e, /warn/);
});
`;

const FIXTURE_MULTIPLE_TESTS = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('orphan A', () => {
  assert.doesNotThrow(() => alpha());
});

test('paired B', () => {
  assert.doesNotThrow(() => beta());
  assert.strictEqual(beta(), 'ok');
});
`;

const FIXTURE_OK_TRIVIAL = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('orphan with assert.ok(true)', () => {
  assert.doesNotThrow(() => bar());
  assert.ok(true);
});
`;

const FIXTURE_OK_NONTRIVIAL = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('paired with non-trivial ok', () => {
  assert.doesNotThrow(() => bar());
  assert.ok(result.length > 0);
});
`;

const FIXTURE_DOESNOTTHROW_ASYNC = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('async orphan', async () => {
  await assert.doesNotThrowAsync(() => bar());
});
`;

const FIXTURE_THROWS_PAIR = `
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('doesNotThrow paired with throws', () => {
  assert.doesNotThrow(() => goodPath());
  assert.throws(() => badPath(), /boom/);
});
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lint-doesnotthrow-orphan: positive (orphan flagged)', () => {
  test('lone doesNotThrow is flagged', () => {
    const findings = lint.findOrphans(FIXTURE_ORPHAN, '/x.test.js');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].test_name, 'only doesNotThrow');
    assert.strictEqual(findings[0].file, '/x.test.js');
    assert.ok(findings[0].line > 0, 'line number > 0');
  });

  test('async-variant doesNotThrowAsync is flagged', () => {
    const findings = lint.findOrphans(FIXTURE_DOESNOTTHROW_ASYNC, '/x.test.js');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].test_name, 'async orphan');
  });

  test('orphan + assert.ok(true) is still flagged (trivial ok does not count)', () => {
    const findings = lint.findOrphans(FIXTURE_OK_TRIVIAL, '/x.test.js');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].test_name, 'orphan with assert.ok(true)');
  });
});

describe('lint-doesnotthrow-orphan: negative (paired, no flag)', () => {
  test('doesNotThrow + deepStrictEqual: no flag', () => {
    const findings = lint.findOrphans(FIXTURE_FOLLOWED_BY_DEEP_STRICT_EQUAL, '/x.test.js');
    assert.deepStrictEqual(findings, []);
  });

  test('doesNotThrow + assert.match(regex): no flag', () => {
    const findings = lint.findOrphans(FIXTURE_FOLLOWED_BY_MATCH_REGEX, '/x.test.js');
    assert.deepStrictEqual(findings, []);
  });

  test('doesNotThrow + assert.ok(non-trivial): no flag', () => {
    const findings = lint.findOrphans(FIXTURE_OK_NONTRIVIAL, '/x.test.js');
    assert.deepStrictEqual(findings, []);
  });

  test('doesNotThrow + assert.throws: no flag (paired complementary)', () => {
    const findings = lint.findOrphans(FIXTURE_THROWS_PAIR, '/x.test.js');
    assert.deepStrictEqual(findings, []);
  });

  test('no doesNotThrow at all: no flag', () => {
    const findings = lint.findOrphans(FIXTURE_NO_DOESNOTTHROW, '/x.test.js');
    assert.deepStrictEqual(findings, []);
  });
});

describe('lint-doesnotthrow-orphan: edge cases', () => {
  test('multi-test fixture: flag orphan A only, not paired B', () => {
    const findings = lint.findOrphans(FIXTURE_MULTIPLE_TESTS, '/x.test.js');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].test_name, 'orphan A');
  });

  test('empty source returns empty findings', () => {
    const findings = lint.findOrphans('', '/x.test.js');
    assert.deepStrictEqual(findings, []);
  });

  test('non-string source returns empty findings (defensive)', () => {
    assert.deepStrictEqual(lint.findOrphans(null, '/x.test.js'), []);
    assert.deepStrictEqual(lint.findOrphans(undefined, '/x.test.js'), []);
  });

  test('lintFile reads from disk and reports orphan', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-orphan-'));
    const f = path.join(tmp, 'sample.test.js');
    fs.writeFileSync(f, FIXTURE_ORPHAN);
    try {
      const findings = lint.lintFile(f);
      assert.strictEqual(findings.length, 1);
      assert.strictEqual(findings[0].file, f);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('lint-doesnotthrow-orphan: kill switch', () => {
  test('isDisabled true when env var = 1', () => {
    const prev = process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED;
    process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED = '1';
    try {
      assert.strictEqual(lint.isDisabled(), true);
    } finally {
      if (prev === undefined) delete process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED;
      else process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED = prev;
    }
  });

  test('isDisabled false by default (default-on shipping)', () => {
    const prev = process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED;
    delete process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED;
    try {
      assert.strictEqual(lint.isDisabled(), false);
    } finally {
      if (prev !== undefined) process.env.ORCHESTRAY_LINT_DOESNOTTHROW_ORPHAN_DISABLED = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Real-source telemetry sweep (v2.2.15 warn-only).
//
// v2.2.15: emit findings to stdout for collection, but do NOT fail the test.
// v2.2.16: promote to a hard assertion if the false-positive ratio in the
// v2.2.15 telemetry window stays low.
// ---------------------------------------------------------------------------

describe('lint-doesnotthrow-orphan: real-source diagnostic (warn-only v2.2.15)', () => {
  test('scan bin/__tests__/ for orphans (telemetry-first)', () => {
    const ROOT = path.resolve(__dirname);
    const files = fs.readdirSync(ROOT).filter((f) => f.endsWith('.test.js'));
    const all = [];
    for (const f of files) {
      // Skip our own file to avoid recursion; its fixtures intentionally
      // contain orphans which are NOT real anti-patterns.
      if (f === 'anti-pattern-doesnotthrow-orphan-lint.test.js') continue;
      const findings = lint.lintFile(path.join(ROOT, f));
      for (const finding of findings) all.push(finding);
    }
    if (all.length > 0) {
      // Telemetry: print to stdout so a v2.2.15 release scan can collect.
      // Hard-block ramp deferred to v2.2.16 per spec.
      process.stdout.write(
        '[lint-doesnotthrow-orphan] WARN — found ' + all.length +
        ' orphan(s) in bin/__tests__/:\n' +
        all.map((f) => '  ' + f.file + ':' + f.line + ' — test(' + JSON.stringify(f.test_name) + ')').join('\n') +
        '\n'
      );
    }
    // v2.2.15 ships warn-only; do not fail.
    assert.ok(true);
  });
});
