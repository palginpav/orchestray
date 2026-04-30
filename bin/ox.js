#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * ox — Orchestray porcelain (user-facing CLI) for routine orchestration lifecycle ops.
 *
 * Grammar: ox <verb> <subverb> <positional>... [--flag=value]... [--dry-run] [--json]
 *
 * Exit codes:
 *   0 — success (mutating: silent; read-only: data on stdout)
 *   1 — known error (business rule, IO, state conflict)
 *   2 — usage error (unknown verb, missing required args)
 *
 * Stderr format (known errors): ox: <verb>: <reason>
 * Stderr format (usage errors): ox: usage: <synopsis>
 *
 * Mutating verbs: silent on success (empty stdout), idempotent, accept --dry-run.
 * Idempotent no-ops: emit {"noop":true,"reason":"..."} on stdout and exit 0.
 * Read-only verbs: emit data on stdout; --json for machine-readable.
 *
 * Security constraints:
 *   S03 — events append --extra: force orchestration_id from marker; reject
 *          reserved keys (orchestration_id, event, ts, type); cap 2048 bytes.
 *   S04 — any --file arg: path containment via realpath + path.relative.
 *   S05 — ALL JSONL writes use atomicAppendJsonl from bin/_lib/atomic-append.js.
 *
 * OX_CWD env override: test-only. Hooks must never set this in production.
 */

const fs   = require('fs');
const path = require('path');

// atomicAppendJsonlIfAbsent is retained for the routing.jsonl write path (line ~553);
// events.jsonl emissions now route through the central audit-event gateway.
const { atomicAppendJsonlIfAbsent } = require('./_lib/atomic-append');
const { writeEvent }                = require('./_lib/audit-event-writer');
const { getCurrentOrchestrationFile }                  = require('./_lib/orchestration-state');

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

/** Maximum byte length for any --flag=value string (S03 + H01). */
const MAX_FLAG_LEN = 2048;

/** Maximum byte length specifically for --extra JSON payload (S03). */
const MAX_EXTRA_LEN = 2048;

/** Reserved top-level keys that --extra must NOT contain (S03). */
const EXTRA_RESERVED_KEYS = new Set(['orchestration_id', 'event', 'ts', 'type']);

/** Canonical agent types (mirrors audit-event.js CANONICAL_AGENTS). */
const CANONICAL_AGENTS = new Set([
  'pm', 'architect', 'developer', 'refactorer', 'inventor', 'researcher', 'reviewer',
  'debugger', 'tester', 'documenter', 'security-engineer',
  'release-manager', 'ux-critic', 'platform-oracle',
  'Explore', 'Plan', 'general-purpose', 'Task',
]);

/** Valid model short-names and full IDs. */
const VALID_MODELS = new Set([
  'haiku', 'sonnet', 'opus',
  'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7',
  'claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20250922',
]);

// --------------------------------------------------------------------------
// Project root resolution
// --------------------------------------------------------------------------

/**
 * Return the project root directory.
 * OX_CWD is a test-only override; hooks must never set this in production.
 */
function projectRoot() {
  return process.env.OX_CWD || process.cwd();
}

// --------------------------------------------------------------------------
// Path containment (S04)
// Mandatory contract for any future --file argument.
// --------------------------------------------------------------------------

/**
 * Resolve and validate a --file path argument.
 * Rejects any path that escapes the project root.
 *
 * @param {string} verb      - The verb name (for error messages).
 * @param {string} flagValue - The raw flag value from the user.
 * @returns {string} Resolved absolute path (safe).
 */
function resolveFilePath(verb, flagValue) {
  const root = projectRoot();
  const resolved = path.resolve(root, flagValue);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (_e) {
    // File does not exist yet — check the unresolved path.
    real = resolved;
  }
  const rel = path.relative(root, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    die(verb, 'file path outside project root', 1);
  }
  return real;
}

// --------------------------------------------------------------------------
// Argument parser
// --------------------------------------------------------------------------

