'use strict';

/**
 * fixture-shape.js — structural fingerprint of a hook payload (v2.3.18 W0, BDG).
 *
 * Collapses a hook payload down to its *shape* so that two payloads which
 * exercise the same code path hash to the same value, while two payloads that
 * take different branches do not. Used by the Behavior Diff Gate (BDG) fixture
 * corpus to answer "have we already captured this shape?" without storing the
 * payload itself.
 *
 * Design rationale (from `.orchestray/kb/artifacts/v2318-invention-quality-mechanisms.md` §2.4):
 * most string values in a hook payload are prose or paths and steer nothing.
 * A handful of keys DO steer control flow — those keep their literal value so
 * the two branches stay distinguishable in the corpus.
 *
 * This module is pure: no I/O, no env reads, no throwing on cyclic input.
 */

const crypto = require('crypto');

// Keys whose VALUE steers control flow — kept literal so branches stay distinguishable.
const LITERAL_KEYS = new Set([
  'subagent_type',
  'agent_type',
  'hook_event_name',
  'hookEventName',
  'tool_name',
  'source',
  'stop_hook_active',
]);

const MAX_LITERAL_LEN = 40;

/**
 * Reduce a value to its shape descriptor.
 *
 * @param {*} v
 * @param {string} [key] — the object key `v` was found under (drives LITERAL_KEYS).
 * @param {WeakSet} [seen] — cycle guard.
 * @returns {*} A JSON-serialisable shape descriptor.
 */
function shapeOf(v, key, seen) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '[' + JSON.stringify(shapeOf(v[0], undefined, seen)) + ']';
  }
  if (typeof v === 'object') {
    const guard = seen || new WeakSet();
    if (guard.has(v)) return 'cycle';
    guard.add(v);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = shapeOf(v[k], k, guard);
    return out;
  }
  if (LITERAL_KEYS.has(key)) return typeof v + ':' + String(v).slice(0, MAX_LITERAL_LEN);
  if (typeof v === 'string') return v.length === 0 ? 'string:empty' : 'string';
  return typeof v;
}

/**
 * Stable 12-hex-char fingerprint of a payload's shape.
 *
 * @param {*} payload
 * @returns {string}
 */
function shapeHash(payload) {
  let serialised;
  try {
    serialised = JSON.stringify(shapeOf(payload));
  } catch (_e) {
    serialised = 'unhashable';
  }
  return crypto.createHash('sha256').update(String(serialised)).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Observations (v2.3.18 W5b, BDG)
// ---------------------------------------------------------------------------
//
// An *observation* is what one script did to one fixture: `{code, events,
// stderr_class}`. Two rules here are not stylistic, they came out of the §2.4
// prototype run and the design calls both mandatory:
//
//   1. stderr is compared by CLASS, never by text. Refactors legitimately
//      reword messages; if wording churn reads as behavior change, every commit
//      carries a waiver and the gate becomes a rubber stamp.
//   2. The trivial observation `{0, [], ''}` on BOTH sides means the script was
//      never exercised, NOT that behavior is unchanged. Reporting that as
//      `deltas: []` turns BDG into a false-negative machine that reports green
//      while testing nothing.

/** Longest stderr prefix kept when classing a message. */
const MAX_STDERR_CLASS_LEN = 60;

/**
 * Reduce stderr to a comparison class: first line, truncated at the first
 * quoted span (where paths and identifiers live), capped.
 *
 * @param {string} stderr
 * @returns {string} `''` for empty stderr.
 */
function stderrClass(stderr) {
  const s = String(stderr || '');
  if (!s) return '';
  return s.split('\n')[0].replace(/["'`].*/, '').trim().slice(0, MAX_STDERR_CLASS_LEN);
}

/**
 * Normalise a raw run into a comparable observation.
 *
 * @param {{code?: number, events?: string[], stderr?: string}} raw
 * @returns {{code: number, events: string[], stderr_class: string}}
 */
function observationOf(raw) {
  const r = raw || {};
  return {
    code: Number.isFinite(r.code) ? r.code : 0,
    events: Array.isArray(r.events) ? [...r.events].sort() : [],
    stderr_class: stderrClass(r.stderr !== undefined ? r.stderr : r.stderr_class),
  };
}

/**
 * True for `{code: 0, events: [], stderr_class: ''}` — the fingerprint of a
 * script that fail-opened without reaching any decision. Our hooks are
 * state-dependent and fail-open by design, so this is the *common* outcome for
 * a badly-built fixture, not an edge case.
 *
 * @param {object} obs
 * @returns {boolean}
 */
function isTrivialObservation(obs) {
  if (!obs || typeof obs !== 'object') return true;
  return obs.code === 0 &&
    Array.isArray(obs.events) && obs.events.length === 0 &&
    !obs.stderr_class;
}

/**
 * Structural equality of two observations.
 *
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function observationEquals(a, b) {
  const x = observationOf(a);
  const y = observationOf(b);
  return x.code === y.code &&
    x.stderr_class === y.stderr_class &&
    x.events.length === y.events.length &&
    x.events.every((e, i) => e === y.events[i]);
}

/**
 * True for a well-formed BDG fixture — `{stdin, state}`, not a bare payload.
 *
 * The §2.4 prototype run proved a stdin-only fixture exercises almost none of a
 * hook's real decision surface: every observation collapsed to `{0, [], ''}`
 * even for inputs that should have tripped the gate. `state` is what makes the
 * replay mean anything, so a fixture without it is rejected at the door.
 *
 * @param {*} fixture
 * @returns {boolean}
 */
function isFixture(fixture) {
  return !!fixture && typeof fixture === 'object' && !Array.isArray(fixture) &&
    'stdin' in fixture && !!fixture.stdin && typeof fixture.stdin === 'object' &&
    'state' in fixture && !!fixture.state && typeof fixture.state === 'object';
}

module.exports = {
  shapeHash,
  shapeOf,
  LITERAL_KEYS,
  stderrClass,
  observationOf,
  isTrivialObservation,
  observationEquals,
  isFixture,
  MAX_STDERR_CLASS_LEN,
};
