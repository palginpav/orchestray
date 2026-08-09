#!/usr/bin/env node
'use strict';

/**
 * warn-ungranted-tool-mention.js — PreToolUse hook (matcher: "Agent").
 *
 * v2.3.23 — the real incident this fixes: a PM delegation prompt instructed
 * an `architect` spawn to persist output via `mcp__orchestray__kb_write`.
 * `architect`'s `tools:` frontmatter does not grant `kb_write` (PM-only by
 * design). The architect silently fell back to raw `Write` — nothing detected
 * it; it surfaced only because a human read the transcript.
 *
 * Scans the prompt body of every `Agent()` spawn for `mcp__orchestray__*`
 * tokens, loads the target agent's declared `tools:` frontmatter, and emits a
 * WARN-level audit event (never blocks) when the prompt names a tool the
 * agent was not granted.
 *
 * False-positive handling: a prompt may legitimately *mention* a tool name
 * without instructing its use — e.g. explaining what an agent must NOT call.
 * Lines carrying a negation marker ("do not", "must not", "cannot", "never",
 * "should not", "won't", "will not" — case-insensitive) are excluded from
 * extraction. This does NOT catch every false-positive shape: a line
 * narrating the PM's OWN subsequent action ("I will then call
 * mcp__orchestray__kb_write to persist this") reads identically to an
 * instruction to the spawned agent and is not excluded. That residual risk
 * is accepted rather than attempting speaker attribution from prose, which
 * would need real NLU to do reliably — see Structured Result assumptions.
 *
 * Contract:
 *   - exit 0 ALWAYS — advisory only, never blocking.
 *   - emit `ungranted_tool_mention_warn` per spawn with >=1 ungranted tool.
 *   - fail-open: malformed stdin, missing/unreadable agent file, unknown
 *     subagent_type (dynamic specialist — no static file), malformed
 *     frontmatter → exit 0 silently, no event.
 *   - honours ORCHESTRAY_UNGRANTED_TOOL_WARN_DISABLED=1 env kill-switch.
 *   - honours .orchestray/config.json → ungranted_tool_mention.enabled: false.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { readHookInputRaw } = require('./_lib/hook-stdin');

// Deliberately conservative: matches only the known mcp__orchestray__ tool
// namespace, lowercase snake_case (every declared tool name in agents/*.md
// frontmatter follows this shape).
const MCP_TOOL_RE = /\bmcp__orchestray__[a-z_]+/g;

// Negation markers that suppress extraction on the line they appear in.
const NEGATION_RE = /\b(do\s+not|does\s+not|did\s+not|must\s+not|cannot|can't|never|should\s+not|won't|will\s+not)\b/i;

/**
 * Kill switch. Env takes precedence over config.
 * @param {string} cwd
 * @returns {boolean}
 */
function isDisabled(cwd) {
  if (process.env.ORCHESTRAY_UNGRANTED_TOOL_WARN_DISABLED === '1') return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    if (cfg && cfg.ungranted_tool_mention && cfg.ungranted_tool_mention.enabled === false) return true;
  } catch (_e) { /* fail-open: treat as enabled */ }
  return false;
}

/**
 * Locate an agent definition file across every install location this
 * codebase is known to use, same priority order as
 * `bin/detect-tool-grant-shortfall.js#resolveAgentDefinitionPath` for the
 * identical multi-tier-install problem: project install > project-legacy
 * (source-repo dev layout) > user (global install) > plugin-legacy (older
 * global install layout still present on some machines).
 *
 * @param {string} cwd
 * @param {string} role
 * @returns {string|null}
 */
function resolveAgentDefinitionPath(cwd, role) {
  let home;
  try { home = os.homedir(); } catch (_e) { home = null; }
  const candidates = [
    path.join(cwd, '.claude', 'agents', role + '.md'),
    path.join(cwd, 'agents', role + '.md'),
    home ? path.join(home, '.claude', 'agents', role + '.md') : null,
    home ? path.join(home, '.claude', 'orchestray', 'agents', role + '.md') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_e) { /* keep looking */ }
  }
  return null;
}