/**
 * Parse process.argv[2..] into structured args.
 * Enforces MAX_FLAG_LEN on every flag value.
 *
 * @returns {{ verb: string|undefined, subverb: string|undefined,
 *             positionals: string[], flags: Object, dryRun: boolean, jsonMode: boolean }}
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const positionals = [];
  const flags = {};
  let dryRun   = false;
  let jsonMode = false;

  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--json') {
      jsonMode = true;
    } else if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) {
        // Boolean flag with no value.
        const key = arg.slice(2);
        flags[key] = true;
      } else {
        const key   = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        if (Buffer.byteLength(value, 'utf8') > MAX_FLAG_LEN) {
          die('usage', `--${key} value exceeds ${MAX_FLAG_LEN}-byte cap`, 2);
        }
        flags[key] = value;
      }
    } else {
      positionals.push(arg);
    }
  }

  const verb    = positionals[0];
  const subverb = positionals[1];
  const rest    = positionals.slice(2);

  return { verb, subverb, positionals: rest, flags, dryRun, jsonMode };
}

// --------------------------------------------------------------------------
// Error helpers
// --------------------------------------------------------------------------

/**
 * Write one-line stderr and exit.
 *
 * @param {string} verb   - The verb (or "usage") for the message prefix.
 * @param {string} reason - Human-readable reason.
 * @param {number} code   - Exit code (1 = known error, 2 = usage error).
 */
function die(verb, reason, code) {
  if (code === 2) {
    process.stderr.write(`ox: usage: ${reason}\n`);
  } else {
    process.stderr.write(`ox: ${verb}: ${reason}\n`);
  }
  process.exit(code);
}

// --------------------------------------------------------------------------
// Orchestration state helpers
// --------------------------------------------------------------------------

/**
 * Read the current-orchestration.json marker.
 *
 * @param {string} cwd
 * @returns {Object|null} Parsed marker data or null if not present.
 */
function readMarker(cwd) {
  const markerPath = getCurrentOrchestrationFile(cwd);
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (_e) {
    return null;
  }
}

/**
 * Write the current-orchestration.json marker atomically (tmp + rename).
 *
 * @param {string} cwd
 * @param {Object} data
 */
function writeMarker(cwd, data) {
  const markerPath = getCurrentOrchestrationFile(cwd);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const tmp = markerPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, markerPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) {}
    throw err;
  }
}

/** Absolute path to events.jsonl for the given project root. */
function eventsPath(cwd) {
  return path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
}

/** Absolute path to routing.jsonl for the given project root. */
function routingPath(cwd) {
  return path.join(cwd, '.orchestray', 'state', 'routing.jsonl');
}

// --------------------------------------------------------------------------
// Verb: state init
//
// Replaces: mkdir -p .orchestray/audit + Write current-orchestration.json
//           + printf orchestration_start event
// English gloss: initialise orchestration marker and log for this orch-id
// --------------------------------------------------------------------------

function cmdStateInit(positionals, flags, dryRun) {
  const orchId = positionals[0];
  if (!orchId) {
    die('state init', 'ox state init <orchestration_id> [--task="..."] [--dry-run]', 2);
  }

  // Validate orch-id: must start with "orch-" followed by alphanumerics/hyphens/underscores.
  // Real orchestrations use orch-<timestamp> (^orch-\d+$); test orchestrations may use
  // orch-<name> forms. The looser pattern covers both cases while still blocking obviously
  // invalid values.
  if (!/^orch-[a-zA-Z0-9_-]+$/.test(orchId)) {
    die('state init', `orchestration_id must start with 'orch-' followed by alphanumerics (got: ${orchId})`, 1);
  }

  const cwd    = projectRoot();
  const marker = readMarker(cwd);
  const task   = flags.task || null;
  const now    = new Date().toISOString();

  if (marker && marker.orchestration_id === orchId) {
    // Idempotent no-op.
    process.stdout.write(JSON.stringify({ noop: true, reason: `orchestration ${orchId} already active` }) + '\n');
    process.exit(0);
  }

  if (marker && marker.orchestration_id !== orchId) {
    die('state init',
      `active orchestration ${marker.orchestration_id} exists; cancel or complete it first`,
      1);
  }

  if (dryRun) {
    const mkrPath = getCurrentOrchestrationFile(cwd);
    process.stdout.write(
      `[dry-run] would write: ${mkrPath}\n` +
      `[dry-run] would append orchestration_start to: ${eventsPath(cwd)}\n`
    );
    process.exit(0);
  }

  const markerData = {
    orchestration_id: orchId,
    task:             task,
    started_at:       now,
  };
  writeMarker(cwd, markerData);

  const event = {
    timestamp:        now,
    type:             'orchestration_start',
    orchestration_id: orchId,
    task:             task,
    started_at:       now,
  };
  writeEvent(event, { cwd });
}

