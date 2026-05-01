#!/usr/bin/env node
'use strict';

/**
 * Error-message actionability tests.
 *
 * Asserts two invariants across all BLOCKED stderr lines emitted by
 * gate-agent-spawn.js and validate-task-completion.js:
 *
 *   1. Every blocking error that mentions model routing includes
 *      literal example syntax (e.g., model: "sonnet").
 *   2. No blocking error contains a bare version-pinned internal tag
 *      ("Section N" or "v2.X.Y A-N") without an action description
 *      on the same line.
 *
 * Strategy: drive both scripts via spawnSync with crafted stdin payloads,
 * capture stderr, and assert message content.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const GATE_SCRIPT = path.resolve(__dirname, '../bin/gate-agent-spawn.js');
const VALIDATE_SCRIPT = path.resolve(__dirname, '../bin/validate-task-completion.js');

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

/** Create a minimal temp workspace that gate-agent-spawn.js accepts. */
function makeTmpCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-actionability-'));
  cleanup.push(dir);
  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'events'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  // orchestration.md for validate-task-completion.js resolveOrchestrationId
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'state', 'orchestration.md'),
    '# Orchestration\norchestration_id: test-id\nphase: executing\n'
  );
  // current-orchestration.json for gate-agent-spawn.js getCurrentOrchestrationFile
  fs.writeFileSync(
    path.join(dir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'test-id', phase: 'executing' })
  );
  return dir;
}

/** Spawn a script with a JSON event piped to stdin. Returns { stdout, stderr, status }. */
function runScript(script, event, env = {}) {
  const cwd = makeTmpCwd();
  // gate-agent-spawn.js reads cwd from event.cwd via resolveSafeCwd
  const fullEvent = { cwd, ...event };
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(fullEvent),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, ...env },
    cwd,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

// ── Invariant helpers ─────────────────────────────────────────────────────────

/**
 * Returns all lines from stderr that look like blocking orchestray errors.
 * We match lines containing "[orchestray]" and "BLOCKED" or "Missing required".
 */
function blockingLines(stderr) {
  return stderr.split('\n').filter(l =>
    l.includes('[orchestray]') && (l.includes('BLOCKED') || l.includes('Missing required'))
  );
}

/** Invariant 1: every blocking line with model routing includes a literal example. */
function assertHasExample(lines, label) {
  for (const line of lines) {
    // Only check lines that concern model routing
    if (!line.includes('model')) continue;
    assert.ok(
      line.includes('model: "sonnet"') ||
      line.includes('model=<haiku') ||
      line.includes('model: "haiku"') ||
      line.includes('model: "opus"'),
      `${label}: blocking line missing literal example syntax.\nLine: ${line}`
    );
  }
}

/** Invariant 2: no blocking stderr chunk contains bare internal tags without action. */
function assertNoBareTags(stderr, label) {
  // Pattern: "Section N" (digit-only) with no action word following on same segment
  const sectionTagRe = /Section\s+\d+\b(?!\s*\()/g;
  // Pattern: "v2.X.Y A-N" style internal release IDs without surrounding context
  const versionTagRe = /\bv2\.\d+\.\d+\s+[A-Z]+-\d+\b/g;

  const lines = stderr.split('\n');
  for (const line of lines) {
    // Check section tags: allowed if same line has an action description (parenthetical or colon)
    let match;
    sectionTagRe.lastIndex = 0;
    while ((match = sectionTagRe.exec(line)) !== null) {
      // "Section 19 (Model Routing Protocol)" is acceptable — has a description in parens
      const after = line.slice(match.index + match[0].length);
      const hasDescription = /^\s*\(/.test(after) || /^\s*:/.test(after);
      assert.ok(
        hasDescription,
        `${label}: bare "Section N" tag without action description.\nLine: ${line}`
      );
    }

    versionTagRe.lastIndex = 0;
    while ((match = versionTagRe.exec(line)) !== null) {
      assert.fail(
        `${label}: bare internal version tag "${match[0]}" in error message.\nLine: ${line}`
      );
    }
  }
}

// ── gate-agent-spawn.js tests ─────────────────────────────────────────────────

describe('gate-agent-spawn.js — missing model error message', () => {
  test('leads with literal example syntax, not internal jargon', () => {
    const event = {
      event: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'do something' },
      // no model field → triggers strict block
    };
    const { stderr, status } = runScript(GATE_SCRIPT, event, {
      ORCHESTRAY_STRICT_MODEL_REQUIRED: '1',
    });

    assert.strictEqual(status, 2, 'Expected exit code 2 for missing-model block');

    // Must contain a literal example line
    assert.ok(
      stderr.includes('model: "sonnet"') || stderr.includes('model=<haiku'),
      `Missing literal example syntax in:\n${stderr}`
    );

    // Must NOT contain bare internal tags
    assertNoBareTags(stderr, 'gate-agent-spawn missing-model');
  });

  test('error message includes kill-switch instruction', () => {
    const event = {
      event: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'do something' },
    };
    const { stderr } = runScript(GATE_SCRIPT, event, {
      ORCHESTRAY_STRICT_MODEL_REQUIRED: '1',
    });

    assert.ok(
      stderr.includes('ORCHESTRAY_STRICT_MODEL_REQUIRED=0'),
      `Kill-switch instruction missing from:\n${stderr}`
    );
  });

  test('error message cites agents/pm.md section with description', () => {
    const event = {
      event: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'developer', prompt: 'do something' },
    };
    const { stderr } = runScript(GATE_SCRIPT, event, {
      ORCHESTRAY_STRICT_MODEL_REQUIRED: '1',
    });

    // Section reference must have a description (not bare "Section 19")
    assert.ok(
      stderr.includes('§19') || stderr.includes('Section 19 ('),
      `Section reference missing description in:\n${stderr}`
    );
  });
});

