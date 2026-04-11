#!/usr/bin/env node
'use strict';

/**
 * Tests for hooks/hooks.json
 *
 * Static validation that every hook command references a script file that
 * actually exists in the repo. A typo in hooks.json (e.g., a missing letter
 * in a script name) would otherwise ship silently because no other test
 * exercises scripts through their hooks.json path.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const hooksJsonPath = path.join(repoRoot, 'hooks', 'hooks.json');

function extractScriptPath(command) {
  // Strip optional `node ` prefix, then `${CLAUDE_PLUGIN_ROOT}/`, then take
  // everything up to the first whitespace as the repo-relative script path.
  let rest = command;
  if (rest.startsWith('node ')) rest = rest.slice(5);
  const prefix = '${CLAUDE_PLUGIN_ROOT}/';
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  const firstSpace = rest.search(/\s/);
  return firstSpace === -1 ? rest : rest.slice(0, firstSpace);
}

function collectHookEntries(hooksJson) {
  // Shape: { hooks: { <EventName>: [ { hooks: [ { type, command } ] } ] } }
  assert.ok(hooksJson && typeof hooksJson.hooks === 'object',
    'hooks.json must have a top-level "hooks" object');
  const entries = [];
  for (const [eventName, eventList] of Object.entries(hooksJson.hooks)) {
    assert.ok(Array.isArray(eventList), `hooks.${eventName} must be an array`);
    for (const group of eventList) {
      assert.ok(group && Array.isArray(group.hooks),
        `hooks.${eventName} entry must have a "hooks" array`);
      for (const h of group.hooks) entries.push({ eventName, hook: h });
    }
  }
  return entries;
}

describe('hooks/hooks.json static validation', () => {

  const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
  const entries = collectHookEntries(hooksJson);

  test('hooks.json declares at least one hook', () => {
    assert.ok(entries.length > 0, 'hooks.json should declare at least one hook');
  });

  test('every hook entry has type "command" and a non-empty command string', () => {
    for (const { eventName, hook } of entries) {
      assert.equal(hook.type, 'command',
        `hooks.${eventName} entry must have type: "command", got: ${hook.type}`);
      assert.equal(typeof hook.command, 'string',
        `hooks.${eventName} command must be a string`);
      assert.ok(hook.command.trim().length > 0,
        `hooks.${eventName} command must be non-empty`);
    }
  });

  test('every referenced script path exists on disk', () => {
    for (const { eventName, hook } of entries) {
      const scriptPath = extractScriptPath(hook.command);
      assert.ok(scriptPath.length > 0,
        `hooks.${eventName} command did not yield a script path: ${hook.command}`);
      const resolved = path.join(repoRoot, scriptPath);
      assert.ok(fs.existsSync(resolved),
        `hooks.${eventName} references missing script: ${scriptPath} (command: ${hook.command})`);
    }
  });

});

// ---------------------------------------------------------------------------
// D3 Fix 1 — matcher regex assertions (2.0.12)
// ---------------------------------------------------------------------------

describe('D3 Fix 1 — hooks.json matcher regex for Agent|Explore|Task', () => {

  const hooksJson = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));

  /**
   * Collect all matchers for a given event name.
   * Returns an array of matcher strings (one per group that has a matcher field).
   */
  function getMatchers(eventName) {
    const eventList = hooksJson.hooks[eventName] || [];
    return eventList
      .filter(group => typeof group.matcher === 'string')
      .map(group => group.matcher);
  }

  test('PreToolUse has exactly one group with matcher "Agent|Explore|Task"', () => {
    const matchers = getMatchers('PreToolUse');
    assert.ok(
      matchers.includes('Agent|Explore|Task'),
      'PreToolUse must have a matcher exactly equal to "Agent|Explore|Task". ' +
      'Got: ' + JSON.stringify(matchers)
    );
  });

  test('PostToolUse has a group with matcher "Agent|Explore|Task"', () => {
    const matchers = getMatchers('PostToolUse');
    assert.ok(
      matchers.includes('Agent|Explore|Task'),
      'PostToolUse must have a matcher exactly equal to "Agent|Explore|Task". ' +
      'Got: ' + JSON.stringify(matchers)
    );
  });

  test('PreToolUse gate-agent-spawn.js is wired under the Agent|Explore|Task matcher', () => {
    const preToolUse = hooksJson.hooks['PreToolUse'] || [];
    const agentGroup = preToolUse.find(g => g.matcher === 'Agent|Explore|Task');
    assert.ok(agentGroup, 'PreToolUse must have a group with matcher "Agent|Explore|Task"');
    const commands = (agentGroup.hooks || []).map(h => h.command || '');
    assert.ok(
      commands.some(c => c.includes('gate-agent-spawn.js')),
      'gate-agent-spawn.js must be wired under the Agent|Explore|Task PreToolUse matcher'
    );
  });

  test('PostToolUse emit-routing-outcome.js is wired under the Agent|Explore|Task matcher', () => {
    const postToolUse = hooksJson.hooks['PostToolUse'] || [];
    const agentGroup = postToolUse.find(g => g.matcher === 'Agent|Explore|Task');
    assert.ok(agentGroup, 'PostToolUse must have a group with matcher "Agent|Explore|Task"');
    const commands = (agentGroup.hooks || []).map(h => h.command || '');
    assert.ok(
      commands.some(c => c.includes('emit-routing-outcome.js')),
      'emit-routing-outcome.js must be wired under the Agent|Explore|Task PostToolUse matcher'
    );
  });

  test('PostToolUse record-mcp-checkpoint.js is wired for all 4 enforced MCP tools', () => {
    const postToolUse = hooksJson.hooks['PostToolUse'] || [];
    // Find the group that wires record-mcp-checkpoint.js
    const mcpGroup = postToolUse.find(g =>
      (g.hooks || []).some(h => (h.command || '').includes('record-mcp-checkpoint.js'))
    );
    assert.ok(mcpGroup, 'PostToolUse must have a group wiring record-mcp-checkpoint.js');
    const matcher = mcpGroup.matcher || '';
    // The matcher must cover all 4 enforced tools
    const requiredTools = [
      'mcp__orchestray__pattern_find',
      'mcp__orchestray__kb_search',
      'mcp__orchestray__history_find_similar_tasks',
      'mcp__orchestray__pattern_record_application',
    ];
    for (const tool of requiredTools) {
      assert.ok(
        matcher.includes(tool),
        `PostToolUse MCP matcher must include "${tool}". Got: ${matcher}`
      );
    }
  });

  test('PreCompact record-pattern-skip.js is wired', () => {
    const preCompact = hooksJson.hooks['PreCompact'] || [];
    const allCommands = preCompact
      .flatMap(g => (g.hooks || []).map(h => h.command || ''));
    assert.ok(
      allCommands.some(c => c.includes('record-pattern-skip.js')),
      'PreCompact must wire record-pattern-skip.js'
    );
  });

});
