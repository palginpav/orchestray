#!/usr/bin/env node
'use strict';

/**
 * anti-pattern-agent-output-fields-parity.test.js — recurrence guard (2026-08-08).
 *
 * Mechanises anti-pattern `half-shipped-enum`. This is the SECOND time this
 * repo has fixed "the agent's raw output field precedence" — first in
 * `validate-claim-evidence.js`/`claim-rules.js` (v2.3.19 W1: discovered that
 * `last_assistant_message` is the only field a live PostToolUse:Agent /
 * SubagentStop payload ever sets, and `result`/`output`/`agent_output`
 * appear on zero harvested production payloads), then again here after
 * `bin/validate-pattern-ack.js` and (four separate times within)
 * `bin/validate-task-completion.js` each carried a private copy of the same
 * precedence list, none of which included `last_assistant_message`.
 *
 * `bin/_lib/claim-rules.js` owns the one definition (`RAW_OUTPUT_FIELDS` /
 * `rawOutputText`). This test:
 *   1. Scans the four sites named in the fix for a private re-declaration of
 *      the field-precedence list, so a manual fix that skips the shared
 *      helper (or a future edit that reintroduces one) is caught mechanically
 *      instead of relying on review.
 *   2. Asserts the canonical list still puts `last_assistant_message` first
 *      — the actual fix, not just "the field is present somewhere".
 *   3. Synthetic-fixture coverage of the scan regex itself (positive/negative).
 *
 * Known, NOT-yet-fixed survivors of the same defect class outside this fix's
 * ownership scope (reported, not remediated here — see the developer's
 * Structured Result `issues`): `bin/feature-auto-release.js`
 * (`event.tool_result || event.output || event.result`) and
 * `bin/validate-commit-handoff.js` (`event.result || event.output` fallback
 * after `event.tool_response.output`/`.text`). Neither is in SCANNED_FILES
 * below — this guard's scope is the four files the 2026-08-08 fix touched,
 * not a repo-wide sweep. Add a file to SCANNED_FILES when it is fixed.
 *
 * Kill switch: none — this is a static source scan, not a runtime hook; it
 * cannot affect a live spawn. Follows the HARD-BLOCK convention of
 * anti-pattern-event-types-enum-parity.test.js.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const path               = require('node:path');

const { RAW_OUTPUT_FIELDS, rawOutputText } = require('../_lib/claim-rules');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The four sites the 2026-08-08 fix touched. bin/_lib/claim-rules.js is the
// canonical owner (declares the list once, legitimately) and is deliberately
// excluded from the "no private list" scan.
const SCANNED_FILES = [
  'bin/validate-pattern-ack.js',
  'bin/validate-task-completion.js',
  'bin/audit-housekeeper-action.js',
];

// ---------------------------------------------------------------------------
// Scan helpers
// ---------------------------------------------------------------------------

/**
 * Strip `/* ... *\/` block comments and full-line `//` comments before
 * scanning, so prose describing the field names (e.g. this file's own
 * docstring, or the module headers the fix added) does not self-trigger.
 * Not a full JS tokenizer — adequate for a source-text lint, matching the
 * house convention (anti-pattern-event-types-enum-parity.test.js).
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  return out;
}

// Two of the five raw-output field names, adjacent and joined by `,` or
// `||` — the shape of both `[event.result, event.output, ...]` array
// literals and `event.result || event.output || ...` chains. This is the
// mechanical signature of "reconstructing the precedence list by hand"
// instead of calling `rawOutputText(event)`.
const FIELD_NAMES = 'last_assistant_message|result|output|agent_output|tool_response';
const PAIR_RE = new RegExp(
  'event\\.(?:' + FIELD_NAMES + ')\\s*(?:,|\\|\\|)\\s*event\\.(?:' + FIELD_NAMES + ')'
);

/**
 * @param {string} src - already comment-stripped
 * @returns {string[]} matched snippets, empty when clean
 */
