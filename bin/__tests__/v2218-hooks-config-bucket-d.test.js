#!/usr/bin/env node
'use strict';

/**
 * v2218-hooks-config-bucket-d.test.js — hook position assertion for W1 v2.2.18.
 *
 * Asserts that hooks/hooks.json SubagentStop array contains the new
 * auto-commit-worktree-on-subagent-stop.js entry in the correct position:
 *   - AFTER a block containing collect-context-telemetry.js stop
 *   - BEFORE a block containing validate-task-completion.js
 *
 * Runner: node --test bin/__tests__/v2218-hooks-config-bucket-d.test.js
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const HOOKS_PATH  = path.join(REPO_ROOT, 'hooks', 'hooks.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the list of command strings (in order) from all SubagentStop hook blocks.
 * @param {object} hooksJson - Parsed hooks.json content.
 * @returns {string[]}
 */
function extractSubagentStopCommands(hooksJson) {
  const blocks = hooksJson.hooks && hooksJson.hooks.SubagentStop;
  if (!Array.isArray(blocks)) return [];

  const commands = [];
  for (const block of blocks) {
    if (!Array.isArray(block.hooks)) continue;
    for (const h of block.hooks) {
      if (h && typeof h.command === 'string') {
        commands.push(h.command);
      }
    }
  }
  return commands;
}

/**
 * Find the index of the first command matching a substring.
 * @param {string[]} commands
 * @param {string} substr
 * @returns {number} -1 if not found
 */
function indexOfCommand(commands, substr) {
  return commands.findIndex(c => c.includes(substr));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v2218 W1 — hooks.json SubagentStop bucket position', () => {

  test('hooks/hooks.json is valid JSON', () => {
    const raw = fs.readFileSync(HOOKS_PATH, 'utf8');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(raw); }, 'hooks.json must be valid JSON');
    assert.ok(parsed && typeof parsed === 'object', 'hooks.json must be an object');
  });

  test('SubagentStop contains auto-commit-worktree-on-subagent-stop.js', () => {
    const hooksJson = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
    const commands = extractSubagentStopCommands(hooksJson);
    const idx = indexOfCommand(commands, 'auto-commit-worktree-on-subagent-stop.js');
    assert.ok(idx >= 0, 'auto-commit-worktree-on-subagent-stop.js must be present in SubagentStop');
  });

  test('auto-commit entry is AFTER collect-context-telemetry.js stop', () => {
    const hooksJson = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
    const commands = extractSubagentStopCommands(hooksJson);

    const telemetryIdx  = indexOfCommand(commands, 'collect-context-telemetry.js stop');
    const autoCommitIdx = indexOfCommand(commands, 'auto-commit-worktree-on-subagent-stop.js');

    assert.ok(telemetryIdx >= 0,  'collect-context-telemetry.js stop must exist in SubagentStop');
    assert.ok(autoCommitIdx >= 0, 'auto-commit entry must exist in SubagentStop');
    assert.ok(
      autoCommitIdx > telemetryIdx,
      'auto-commit (' + autoCommitIdx + ') must come AFTER collect-context-telemetry.js stop (' + telemetryIdx + ')'
    );
  });

  test('auto-commit entry is BEFORE validate-task-completion.js', () => {
    const hooksJson = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
    const commands = extractSubagentStopCommands(hooksJson);

    const autoCommitIdx = indexOfCommand(commands, 'auto-commit-worktree-on-subagent-stop.js');
    // validate-task-completion.js appears in SubagentStop; find the FIRST occurrence after auto-commit.
    const vtcIdx = commands.findIndex(
      (c, i) => i > autoCommitIdx && c.includes('validate-task-completion.js')
    );

    assert.ok(autoCommitIdx >= 0, 'auto-commit entry must exist in SubagentStop');
    assert.ok(
      vtcIdx > autoCommitIdx,
      'validate-task-completion.js must come AFTER auto-commit entry'
    );
  });

  test('auto-commit entry has timeout of 10', () => {
    const hooksJson = JSON.parse(fs.readFileSync(HOOKS_PATH, 'utf8'));
    const blocks = hooksJson.hooks && hooksJson.hooks.SubagentStop;
    assert.ok(Array.isArray(blocks), 'SubagentStop must be an array');

    let found = false;
    for (const block of blocks) {
      if (!Array.isArray(block.hooks)) continue;
      for (const h of block.hooks) {
        if (h && typeof h.command === 'string' && h.command.includes('auto-commit-worktree-on-subagent-stop.js')) {
          assert.equal(h.timeout, 10, 'auto-commit hook must have timeout: 10');
          found = true;
        }
      }
    }
    assert.ok(found, 'auto-commit-worktree-on-subagent-stop.js hook entry must be present');
  });

});
