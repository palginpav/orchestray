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
 * Compares the target agent's declared `tools:` (parsed from an `agents/<role>.md`
 * frontmatter file) against tool names actually observed in the completed
 * subagent's own transcript. When a declared CAPABILITY-CRITICAL tool
 * (WebFetch, WebSearch — the minimum set called out in the discovery doc)
 * was never used, emits `tool_grant_shortfall` with the unused tool list and,
 * when determinable, what was substituted instead (currently: Bash + curl).
 *
 * v2.3.19 W2 fix — this hook shipped correct but blind and fired zero times:
 *   1. `event.agent_type` on a real SubagentStop payload is the caller-chosen
 *      ROSTER NAME (e.g. "oracle-v2318"), not the `subagent_type` role
 *      ("platform-oracle") that decides tool grants — so `agents/<role>.md`
 *      never resolved. Fixed by reusing the spawn-metadata sidecar resolution
 *      established for the identical conflation in W-AC-4
 *      (`bin/_lib/caller-identity.js`), rather than a second parallel
 *      heuristic.
 *   2. The agent definition was only ever looked for under `<cwd>/agents/` —
 *      the source-repo dev layout. Real installs put it under
 *      `<cwd>/.claude/agents/` (project install) or `~/.claude/agents/`
 *      (global install), with `~/.claude/orchestray/agents/` as a legacy
 *      layout some machines still carry. Now searched in the same
 *      project > project-legacy > user > plugin-legacy order established by
 *      `bin/audit-housekeeper-drift.js#resolveAgentFile` for the same
 *      multi-tier problem.
 *   A role that resolves to no definition anywhere is NOT a shortfall — its
 *   declared tools are unknowable from here, so nothing is emitted (silent,
 *   matching this hook's existing no-stderr footprint; the alternative of a
 *   stderr diagnostic was considered and rejected to avoid noise on every
 *   dynamic-specialist spawn, which is the common case).
 *
 * Telemetry-only this wave — we do not yet know whether the root cause is
 * platform behaviour or an Orchestray-side spawn-option bug, so this hook
 * NEVER blocks.
 *
 * v2.3.26 W12 fix — this hook fired correctly but under-specified what it
 * found:
 *   1. "declared but unused" cannot by itself distinguish "the agent didn't
 *      need the tool" (benign) from "the agent couldn't have gotten it"
 *      (the real defect). Every emitted row now carries `confidence`:
 *      `'workaround_observed'` when the transcript shows a Bash+curl substitution
 *      (positive evidence of a workaround), else `'ambiguous_unused'` — said
 *      explicitly rather than implied away.
 *   2. Every emitted row now carries `agent_role_source`: `'sidecar'` when
 *      the role came from Claude Code's own runtime-recorded spawn metadata
 *      (authoritative), or `'roster_fallback'` when it is a suffix-stripped
 *      caller-chosen roster name (unverified). This is the same
 *      identity-resolution ambiguity documented for the model-attribution
 *      gap (W4, `orch-20260812T-v2326-lifecycle`) — made explicit here
 *      instead of silently repeating it in a second subsystem.
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
const os   = require('os');
const path = require('path');
const { resolveSafeCwd }        = require('./_lib/resolve-project-cwd');
const { writeEvent }            = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }       = require('./_lib/constants');
const { validateTranscriptPath } = require('./_lib/path-containment');
const { readFileBounded }       = require('./_lib/file-read-bounded');
const { getCurrentOrchestrationFile } = require('./_lib/orchestration-state');
const { readHookInputRaw }      = require('./_lib/hook-stdin');
// Reuse of the established caller-identity resolution (W-AC-4, v2.3.19).
// Sourced from _lib, not from gate-agent-spawn.js: requiring that hook pulled
// zod and ~87 other modules into every SubagentStop for two pure functions.
const { resolveCallerAgentTypeFromMeta, stripCollisionSuffix } = require('./_lib/caller-identity');

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
 * Locate an agent definition file across every install location this
 * codebase is known to use, in the same priority order established by
 * `bin/audit-housekeeper-drift.js#resolveAgentFile` for the same problem:
 * project install > project-legacy (source-repo dev layout) > user
 * (global install) > plugin-legacy (older global install layout still
 * present on some machines). Returns null — not a guess, an honest "not
 * found here" — when none of the four candidates exist.
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
 * Parse the flat, comma-separated `tools:` frontmatter line from an agent
 * definition file, searched across install tiers via
 * `resolveAgentDefinitionPath`. Returns [] when the definition cannot be
 * found anywhere, or on any read/parse error (no tools: line, malformed
 * frontmatter).
 *
 * @param {string} cwd
 * @param {string} role
 * @returns {string[]}
 */
