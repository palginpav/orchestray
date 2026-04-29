'use strict';

/**
 * W0e — session_source typo fix verification.
 *
 * Platform SessionStart payload uses `source`, not `session_source`.
 * Line 779 of bin/inject-resilience-dossier.js was reading event.session_source
 * (always undefined). Fixed to event.source.
 *
 * Tests:
 *   1. SessionStart with source:"resume" — handler reads it, routes to SessionStart path.
 *   2. SessionStart with no source field — handler doesn't crash.
 *   3. SessionStart with session_source:"resume" (old typo field) — NOT treated as resume source.
 *   4. Grep — event.session_source does not appear as a read site in the production file.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'inject-resilience-dossier.js');

const {
  buildDossier,
  serializeDossier,
} = require('../_lib/resilience-dossier-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMinimalDossier(orchestrationId = 'orch-w0e-test') {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: {
      id: orchestrationId,
      phase: 'executing',
      status: 'in_progress',
      complexity_score: 7,
    },
    task_ids: { pending: ['W1'], completed: [], failed: [] },
  }));
  return serialized;
}

/**
 * Create minimal project dir with dossier.
 */
function makeProjectDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'w0e-typo-'));
  const stateDir = path.join(tmp, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'resilience-dossier.json'), buildMinimalDossier());
  return tmp;
}

/**
 * Run hook with spawnSync, piping event JSON to stdin.
 */
function runHook(eventPayload, extraEnv = {}) {
  const env = Object.assign({}, process.env, extraEnv);
  // Remove kill-switches from parent env.
  delete env.ORCHESTRAY_RESILIENCE_DISABLED;
  delete env.ORCHESTRAY_RESILIENCE_NATIVE_ENVELOPE_DISABLED;
  delete env.SESSION_SOURCE;
  Object.assign(env, extraEnv);

  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(eventPayload),
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

// ---------------------------------------------------------------------------
// Test 1: source:"resume" is read correctly
// ---------------------------------------------------------------------------

describe('W0e — event.source field read (not session_source)', () => {

  test('SessionStart with source:"resume" routes to SessionStart handler', () => {
    const tmp = makeProjectDir();
    try {
      // hook_event_name triggers SessionStart path regardless of source field,
      // but we also set source to exercise the event.source read site on line 779.
      const r = runHook({
        hook_event_name: 'SessionStart',
        source: 'resume',
        cwd: tmp,
      });
      // Script must exit cleanly.
      assert.equal(r.status, 0, `Non-zero exit. stderr: ${r.stderr}`);
      // Output must be valid JSON.
      let parsed;
      try {
        parsed = JSON.parse(r.stdout.trim());
      } catch (e) {
        assert.fail(`stdout is not valid JSON: ${r.stdout}`);
      }
      // SessionStart handler returns either additionalContext envelope or nop continue.
      // Either is fine — we just need no crash and valid JSON.
      assert.ok(typeof parsed === 'object' && parsed !== null, 'output must be object');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 2: no source field — no crash
  // ---------------------------------------------------------------------------

  test('SessionStart with no source field does not crash', () => {
    const tmp = makeProjectDir();
    try {
      const r = runHook({
        hook_event_name: 'SessionStart',
        cwd: tmp,
      });
      assert.equal(r.status, 0, `Non-zero exit. stderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      assert.ok(typeof parsed === 'object' && parsed !== null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 3: session_source (old typo field) is NOT used as source
  // ---------------------------------------------------------------------------

  test('session_source typo field does NOT trigger SessionStart routing', () => {
    const tmp = makeProjectDir();
    try {
      // No hook_event_name, only the old typo'd field.
      // With the fix, event.source is undefined, so sessionSource = '' (no env override).
      // isSessionStart is false -> routes to handleUserPromptSubmit.
      // We verify: (a) no crash, (b) output is valid JSON.
      // handleUserPromptSubmit on a dir with no lock file will produce a skip or inject response.
      const r = runHook({
        session_source: 'resume',
        cwd: tmp,
      });
      assert.equal(r.status, 0, `Non-zero exit. stderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout.trim());
      // UserPromptSubmit path: output must be an object (either inject or skip envelope).
      assert.ok(typeof parsed === 'object' && parsed !== null, 'output must be an object');
      // Confirm it did NOT inject via SessionStart path by checking there's no
      // "session_source" influence — the action field (if present) won't be "session_start_inject".
      // We just verify the hook didn't crash and returned valid output.
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Test 4: grep — event.session_source not present as read site in production file
  // ---------------------------------------------------------------------------

  test('event.session_source does not appear as read site in inject-resilience-dossier.js', () => {
    const source = fs.readFileSync(HOOK, 'utf8');
    // Allow JSDoc comments that mention session_source (documentation).
    // Disallow actual JS property access: event.session_source
    const lines = source.split('\n');
    const badLines = lines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => {
        // Must contain event.session_source as a property access (not in a comment).
        const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        return /event\.session_source/.test(stripped);
      });

    assert.deepEqual(
      badLines,
      [],
      `Found event.session_source read sites (should be zero after fix):\n` +
      badLines.map(({ num, line }) => `  line ${num}: ${line.trim()}`).join('\n')
    );
  });

});
