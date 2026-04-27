#!/usr/bin/env node
'use strict';

/**
 * v222-hooks-config-bucket-c.test.js — C3 hook chain registration tests.
 *
 * Asserts that hooks/hooks.json registers the two new Bucket C hooks with the
 * correct matcher, ordering, and timeout per v222-design.md §C3.
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOKS_PATH = path.join(REPO_ROOT, 'hooks', 'hooks.json');

function loadHooks() {
  return JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
}

function findAgentMatcherChain(hooks) {
  // Find the entry whose matcher is exactly "Agent" (NOT "Agent|Explore|Task").
  // Per design §C3, the C1+C2 hooks live in this dedicated chain.
  const entries = hooks.hooks.PreToolUse || [];
  return entries.find((e) => e.matcher === 'Agent');
}

describe('C3 hook chain registration', () => {
  test('hooks.json is valid JSON', () => {
    assert.doesNotThrow(() => loadHooks(), 'hooks.json must be valid JSON');
  });

  test('PreToolUse Agent matcher chain exists with the expected validators', () => {
    const hooks = loadHooks();
    const chain = findAgentMatcherChain(hooks);
    assert.ok(chain, 'PreToolUse matcher="Agent" entry must exist');
    const cmds = chain.hooks.map((h) => h.command || '');

    assert.ok(cmds.some((c) => c.includes('validate-task-subject.js')),
      'validate-task-subject.js must be in the Agent matcher chain');
    assert.ok(cmds.some((c) => c.includes('validate-reviewer-scope.js')),
      'validate-reviewer-scope.js must be in the Agent matcher chain');
    assert.ok(cmds.some((c) => c.includes('warn-isolation-omitted.js')),
      'warn-isolation-omitted.js must be in the Agent matcher chain');
  });

  test('inject-delegation-delta.js registered exactly once', () => {
    const hooks = loadHooks();
    const chain = findAgentMatcherChain(hooks);
    const cmds = chain.hooks.map((h) => h.command || '');
    const matches = cmds.filter((c) => c.includes('inject-delegation-delta.js'));
    assert.equal(matches.length, 1,
      'inject-delegation-delta.js must appear EXACTLY once');
  });

  test('inject-output-shape.js registered exactly once', () => {
    const hooks = loadHooks();
    const chain = findAgentMatcherChain(hooks);
    const cmds = chain.hooks.map((h) => h.command || '');
    const matches = cmds.filter((c) => c.includes('inject-output-shape.js'));
    assert.equal(matches.length, 1,
      'inject-output-shape.js must appear EXACTLY once');
  });

  test('order: validators → inject-delegation-delta → inject-output-shape', () => {
    const hooks = loadHooks();
    const chain = findAgentMatcherChain(hooks);
    const cmds = chain.hooks.map((h) => h.command || '');
    const idxValidate = cmds.findIndex((c) => c.includes('validate-task-subject.js'));
    const idxReviewer = cmds.findIndex((c) => c.includes('validate-reviewer-scope.js'));
    const idxIso      = cmds.findIndex((c) => c.includes('warn-isolation-omitted.js'));
    const idxDelta    = cmds.findIndex((c) => c.includes('inject-delegation-delta.js'));
    const idxOutput   = cmds.findIndex((c) => c.includes('inject-output-shape.js'));

    assert.ok(idxValidate < idxDelta && idxValidate < idxOutput,
      'validate-task-subject must precede both injection hooks');
    assert.ok(idxReviewer < idxDelta && idxReviewer < idxOutput,
      'validate-reviewer-scope must precede both injection hooks');
    assert.ok(idxIso < idxDelta && idxIso < idxOutput,
      'warn-isolation-omitted must precede both injection hooks');
    assert.ok(idxDelta < idxOutput,
      'inject-delegation-delta MUST precede inject-output-shape (cache-prefix locking)');
  });

  test('both new hooks have a 5-second timeout', () => {
    const hooks = loadHooks();
    const chain = findAgentMatcherChain(hooks);
    const delta = chain.hooks.find((h) => (h.command || '').includes('inject-delegation-delta.js'));
    const output = chain.hooks.find((h) => (h.command || '').includes('inject-output-shape.js'));
    assert.equal(delta.timeout, 5);
    assert.equal(output.timeout, 5);
    assert.equal(delta.type, 'command');
    assert.equal(output.type, 'command');
  });

  test('hooks register on matcher "Agent" only — NOT on the broader Agent|Explore|Task chain', () => {
    // Per design §C3 rationale: Explore and Task are I/O wrappers that do not
    // carry the static/per-spawn marker structure or the subagent_type field.
    const hooks = loadHooks();
    const allEntries = hooks.hooks.PreToolUse || [];
    for (const entry of allEntries) {
      const matcher = entry.matcher || '';
      const cmds = entry.hooks.map((h) => h.command || '');
      const hasDelta = cmds.some((c) => c.includes('inject-delegation-delta.js'));
      const hasOutput = cmds.some((c) => c.includes('inject-output-shape.js'));
      if (hasDelta || hasOutput) {
        assert.equal(matcher, 'Agent',
          'inject-* hooks must register on matcher="Agent" exactly, found "' + matcher + '"');
      }
    }
  });
});