function loadDeclaredTools(cwd, role) {
  const defPath = resolveAgentDefinitionPath(cwd, role);
  if (!defPath) return [];
  try {
    const raw = fs.readFileSync(defPath, 'utf8');
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
 * Resolve the true agent role for a completed spawn, given the SubagentStop
 * payload. Thin wrapper over `resolveAgentRoleWithSource` for callers that
 * only need the name, not its provenance.
 *
 * @param {object} event
 * @param {string} cwd
 * @returns {string}
 */
function resolveAgentRole(event, cwd) {
  return resolveAgentRoleWithSource(event, cwd).role;
}

/**
 * Resolve the true agent role for a completed spawn, given the SubagentStop
 * payload, AND report which source produced it — the W12 identity-confidence
 * fix. `event.agent_type` (and its siblings) carry the caller-chosen ROSTER
 * NAME, not the `subagent_type` that decided the agent's tool grants — see
 * the v2.3.19 W2 header note. Resolution order:
 *   1. Spawn-metadata sidecar (`resolveCallerAgentTypeFromMeta`) — authoritative,
 *      recorded by the Claude Code runtime at spawn time. source: 'sidecar'.
 *   2. `stripCollisionSuffix` on the roster name — repairs the common
 *      `<role>-2` auto-suffix case when the sidecar is unreadable, but the
 *      result is still a caller-chosen string, not runtime-verified.
 *      source: 'roster_fallback'.
 * Never throws; returns role '' / source 'unresolved' when no usable name is
 * present at all.
 *
 * Consumers care about the distinction because a `tool_grant_shortfall` row
 * attributed via 'roster_fallback' is a weaker identity claim than one
 * confirmed via 'sidecar' — the same "one field silently conflates two
 * different provenances" failure documented for the cost-attribution gap
 * (W4, `orch-20260812T-v2326-lifecycle`), now made explicit here instead of
 * repeating it in a second subsystem.
 *
 * @param {object} event
 * @param {string} cwd
 * @returns {{role: string, source: 'sidecar'|'roster_fallback'|'unresolved'}}
 */
function resolveAgentRoleWithSource(event, cwd) {
  const rosterRaw = (
    event.subagent_type || event.agent_type || event.agent_role ||
    (event.tool_input && event.tool_input.subagent_type) || ''
  );
  if (typeof rosterRaw !== 'string' || !rosterRaw.trim()) {
    return { role: '', source: 'unresolved' };
  }
  const roster = rosterRaw.trim();

  let resolved = null;
  try {
    resolved = resolveCallerAgentTypeFromMeta(roster, event.session_id, cwd);
  } catch (_e) { resolved = null; }

  if (typeof resolved === 'string' && resolved.trim()) {
    return { role: resolved.toLowerCase().trim(), source: 'sidecar' };
  }

  const fallback = stripCollisionSuffix(roster);
  if (typeof fallback === 'string' && fallback.trim()) {
    return { role: fallback.toLowerCase().trim(), source: 'roster_fallback' };
  }
  return { role: '', source: 'unresolved' };
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

      let cwd;
      try { cwd = resolveSafeCwd(event.cwd); } catch (_e) { cwd = process.cwd(); }

      // cwd (and event.session_id) must be resolved before role resolution —
      // the sidecar lookup keys on both.
      const { role, source: roleSource } = resolveAgentRoleWithSource(event, cwd);
      if (!role) {
        process.stdout.write(JSON.stringify({ continue: true }));
        process.exit(0);
        return;
      }

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

      // W12 semantics fix: "declared but unused" alone cannot distinguish
      // "the agent didn't need the tool" (benign) from "the agent couldn't
      // have gotten it" (the real defect). A Bash+curl substitution is
      // evidence the agent compensated for something — but NOT evidence the
      // tool was absent.
      //
      // Worked counter-example (2026-08-12): platform-oracle used curl for
      // ~3 weeks while WebFetch was available the whole time, because a stale
      // memory instructed it never to attempt the call. Labelling that
      // 'confirmed_gap' would have been maximum confidence and wrong — the
      // behaviour came from a belief, not a capability. Only invocation can
      // confirm absence, and this hook never invokes anything.
      const confidence = bashHasCurl ? 'workaround_observed' : 'ambiguous_unused';

      try {
        writeEvent({
          version:              SCHEMA_VERSION,
          schema_version:       SCHEMA_VERSION,
          type:                 'tool_grant_shortfall',
          agent_role:           role,
          agent_role_source:    roleSource, // 'sidecar' (authoritative) | 'roster_fallback' (unverified) — W12 identity fix
          confidence:           confidence, // 'workaround_observed' | 'ambiguous_unused' — W12 semantics fix
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
  resolveAgentDefinitionPath,
  resolveAgentRole,
  resolveAgentRoleWithSource,
  scanTranscriptToolUsage,
  isDisabled,
  CAPABILITY_CRITICAL_TOOLS,
};

if (require.main === module) {
  main();
}
