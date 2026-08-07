#!/usr/bin/env node
'use strict';

/**
 * detect-tool-grant-shortfall.js — SubagentStop hook (v2.3.18 W3, new).
 *
 * Found live during the v2.3.18 discovery pass: `platform-oracle` declares
 * `WebFetch` and `researcher` declares `WebFetch, WebSearch` in their agent
 * frontmatter `tools:` list, but neither is guaranteed to receive them at
 * spawn time — both have been observed silently falling back to `curl` via
 * Bash, with no error and no telemetry. The two point-gates that were supposed
 * to catch this (`validate-platform-oracle-grounding.js`,
 * `validate-researcher-citations.js`) had fired zero times in 98 days at time
 * of writing; both were retired into the Claim–Evidence Ledger in v2.3.18 (W4),
 * whose `oracle-grounded` / `research-sourced` rules check the transcript
 * rather than the agent's self-reported source list.
 *
 * Compares the target agent's declared `tools:` (parsed from `agents/<role>.md`
 * frontmatter) against tool names actually observed in the completed subagent's
 * own transcript. When a declared CAPABILITY-CRITICAL tool (WebFetch, WebSearch
 * — the minimum set called out in the discovery doc) was never used, emits
 * `tool_grant_shortfall` with the unused tool list and, when determinable,
 * what was substituted instead (currently: Bash + curl).
 *
 * Telemetry-only this wave — we do not yet know whether the root cause is
 * platform behaviour or an Orchestray-side spawn-option bug, so this hook
 * NEVER blocks.
 *
 * Kill switch: ORCHESTRAY_TOOL_GRANT_SHORTFALL_DISABLED=1
 * Config key:  tool_grant_shortfall.enabled (default true)
 *
 * Contract:
 *   - Always exits 0. Never blocks a spawn.
 *   - Fail-open on any internal error (missing agent file, unreadable
 *     transcript, malformed payload).
 *
 * Input:  Claude Code SubagentStop JSON payload on stdin
 * Output: { continue: true } on stdout; exit 0 always.
 */

const fs   = require('fs');
const path = require('path');
const { resolveSafeCwd }        = require('./_lib/resolve-project-cwd');
const { writeEvent }            = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }       = require('./_lib/constants');
const { validateTranscriptPath } = require('./_lib/path-containment');
const { readFileBounded }       = require('./_lib/file-read-bounded');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { readHookInputRaw }      = require('./_lib/hook-stdin');

const SCHEMA_VERSION = 1;
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024; // 8 MB — generous, telemetry-only

// The minimum set called out in the discovery doc. Extend here as new
// capability-critical tools are identified — deliberately conservative
// (a false-positive shortfall on a routine tool would just be noise).
const CAPABILITY_CRITICAL_TOOLS = ['WebFetch', 'WebSearch'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Kill switch. Env takes precedence over config.
 * @param {string} cwd
 * @returns {boolean}
 */
function isDisabled(cwd) {
  if (process.env.ORCHESTRAY_TOOL_GRANT_SHORTFALL_DISABLED === '1') return true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.orchestray', 'config.json'), 'utf8'));
    if (cfg && cfg.tool_grant_shortfall && cfg.tool_grant_shortfall.enabled === false) return true;
  } catch (_e) { /* fail-open: treat as enabled */ }
  return false;
}

/**
 * Parse the flat, comma-separated `tools:` frontmatter line from an agent
 * definition file. Returns [] on any error (missing file, no tools: line).
 *
 * @param {string} cwd
 * @param {string} role
 * @returns {string[]}
 */
function loadDeclaredTools(cwd, role) {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'agents', role + '.md'), 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return [];
    const m = fm[1].match(/^tools:\s*(.+)$/m);
    if (!m) return [];
    return m[1].split(',').map((t) => t.trim()).filter(Boolean);
  } catch (_e) {
    return [];
  }
}

/**
 * Scan a transcript's raw text for tool_use blocks by tool name. Cheap
 * substring/regex scan rather than full JSONL parse — transcripts are
 * internal, system-generated JSONL, so `"name":"WebFetch"` is a reliable
 * anchor for a tool_use block without needing to walk the whole structure.
 *
 * @param {string} transcriptText
 * @returns {{used: Set<string>, bashHasCurl: boolean}}
 */
function scanTranscriptToolUsage(transcriptText) {
  const used = new Set();
  const nameRe = /"name"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g;
  let m;
  while ((m = nameRe.exec(transcriptText)) !== null) {
    used.add(m[1]);
  }
  const bashHasCurl = used.has('Bash') && /"command"\s*:\s*"[^"]*\bcurl\b/.test(transcriptText);
  return { used, bashHasCurl };
}

function resolveOrchId(cwd) {
  try {
    const f = getCurrentOrchestrationFile(cwd);
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    return parsed.orchestration_id || parsed.id || null;
  } catch (_e) { return null; }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (process.env.ORCHESTRAY_TOOL_GRANT_SHORTFALL_DISABLED === '1') {
    process.stdout.write(JSON.stringify({ continue: true }));
    process.exit(0);
  }

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

      if ((event.hook_event_name || '') !== 'SubagentStop') {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const role = (
        event.subagent_type || event.agent_type || event.agent_role ||
        (event.tool_input && event.tool_input.subagent_type) || ''
      ).toLowerCase().trim();
      if (!role) {
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

      const declared = loadDeclaredTools(cwd, role);
      const criticalDeclared = declared.filter((t) => CAPABILITY_CRITICAL_TOOLS.includes(t));
      if (criticalDeclared.length === 0) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const transcriptPath = validateTranscriptPath(event.agent_transcript_path, cwd, () => {});
      if (!transcriptPath) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const readResult = readFileBounded(transcriptPath, MAX_TRANSCRIPT_BYTES);
      if (!readResult.ok) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      const { used, bashHasCurl } = scanTranscriptToolUsage(readResult.content);
      const unusedCritical = criticalDeclared.filter((t) => !used.has(t));
      if (unusedCritical.length === 0) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

      try {
        writeEvent({
          version:              SCHEMA_VERSION,
          schema_version:       SCHEMA_VERSION,
          type:                 'tool_grant_shortfall',
          agent_role:           role,
          declared_but_unused:  unusedCritical,
          substituted_via:      bashHasCurl ? 'bash_curl' : null,
          orchestration_id:     resolveOrchId(cwd),
          spawn_id:             event.agent_id || event.task_id || null,
        }, { cwd });
      } catch (_e) { /* fail-open */ }

      process.stdout.write(JSON.stringify({ continue: true }));
      process.exit(0);
    } catch (_e) {
      // Top-level safety net — telemetry hook must never affect the spawn.
      try { process.stdout.write(JSON.stringify({ continue: true })); } catch (_e2) { /* swallow */ }
      process.exit(0);
    }
  });
}

module.exports = {
  loadDeclaredTools,
  scanTranscriptToolUsage,
  isDisabled,
  CAPABILITY_CRITICAL_TOOLS,
};

if (require.main === module) {
  main();
}
