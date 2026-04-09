#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/complexity-precheck.js
 *
 * Tests the scoreComplexity logic and MAGIC_KEYWORD_PATTERNS via the
 * script's stdin/stdout interface. Each test spawns the script as a
 * subprocess and asserts on the JSON output.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '../bin/complexity-precheck.js');

/**
 * Run the hook script with the given stdin input string.
 * Returns { stdout, stderr, status }.
 */
function run(stdinData) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 5000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

/**
 * Parse the JSON output from the hook and return the object.
 * Throws if stdout is not valid JSON.
 */
function parseOutput(stdout) {
  return JSON.parse(stdout.trim());
}

// ---------------------------------------------------------------------------
// MAGIC_KEYWORD_PATTERNS regex correctness
// ---------------------------------------------------------------------------

describe('MAGIC_KEYWORD_PATTERNS regex correctness', () => {

  // -------------------------------------------------------------------------
  // /\borchestrate\b/i
  // -------------------------------------------------------------------------
  describe('/\\borchestrate\\b/i', () => {

    test('matches "orchestrate this task" and triggers orchestration', () => {
      const input = JSON.stringify({ message: 'orchestrate this task for me' });
      const { stdout, status } = run(input);
      assert.equal(status, 0, 'script should exit 0');
      const out = parseOutput(stdout);
      assert.equal(out.continue, true);
      // score 8 → additionalContext should be present
      assert.ok(out.additionalContext, 'should include additionalContext for magic keyword match');
    });

    test('does NOT match "orchestrated" (past tense, no word boundary after "orchestrate")', () => {
      // "orchestrated" — the \b is after the 'e', but "orchestrated" has 'd' after 'e'
      // so \borchestrate\b fails because 'e' is followed by 'd' (word char, not boundary)
      const input = JSON.stringify({ message: 'I orchestrated the deployment last week' });
      const { stdout, status } = run(input);
      assert.equal(status, 0);
      const out = parseOutput(stdout);
      // Short prompt (7 words > 5 threshold), won't be blocked by length check.
      // But should NOT fire as magic keyword — score depends on other signals only.
      assert.ok(!out.additionalContext || !out.additionalContext.includes('Complex task detected'),
        'orchestrated should NOT trigger magic keyword orchestration');
    });

    test('does NOT match "orchestration" (suffix, no word boundary)', () => {
      // \borchestrate\b: "orchestration" — 'e' is followed by 'i' (word char) → no boundary
      const input = JSON.stringify({ message: 'tell me about orchestration patterns' });
      const { stdout, status } = run(input);
      assert.equal(status, 0);
      const out = parseOutput(stdout);
      assert.ok(!out.additionalContext, 'orchestration should NOT trigger orchestration hint');
    });

    test('matches "Orchestrate" case-insensitively', () => {
      const input = JSON.stringify({ message: 'Orchestrate the migration across all services please' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, 'Orchestrate (capital) should trigger hint');
    });

    test('matches "ORCHESTRATE" all-caps', () => {
      const input = JSON.stringify({ message: 'ORCHESTRATE this entire refactor now' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, 'ORCHESTRATE all-caps should trigger hint');
    });

  });

  // -------------------------------------------------------------------------
  // /\bmulti-agent\b/i and /\bmulti\s+agent\b/i
  // -------------------------------------------------------------------------
  describe('/\\bmulti-agent\\b/i', () => {

    test('matches "multi-agent workflow"', () => {
      const input = JSON.stringify({ message: 'set up a multi-agent workflow for testing' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, 'multi-agent should trigger hint');
    });

    test('matches "multi agent" (space instead of hyphen)', () => {
      const input = JSON.stringify({ message: 'use a multi agent system to handle this' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, 'multi agent (space) should trigger hint');
    });

    test('matches "multi  agent" (multiple spaces between multi and agent)', () => {
      // \s+ matches one or more whitespace
      const input = JSON.stringify({ message: 'use a multi  agent setup here' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, 'multi  agent (multiple spaces) should trigger hint');
    });

  });

  // -------------------------------------------------------------------------
  // /\buse orchestray\b/i
  // -------------------------------------------------------------------------
  describe('/\\buse orchestray\\b/i', () => {

    test('matches "use orchestray to handle"', () => {
      const input = JSON.stringify({ message: 'use orchestray to handle this migration' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, 'use orchestray should trigger hint');
    });

  });

  // -------------------------------------------------------------------------
  // /\buse agents\b(?=\s+(to|for|on)\b)/i
  // -------------------------------------------------------------------------
  describe('/\\buse agents\\b(?=\\s+(to|for|on)\\b)/i', () => {

    test('matches "use agents to build"', () => {
      const input = JSON.stringify({ message: 'use agents to build the feature from scratch' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, '"use agents to" should trigger hint');
    });

    test('matches "use agents for deployment"', () => {
      const input = JSON.stringify({ message: 'use agents for deployment automation' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, '"use agents for" should trigger hint');
    });

    test('matches "use agents on this codebase"', () => {
      const input = JSON.stringify({ message: 'use agents on this codebase refactor' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, '"use agents on" should trigger hint');
    });

    test('does NOT match "what frameworks use agents" (agents not followed by to/for/on)', () => {
      // "use agents" appears but is not followed by \s+(to|for|on)
      const input = JSON.stringify({ message: 'what frameworks use agents in their architecture' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      // This prompt is 9 words, low complexity score — no orchestration hint expected
      assert.ok(!out.additionalContext, '"use agents" without to/for/on should NOT trigger hint');
    });

    test('does NOT match "use agents" followed by other word (not to/for/on)', () => {
      const input = JSON.stringify({ message: 'use agents sparingly when needed for best results' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      // "use agents sparingly" — "sparingly" is not to/for/on
      assert.ok(!out.additionalContext, '"use agents sparingly" should NOT trigger hint');
    });

  });

  // -------------------------------------------------------------------------
  // /\bdelegate this\s+task\b/i  — FIXED: only matches "delegate this task"
  // -------------------------------------------------------------------------
  describe('/\\bdelegate this\\s+task\\b/i — fixed regex', () => {

    test('matches "delegate this task to the team"', () => {
      const input = JSON.stringify({ message: 'delegate this task to the team immediately' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(out.additionalContext, '"delegate this task" should trigger hint');
    });

    test('does NOT match "delegate this to John" — false positive fixed', () => {
      // Previously matched due to lookahead including "to". Now fixed to require "task" only.
      const input = JSON.stringify({ message: 'delegate this to John when he is available' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(!out.additionalContext,
        '"delegate this to John" should NOT trigger orchestration — false positive was fixed');
    });

    test('does NOT match "delegate this to the developer agent"', () => {
      // Only "delegate this task" triggers now, not "delegate this to ..."
      const input = JSON.stringify({ message: 'delegate this to the developer agent please' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      assert.ok(!out.additionalContext, '"delegate this to ..." no longer triggers — use "delegate this task" instead');
    });

    test('does NOT match "I will delegate this later" (no task/to after "this")', () => {
      const input = JSON.stringify({ message: 'I will delegate this later once reviewed' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      // "delegate this later" — "later" is not task|to, so lookahead fails
      assert.ok(!out.additionalContext, '"delegate this later" should NOT trigger hint');
    });

    test('does NOT match "please delegate this project" (no lookahead match)', () => {
      const input = JSON.stringify({ message: 'please delegate this project forward to review' });
      const { stdout } = run(input);
      const out = parseOutput(stdout);
      // "delegate this project" — "project" is not task|to after \bdelegate this\b
      // Wait: "delegate this" is at pos X, then " project" — lookahead needs \s+(task|to)
      // "project" != task|to → no match
      assert.ok(!out.additionalContext, '"delegate this project" should NOT trigger hint');
    });

  });

});

// ---------------------------------------------------------------------------
// stdin parsing safety
// ---------------------------------------------------------------------------

describe('stdin parsing safety', () => {

  test('empty stdin produces continue:true and exits 0', () => {
    const { stdout, status } = run('');
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
  });

  test('invalid JSON produces continue:true and exits 0 (safe fallback)', () => {
    const { stdout, status } = run('not valid json {{{');
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
  });

  test('missing "message" and "prompt" fields produces continue:true', () => {
    const input = JSON.stringify({ cwd: '/tmp', session_id: 'abc' });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
  });

  test('null prompt value produces continue:true without crashing', () => {
    const input = JSON.stringify({ message: null });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
  });

  test('very large input (>1MB of JSON) does not crash, produces continue:true', () => {
    // Build a prompt that's ~1.2MB
    const bigPrompt = 'refactor the code and ' + 'x'.repeat(1_200_000);
    const input = JSON.stringify({ message: bigPrompt });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
  });

  test('uses "prompt" field when "message" is absent', () => {
    // The script tries data.message || data.prompt
    const input = JSON.stringify({ prompt: 'orchestrate the entire build pipeline' });
    const { stdout } = run(input);
    const out = parseOutput(stdout);
    assert.ok(out.additionalContext, '"prompt" field should be used when "message" is absent');
  });

});

// ---------------------------------------------------------------------------
// Early-exit / skip conditions
// ---------------------------------------------------------------------------

describe('early-exit skip conditions', () => {

  test('slash command prompts pass through unchanged', () => {
    const input = JSON.stringify({ message: '/orchestray:run build the app' });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
    assert.equal(out.additionalContext, undefined);
  });

  test('prompts shorter than 5 words pass through unchanged', () => {
    const input = JSON.stringify({ message: 'fix the bug' });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
    assert.equal(out.additionalContext, undefined);
  });

  test('task-notification XML messages pass through unchanged', () => {
    const input = JSON.stringify({ message: '<task-notification>some internal message</task-notification>' });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
    assert.equal(out.additionalContext, undefined);
  });

  test('command-name XML messages pass through unchanged', () => {
    const input = JSON.stringify({ message: 'some message with <command-name>orchestray:run</command-name>' });
    const { stdout, status } = run(input);
    assert.equal(status, 0);
    const out = parseOutput(stdout);
    assert.equal(out.continue, true);
    assert.equal(out.additionalContext, undefined);
  });

});

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

describe('exit codes', () => {

  test('always exits 0 (never blocks via exit code 2)', () => {
    // complexity-precheck is a UserPromptSubmit hook that modifies but never blocks
    const inputs = [
      '',
      'not json',
      JSON.stringify({ message: 'orchestrate everything' }),
      JSON.stringify({ message: 'fix typo' }),
    ];
    for (const input of inputs) {
      const { status } = run(input);
      assert.equal(status, 0, `expected exit 0 for input: ${input.slice(0, 40)}`);
    }
  });

});

// ---------------------------------------------------------------------------
// PROJECT_CREATION_PATTERNS
// ---------------------------------------------------------------------------

describe('PROJECT_CREATION_PATTERNS trigger score 8', () => {

  test('"make a project from this spec" triggers orchestration', () => {
    const input = JSON.stringify({ message: 'make a project from this spec' });
    const { stdout } = run(input);
    const out = parseOutput(stdout);
    assert.ok(out.additionalContext, '"make a project" should trigger orchestration');
  });

  test('"build a project based on requirements" triggers orchestration', () => {
    const input = JSON.stringify({ message: 'build a project based on these requirements please' });
    const { stdout } = run(input);
    const out = parseOutput(stdout);
    assert.ok(out.additionalContext, '"build a project" should trigger orchestration');
  });

  test('"implement it based on the description" triggers orchestration', () => {
    const input = JSON.stringify({ message: 'read the doc and implement it for me now' });
    const { stdout } = run(input);
    const out = parseOutput(stdout);
    assert.ok(out.additionalContext, '"implement it" should trigger orchestration');
  });

});

// ---------------------------------------------------------------------------
// score threshold behavior
// ---------------------------------------------------------------------------

describe('complexity scoring threshold behavior', () => {

  test('high-complexity prompt (many keywords + long) triggers orchestration', () => {
    const input = JSON.stringify({
      message: 'refactor the entire authentication backend and database schema, ' +
               'implement new API endpoints for the frontend components, ' +
               'update middleware security logging configuration, and ' +
               'create test suite and deployment pipeline with CI/CD docker integration',
    });
    const { stdout } = run(input);
    const out = parseOutput(stdout);
    assert.ok(out.additionalContext, 'high complexity prompt should trigger hint');
    assert.ok(out.additionalContext.includes('score'), 'hint should contain score');
  });

  test('low-complexity conversational prompt does NOT trigger orchestration', () => {
    const input = JSON.stringify({ message: 'what does this function return when called' });
    const { stdout } = run(input);
    const out = parseOutput(stdout);
    assert.ok(!out.additionalContext, 'simple question should not trigger orchestration hint');
  });

  test('score is reported in additionalContext when orchestration is triggered', () => {
    const input = JSON.stringify({ message: 'orchestrate this task across agents' });
    const { stdout } = run(input);
    const out = parseOutput(stdout);
    assert.ok(out.additionalContext, 'should have additionalContext');
    assert.ok(out.additionalContext.includes('score'), 'additionalContext should contain "score"');
    assert.ok(out.additionalContext.includes('/12'), 'additionalContext should reference /12 max score');
  });

});

// ---------------------------------------------------------------------------
// marker file behavior
// ---------------------------------------------------------------------------

describe('auto-trigger marker file', () => {

  test('writes auto-trigger.json when score >= threshold', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-test-'));
    try {
      const input = JSON.stringify({
        message: 'orchestrate the entire refactor of the backend database and api services',
        cwd: tmpDir,
      });
      run(input);
      const markerPath = path.join(tmpDir, '.orchestray', 'auto-trigger.json');
      assert.ok(fs.existsSync(markerPath), 'auto-trigger.json should be written');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      assert.ok(marker.score >= 4, 'marker should contain score >= threshold');
      assert.ok(marker.timestamp, 'marker should contain timestamp');
      assert.ok(marker.prompt, 'marker should contain prompt');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('does NOT write auto-trigger.json when score < threshold', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-test-'));
    try {
      const input = JSON.stringify({
        message: 'what does this function do exactly here',
        cwd: tmpDir,
      });
      run(input);
      const markerPath = path.join(tmpDir, '.orchestray', 'auto-trigger.json');
      assert.ok(!fs.existsSync(markerPath), 'auto-trigger.json should NOT be written for low score');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('deletes stale marker older than 5 minutes before writing new one', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-test-'));
    try {
      const markerDir = path.join(tmpDir, '.orchestray');
      fs.mkdirSync(markerDir, { recursive: true });
      const markerPath = path.join(markerDir, 'auto-trigger.json');

      // Write a stale marker with a past mtime
      fs.writeFileSync(markerPath, JSON.stringify({ score: 5, timestamp: 'old', prompt: 'old' }));
      // Backdate the file by 10 minutes
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(markerPath, tenMinutesAgo, tenMinutesAgo);

      const input = JSON.stringify({
        message: 'orchestrate the deployment pipeline across all environments now',
        cwd: tmpDir,
      });
      run(input);

      // File should still exist (re-written with fresh content), but content should be new
      assert.ok(fs.existsSync(markerPath), 'marker should exist after re-write');
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      assert.notEqual(marker.timestamp, 'old', 'stale marker should have been replaced with fresh one');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

});