function findPrivateFieldLists(src) {
  const matches = src.match(new RegExp(PAIR_RE.source, 'g'));
  return matches || [];
}

// ---------------------------------------------------------------------------
// Real-source tests (HARD-BLOCK)
// ---------------------------------------------------------------------------

describe('agent-output-fields-parity: real source', () => {
  test('claim-rules.js RAW_OUTPUT_FIELDS still leads with last_assistant_message', () => {
    assert.ok(Array.isArray(RAW_OUTPUT_FIELDS) && RAW_OUTPUT_FIELDS.length > 0);
    assert.strictEqual(
      RAW_OUTPUT_FIELDS[0],
      'last_assistant_message',
      'last_assistant_message must stay first — the only field a live payload sets (v2.3.19 W1)'
    );
    assert.ok(RAW_OUTPUT_FIELDS.includes('result'));
    assert.ok(RAW_OUTPUT_FIELDS.includes('output'));
    assert.ok(RAW_OUTPUT_FIELDS.includes('agent_output'));
  });

  test('rawOutputText prefers last_assistant_message over every legacy field', () => {
    const event = {
      last_assistant_message: 'the real testimony',
      result: 'stale', output: 'stale', agent_output: 'stale',
    };
    assert.strictEqual(rawOutputText(event), 'the real testimony');
  });

  for (const rel of SCANNED_FILES) {
    test(rel + ': no private agent-output field-precedence list', () => {
      const abs = path.join(REPO_ROOT, rel);
      assert.ok(fs.existsSync(abs), rel + ' must exist');
      const src = stripComments(fs.readFileSync(abs, 'utf8'));
      const found = findPrivateFieldLists(src);
      assert.deepStrictEqual(
        found,
        [],
        rel + ' re-declares the agent-output field list privately instead of using ' +
        "claim-rules.js#rawOutputText: " + JSON.stringify(found)
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Synthetic fixture tests (regex correctness, independent of real source)
// ---------------------------------------------------------------------------

describe('agent-output-fields-parity: synthetic fixtures', () => {
  test('positive: array-literal re-declaration is caught', () => {
    const src = "const raw = [event.result, event.output, event.agent_output].find(v => v);";
    assert.strictEqual(findPrivateFieldLists(src).length, 1);
  });

  test('positive: ||-chain re-declaration is caught', () => {
    const src = "const raw = event.result || event.output || event.agent_output || null;";
    assert.strictEqual(findPrivateFieldLists(src).length, 1);
  });

  test('positive: the exact pre-fix tool_response-led list is caught', () => {
    const src = "[event.tool_response, event.output, event.result, event.agent_output].find(v => typeof v === 'string')";
    assert.ok(findPrivateFieldLists(src).length >= 1);
  });

  test('negative: a single field reference alone is not flagged', () => {
    const src = "const raw = event.result;";
    assert.strictEqual(findPrivateFieldLists(src).length, 0);
  });

  test('negative: calling the shared helper is not flagged', () => {
    const src = "const raw = rawOutputText(event) || '';";
    assert.strictEqual(findPrivateFieldLists(src).length, 0);
  });

  test('negative: prose describing the fields in a block comment is stripped first', () => {
    const src = [
      '/**',
      ' * Uses [event.result, event.output, event.agent_output] historically.',
      ' */',
      "const raw = rawOutputText(event);",
    ].join('\n');
    assert.strictEqual(findPrivateFieldLists(stripComments(src)).length, 0);
  });

  test('negative: prose describing the fields in line comments is stripped first', () => {
    const src = [
      '// old list was [event.result, event.output, event.agent_output]',
      "const raw = rawOutputText(event);",
    ].join('\n');
    assert.strictEqual(findPrivateFieldLists(stripComments(src)).length, 0);
  });

  test('edge: unrelated array with only one matching field is not flagged', () => {
    const src = "const x = [event.result, event.status, event.session_id];";
    assert.strictEqual(findPrivateFieldLists(src).length, 0);
  });
});
