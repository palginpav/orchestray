#!/usr/bin/env node
'use strict';

/**
 * record-pattern-offers.js — PreToolUse:Agent hook. Phase 1 of the
 * evidence-based pattern-application pipeline (design:
 * .orchestray/kb/artifacts/pattern-application-evidence-design.md §4.1).
 *
 * Scans every Agent spawn's prompt for pattern-slug offers — curated
 * `@orchestray:pattern://<slug>` citations and ambient <mcp-grounding>
 * catalog entries — appends one row to `.orchestray/state/pattern-offers.jsonl`
 * via bin/_lib/pattern-evidence-ledger.js, and emits `pattern_offered`.
 *
 * Why this hook, this event: tool_input.prompt exists in exactly one
 * observable place and is gone by PostToolUse. Positioned in hooks.json
 * AFTER prefetch-mcp-grounding.js in the same "Agent" matcher block so the
 * <mcp-grounding> fence it injects has landed in tool_input.prompt by the
 * time this hook runs (mirrors how bin/validate-pattern-ack.js already
 * reads the fence out of tool_input.prompt on PostToolUse).
 *
 * Fail-open contract:
 *   - Any internal error → swallowed, no event, no ledger row.
 *   - stdout is always `{ continue: true }`; exit code is always 0.
 *   - Never blocks a spawn.
 *
 * Kill switches (default-on per feedback_default_on_shipping.md):
 *   ORCHESTRAY_PATTERN_EVIDENCE_DISABLED=1  — this hook + all Phase 2/3 work
 *   config.pattern_evidence.enabled: false  — same
 *
 * Input:  Claude Code PreToolUse:Agent JSON payload on stdin
 * Output: `{ continue: true }` on stdout always; exit 0 always
 */

const fs   = require('fs');
const path = require('path');

const { resolveSafeCwd }     = require('./_lib/resolve-project-cwd');
const { writeEvent }         = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES }    = require('./_lib/constants');
const { readHookInputRaw }   = require('./_lib/hook-stdin');
const { peekOrchestrationId } = require('./_lib/peek-orchestration-id');
const { scanOffers }         = require('./_lib/pattern-offer-scan');
const { appendOffer, spawnAgentName } = require('./_lib/pattern-evidence-ledger');
const paths                  = require('./mcp-server/lib/paths');

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Config — reads pattern_evidence.enabled from .orchestray/config.json.
// Schema registration (schemas/config.schema.js) is out of scope for this
// hook; a missing/unregistered block fails open to enabled=true.
// ---------------------------------------------------------------------------