// --------------------------------------------------------------------------
// Verb: state complete
//
// Replaces: printf orchestration_complete event + remove marker
// English gloss: mark current orchestration complete with final status
// --------------------------------------------------------------------------

function cmdStateComplete(positionals, flags, dryRun) {
  const validStatuses = new Set(['success', 'partial', 'failure']);
  const status = flags.status || 'success';

  if (!validStatuses.has(status)) {
    die('state complete', `--status must be one of: success, partial, failure (got: ${status})`, 2);
  }

  const cwd    = projectRoot();
  const marker = readMarker(cwd);
  const now    = new Date().toISOString();

  if (!marker) {
    // No active orchestration — idempotent no-op.
    process.stdout.write(JSON.stringify({ noop: true, reason: 'no active orchestration' }) + '\n');
    process.exit(0);
  }

  const orchId = marker.orchestration_id;

  if (dryRun) {
    const mkrPath = getCurrentOrchestrationFile(cwd);
    process.stdout.write(
      `[dry-run] would append orchestration_complete (status=${status}, orch=${orchId}) to events.jsonl\n` +
      `[dry-run] would remove: ${mkrPath}\n`
    );
    process.exit(0);
  }

  const event = {
    timestamp:        now,
    type:             'orchestration_complete',
    orchestration_id: orchId,
    status:           status,
    completed_at:     now,
  };
  writeEvent(event, { cwd });

  const mkrPath = getCurrentOrchestrationFile(cwd);
  try {
    fs.unlinkSync(mkrPath);
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      die('state complete', `failed to remove marker: ${e.message}`, 1);
    }
  }
}

// --------------------------------------------------------------------------
// Verb: state pause
//
// Replaces: printf state_pause_set event + write pause sentinel
// English gloss: pause current orchestration and write resume sentinel
// --------------------------------------------------------------------------

function cmdStatePause(positionals, flags, dryRun) {
  const cwd    = projectRoot();
  const marker = readMarker(cwd);
  const reason = flags.reason || null;
  const now    = new Date().toISOString();

  if (!marker) {
    die('state pause', 'no active orchestration to pause', 1);
  }

  const orchId       = marker.orchestration_id;
  const sentinelPath = path.join(cwd, '.orchestray', 'state', 'pause-sentinel.json');

  // Idempotent: if already paused with same orch + reason, no-op.
  if (fs.existsSync(sentinelPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
      if (existing.orchestration_id === orchId && existing.reason === reason) {
        process.stdout.write(JSON.stringify({ noop: true, reason: `orchestration ${orchId} already paused` }) + '\n');
        process.exit(0);
      }
    } catch (_e) {
      // Corrupt sentinel — overwrite.
    }
  }

  if (dryRun) {
    process.stdout.write(
      `[dry-run] would write pause sentinel: ${sentinelPath}\n` +
      `[dry-run] would append state_pause_set event (orch=${orchId}) to: ${eventsPath(cwd)}\n`
    );
    process.exit(0);
  }

  const sentinel = { orchestration_id: orchId, reason, paused_at: now };
  const tmp = sentinelPath + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
  try {
    fs.writeFileSync(tmp, JSON.stringify(sentinel, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, sentinelPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) {}
    die('state pause', `failed to write sentinel: ${err.message}`, 1);
  }

  const event = {
    timestamp:        now,
    type:             'state_pause_set',
    orchestration_id: orchId,
    reason,
    paused_at:        now,
  };
  writeEvent(event, { cwd });
}

// --------------------------------------------------------------------------
// Verb: state peek (read-only)
//
// The canonical machine-readable verify path for the silent-success convention.
// Agents that need to confirm a mutator landed run `ox state peek --json`.
// English gloss: read and display current orchestration state (read-only)
//
// JSON shape:
//   { orchestration_id, status, phase, current_group, groups, last_event_ts, marker_path }
//
// With no active orchestration: status='none', other fields null.
// Peek NEVER errors on an absent orchestration; only on a corrupt one.
// --------------------------------------------------------------------------

function cmdStatePeek(positionals, flags, jsonMode) {
  const cwd        = projectRoot();
  const marker     = readMarker(cwd);
  const markerPath = getCurrentOrchestrationFile(cwd);

  if (!marker) {
    const result = {
      orchestration_id: null,
      status:           'none',
      phase:            null,
      current_group:    null,
      groups:           [],
      last_event_ts:    null,
      marker_path:      markerPath,
    };
    if (jsonMode) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      process.stdout.write('no active orchestration\n');
    }
    process.exit(0);
  }

  // Detect pause sentinel.
  const sentinelPath = path.join(cwd, '.orchestray', 'state', 'pause-sentinel.json');
  let isPaused = false;
  if (fs.existsSync(sentinelPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(sentinelPath, 'utf8'));
      if (s.orchestration_id === marker.orchestration_id) isPaused = true;
    } catch (_e) {}
  }

  // Read last event timestamp for this orchestration from events.jsonl.
  let lastEventTs = null;
  try {
    const raw   = fs.readFileSync(eventsPath(cwd), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.orchestration_id === marker.orchestration_id && parsed.timestamp) {
          lastEventTs = parsed.timestamp;
          break;
        }
      } catch (_e) {}
    }
  } catch (_e) {}

  const result = {
    orchestration_id: marker.orchestration_id,
    status:           isPaused ? 'paused' : 'active',
    phase:            marker.phase         || null,
    current_group:    marker.current_group || null,
    groups:           marker.groups        || [],
    last_event_ts:    lastEventTs,
    marker_path:      markerPath,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    process.stdout.write(
      `orch=${result.orchestration_id} status=${result.status}` +
      (result.last_event_ts ? ` last_event=${result.last_event_ts}` : '') + '\n'
    );
  }
}

