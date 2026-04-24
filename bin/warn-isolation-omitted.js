#!/usr/bin/env node
'use strict';

/**
 * warn-isolation-omitted.js — PreToolUse hook (matcher: "Agent").
 *
 * v2.1.10 R4 — advisory validator for worktree isolation.
 *
 * Emits an `isolation_omitted_warn` audit event when a write-capable agent
 * (architect, developer, refactorer, tester, security-engineer, inventor) is
 * spawned without worktree isolation. As of v2.1.10 these agents carry
 * `isolation: worktree` in their frontmatter, so the normal path is always
 * isolated. This hook fires when:
 *   1. The spawn targets a write-capable agent type, AND
 *   2. The tool_input does NOT carry `isolation: "worktree"`, AND
 *   3. The agent's own frontmatter does NOT carry `isolation: worktree`
 *      (guards against custom specialists that omit it).
 *
 * Contract:
 *   - exit 0 ALWAYS — this is advisory only, never blocking.
 *   - emit `isolation_omitted_warn` event to .orchestray/audit/events.jsonl.
 *   - fail-open: malformed stdin, missing agent file, parse errors → exit 0 silently.
 *   - honours ORCHESTRAY_ISOLATION_WARN_DISABLED=1 env kill-switch.
 *   - honours .orchestray/config.json → worktree_isolation.warn_on_omission: false.
 */

const fs = require('fs');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { atomicAppendJsonl } = require('./_lib/atomic-append');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');

/** Agent types that must have worktree isolation. */
const WRITE_CAPABLE_AGENTS = new Set([
  'architect',
  'developer',
  'refactorer',
  'tester',
  'security-engineer',
  'inventor',
]);

/**
 * Return true if warn-on-omission is enabled.
 * Default: true. Disabled by env var or config key.
 *
 * @param {string} cwd
 * @returns {boolean}
 */
function isWarnEnabled(cwd) {
  if (process.env.ORCHESTRAY_ISOLATION_WARN_DISABLED === '1') return false;
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (
      cfg &&
      cfg.worktree_isolation &&
      cfg.worktree_isolation.warn_on_omission === false
    ) {
      return false;
    }
  } catch (_e) {
    // Config missing or unreadable — default to warn enabled.
  }
  return true;
}

/**
 * Read the agent markdown file frontmatter at agents/<type>.md and check
 * whether `isolation: worktree` is present.
 *
 * @param {string} cwd
 * @param {string} agentType
 * @returns {boolean} true if the frontmatter carries isolation: worktree
 */
function agentFrontmatterHasIsolation(cwd, agentType) {
  try {
    const agentFile = path.join(cwd, 'agents', agentType + '.md');
    const content = fs.readFileSync(agentFile, 'utf8');
    // Extract the YAML frontmatter block (between the first two `---` delimiters).
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return false;
    const frontmatter = fmMatch[1];
    // Check for `isolation: worktree` — accept optional surrounding whitespace.
    return /^\s*isolation\s*:\s*worktree\s*$/m.test(frontmatter);
  } catch (_e) {
    // File missing or unreadable — cannot confirm isolation in frontmatter.
    return false;
  }
}

/**
 * Resolve the current orchestration_id from current-orchestration.json.
 *
 * @param {string} cwd
 * @returns {string}
 */
function resolveOrchestrationId(cwd) {
  try {
    const orchFile = getCurrentOrchestrationFile(cwd);
    const orchData = JSON.parse(fs.readFileSync(orchFile, 'utf8'));
    return (orchData && orchData.orchestration_id) ? orchData.orchestration_id : 'unknown';
  } catch (_e) {
    return 'unknown';
  }
}

/**
 * Append the isolation_omitted_warn event to events.jsonl.
 * Fail-open on any I/O error.
 *
 * @param {string} cwd
 * @param {object} record
 */
function emitAuditEvent(cwd, record) {
  try {
    const auditDir = path.join(cwd, '.orchestray', 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    try { fs.chmodSync(auditDir, 0o700); } catch (_e) { /* best-effort */ }
    atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), record);
  } catch (_e) {
    // Swallow — advisory path must never crash the hook.
  }
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', () => {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
  process.stdin.on('data', (chunk) => {
    input += chunk;
    if (input.length > MAX_INPUT_BYTES) {
      process.stdout.write(JSON.stringify({ continue: true }) + '\n');
      process.exit(0);
    }
  });
  process.stdin.on('end', () => {
    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_e) {
      // Malformed stdin — fail-open silently.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Only handle Agent tool calls with a subagent_type targeting a write-capable agent.
    const toolName = event.tool_name || '';
    if (toolName !== 'Agent') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const toolInput = event.tool_input;
    if (!toolInput || typeof toolInput !== 'object') {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    const subagentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : '';
    if (!WRITE_CAPABLE_AGENTS.has(subagentType)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Resolve cwd — needed for config, agent file, and audit dir.
    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_e) {
      cwd = process.cwd();
    }

    // Check kill-switches before doing any further work.
    if (!isWarnEnabled(cwd)) {
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Determine whether isolation is present via tool_input OR frontmatter.
    const paramIsolation = toolInput.isolation;
    const hasParamIsolation = paramIsolation === 'worktree' || paramIsolation === '"worktree"';
    const hasFrontmatterIsolation = agentFrontmatterHasIsolation(cwd, subagentType);

    if (hasParamIsolation || hasFrontmatterIsolation) {
      // Isolation is covered — no warning needed.
      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    }

    // Isolation omitted on a write-capable agent — emit advisory event.
    const orchestrationId = resolveOrchestrationId(cwd);
    emitAuditEvent(cwd, {
      // v2.1.13 R-EVENT-NAMING: canonical snake_case shape.
      // Legacy v2.1.12 emissions used `event`/`ts` — back-compat read path
      // in bin/read-event.js maps both forms.
      type: 'isolation_omitted_warn',
      orchestration_id: orchestrationId,
      timestamp: new Date().toISOString(),
      agent: subagentType,
      reason: 'write-capable agent spawned without worktree isolation',
    });

    process.stderr.write(
      '[orchestray] warn-isolation-omitted: WARN — ' + subagentType +
      ' spawned without worktree isolation (no isolation param and no isolation: worktree in frontmatter). ' +
      'Set isolation: worktree in frontmatter or pass it on the Agent() call to isolate writes.\n'
    );

    // Always exit 0 — this hook is advisory only.
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  });
}

module.exports = {
  WRITE_CAPABLE_AGENTS,
  isWarnEnabled,
  agentFrontmatterHasIsolation,
};

if (require.main === module) {
  main();
}
