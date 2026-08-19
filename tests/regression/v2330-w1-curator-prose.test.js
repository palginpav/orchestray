#!/usr/bin/env node
'use strict';

/**
 * Regression tests for v2.3.30 W1 D4 — curator prose must stop describing an
 * impossible action (Write to the shared tier / invoking bin/_lib/shared-promote.js
 * directly, neither of which the curator's grants permit).
 *
 * These are anti-inertness tests: they matter more than the functional gate
 * tests because a prose fix that quietly leaves a second stale instruction
 * intact is the exact failure mode this task exists to close.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CURATOR_MD = path.join(ROOT, 'agents', 'curator.md');
const CURATOR_STAGES_DIR = path.join(ROOT, 'agents', 'curator-stages');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function listStageFiles() {
  return fs.readdirSync(CURATOR_STAGES_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => path.join(CURATOR_STAGES_DIR, f));
}

describe('v2330-w1 — curator.md grants pattern_promote', () => {
  test('tools: line includes mcp__orchestray__pattern_promote', () => {
    const body = readFile(CURATOR_MD);
    const toolsLine = body.split('\n').find(l => l.startsWith('tools:'));
    assert.ok(toolsLine, 'curator.md must have a tools: frontmatter line');
    assert.match(toolsLine, /mcp__orchestray__pattern_promote/);
  });

  test('Write and Edit remain granted (local writes are still legitimate)', () => {
    const body = readFile(CURATOR_MD);
    const toolsLine = body.split('\n').find(l => l.startsWith('tools:'));
    assert.match(toolsLine, /\bWrite\b/);
    assert.match(toolsLine, /\bEdit\b/);
  });
});

describe('v2330-w1 — grant/instruction parity: every mcp__orchestray__* token in curator-stages/*.md is granted', () => {
  test('no ungranted mcp__orchestray__* tool mentioned in curator stage prose', () => {
    const body = readFile(CURATOR_MD);
    const toolsLine = body.split('\n').find(l => l.startsWith('tools:')) || '';
    const grantedTools = toolsLine
      .replace(/^tools:\s*/, '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const grantedMcp = new Set(grantedTools.filter(t => t.startsWith('mcp__orchestray__')));

    const mentionRe = /mcp__orchestray__[a-zA-Z0-9_]+/g;
    const missing = [];
    for (const file of listStageFiles()) {
      const text = readFile(file);
      const mentions = new Set(text.match(mentionRe) || []);
      for (const m of mentions) {
        if (!grantedMcp.has(m)) {
          missing.push(`${m} (in ${path.basename(file)}, not in curator.md tools:)`);
        }
      }
    }
    assert.deepEqual(missing, [], 'every mcp__orchestray__* tool mentioned in curator-stages/*.md must be granted in curator.md tools:');
  });
});

describe('v2330-w1 — no stale instruction to invoke bin/_lib/shared-promote.js directly', () => {
  // Mentioning the module name as background context ("wraps
  // bin/_lib/shared-promote.js") is fine — the defect is an INSTRUCTION to
  // run/invoke it, which the curator cannot do (no Bash, cannot require()).
  const INSTRUCTIVE_RE = /(run|invoke|call|execute)[^.\n]{0,40}bin\/_lib\/shared-promote\.js/i;

  test('curator-stages/*.md contain no instruction to run shared-promote.js', () => {
    const offenders = [];
    for (const file of listStageFiles()) {
      const text = readFile(file);
      if (INSTRUCTIVE_RE.test(text)) {
        offenders.push(path.basename(file));
      }
    }
    assert.deepEqual(offenders, [], 'no curator-stages file may instruct invoking shared-promote.js directly (the curator has no Bash and cannot require() it)');
  });

  test('phase-execute.md promote section names the MCP tool, not a direct Write', () => {
    const text = readFile(path.join(CURATOR_STAGES_DIR, 'phase-execute.md'));
    assert.match(text, /mcp__orchestray__pattern_promote/);
    assert.match(text, /result:\s*"blocked"/);
    assert.match(text, /retryable_after_edit/);
  });
});

describe('v2330-w1 — blocked-result handling is explicit about no-retry', () => {
  test('phase-execute.md instructs NOT retrying when retryable_after_edit is false', () => {
    const text = readFile(path.join(CURATOR_STAGES_DIR, 'phase-execute.md'));
    assert.match(text, /do not retry/i);
    assert.match(text, /operator\s+decision/i);
  });
});
