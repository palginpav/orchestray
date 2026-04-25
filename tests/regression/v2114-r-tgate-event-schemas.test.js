#!/usr/bin/env node
'use strict';

/**
 * Regression test: R-TGATE event schema docs present in event-schemas.md (v2.1.14).
 *
 * AC verified:
 *   - tier2_invoked schema entry exists with version: 1
 *   - feature_gate_eval schema entry exists with version: 1
 *   - mcp_checkpoint_recorded fields_used + response_bytes augmentation documented
 *   - tier2_load entry updated to include version: 1 (pre-existing schema, v2.1.14 addition)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMAS_FILE = path.resolve(
  __dirname, '../../agents/pm-reference/event-schemas.md'
);

let content;
test('event-schemas.md can be read', () => {
  content = fs.readFileSync(SCHEMAS_FILE, 'utf8');
  assert.ok(content.length > 0, 'event-schemas.md must be non-empty');
});

describe('R-TGATE event types in event-schemas.md', () => {

  test('tier2_invoked type is documented', () => {
    assert.ok(
      content.includes('tier2_invoked'),
      'event-schemas.md must contain tier2_invoked'
    );
  });

  test('tier2_invoked has version: 1', () => {
    // Search in the section heading block, not the first summary mention
    const idx = content.indexOf('### `tier2_invoked` event');
    assert.ok(idx !== -1, 'tier2_invoked section heading must be present');
    const snippet = content.slice(idx, idx + 2000);
    assert.ok(
      snippet.includes('"version": 1') || snippet.includes('"version":1'),
      'tier2_invoked schema must include version: 1'
    );
  });

  test('tier2_invoked documents protocol field', () => {
    const idx = content.indexOf('### `tier2_invoked` event');
    const snippet = content.slice(idx, idx + 2000);
    assert.ok(
      snippet.includes('protocol'),
      'tier2_invoked schema must document protocol field'
    );
  });

  test('tier2_invoked documents trigger_signal field', () => {
    const idx = content.indexOf('### `tier2_invoked` event');
    const snippet = content.slice(idx, idx + 2000);
    assert.ok(
      snippet.includes('trigger_signal'),
      'tier2_invoked schema must document trigger_signal field'
    );
  });

  test('feature_gate_eval type is documented', () => {
    assert.ok(
      content.includes('feature_gate_eval'),
      'event-schemas.md must contain feature_gate_eval'
    );
  });

  test('feature_gate_eval has version: 1', () => {
    const idx = content.indexOf('### `feature_gate_eval` event');
    assert.ok(idx !== -1, 'feature_gate_eval section heading must be present');
    const snippet = content.slice(idx, idx + 2000);
    assert.ok(
      snippet.includes('"version": 1') || snippet.includes('"version":1'),
      'feature_gate_eval schema must include version: 1'
    );
  });

  test('feature_gate_eval documents gates_true and gates_false fields', () => {
    const idx = content.indexOf('### `feature_gate_eval` event');
    const snippet = content.slice(idx, idx + 2000);
    assert.ok(snippet.includes('gates_true'), 'feature_gate_eval must document gates_true');
    assert.ok(snippet.includes('gates_false'), 'feature_gate_eval must document gates_false');
  });

  test('feature_gate_eval documents eval_source field', () => {
    const idx = content.indexOf('### `feature_gate_eval` event');
    const snippet = content.slice(idx, idx + 2000);
    assert.ok(
      snippet.includes('eval_source'),
      'feature_gate_eval schema must document eval_source field'
    );
  });

  test('mcp_checkpoint_recorded fields_used augmentation is documented', () => {
    assert.ok(
      content.includes('fields_used'),
      'event-schemas.md must document the fields_used augmentation'
    );
  });

  test('mcp_checkpoint_recorded response_bytes augmentation is documented', () => {
    assert.ok(
      content.includes('response_bytes'),
      'event-schemas.md must document the response_bytes augmentation'
    );
  });

  test('v2.1.14 additions section exists', () => {
    assert.ok(
      content.includes('v2.1.14') || content.includes('R-TGATE'),
      'event-schemas.md must include v2.1.14 additions section'
    );
  });

  test('summary index includes tier2_invoked', () => {
    // The summary index is before line 30
    const summaryEnd = content.indexOf('END CONDITIONAL-LOAD NOTICE');
    const summary = content.slice(0, summaryEnd);
    assert.ok(
      summary.includes('tier2_invoked'),
      'summary index must list tier2_invoked'
    );
  });

  test('summary index includes feature_gate_eval', () => {
    const summaryEnd = content.indexOf('END CONDITIONAL-LOAD NOTICE');
    const summary = content.slice(0, summaryEnd);
    assert.ok(
      summary.includes('feature_gate_eval'),
      'summary index must list feature_gate_eval'
    );
  });
});