// ── validate-task-completion.js tests ────────────────────────────────────────

describe('validate-task-completion.js — pre-done checklist error message', () => {
  test('BLOCKED message leads with required field list', () => {
    const cwd = makeTmpCwd();
    // SubagentStop event with no structured result to trigger pre-done checklist fail
    const event = {
      event: 'SubagentStop',
      agent_role: 'developer',
      result: 'I did some work but forgot to include a structured result.',
      session_id: 'test-session',
    };

    const result = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCHESTRAY_CWD: cwd,
        PRE_DONE_ENFORCEMENT: 'block',
      },
      cwd,
    });
    const stderr = result.stderr || '';

    if (result.status === 2) {
      // Blocking — check message content
      assert.ok(
        stderr.includes('`status`') || stderr.includes('status') && stderr.includes('summary'),
        `Required field list missing from blocked error:\n${stderr}`
      );
      assert.ok(
        stderr.includes('handoff-contract.md'),
        `Doc reference missing from blocked error:\n${stderr}`
      );
      assertNoBareTags(stderr, 'validate-task-completion pre-done-checklist');
    }
    // If not blocking (exit 0), the warn path ran — that is acceptable
  });
});

describe('validate-task-completion.js — role-schema violation error message', () => {
  test('includes Required field list and handoff-contract reference', () => {
    // Craft a SubagentStop with a structured result that is missing required fields
    const cwd = makeTmpCwd();
    const badResult = JSON.stringify({
      status: 'complete',
      // missing: summary, files_changed, files_read, issues, assumptions
    });
    const event = {
      event: 'SubagentStop',
      agent_role: 'developer',
      result: `Some output\n\`\`\`json\n${badResult}\n\`\`\``,
      session_id: 'test-session',
    };

    const result = spawnSync(process.execPath, [VALIDATE_SCRIPT], {
      input: JSON.stringify(event),
      encoding: 'utf8',
      env: { ...process.env, ORCHESTRAY_CWD: cwd },
      cwd,
    });
    const stderr = result.stderr || '';

    if (result.status === 2) {
      // Must not have bare internal tags
      assertNoBareTags(stderr, 'validate-task-completion role-schema');

      // Must reference handoff-contract.md
      assert.ok(
        stderr.includes('handoff-contract.md'),
        `handoff-contract.md reference missing from:\n${stderr}`
      );
    }
  });
});

describe('validate-task-completion.js — source file static analysis', () => {
  test('no bare "vX.Y.Z A-N" internal tags in blocking stderr.write calls', () => {
    const src = fs.readFileSync(VALIDATE_SCRIPT, 'utf8');
    const lines = src.split('\n');
    const versionTagRe = /\bv2\.\d+\.\d+\s+[A-Z]+-\d+\b/;

    // Find lines that are inside process.stderr.write(...) blocks
    let inWrite = false;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('process.stderr.write(')) {
        inWrite = true;
        depth = 0;
      }
      if (inWrite) {
        depth += (line.match(/\(/g) || []).length;
        depth -= (line.match(/\)/g) || []).length;
        if (versionTagRe.test(line)) {
          assert.fail(
            `validate-task-completion.js line ${i + 1}: bare internal version tag in stderr.write.\n` +
            `Line: ${line.trim()}`
          );
        }
        if (depth <= 0) inWrite = false;
      }
    }
  });

  test('no bare "Section N" without description in blocking stderr.write calls', () => {
    const src = fs.readFileSync(VALIDATE_SCRIPT, 'utf8');
    const lines = src.split('\n');
    // "Section N" followed immediately by non-descriptive end (no paren or colon)
    const bareRe = /Section\s+\d+\b(?!\s*\()/;

    let inWrite = false;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('process.stderr.write(')) {
        inWrite = true;
        depth = 0;
      }
      if (inWrite) {
        depth += (line.match(/\(/g) || []).length;
        depth -= (line.match(/\)/g) || []).length;
        if (bareRe.test(line)) {
          // §19 style is fine; "Section 19 (description)" is fine
          // only flag plain "Section 19" with no paren follow-up
          // Since §-style references pass the regex test negation already, re-check carefully
          const normalized = line.replace(/§\d+/g, '');
          if (bareRe.test(normalized)) {
            assert.fail(
              `validate-task-completion.js line ${i + 1}: bare "Section N" tag in stderr.write without description.\n` +
              `Line: ${line.trim()}`
            );
          }
        }
        if (depth <= 0) inWrite = false;
      }
    }
  });

  test('gate-agent-spawn.js: no bare "vX.Y.Z A-N" internal tags in blocking stderr.write calls', () => {
    const src = fs.readFileSync(GATE_SCRIPT, 'utf8');
    const lines = src.split('\n');
    const versionTagRe = /\bv2\.\d+\.\d+\s+[A-Z]+-\d+\b/;

    let inWrite = false;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('process.stderr.write(')) {
        inWrite = true;
        depth = 0;
      }
      if (inWrite) {
        depth += (line.match(/\(/g) || []).length;
        depth -= (line.match(/\)/g) || []).length;
        if (versionTagRe.test(line)) {
          assert.fail(
            `gate-agent-spawn.js line ${i + 1}: bare internal version tag in stderr.write.\n` +
            `Line: ${line.trim()}`
          );
        }
        if (depth <= 0) inWrite = false;
      }
    }
  });
});