function evidenceEnabled(cwd) {
  if (process.env.ORCHESTRAY_PATTERN_EVIDENCE_DISABLED === '1') return false;
  try {
    const configPath = path.join(cwd, '.orchestray', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const block = cfg && cfg.pattern_evidence;
    if (block && block.enabled === false) return false;
  } catch (_e) { /* fail-open: default-on */ }
  return true;
}

// ---------------------------------------------------------------------------
// Slug resolver — existence check across the three pattern tiers (§4.1),
// memoized per invocation (offers are typically ≤10 distinct slugs/spawn).
// ---------------------------------------------------------------------------

function makeSlugResolver(cwd) {
  const dirs = [];
  try { dirs.push(paths.getPatternsDir(cwd)); } catch (_e) { /* ignore */ }
  dirs.push(path.join(cwd, '.orchestray', 'team-patterns'));
  try {
    const shared = paths.getSharedPatternsDir();
    if (shared) dirs.push(shared);
  } catch (_e) { /* federation off or unavailable */ }

  const cache = new Map();
  return function exists(slug) {
    if (cache.has(slug)) return cache.get(slug);
    let found = false;
    for (const dir of dirs) {
      try {
        if (fs.existsSync(path.join(dir, slug + '.md'))) { found = true; break; }
      } catch (_e) { /* ignore */ }
    }
    cache.set(slug, found);
    return found;
  };
}

// ---------------------------------------------------------------------------
// Task-id resolution — mirrors gate-agent-spawn.js's documented precedence:
// tool_input.task_id (explicit), else first [A-Z][A-Z0-9-]+ token in
// description, else the same token in prompt[0..120].
// ---------------------------------------------------------------------------

const TASK_TOKEN_RE = /\b([A-Z][A-Z0-9-]+)\b/;

function resolveTaskId(toolInput) {
  if (!toolInput) return null;
  if (typeof toolInput.task_id === 'string' && toolInput.task_id.length > 0) return toolInput.task_id;
  if (typeof toolInput.description === 'string') {
    const m = TASK_TOKEN_RE.exec(toolInput.description);
    if (m) return m[1];
  }
  if (typeof toolInput.prompt === 'string') {
    const m = TASK_TOKEN_RE.exec(toolInput.prompt.slice(0, 120));
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawn-id resolution — same bug class and fix as validate-reviewer-git-diff.js
// resolveSpawnId() (v2.3.18): a real PreToolUse:Agent payload carries the
// unique-per-spawn id as the TOP-LEVEL `tool_use_id`, never as
// `tool_input.agent_id`/`tool_input.spawn_id` — those fields don't exist on
// the wire. The tool_input fallbacks are kept only for a caller that does
// supply them (none observed in production); without event.tool_use_id this
// always resolved to null, which is why every offer row shipped unattributed.
// ---------------------------------------------------------------------------

function resolveSpawnId(event, toolInput) {
  return (
    (typeof event.tool_use_id === 'string' && event.tool_use_id) ||
    (toolInput && toolInput.agent_id) ||
    (toolInput && toolInput.spawn_id) ||
    null
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const input = readHookInputRaw();
  if (input.length > MAX_INPUT_BYTES) {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');
    process.exit(0);
  }

  setImmediate(() => {
    // Always emit continue — this hook never blocks.
    process.stdout.write(JSON.stringify({ continue: true }) + '\n');

    let event = {};
    try {
      event = input.length > 0 ? JSON.parse(input) : {};
    } catch (_e) {
      return;
    }

    const toolInput = event.tool_input || {};
    if (event.tool_name !== 'Agent' || typeof toolInput.prompt !== 'string') return;

    let cwd;
    try {
      cwd = resolveSafeCwd(event.cwd);
    } catch (_e) {
      cwd = process.cwd();
    }

    if (!evidenceEnabled(cwd)) return;

    try {
      run(event, cwd);
    } catch (_e) {
      // Fail-open — never propagate to crash.
    }
  });
}

function run(event, cwd) {
  const toolInput = event.tool_input || {};
  const exists = makeSlugResolver(cwd);
  const scan = scanOffers(toolInput.prompt, exists);

  // Nothing resolvable → nothing to record. Matches §8.1: pattern_offered
  // fires "once per spawn that carries ≥1 resolvable pattern slug".
  if (scan.offers.length === 0) return;

  const timestamp = new Date().toISOString();
  const orchestrationId = peekOrchestrationId(cwd) || 'unknown';
  const spawnId = resolveSpawnId(event, toolInput);
  const agentRole = typeof toolInput.subagent_type === 'string' ? toolInput.subagent_type : null;
  const taskId = resolveTaskId(toolInput);

  const slugsCurated = scan.offers.filter((o) => o.offer_kind === 'curated').map((o) => o.slug);
  const slugsAmbient = scan.offers.filter((o) => o.offer_kind === 'ambient').map((o) => o.slug);

  // session_id + agent_name ARE the Phase-2 join key (pattern-evidence-ledger.js
  // #findOfferRowForAgent) — SubagentStop carries no tool_use_id, so spawn_id
  // alone cannot be joined from there. spawn_id stays on the row: Phase 3
  // (pattern-credit-compute.js) keys its caps on it, and Phase 2 copies it from
  // the row it matched onto the ack row, so that join is untouched.
  appendOffer(cwd, {
    timestamp,
    orchestration_id: orchestrationId,
    session_id: typeof event.session_id === 'string' ? event.session_id : null,
    agent_name: spawnAgentName(toolInput) || null,
    spawn_id: spawnId,
    agent_role: agentRole,
    task_id: taskId,
    offers: scan.offers,
    shape_detected: scan.shape_detected,
    unresolved_slugs: scan.unresolved_slugs,
  });

  // orchestration_id/timestamp passed explicitly (already resolved above for
  // the ledger row) — avoids the per-call autofill-telemetry cost noted in
  // design §8 for call sites that would otherwise omit them.
  writeEvent({
    version: SCHEMA_VERSION,
    type: 'pattern_offered',
    orchestration_id: orchestrationId,
    timestamp,
    spawn_id: spawnId,
    agent_role: agentRole,
    task_id: taskId,
    slugs_curated: slugsCurated,
    slugs_ambient: slugsAmbient,
    shape_detected: scan.shape_detected,
    unresolved_slugs: scan.unresolved_slugs,
    schema_version: SCHEMA_VERSION,
  }, { cwd });
}

main();
