#!/usr/bin/env node
'use strict';

/**
 * Agent-dispatch allowlist sync test.
 *
 * The set of known agent-dispatch tool names (Agent, Explore, Task) is
 * declared in THREE places that must stay in sync. 2.0.12 caught a real
 * drift bug where one of the three was updated but the others weren't
 * (bin/emit-routing-outcome.js's in-script guard lagged the hooks.json
 * matcher expansion for Explore/Task). T7 found it at test-writing
 * time; T4 Finding F6 flagged the generalized risk and recommended
 * this test.
 *
 * The three declaration sites:
 *   1. hooks/hooks.json — PreToolUse and PostToolUse matcher regex
 *   2. bin/gate-agent-spawn.js — AGENT_DISPATCH_ALLOWLIST Set
 *   3. bin/emit-routing-outcome.js — AGENT_DISPATCH_NAMES Set
 *
 * This test parses each declaration from its source and asserts all
 * three decompose to exactly the same set of tool names. Any future
 * edit that updates one location without the others fails this test
 * with a diagnostic naming the drift point.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');

function readFile(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

function extractHooksJsonMatchers() {
  const hooks = JSON.parse(readFile('hooks/hooks.json'));
  const out = {};
  for (const phase of ['PreToolUse', 'PostToolUse']) {
    const entries = (hooks.hooks && hooks.hooks[phase]) || [];
    for (const entry of entries) {
      const matcher = entry.matcher || '';
      if (matcher.includes('Agent')) {
        out[phase] = new Set(matcher.split('|').map(s => s.trim()));
        break;
      }
    }
  }
  return out;
}

function extractSetLiteral(source, constName) {
  // Matches: new Set(['Agent', 'Explore', 'Task']) anywhere in the file.
  // Regex intentionally permissive on whitespace, strict on single-quoted names.
  const re = new RegExp(
    `${constName}\\s*=\\s*new Set\\(\\s*\\[([^\\]]*)\\]\\s*\\)`,
    'm'
  );
  const match = source.match(re);
  if (!match) return null;
  const inner = match[1];
  const names = inner
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(s => s.length > 0);
  return new Set(names);
}

describe('allowlist-sync — hooks.json matcher and in-script guards', () => {

  test('all three dispatch allowlists decompose to the same set', () => {
    const matchers = extractHooksJsonMatchers();
    assert.ok(
      matchers.PreToolUse,
      'hooks/hooks.json: PreToolUse matcher for Agent-family dispatches not found'
    );
    assert.ok(
      matchers.PostToolUse,
      'hooks/hooks.json: PostToolUse matcher for Agent-family dispatches not found'
    );

    const gateSource = readFile('bin/gate-agent-spawn.js');
    const gateSet = extractSetLiteral(gateSource, 'AGENT_DISPATCH_ALLOWLIST');
    assert.ok(
      gateSet,
      'bin/gate-agent-spawn.js: AGENT_DISPATCH_ALLOWLIST Set literal not found. ' +
      'If it was renamed, update this test.'
    );

    const emitSource = readFile('bin/emit-routing-outcome.js');
    const emitSet = extractSetLiteral(emitSource, 'AGENT_DISPATCH_NAMES');
    assert.ok(
      emitSet,
      'bin/emit-routing-outcome.js: AGENT_DISPATCH_NAMES Set literal not found. ' +
      'If it was renamed, update this test.'
    );

    const canonical = matchers.PreToolUse;

    function assertSetEqual(actual, expected, label) {
      const missing = [...expected].filter(x => !actual.has(x));
      const extra = [...actual].filter(x => !expected.has(x));
      assert.equal(
        missing.length + extra.length,
        0,
        `${label} drifts from hooks.json PreToolUse matcher {${[...expected].sort().join(',')}}: ` +
        `missing=[${missing.join(',')}] extra=[${extra.join(',')}]. ` +
        `See T7 emit-routing-outcome bug for the failure mode this test prevents.`
      );
    }

    assertSetEqual(matchers.PostToolUse, canonical, 'hooks.json PostToolUse matcher');
    assertSetEqual(gateSet, canonical, 'bin/gate-agent-spawn.js AGENT_DISPATCH_ALLOWLIST');
    assertSetEqual(emitSet, canonical, 'bin/emit-routing-outcome.js AGENT_DISPATCH_NAMES');
  });

  test('canonical set contains Agent, Explore, Task (2.0.12 baseline)', () => {
    const matchers = extractHooksJsonMatchers();
    const canonical = matchers.PreToolUse;
    for (const name of ['Agent', 'Explore', 'Task']) {
      assert.ok(
        canonical.has(name),
        `hooks.json PreToolUse matcher must include "${name}" for 2.0.12 dispatch coverage`
      );
    }
  });

});
