'use strict';

/**
 * v2.3.12 W1 (A1) + W2 (M1) — git-gate false-positive / true-positive matrix.
 *
 * W1: read-only roles must NOT be blocked when a benign command merely contains
 * the substring "git" in a filename/path or quoted argument. Destructive
 * working-tree git must still be blocked for read-only roles and in the main
 * checkout.
 * W2: isMainCheckout fails CLOSED (returns true) on timeout/throw.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const gate = require('../gate-developer-git.js');
const {
  findForbiddenPattern,
  splitChained,
  hasGitCommandToken,
  isAllReadOnlyGit,
} = gate;

// --- W1: splitChained is quote-aware -----------------------------------------

test('splitChained does not fracture inside quotes', () => {
  assert.deepStrictEqual(splitChained('echo "a; b"'), ['echo "a; b"']);
  assert.deepStrictEqual(splitChained("echo 'x | y'"), ["echo 'x | y'"]);
});

test('splitChained splits on &&, ||, |, &, ;, newline outside quotes', () => {
  assert.deepStrictEqual(splitChained('a && b'), ['a', 'b']);
  assert.deepStrictEqual(splitChained('a || b'), ['a', 'b']);
  assert.deepStrictEqual(splitChained('a | b'), ['a', 'b']);
  assert.deepStrictEqual(splitChained('a & b'), ['a', 'b']);
  assert.deepStrictEqual(splitChained('a ; b'), ['a', 'b']);
  assert.deepStrictEqual(splitChained('a\nb'), ['a', 'b']);
});

// --- W1: hasGitCommandToken distinguishes command from substring -------------

test('hasGitCommandToken: true only when git is in command position', () => {
  assert.strictEqual(hasGitCommandToken('git status'), true);
  assert.strictEqual(hasGitCommandToken('/usr/bin/git status'), true);
  assert.strictEqual(hasGitCommandToken('sudo git clean -fd'), true);
  assert.strictEqual(hasGitCommandToken('GIT_PAGER=cat git log'), true);
  assert.strictEqual(hasGitCommandToken('xargs git rm'), true);
});

test('hasGitCommandToken: false for substrings in paths / args / quotes', () => {
  assert.strictEqual(hasGitCommandToken('grep -n x bin/gate-developer-git.js'), false);
  assert.strictEqual(hasGitCommandToken('cat .gitignore'), false);
  assert.strictEqual(hasGitCommandToken('echo "use git stash"'), false);
  assert.strictEqual(hasGitCommandToken('grep "git diff" file'), false);
  assert.strictEqual(hasGitCommandToken('grep git file'), false); // git is an arg to grep
});

// --- W1: false-positive set must NOT be blocked for read-only roles ----------

const FP_COMMANDS = [
  'grep -n x bin/gate-developer-git.js',
  'cat .gitignore',
  'echo "use git stash"',
  'grep "git diff" file',
  'node -e "require(\'./bin/gate-developer-git.js\')"',
];

for (const cmd of FP_COMMANDS) {
  test(`FP not blocked for reviewer: ${cmd}`, () => {
    const ctx = { isMain: true, isReadOnly: true };
    assert.strictEqual(findForbiddenPattern(cmd, 'reviewer', ctx), null);
  });
}

// --- W1: true-positive set MUST stay blocked ---------------------------------

test('TP destructive git blocked for read-only role', () => {
  const ctx = { isMain: false, isReadOnly: true };
  assert.notStrictEqual(findForbiddenPattern('git clean -fd', 'reviewer', ctx), null);
  assert.notStrictEqual(findForbiddenPattern('git reset --hard', 'reviewer', ctx), null);
});

test('TP destructive git blocked in main checkout for any role', () => {
  const ctx = { isMain: true, isReadOnly: false };
  assert.notStrictEqual(findForbiddenPattern('foo && git clean -fd', 'developer', ctx), null);
});

test('TP wrapper-prefixed destructive git still detected', () => {
  const ctx = { isMain: true, isReadOnly: true };
  assert.notStrictEqual(findForbiddenPattern('sudo git clean -fd', 'reviewer', ctx), null);
});

// --- read-only git verbs remain allowed --------------------------------------

test('read-only git verbs allowed', () => {
  assert.strictEqual(isAllReadOnlyGit('git log --oneline'), true);
  assert.strictEqual(isAllReadOnlyGit('git status && git diff'), true);
  assert.strictEqual(isAllReadOnlyGit('git log | grep "git push"'), true);
});