// --------------------------------------------------------------------------
// Verb: routing add
//
// Replaces: 400-char printf one-liner at tier1-orchestration.md §14
// English gloss: append one routing-decision row to routing.jsonl
// Idempotent: tail-scans for duplicate (task_id + agent_type + model).
// --------------------------------------------------------------------------

function cmdRoutingAdd(positionals, flags, dryRun) {
  const [taskId, agentType, model, effort, scoreRaw] = positionals;

  if (!taskId || !agentType || !model) {
    die('routing add',
      'ox routing add <task_id> <agent_type> <model> [effort] [score] [--desc="..."] [--dry-run]',
      2);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
    die('routing add', `task_id must match ^[a-zA-Z0-9_-]+$ (got: ${taskId})`, 1);
  }

  if (!CANONICAL_AGENTS.has(agentType)) {
    die('routing add', `unknown agent_type: ${agentType}; must be one of the canonical agent set`, 1);
  }

  if (!VALID_MODELS.has(model)) {
    die('routing add', `unknown model: ${model}; use haiku, sonnet, or opus (or full model ID)`, 1);
  }

  const effortVal = effort || flags.effort || null;
  const scoreVal  = scoreRaw !== undefined ? Number(scoreRaw)
                  : flags.score            ? Number(flags.score)
                  : null;
  const desc      = flags.desc || flags.description || null;

  const cwd    = projectRoot();
  const marker = readMarker(cwd);

  if (!marker) {
    die('routing add', 'no active orchestration; run `ox state init <orch-id>` first', 1);
  }

  const orchId = marker.orchestration_id;
  const now    = new Date().toISOString();

  const row = {
    timestamp:        now,
    orchestration_id: orchId,
    task_id:          taskId,
    agent_type:       agentType,
    description:      desc,
    model:            model,
    effort:           effortVal,
    complexity_score: Number.isFinite(scoreVal) ? scoreVal : null,
    decided_by:       'pm',
    decided_at:       'decomposition',
  };

  if (dryRun) {
    process.stdout.write(`[dry-run] would append to routing.jsonl: ${JSON.stringify(row)}\n`);
    process.exit(0);
  }

  // Idempotent: check for existing row with same (task_id, agent_type, model).
  const rPath = routingPath(cwd);
  const wasAppended = atomicAppendJsonlIfAbsent(rPath, row, (existing) =>
    existing.orchestration_id === orchId &&
    existing.task_id          === taskId &&
    existing.agent_type       === agentType &&
    existing.model            === model
  );

  if (!wasAppended) {
    process.stdout.write(JSON.stringify({ noop: true, reason: `routing row for ${taskId}/${agentType}/${model} already exists` }) + '\n');
    process.exit(0);
  }
}

// --------------------------------------------------------------------------
// Verb: events append
//
// Replaces: ad-hoc printf to events.jsonl
// English gloss: append one audit event of the given type to events.jsonl
// Security: S03 — force orchestration_id from marker; reject reserved keys;
//           cap --extra at 2048 bytes.
// --------------------------------------------------------------------------

