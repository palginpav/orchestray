'use strict';

/**
 * security-paths-parity.test.js — W-SE-1 parity + W-AC-4 enforcement tests.
 *
 * Sub-test 1: pm.md §3.RV references the canonical source (no inline list).
 * Sub-test 2: classify-review-dimensions.js imports SECURITY_SENSITIVE_PATHS
 *             (no local duplicate array).
 * Sub-test 3: gate-agent-spawn blocks a non-PM agent with Agent() in tools.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Sub-test 1: pm.md §3.RV references canonical source, not an inline list
// ---------------------------------------------------------------------------

test('pm.md §3.RV references bin/_lib/security-sensitive-paths.js as canonical source', () => {
  const pmPath = path.join(ROOT, 'agents', 'pm.md');
  const pmContent = fs.readFileSync(pmPath, 'utf8');

  // Find the §3.RV security-sensitive block (decision tree rule 3).
  const rvBlockMatch = pmContent.match(
    /3\.\s+\*\*Security-sensitive paths present\*\*([\s\S]*?)(?=\n\d+\.|\n##)/
  );
  assert.ok(rvBlockMatch, 'pm.md must contain a Rule 3 security-sensitive paths block');

  const rvBlock = rvBlockMatch[1];

  // Must reference the canonical source file.
  assert.ok(
    rvBlock.includes('security-sensitive-paths.js'),
    'pm.md §3.RV must reference bin/_lib/security-sensitive-paths.js as canonical source'
  );

  // Must NOT use the old format where the inline list was the ONLY authority
  // (no canonical source reference). The new format references the JS file first.
  // Verify the JS file reference comes before the path examples.
  const jsRefPos = rvBlock.indexOf('security-sensitive-paths.js');
  const authPos = rvBlock.indexOf('auth/');
  assert.ok(
    jsRefPos !== -1 && (authPos === -1 || jsRefPos < authPos),
    'pm.md §3.RV must reference security-sensitive-paths.js before any path examples'
  );
});

// ---------------------------------------------------------------------------
// Sub-test 2: classify-review-dimensions.js imports from security-sensitive-paths.js
// ---------------------------------------------------------------------------

test('classify-review-dimensions.js imports SECURITY_SENSITIVE_PATHS (no local duplicate)', () => {
  const classifyPath = path.join(ROOT, 'bin', '_lib', 'classify-review-dimensions.js');
  const classifyContent = fs.readFileSync(classifyPath, 'utf8');

  // Must import from the canonical module.
  assert.ok(
    classifyContent.includes("require('./security-sensitive-paths')"),
    "classify-review-dimensions.js must require('./security-sensitive-paths')"
  );

  // Must NOT contain a local SECURITY_PATH_PATTERNS array literal definition.
  // A local definition would be an array starting with `= [` after the constant name.
  const hasLocalArrayDef = /const SECURITY_PATH_PATTERNS\s*=\s*\[/.test(classifyContent);
  assert.ok(
    !hasLocalArrayDef,
    'classify-review-dimensions.js must not define a local SECURITY_PATH_PATTERNS array'
  );

  // Sanity: the module must still export classifyReviewDimensions and work.
  const { classifyReviewDimensions } = require(classifyPath);
  assert.equal(typeof classifyReviewDimensions, 'function',
    'classifyReviewDimensions must still be exported and be a function');

  // Spot-check: a security-sensitive path still triggers rule 3.
  const result = classifyReviewDimensions({
    files_changed: ['src/auth/login.js'],
  });
  assert.deepEqual(result.review_dimensions, ['code-quality', 'operability', 'api-compat'],
    'security-sensitive path must still trigger rule 3 after refactor');
});

// ---------------------------------------------------------------------------
// Sub-test 3: gate-agent-spawn blocks non-PM/non-curate-runner Agent() call
// ---------------------------------------------------------------------------

describe('gate-agent-spawn non-PM agent block (W-AC-4)', () => {
  const SCRIPT = path.resolve(ROOT, 'bin', 'gate-agent-spawn.js');

  // Helper: link schemas into a sandbox dir (mirrors gate-agent-spawn.test.js).
  function linkSchemas(dir) {
    const schemaDir = path.join(ROOT, 'agents', 'pm-reference');
    const sandboxSchemaDir = path.join(dir, 'agents', 'pm-reference');
    fs.mkdirSync(sandboxSchemaDir, { recursive: true });
    for (const f of ['event-schemas.md', 'event-schemas.shadow.json']) {
      const src = path.join(schemaDir, f);
      const dst = path.join(sandboxSchemaDir, f);
      try { fs.symlinkSync(src, dst); }
      catch (_e) { try { fs.copyFileSync(src, dst); } catch (_e2) {} }
    }
  }

  function makeDir({ withOrch = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nonpm-test-'));
    if (withOrch) {
      const auditDir = path.join(dir, '.orchestray', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      const stateDir = path.join(dir, '.orchestray', 'state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'current-orchestration.json'),
        JSON.stringify({ orchestration_id: 'orch-test-001', phase: 'execute', current_group: 1 }),
        'utf8'
      );
    }
    linkSchemas(dir);
    return dir;
  }

  function runGate(dir, event) {
    const result = spawnSync(
      process.execPath,
      [SCRIPT],
      {
        input: JSON.stringify(event),
        encoding: 'utf8',
        env: {
          ...process.env,
          // Disable model-required check to isolate the non-PM gate.
          ORCHESTRAY_STRICT_MODEL_REQUIRED: '0',
          // Disable group boundary gate to isolate non-PM gate.
          ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
        },
        timeout: 10000,
      }
    );
    return result;
  }

  test('blocks a non-PM agent (developer) that calls Agent()', () => {
    const dir = makeDir({ withOrch: true });
    try {
      const event = {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'refactorer',
          model: 'sonnet',
          description: 'T5 refactor auth module',
          prompt: 'Refactor the auth module',
        },
        // Calling agent is a developer — not pm or curate-runner.
        agent_type: 'developer',
        cwd: dir,
        session_id: 'sess-nonpm-001',
      };

      const result = runGate(dir, event);

      assert.equal(result.status, 2,
        'gate must exit 2 (block) when a non-PM agent calls Agent()');

      assert.ok(
        result.stderr.includes('non_pm_agent_declares_agent_tool') ||
        result.stderr.includes("not authorized to call Agent()"),
        'stderr must name the non_pm_agent_declares_agent_tool reason'
      );
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  test('allows pm role to call Agent()', () => {
    const dir = makeDir({ withOrch: true });
    try {
      const event = {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'developer',
          model: 'sonnet',
          description: 'T5 implement feature',
          prompt: 'Implement feature X',
        },
        agent_type: 'pm',
        cwd: dir,
        session_id: 'sess-pm-001',
      };

      const result = runGate(dir, event);

      // PM is allowed — gate must not exit 2 for the non-PM check specifically.
      // (It may exit 2 for another reason like routing mismatch, but not non-PM gate.)
      const stdout = result.stdout || '';
      let denied = false;
      try {
        const parsed = JSON.parse(stdout);
        const decision = parsed &&
          parsed.hookSpecificOutput &&
          parsed.hookSpecificOutput.permissionDecision;
        if (decision === 'deny') {
          const reason = parsed.hookSpecificOutput.permissionDecisionReason || '';
          denied = reason.includes('non_pm_agent_declares_agent_tool') ||
                   reason.includes("not authorized to call Agent()");
        }
      } catch (_e) {}
      assert.ok(!denied, 'pm role must not be blocked by the non-PM agent gate');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  test('allows curate-runner role to call Agent()', () => {
    const dir = makeDir({ withOrch: true });
    try {
      const event = {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'curator',
          model: 'sonnet',
          description: 'curate pattern corpus',
          prompt: 'Curate patterns',
        },
        agent_type: 'curate-runner',
        cwd: dir,
        session_id: 'sess-curate-001',
      };

      const result = runGate(dir, event);

      const stdout = result.stdout || '';
      let denied = false;
      try {
        const parsed = JSON.parse(stdout);
        const decision = parsed &&
          parsed.hookSpecificOutput &&
          parsed.hookSpecificOutput.permissionDecision;
        if (decision === 'deny') {
          const reason = parsed.hookSpecificOutput.permissionDecisionReason || '';
          denied = reason.includes('non_pm_agent_declares_agent_tool') ||
                   reason.includes("not authorized to call Agent()");
        }
      } catch (_e) {}
      assert.ok(!denied, 'curate-runner role must not be blocked by the non-PM agent gate');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  test('kill switch ORCHESTRAY_NON_PM_AGENT_GATE_DISABLED=1 bypasses block', () => {
    const dir = makeDir({ withOrch: true });
    try {
      const event = {
        tool_name: 'Agent',
        tool_input: {
          subagent_type: 'developer',
          model: 'sonnet',
          description: 'T9 some task',
          prompt: 'Do something',
        },
        agent_type: 'refactorer',
        cwd: dir,
        session_id: 'sess-ks-001',
      };

      const result = spawnSync(
        process.execPath,
        [SCRIPT],
        {
          input: JSON.stringify(event),
          encoding: 'utf8',
          env: {
            ...process.env,
            ORCHESTRAY_STRICT_MODEL_REQUIRED: '0',
            ORCHESTRAY_GROUP_BOUNDARY_GATE_DISABLED: '1',
            ORCHESTRAY_NON_PM_AGENT_GATE_DISABLED: '1',
          },
          timeout: 10000,
        }
      );

      // With kill switch on, the non-PM gate must not block.
      const stdout = result.stdout || '';
      let deniedByNonPmGate = false;
      try {
        const parsed = JSON.parse(stdout);
        const decision = parsed &&
          parsed.hookSpecificOutput &&
          parsed.hookSpecificOutput.permissionDecision;
        if (decision === 'deny') {
          const reason = parsed.hookSpecificOutput.permissionDecisionReason || '';
          deniedByNonPmGate = reason.includes('non_pm_agent_declares_agent_tool') ||
                              reason.includes("not authorized to call Agent()");
        }
      } catch (_e) {}
      assert.ok(!deniedByNonPmGate,
        'non-PM gate must be bypassed when ORCHESTRAY_NON_PM_AGENT_GATE_DISABLED=1');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});