/**
 * Parse the `tools:` frontmatter line, tolerant of both the flat comma form
 * (`tools: a, b`) and the YAML flow-sequence form (`tools: [a, b]`). A scan
 * that split on commas without stripping brackets caused a real false miss:
 * the bracket form's final entry parsed as `token]` and never matched.
 *
 * @param {string} cwd
 * @param {string} role
 * @returns {string[]|null} null when the agent definition cannot be found or
 *   parsed at all — distinct from `[]`, which is a real agent that legitimately
 *   grants no tools (e.g. `pattern-extractor`'s `tools: []`).
 */
function loadDeclaredTools(cwd, role) {
  const defPath = resolveAgentDefinitionPath(cwd, role);
  if (!defPath) return null;
  try {
    const raw = fs.readFileSync(defPath, 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    const m = fm[1].match(/^tools:\s*(.+)$/m);
    if (!m) return null;
    return m[1].replace(/[[\]]/g, '').split(',').map((t) => t.trim()).filter(Boolean);
  } catch (_e) {
    return null;
  }
}

/**
 * Extract every `mcp__orchestray__*` token named in non-negated lines of the
 * prompt. Deduplicated, first-seen order preserved.
 *
 * @param {string} prompt
 * @returns {string[]}
 */
function extractMentionedTools(prompt) {
  if (typeof prompt !== 'string' || !prompt) return [];
  const found = [];
  const seen = new Set();
  for (const line of prompt.split('\n')) {
    if (NEGATION_RE.test(line)) continue;
    MCP_TOOL_RE.lastIndex = 0;
    let m;
    while ((m = MCP_TOOL_RE.exec(line)) !== null) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        found.push(m[0]);
      }
    }
  }
  return found;
}

/**
 * Resolve the current orchestration_id from current-orchestration.json.
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

function main() {
  let input = '';
  input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }
  setImmediate(() => {
    try {
      let event = {};
      try {
        event = input.length > 0 ? JSON.parse(input) : {};
      } catch (_e) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const toolName = event.tool_name || (event.tool_input && event.tool_input.tool) || '';
      if (toolName !== 'Agent') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const toolInput = event.tool_input;
      if (!toolInput || typeof toolInput !== 'object') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const subagentType = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type.trim() : '';
      const prompt = typeof toolInput.prompt === 'string' ? toolInput.prompt : '';
      if (!subagentType || !prompt) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      let cwd;
      try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

      if (isDisabled(cwd)) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const mentioned = extractMentionedTools(prompt);
      if (mentioned.length === 0) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      // Unknown subagent_type (dynamic specialist, no static file) — declared
      // tools are unknowable from here, so nothing is flagged. Same precedent
      // as detect-tool-grant-shortfall.js for the identical resolution gap.
      const declared = loadDeclaredTools(cwd, subagentType);
      if (declared === null) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const grantedSet = new Set(declared);
      const ungranted = mentioned.filter((t) => !grantedSet.has(t));
      if (ungranted.length === 0) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      try {
        writeEvent({
          version: 1,
          schema_version: 1,
          type: 'ungranted_tool_mention_warn',
          timestamp: new Date().toISOString(),
          orchestration_id: resolveOrchestrationId(cwd),
          agent_type: subagentType,
          ungranted_tools: ungranted,
          reason: 'delegation prompt names a tool the target agent tools: frontmatter does not grant',
        }, { cwd });
      } catch (_e) { /* fail-open */ }

      process.stderr.write(
        '[orchestray] warn-ungranted-tool-mention: WARN — ' + subagentType +
        ' prompt names ungranted tool(s): ' + ungranted.join(', ') +
        ' — this instruction cannot be followed (not present in the agent\'s tools: frontmatter).\n'
      );

      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    } catch (_e) {
      // Top-level safety net — advisory hook must never affect the spawn.
      try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_e2) { /* swallow */ }
      process.exit(0);
    }
  });
}

module.exports = {
  isDisabled,
  resolveAgentDefinitionPath,
  loadDeclaredTools,
  extractMentionedTools,
  resolveOrchestrationId,
  MCP_TOOL_RE,
  NEGATION_RE,
};

if (require.main === module) {
  main();
}
