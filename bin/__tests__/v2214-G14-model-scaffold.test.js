'use strict';

/**
 * v2.2.14 G-14 — model-scaffold mandatory marker in delegation-templates.md.
 *
 * Asserts that:
 *   1. Every Agent() example code block in delegation-templates.md includes a `model:` field
 *      with one of "haiku", "sonnet", "opus" values.
 *   2. At least one inline `// MANDATORY` comment is present.
 *   3. The doc-block warning about gate-agent-spawn.js exists.
 *   4. Each tier (haiku/sonnet/opus) has at least one canonical example.
 */

const fs = require('node:fs');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATES_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'delegation-templates.md');

const text = fs.readFileSync(TEMPLATES_PATH, 'utf8');

describe('v2.2.14 G-14 — Mandatory model: field scaffold in delegation-templates.md', () => {
  test('Doc-block warning about gate-agent-spawn.js is present', () => {
    assert.match(
      text,
      /gate-agent-spawn\.js/,
      'doc-block must reference bin/gate-agent-spawn.js so PMs know which gate enforces this'
    );
    assert.match(
      text,
      /Mandatory `model:` field/,
      'section header "Mandatory `model:` field" must be present'
    );
  });

  test('Kill switch ORCHESTRAY_STRICT_MODEL_REQUIRED is documented', () => {
    assert.match(
      text,
      /ORCHESTRAY_STRICT_MODEL_REQUIRED/,
      'doc-block must mention the kill switch env var'
    );
  });

  test('At least one inline `// MANDATORY` comment is present', () => {
    const matches = text.match(/\/\/ MANDATORY/g) || [];
    assert.ok(
      matches.length >= 3,
      `expected ≥ 3 inline // MANDATORY comments (one per tier example), got ${matches.length}`
    );
  });

  test('Every Agent({…}) invocation contains a model: field with valid value', () => {
    // Match every Agent({...}) block (greedy across newlines, balanced by `})` close).
    const invRegex = /Agent\s*\(\s*\{[\s\S]*?\}\s*\)/g;
    const invocations = text.match(invRegex) || [];

    assert.ok(
      invocations.length >= 3,
      `expected ≥ 3 Agent({…}) invocations (one per tier), got ${invocations.length}`
    );

    for (const inv of invocations) {
      assert.match(
        inv,
        /model:\s*"(haiku|sonnet|opus)"/,
        `Agent() invocation missing model: field with valid tier:\n${inv.slice(0, 240)}`
      );
    }
  });

  test('All three tiers (haiku, sonnet, opus) have at least one canonical example', () => {
    assert.match(text, /model:\s*"haiku"/,  'no haiku example found');
    assert.match(text, /model:\s*"sonnet"/, 'no sonnet example found');
    assert.match(text, /model:\s*"opus"/,   'no opus example found');
  });
});
