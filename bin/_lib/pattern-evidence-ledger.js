'use strict';

/**
 * pattern-evidence-ledger.js — read/append primitives for the pattern
 * evidence pipeline (design: pattern-application-evidence-design.md §4, §11).
 *
 * Phase 1 (bin/record-pattern-offers.js, this wave) calls appendOffer() for
 * every spawn that carries ≥1 resolvable pattern slug. Phase 2 (a future
 * rewrite of bin/validate-pattern-ack.js) and Phase 3
 * (bin/commit-pattern-applications.js, orch-close) consume the rest of this
 * API — appendAck(), readOffersForOrch(), readAcksForOrch(), appendJournal().
 * This module's exports ARE that contract; treat every signature here as
 * load-bearing for work that has not landed yet. That includes the Phase-1↔2
 * join key — spawnAgentName/stopAgentName/findOfferRowForAgent at the bottom
 * of this file are the single definition of how an ack finds its offer.
 *
 * NOT included here: `computeCredits` (design §11 lists it in this file,
 * but it is a pure join over offers/acks/orchEvents/config implementing the
 * §5 bounds — Phase-3 business logic, not a ledger read/write primitive).
 * It belongs with bin/commit-pattern-applications.js, whoever builds Phase 3.
 *
 * Files (under `cwd`, created on first append):
 *   .orchestray/state/pattern-offers.jsonl
 *   .orchestray/state/pattern-acks.jsonl
 *   .orchestray/state/pattern-counter-journal.jsonl
 *
 * Contract:
 *   - Every append goes through atomicAppendJsonl (advisory-locked,
 *     fail-open on lock contention — see bin/_lib/atomic-append.js). Append
 *     functions additionally swallow any I/O error: a broken ledger must
 *     never throw into a spawn hook.
 *   - Every read fails open to []: a missing or corrupt ledger file is
 *     "no rows", not an error, so a mid-orchestration caller never crashes.
 *   - Reads cap at MAX_JSONL_READ_BYTES (mirrors atomic-append.js's own
 *     guard) — these files are per-orchestration-scoped and archived at
 *     orch-close, so this is a defensive ceiling, not a normal path.
 */

const fs   = require('fs');
const path = require('path');
const { atomicAppendJsonl, MAX_JSONL_READ_BYTES } = require('./atomic-append');
const { stripCollisionSuffix } = require('./caller-identity');

const OFFERS_REL  = path.join('.orchestray', 'state', 'pattern-offers.jsonl');
const ACKS_REL    = path.join('.orchestray', 'state', 'pattern-acks.jsonl');
const JOURNAL_REL = path.join('.orchestray', 'state', 'pattern-counter-journal.jsonl');

function offersPath(cwd) { return path.join(cwd, OFFERS_REL); }
function acksPath(cwd) { return path.join(cwd, ACKS_REL); }
function journalPath(cwd) { return path.join(cwd, JOURNAL_REL); }

/**
 * Append one offer row to pattern-offers.jsonl. Fail-open — never throws.
 *
 * @param {string} cwd
 * @param {object} row - see design §4.1 for the row shape.
 * @returns {void}
 */
function appendOffer(cwd, row) {
  try { atomicAppendJsonl(offersPath(cwd), row); } catch (_e) { /* fail-open */ }
}

/**
 * Append one ack row to pattern-acks.jsonl (Phase 2 producer). Fail-open.
 *
 * @param {string} cwd
 * @param {object} row - see design §4.2 for the row shape.
 * @returns {void}
 */
function appendAck(cwd, row) {
  try { atomicAppendJsonl(acksPath(cwd), row); } catch (_e) { /* fail-open */ }
}

/**
 * Append one row to pattern-counter-journal.jsonl (Phase 3 committer;
 * consumed in reverse by bin/pattern-counter-revert.js). Fail-open.
 *
 * @param {string} cwd
 * @param {object} row - see design §10.2 for the row shape.
 * @returns {void}
 */
function appendJournal(cwd, row) {
  try { atomicAppendJsonl(journalPath(cwd), row); } catch (_e) { /* fail-open */ }
}

/**
 * Read and parse every line of a JSONL file. Fail-open to [] on any error
 * (missing file, oversize file, malformed lines are skipped individually).
 *
 * @param {string} filePath
 * @returns {object[]}
 */
function readJsonlLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_JSONL_READ_BYTES) {
      process.stderr.write(
        '[orchestray] pattern-evidence-ledger: ' + filePath + ' too large (' +
        stat.size + ' bytes) — skipping read\n'
      );
      return [];
    }
  } catch (_e) {
    return []; // missing/unstattable — no rows
  }

  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_e) { return []; }

  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch (_e) { /* skip malformed line */ }
  }
  return out;
}

/**
 * Offer rows for one orchestration, in file (append) order. Fail-open to [].
 *
 * @param {string} cwd
 * @param {string} orchId
 * @returns {object[]}
 */
function readOffersForOrch(cwd, orchId) {
  return readJsonlLines(offersPath(cwd)).filter((r) => r && r.orchestration_id === orchId);
}

