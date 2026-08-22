#!/usr/bin/env node
'use strict';

/**
 * reviewer-autofill.test.js — W8B (v2.3.31) validator-side autofill tests.
 *
 * Proves, via spawnSync against the REAL hooks with REAL payloads:
 *   - validate-reviewer-dimensions.js autofills `## Dimensions to Apply`
 *     itself (the sibling injector never had its updatedInput observed).
 *   - validate-reviewer-scope.js autofills `## Files to Review` from
 *     `git diff --name-only HEAD` (falling back to a clean-tree hard block).
 *   - Neither validator double-injects when a well-formed block is already
 *     present.
 *   - Autofilled dimensions never include "correctness" or "security".
 *   - >40 changed files are capped with a truncation note.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const cp     = require('node:child_process');

const REPO_ROOT     = path.resolve(__dirname, '..');
const DIMS_SCRIPT    = path.join(REPO_ROOT, 'bin', 'validate-reviewer-dimensions.js');
const SCOPE_SCRIPT   = path.join(REPO_ROOT, 'bin', 'validate-reviewer-scope.js');
const NODE           = process.execPath;

function run(script, payload) {
  const r = cp.spawnSync(NODE, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 8000,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    parsed: (() => {
      try { return r.stdout ? JSON.parse(r.stdout) : null; } catch (_e) { return null; }
    })(),
  };
}

// ---------------------------------------------------------------------------
// git fixtures for validate-reviewer-scope.js
// ---------------------------------------------------------------------------

function gitInit(root) {
  cp.execFileSync('git', ['init', '-q'], { cwd: root });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitkeep'), '');
  cp.execFileSync('git', ['add', '.'], { cwd: root });
  cp.execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
}

function makeCleanRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w8b-scope-clean-'));
  gitInit(root);
  return root;
}

function makeDirtyRepo(fileCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w8b-scope-dirty-'));
  gitInit(root);
  for (let i = 0; i < fileCount; i++) {
    fs.writeFileSync(path.join(root, `changed-${i}.txt`), 'x'.repeat(i + 1));
  }
  // git diff --name-only HEAD only reports tracked-file changes; new files
  // must be staged to appear (precedence tier b: `git diff --cached HEAD`).
  cp.execFileSync('git', ['add', '.'], { cwd: root });
  return root;
}

// ---------------------------------------------------------------------------
// events.jsonl fixtures for validate-reviewer-dimensions.js
// ---------------------------------------------------------------------------

function makeOrchRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'w8b-dims-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md'),
    path.join(pmRefDir, 'event-schemas.md')
  );
  return root;
}

function writeOrchMarker(root, orchId) {
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: orchId }),
    'utf8'
  );
}

function appendDevAgentStop(root, orchId, filesChanged) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  const row = JSON.stringify({
    type: 'agent_stop',
    agent_type: 'developer',
    orchestration_id: orchId,
    timestamp: new Date().toISOString(),
    files_changed: filesChanged,
  });
  fs.appendFileSync(eventsPath, row + '\n', 'utf8');
}

const ORIG_PROMPT = '## Task\nReview the changes.\n';

// ---------------------------------------------------------------------------
// validate-reviewer-dimensions.js: autofill
// ---------------------------------------------------------------------------

test('dims: no block present -> exit 0, autofilled block appended', () => {
  const root = makeOrchRoot();
  const orchId = 'orch-dims-1';
  writeOrchMarker(root, orchId);
  appendDevAgentStop(root, orchId, ['bin/foo.js']);

  const r = run(DIMS_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
  });
  assert.equal(r.status, 0, 'exit 0; stderr=' + r.stderr);
  assert.ok(r.parsed.hookSpecificOutput, 'updatedInput present');
  const newPrompt = r.parsed.hookSpecificOutput.updatedInput.prompt;
  assert.match(newPrompt, /^##\s+Dimensions to Apply/m, 'block appended');
  assert.ok(newPrompt.startsWith(ORIG_PROMPT), 'original prompt preserved');
});

test('dims: block already present -> exit 0, prompt byte-identical (no double-inject)', () => {
  const root = makeOrchRoot();
  const orchId = 'orch-dims-2';
  writeOrchMarker(root, orchId);

  const prebuilt = ORIG_PROMPT +
    '\n\n## Dimensions to Apply\n\n- documentation\n\n' +
    'For each item above, Read the matching fragment file BEFORE forming findings:\n' +
    '- code-quality   → agents/reviewer-dimensions/code-quality.md\n';

  const r = run(DIMS_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'reviewer', prompt: prebuilt },
  });
  assert.equal(r.status, 0);
  assert.equal(r.parsed.hookSpecificOutput, undefined, 'no mutation');
  assert.equal(r.parsed.continue, true);
});

test('dims: non-reviewer spawn -> exit 0, untouched', () => {
  const root = makeOrchRoot();
  const r = run(DIMS_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'developer', prompt: ORIG_PROMPT },
  });
  assert.equal(r.status, 0);
  assert.deepEqual(r.parsed, { continue: true });
});

test('dims: autofilled dimensions never contain "correctness" or "security"', () => {
  const root = makeOrchRoot();
  const orchId = 'orch-dims-3';
  writeOrchMarker(root, orchId);
  // security-sensitive path (bin/validate-*) drives the security archetype.
  appendDevAgentStop(root, orchId, ['bin/validate-task-completion.js']);

  const r = run(DIMS_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
  });
  assert.equal(r.status, 0);
  const newPrompt = r.parsed.hookSpecificOutput.updatedInput.prompt;
  const dimsSection = newPrompt.slice(newPrompt.indexOf('## Dimensions to Apply'));
  const bulletLines = dimsSection.split('\n').filter((l) => /^-\s/.test(l.trim()));
  const chosen = bulletLines
    .map((l) => l.trim().replace(/^-\s+/, '').split(/\s+→/)[0])
    .filter((d) => !d.includes('/')); // drop legend lines that slipped through split
  for (const d of chosen) {
    assert.notEqual(d, 'correctness', 'never autofills correctness');
    assert.notEqual(d, 'security', 'never autofills security');
  }
});

test('dims: real failing probe from the task description now passes (exit 0, block present)', () => {
  const r = run(DIMS_SCRIPT, {
    tool_name: 'Agent',
    cwd: REPO_ROOT,
    subagent_type: 'reviewer',
    model: 'sonnet',
    description: 'review the thing',
    tool_input: {
      subagent_type: 'reviewer',
      model: 'sonnet',
      description: 'review the thing',
      prompt: 'Review the recent changes.',
    },
  });
  assert.equal(r.status, 0, 'stderr=' + r.stderr);
  assert.ok(r.parsed.hookSpecificOutput, 'updatedInput present — autofill fired');
  assert.match(
    r.parsed.hookSpecificOutput.updatedInput.prompt,
    /^##\s+Dimensions to Apply/m
  );
});

// ---------------------------------------------------------------------------
// validate-reviewer-scope.js: autofill
// ---------------------------------------------------------------------------

test('scope: no file list, dirty tree -> exit 0, "## Files to Review" with real paths', () => {
  const root = makeDirtyRepo(3);
  const r = run(SCOPE_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
  });
  assert.equal(r.status, 0, 'exit 0; stderr=' + r.stderr);
  assert.ok(r.parsed.hookSpecificOutput, 'updatedInput present');
  const newPrompt = r.parsed.hookSpecificOutput.updatedInput.prompt;
  assert.match(newPrompt, /## Files to Review/);
  assert.match(newPrompt, /changed-0\.txt/);
  assert.match(newPrompt, /changed-1\.txt/);
  assert.match(newPrompt, /changed-2\.txt/);
});

test('scope: no file list, clean tree -> exit 2 (documented fallback)', () => {
  const root = makeCleanRepo();
  const r = run(SCOPE_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
  });
  assert.equal(r.status, 2, 'clean tree still blocks; stderr=' + r.stderr);
  assert.equal(r.parsed.continue, false);
});

test('scope: non-reviewer spawn -> exit 0, untouched', () => {
  const root = makeDirtyRepo(1);
  const r = run(SCOPE_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'developer', prompt: ORIG_PROMPT },
  });
  assert.equal(r.status, 0);
  assert.equal(r.parsed.hookSpecificOutput, undefined);
});

test('scope: prompt already has a file list -> exit 0, byte-identical (no double-inject)', () => {
  const root = makeDirtyRepo(2);
  const prompt = 'files:\n- changed-0.txt\n';
  const r = run(SCOPE_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'reviewer', prompt },
  });
  assert.equal(r.status, 0);
  assert.equal(r.parsed.hookSpecificOutput, undefined, 'no mutation — already scoped');
  assert.equal(r.parsed.continue, true);
});

test('scope: >40 changed files -> capped at 40 with truncation noted', () => {
  const root = makeDirtyRepo(55);
  const r = run(SCOPE_SCRIPT, {
    tool_name: 'Agent', cwd: root,
    tool_input: { subagent_type: 'reviewer', prompt: ORIG_PROMPT },
  });
  assert.equal(r.status, 0, 'exit 0; stderr=' + r.stderr);
  const newPrompt = r.parsed.hookSpecificOutput.updatedInput.prompt;
  const pathLines = newPrompt
    .slice(newPrompt.indexOf('## Files to Review'))
    .split('\n')
    .filter((l) => /^-\s+`changed-/.test(l.trim()));
  assert.equal(pathLines.length, 40, 'list capped at 40 paths');
  assert.match(newPrompt, /capped at 40/, 'truncation noted in the injected block');
});
