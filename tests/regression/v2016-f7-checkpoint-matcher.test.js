#!/usr/bin/env node
'use strict';

/**
 * W10 — T2 F7 regression: `pattern_record_skip_reason` must be present in
 * the PostToolUse checkpoint matcher in hooks/hooks.json.
 *
 * The pre-v2.0.15 matcher only covered:
 *   pattern_find | kb_search | history_find_similar_tasks | pattern_record_application
 *
 * After v2.0.15 fix (hooks.json:37), `pattern_record_skip_reason` was added.
 *
 * This test locks the full set so no accidental removal goes undetected.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hooksJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../hooks/hooks.json'), 'utf8')
);

function getCheckpointMatcher() {
  const postToolUse = hooksJson.hooks.PostToolUse || [];
  const group = postToolUse.find(g =>
    (g.hooks || []).some(h => (h.command || '').includes('record-mcp-checkpoint.js'))
  );
  return group ? (group.matcher || '') : '';
}

describe('W10 T2 F7 regression — PostToolUse checkpoint matcher completeness', () => {

  const matcher = getCheckpointMatcher();

  test('record-mcp-checkpoint.js PostToolUse group exists', () => {
    assert.ok(matcher.length > 0,
      'PostToolUse must have a group wiring record-mcp-checkpoint.js with a matcher');
  });

  test('matcher includes mcp__orchestray__pattern_record_skip_reason (F7 fix)', () => {
    assert.ok(
      matcher.includes('mcp__orchestray__pattern_record_skip_reason'),
      'pattern_record_skip_reason must be in the PostToolUse checkpoint matcher. ' +
      'Got: ' + matcher
    );
  });

  test('matcher includes all 4 pre-existing enforced tools', () => {
    const required = [
      'mcp__orchestray__pattern_find',
      'mcp__orchestray__kb_search',
      'mcp__orchestray__history_find_similar_tasks',
      'mcp__orchestray__pattern_record_application',
    ];
    for (const tool of required) {
      assert.ok(
        matcher.includes(tool),
        `PostToolUse checkpoint matcher must include "${tool}". Got: ${matcher}`
      );
    }
  });

  test('matcher is a pipe-separated union of exactly the 7 expected tools', () => {
    // Each tool name appears as a segment. We use .split('|') to count.
    // v2.1.12 (R-FPM): routing_lookup and metrics_query added for fields-projected hook coverage.
    const segments = matcher.split('|').map(s => s.trim());
    const expected = new Set([
      'mcp__orchestray__pattern_find',
      'mcp__orchestray__kb_search',
      'mcp__orchestray__history_find_similar_tasks',
      'mcp__orchestray__pattern_record_application',
      'mcp__orchestray__pattern_record_skip_reason',
      'mcp__orchestray__routing_lookup',
      'mcp__orchestray__metrics_query',
    ]);
    for (const seg of segments) {
      assert.ok(expected.has(seg),
        `Unexpected tool in checkpoint matcher: "${seg}"`);
    }
    for (const exp of expected) {
      assert.ok(segments.includes(exp),
        `Expected tool missing from checkpoint matcher: "${exp}"`);
    }
  });

});