/**
 * Ack rows for one orchestration, in file (append) order. Fail-open to [].
 *
 * @param {string} cwd
 * @param {string} orchId
 * @returns {object[]}
 */
function readAcksForOrch(cwd, orchId) {
  return readJsonlLines(acksPath(cwd)).filter((r) => r && r.orchestration_id === orchId);
}

// ---------------------------------------------------------------------------
// The offer↔ack join key. BOTH sides resolve it here, in this one file.
//
// Phase 1 runs at PreToolUse:Agent, Phase 2 at SubagentStop, and those two
// payloads share exactly two values: `session_id` and the agent's ROSTER NAME.
// They do NOT share an id — PreToolUse has `tool_use_id`, SubagentStop has no
// such field, and the two `agent_id`s that do exist are differently shaped
// (`dev-d1-gate@session-bed562d5` at PostToolUse vs `adev-pe4-registry-<hash>`
// at SubagentStop). Hence the composite key.
//
// The roster name is unique per session because Claude Code auto-suffixes a
// colliding registration (`curate-runner` → `curate-runner-2`; see
// caller-identity.js#stripCollisionSuffix, which exists to undo exactly that).
// The suffix is applied by the runtime AFTER Phase 1 has already recorded the
// requested name, so the stop-side lookup must tolerate it — see
// findOfferRowForAgent.
//
// This subsystem has shipped two identifier disagreements between its phases
// already. Co-locating both resolvers is the mechanical fix: a change to one
// side cannot land without the other side moving with it.
// ---------------------------------------------------------------------------

/** Key parts are compared case-/whitespace-insensitively; non-strings are ''. */
function normKeyPart(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Producer side (PreToolUse:Agent): the roster name this spawn was requested
 * under. `tool_input.name` is the Agent Teams roster name; absent it, the
 * runtime names the agent after its `subagent_type`.
 *
 * Returns the NORMALIZED name — that is what goes on the ledger row, so the
 * two sides cannot drift on casing.
 *
 * @param {object} toolInput
 * @returns {string} '' when unresolvable
 */
function spawnAgentName(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  return normKeyPart(toolInput.name) || normKeyPart(toolInput.subagent_type);
}

/**
 * Consumer side (SubagentStop): `event.agent_type` is the roster name of the
 * agent that just stopped — NOT its subagent_type, and not the caller's type
 * the way the identically-named field reads at PreToolUse (caller-identity.js
 * header, verified against 55/55 live sidecars).
 *
 * @param {object} event
 * @returns {string} '' when unresolvable
 */
function stopAgentName(event) {
  if (!event || typeof event !== 'object') return '';
  return normKeyPart(event.agent_type);
}

/**
 * Offer row for the agent that just stopped, or null.
 *
 * Match order:
 *   1. Exact (session_id, agent_name). Multiple hits are the retry/duplicate
 *      case — same requested name, so the most recent offer set is in force.
 *   2. No exact hit → compare with the collision suffix stripped from both
 *      sides, which repairs "requested `foo`, registered `foo-2`". Accepted
 *      only when exactly one row matches: two rows under one base name is a
 *      genuine ambiguity, and guessing would attribute a sibling spawn's
 *      offers to this agent.
 *
 * Known bound: a name reused SEQUENTIALLY inside one orchestration+session
 * (the first agent already deregistered, so the runtime does not suffix) makes
 * both spawns share a key; rule 1 gives the stop the newer offer set. Blast
 * radius is a coverage warning computed against the wrong offer set — the §5
 * per-slug and per-orchestration credit caps are unaffected.
 *
 * @param {string} cwd
 * @param {string} orchId
 * @param {string} sessionId
 * @param {string} agentName - already normalized (stopAgentName/spawnAgentName)
 * @returns {object|null}
 */
function findOfferRowForAgent(cwd, orchId, sessionId, agentName) {
  if (!agentName) return null;
  const sess = normKeyPart(sessionId);
  const rows = readOffersForOrch(cwd, orchId).filter((r) => normKeyPart(r.session_id) === sess);

  const exact = rows.filter((r) => normKeyPart(r.agent_name) === agentName);
  if (exact.length > 0) return exact[exact.length - 1];

  const base = normKeyPart(stripCollisionSuffix(agentName));
  const stripped = rows.filter((r) => normKeyPart(stripCollisionSuffix(r.agent_name)) === base);
  return stripped.length === 1 ? stripped[0] : null;
}

module.exports = {
  appendOffer,
  appendAck,
  appendJournal,
  readOffersForOrch,
  readAcksForOrch,
  spawnAgentName,
  stopAgentName,
  findOfferRowForAgent,
  // Path resolvers exported for tests and for the orch-close archive sweep
  // (design §10.1 — these two files move into .orchestray/history/<orch-id>/
  // alongside sibling operational state, same as mcp-checkpoint.jsonl).
  _offersPath: offersPath,
  _acksPath: acksPath,
  _journalPath: journalPath,
};
