#!/usr/bin/env node
'use strict';

/**
 * p22-scout-whitelist-frozen.test.js — P2.2 agent-file `tools:` byte-equality.
 *
 * Layer (c) of the three-layer tool-whitelist enforcement (P2.2 §4): a
 * drift-detector that fails CI on any byte-level mutation of the
 * `agents/haiku-scout.md` `tools:` line OR a reordering that loses the
 * shape `^---\n[...]\ntools: [Read, Glob, Grep]\n[...]^---`.
 *
 * Per `feedback_explore_agent_readonly.md`: drift on a read-only role's
 * tool list MUST be observable. Promotion to a wider whitelist requires
 * a deliberate edit of THIS test's pinned baseline (i.e., the team agrees
 * in the same PR that the scout's read-only contract is being relaxed).
 *
 * Runner: node --test bin/__tests__/p22-scout-whitelist-frozen.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCOUT_PATH = path.resolve(__dirname, '..', '..', 'agents', 'haiku-scout.md');
const VALIDATE_PATH = path.resolve(__dirname, '..', 'validate-task-completion.js');
const FROZEN_TOOLS_LINE = 'tools: [Read, Glob, Grep]';
// F-012 (v2.2.0 fix-pass): the runtime forbidden-list MUST be the strict
// complement of the frontmatter allow-list. Frontmatter (layer a) +
// runtime rejection (layer b) + this byte-equality check (layer c) are the
// three layers of the read-only-tier whitelist. Drift on any one layer
// alone is observable but defense-in-depth weakens.
const FROZEN_FORBIDDEN_TOOLS = ['Edit', 'Write', 'Bash'];

describe('P2.2 — agent file tools-line byte-equality (drift detector)', () => {

  test('agents/haiku-scout.md exists', () => {
    assert.ok(fs.existsSync(SCOUT_PATH),
      'Expected agents/haiku-scout.md at ' + SCOUT_PATH);
  });

  test('tools: line byte-equals frozen baseline', () => {
    const body = fs.readFileSync(SCOUT_PATH, 'utf8');
    const lines = body.split('\n');
    const toolsLine = lines.find(l => l.trim().startsWith('tools:'));
    assert.ok(typeof toolsLine === 'string',
      'no `tools:` line found in agents/haiku-scout.md');
    assert.equal(toolsLine, FROZEN_TOOLS_LINE,
      'haiku-scout `tools:` line drifted from frozen baseline.\n' +
      '  Expected: ' + JSON.stringify(FROZEN_TOOLS_LINE) + '\n' +
      '  Actual:   ' + JSON.stringify(toolsLine) + '\n' +
      'If this change is intentional, update FROZEN_TOOLS_LINE in this test\n' +
      'AND the runtime SCOUT_FORBIDDEN_TOOLS set in bin/validate-task-completion.js\n' +
      'in the same commit. See feedback_explore_agent_readonly.md.');
  });

  test('frontmatter shape: tools: [Read, Glob, Grep] inside YAML block', () => {
    const body = fs.readFileSync(SCOUT_PATH, 'utf8');
    // Locate the leading `---` and the next `---` to bound the frontmatter.
    const fmMatch = body.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(fmMatch, 'agents/haiku-scout.md must start with YAML frontmatter');
    const fm = fmMatch[1];
    assert.match(fm, /\ntools: \[Read, Glob, Grep\]\n/,
      'frontmatter must contain the literal line `tools: [Read, Glob, Grep]`');
  });

  // F-012 (v2.2.0 fix-pass): cross-check that the runtime SCOUT_FORBIDDEN_TOOLS
  // set in bin/validate-task-completion.js is exactly {Edit, Write, Bash} —
  // the strict complement of the frontmatter allow-list. The error message
  // at the top of this file ("update FROZEN_TOOLS_LINE in this test AND the
  // runtime SCOUT_FORBIDDEN_TOOLS set ... in the same commit") was a verbal
  // commitment until this assertion landed; institutional memory is now a
  // tested invariant.
  test('runtime SCOUT_FORBIDDEN_TOOLS matches frozen complement of allow-list', () => {
    const src = fs.readFileSync(VALIDATE_PATH, 'utf8');
    const m = src.match(/SCOUT_FORBIDDEN_TOOLS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    assert.ok(m,
      'Could not locate `const SCOUT_FORBIDDEN_TOOLS = new Set([...])` in\n' +
      '  ' + VALIDATE_PATH + '\n' +
      'If the symbol was renamed, update this test and the agent file\n' +
      'frontmatter in the same commit.');
    const literal = m[1];
    const tools = Array.from(literal.matchAll(/['"]([^'"]+)['"]/g)).map(x => x[1]);
    assert.deepEqual(tools.sort(), FROZEN_FORBIDDEN_TOOLS.slice().sort(),
      'SCOUT_FORBIDDEN_TOOLS drifted from the frozen complement of the\n' +
      'haiku-scout `tools:` allow-list.\n' +
      '  Expected: ' + JSON.stringify(FROZEN_FORBIDDEN_TOOLS) + '\n' +
      '  Actual:   ' + JSON.stringify(tools) + '\n' +
      'Layer (a) frontmatter and layer (b) runtime rejection must be exact\n' +
      'complements. Update both this test and SCOUT_FORBIDDEN_TOOLS in the\n' +
      'same commit. See feedback_explore_agent_readonly.md.');
  });

});
