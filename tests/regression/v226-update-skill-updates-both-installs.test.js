'use strict';

// Regression test for user-memory rule `feedback_update_both_installs.md`:
// when both global and local installs exist, /orchestray:update must
// upgrade BOTH, not just the "active" one. v2.2.5's skill body had a
// step-2 instruction that picked the active install and ignored the
// other — observed in a real session where the local install drifted
// behind by 3 patch versions while the global was current.
//
// This test guards against the regression by parsing skills/orchestray:update/
// SKILL.md and asserting:
//   - The install detection step builds a LIST of installs (not "prefer one").
//   - The update step instructs to update EVERY stale install in sequence.
//   - The user-memory rule citation is present so future readers know why.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_PATH = path.resolve(__dirname, '..', '..', 'skills', 'orchestray:update', 'SKILL.md');

function readSkill() {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

test('orchestray:update — detection step builds a list of installs (not single-pick)', () => {
  const body = readSkill();
  // The bug shape was: "If both exist: prefer local". Refuse to ship that
  // wording or any synonym that implies single-install selection.
  assert.doesNotMatch(
    body,
    /prefer (local|global)/i,
    'install-detection step must not say "prefer local/global" — both installs must be tracked'
  );
  assert.match(
    body,
    /list of every install that exists|build a list `\{installs\}`|each install in `?\{?installs\}?`/i,
    'detection step must build a list of installs (not pick one)'
  );
});

test('orchestray:update — update step instructs to update every stale install', () => {
  const body = readSkill();
  assert.match(
    body,
    /update EVERY stale install|for each install in `?\{?stale\}?`/i,
    'update step must iterate over every stale install, not just the "active" one'
  );
});

test('orchestray:update — cites the feedback_update_both_installs rule by name', () => {
  const body = readSkill();
  assert.match(
    body,
    /feedback_update_both_installs/,
    'the skill body must cite the user-memory rule that motivates the both-installs sweep'
  );
});

test('orchestray:update — partial-failure does not abort the sweep', () => {
  const body = readSkill();
  // The bug pattern would be: first failure halts the second update.
  // Lock the "continue with the next stale install" wording.
  assert.match(
    body,
    /(continue with the next stale install|do not abort the whole sweep|partial success is better than no progress)/i,
    'update step must continue past a single-install failure rather than aborting'
  );
});

test('orchestray:update — final report lists each install', () => {
  const body = readSkill();
  // The summary must enumerate per-install status (success or failure)
  // rather than collapsing to a single line.
  assert.match(
    body,
    /one-line summary per install|per-install result|Updated \[<scope>\]|Failed \[<scope>\]/i,
    'final report must enumerate each install (so partial failures are visible)'
  );
});