function cmdEventsAppend(positionals, flags, dryRun) {
  // Support --event-type=, --type= (alias), --event_type= (underscore alias).
  const eventType = flags['event-type'] || flags['type'] || flags['event_type'];

  if (!eventType) {
    die('events append', 'ox events append --event-type=<type> [--extra=json] [--task-id=...] [--dry-run]', 2);
  }

  const cwd    = projectRoot();
  const marker = readMarker(cwd);

  if (!marker) {
    die('events append', 'no active orchestration; run `ox state init <orch-id>` first', 1);
  }

  // S03: orchestration_id is FORCED from the marker. Never from --extra.
  const orchId = marker.orchestration_id;
  const now    = new Date().toISOString();
  const taskId = flags['task-id'] || flags['task_id'] || null;

  // S03: parse and validate --extra.
  let extra = {};
  if (flags.extra) {
    const extraStr = flags.extra;

    // S03c: cap at 2048 bytes.
    if (Buffer.byteLength(extraStr, 'utf8') > MAX_EXTRA_LEN) {
      die('events append', `--extra exceeds 2048-byte cap`, 2);
    }

    try {
      extra = JSON.parse(extraStr);
    } catch (parseErr) {
      die('events append', `--extra is not valid JSON: ${parseErr.message}`, 2);
    }

    if (typeof extra !== 'object' || Array.isArray(extra) || extra === null) {
      die('events append', '--extra must be a JSON object (not array or primitive)', 2);
    }

    // S03b: reject reserved keys.
    for (const key of Object.keys(extra)) {
      if (EXTRA_RESERVED_KEYS.has(key)) {
        die('events append', `--extra contains reserved key: ${key}`, 2);
      }
    }
  }

  const event = {
    timestamp:        now,
    type:             eventType,
    orchestration_id: orchId,  // S03: always from marker
    task_id:          taskId,
    ...extra,
  };

  if (dryRun) {
    process.stdout.write(`[dry-run] would append to events.jsonl: ${JSON.stringify(event)}\n`);
    process.exit(0);
  }

  writeEvent(event, { cwd });
}

// --------------------------------------------------------------------------
// Verb: help
//
// Format per AC-12: one-line header, blank line, one row per verb, sorted
// alphabetically, 2-space indent, 2-space column separators.
// --------------------------------------------------------------------------

const HELP_TEXT = `ox — Orchestray porcelain (user-facing CLI); v1 verbs for orchestration lifecycle.

  events append   --event-type=<t> [--extra=json]    —  append one audit event row
  routing add     <task> <agent> <model>              —  append one routing-decision row
  state complete  [--status=...]                      —  mark current orchestration complete
  state init      <orch-id> [--task=...]              —  initialise orchestration marker + log
  state pause     [--reason=...]                      —  write pause sentinel for resume
  state peek      [--json]                            —  emit current orchestration state
`;

function cmdHelp() {
  process.stdout.write(HELP_TEXT);
}

// --------------------------------------------------------------------------
// Main dispatch
// --------------------------------------------------------------------------

function main() {
  const { verb, subverb, positionals, flags, dryRun, jsonMode } = parseArgs();

  if (!verb || verb === 'help') {
    cmdHelp();
    process.exit(0);
  }

  if (verb === 'state') {
    if (!subverb) die('usage', 'ox state <init|complete|pause|peek> ...', 2);
    if (subverb === 'init')     return cmdStateInit(positionals, flags, dryRun);
    if (subverb === 'complete') return cmdStateComplete(positionals, flags, dryRun);
    if (subverb === 'pause')    return cmdStatePause(positionals, flags, dryRun);
    if (subverb === 'peek')     return cmdStatePeek(positionals, flags, jsonMode);
    die('state', `unknown subverb: ${subverb} (try \`ox help\`)`, 1);
  }

  if (verb === 'routing') {
    if (!subverb) die('usage', 'ox routing <add> ...', 2);
    if (subverb === 'add') return cmdRoutingAdd(positionals, flags, dryRun);
    die('routing', `unknown subverb: ${subverb} (try \`ox help\`)`, 1);
  }

  if (verb === 'events') {
    if (!subverb) die('usage', 'ox events <append> ...', 2);
    if (subverb === 'append') return cmdEventsAppend(positionals, flags, dryRun);
    die('events', `unknown subverb: ${subverb} (try \`ox help\`)`, 1);
  }

  // Unknown top-level verb — exit 1 per AC-04.
  die(verb, `unknown verb (try \`ox help\`)`, 1);
}

main();
