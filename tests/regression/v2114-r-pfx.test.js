#!/usr/bin/env node
'use strict';

/**
 * v2.1.14 R-PFX regression tests.
 *
 * Asserts:
 *   1. Each of the 5 agent prompts contains the fields: convention text for pattern_find.
 *   2. Each of the 5 agent prompts contains the fields: convention text for kb_search.
 *   3. agents/reviewer.md contains the reviewer-exception sentence.
 *   4. agents/pm-reference/handoff-contract.md documents the MCP projection conventions.
 *   5. bin/mcp-server/tools/pattern_find.js contains the literal `fields_used` annotation.
 *   6. bin/mcp-server/tools/kb_search.js contains the literal `fields_used` annotation.
 *   7. bin/record-mcp-checkpoint.js writes `fields_used` to the checkpoint row.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

// ---------------------------------------------------------------------------
// 1-3. Agent prompt convention text
// ---------------------------------------------------------------------------

const AGENTS_WITH_KB_SEARCH = [
  'agents/architect.md',
  'agents/developer.md',
  'agents/researcher.md',
  'agents/reviewer.md',
];

const AGENTS_WITH_PATTERN_FIND = [
  'agents/architect.md',
  'agents/developer.md',
  'agents/researcher.md',
  'agents/debugger.md',
  'agents/reviewer.md',
];

describe('R-PFX: agent prompts contain fields: convention', () => {
  for (const agentPath of AGENTS_WITH_PATTERN_FIND) {
    test(agentPath + ' — pattern_find default projection', () => {
      const content = readFile(agentPath);
      assert.ok(
        content.includes('fields: ["slug", "confidence", "one_line"]'),
        agentPath + ' must contain pattern_find default fields projection'
      );
    });
  }

  for (const agentPath of AGENTS_WITH_KB_SEARCH) {
    test(agentPath + ' — kb_search default projection', () => {
      const content = readFile(agentPath);
      assert.ok(
        content.includes('fields: ["uri", "section", "excerpt"]'),
        agentPath + ' must contain kb_search default fields projection'
      );
    });
  }

  test('agents/reviewer.md — reviewer exception sentence present', () => {
    const content = readFile('agents/reviewer.md');
    assert.ok(
      content.includes('accuracy audits') || content.includes('pattern correctness'),
      'reviewer.md must contain the accuracy-audit exception for full-body pattern reads'
    );
    assert.ok(
      content.includes('fields: null') || content.includes('omitting `fields`'),
      'reviewer.md must describe how to request full bodies (fields: null or omit fields)'
    );
  });
});

// ---------------------------------------------------------------------------
// 4. handoff-contract.md documents the convention
// ---------------------------------------------------------------------------

describe('R-PFX: handoff-contract.md has MCP projection section', () => {
  test('contains MCP projection conventions section', () => {
    const content = readFile('agents/pm-reference/handoff-contract.md');
    assert.ok(
      content.includes('MCP projection conventions') || content.includes('mcp projection'),
      'handoff-contract.md must have an MCP projection conventions section'
    );
  });

  test('documents default fields for pattern_find', () => {
    const content = readFile('agents/pm-reference/handoff-contract.md');
    assert.ok(
      content.includes('pattern_find'),
      'handoff-contract.md must mention pattern_find in MCP conventions'
    );
    assert.ok(
      content.includes('"slug"') && content.includes('"confidence"') && content.includes('"one_line"'),
      'handoff-contract.md must document the pattern_find default fields'
    );
  });

  test('documents default fields for kb_search', () => {
    const content = readFile('agents/pm-reference/handoff-contract.md');
    assert.ok(
      content.includes('kb_search'),
      'handoff-contract.md must mention kb_search in MCP conventions'
    );
    assert.ok(
      content.includes('"uri"') && content.includes('"section"') && content.includes('"excerpt"'),
      'handoff-contract.md must document the kb_search default fields'
    );
  });

  test('documents the follow-up full-body call pattern', () => {
    const content = readFile('agents/pm-reference/handoff-contract.md');
    assert.ok(
      content.includes('follow-up') || content.includes('second call') || content.includes('follow up'),
      'handoff-contract.md must describe the follow-up full-body call pattern'
    );
  });

  test('documents reviewer exception', () => {
    const content = readFile('agents/pm-reference/handoff-contract.md');
    assert.ok(
      content.includes('Reviewer exception') || content.includes('reviewer') && content.includes('exception'),
      'handoff-contract.md must document the reviewer exception'
    );
  });
});

// ---------------------------------------------------------------------------
// 5-6. Tool source files contain fields_used annotation
// ---------------------------------------------------------------------------

describe('R-PFX: tool source files contain fields_used annotation', () => {
  test('pattern_find.js contains fields_used reference', () => {
    const content = readFile('bin/mcp-server/tools/pattern_find.js');
    assert.ok(
      content.includes('fields_used'),
      'pattern_find.js must contain the literal string fields_used'
    );
  });

  test('kb_search.js contains fields_used reference', () => {
    const content = readFile('bin/mcp-server/tools/kb_search.js');
    assert.ok(
      content.includes('fields_used'),
      'kb_search.js must contain the literal string fields_used'
    );
  });
});

// ---------------------------------------------------------------------------
// 7. record-mcp-checkpoint.js writes fields_used to the checkpoint row
// ---------------------------------------------------------------------------

describe('R-PFX: record-mcp-checkpoint.js writes fields_used', () => {
  test('source contains fields_used in row construction', () => {
    const content = readFile('bin/record-mcp-checkpoint.js');
    assert.ok(
      content.includes('fields_used'),
      'record-mcp-checkpoint.js must write fields_used to the checkpoint row'
    );
    // Verify it is assigned in the row object (not just mentioned in a comment).
    assert.ok(
      /fields_used[,\s]/.test(content) || content.includes('fields_used,'),
      'record-mcp-checkpoint.js must include fields_used as a property of the checkpoint row'
    );
  });

  test('fields_used logic handles array fields correctly', () => {
    const content = readFile('bin/record-mcp-checkpoint.js');
    // Verify the logic handles both string and array forms of `fields`
    assert.ok(
      content.includes('Array.isArray(rawFields)'),
      'record-mcp-checkpoint.js must handle array form of fields parameter'
    );
  });
});
