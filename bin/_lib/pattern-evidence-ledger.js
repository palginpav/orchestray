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
 * load-bearing for work that has not landed yet.
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

module.exports = {
  appendOffer,
  appendAck,
  appendJournal,
  readOffersForOrch,
  readAcksForOrch,
  // Path resolvers exported for tests and for the orch-close archive sweep
  // (design §10.1 — these two files move into .orchestray/history/<orch-id>/
  // alongside sibling operational state, same as mcp-checkpoint.jsonl).
  _offersPath: offersPath,
  _acksPath: acksPath,
  _journalPath: journalPath,
};
