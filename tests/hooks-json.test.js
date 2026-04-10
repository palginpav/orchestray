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
