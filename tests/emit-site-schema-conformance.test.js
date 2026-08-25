#!/usr/bin/env node
'use strict';

/**
 * emit-site-schema-conformance.test.js — W7 (v2.3.33)
 *
 * Regression guard: every audit-event emit site whose payload can be read
 * statically must supply the fields its schema declares required.
 *
 * Why this exists. Schema validation never ran outside the Orchestray repo
 * until v2.3.33 W1, so a mismatch between an emitter and its schema produced
 * advisory rows nobody ever saw. Four separate classes of that mismatch were
 * found in this one release:
 *
 *   W3 — `task_completed` omitted a required field.
 *   W5 — 25 event types sat under `## ` headings the parser never anchored.
 *   W6 — `kill_switch_activated` had two emitters and a one-emitter schema.
 *   W8 — the parser hoisted keys out of nested arrays (e.g. `contract_check`'s
 *        `checks: [{target, result, detail}]`) into the event's own required
 *        list, making correctly-shaped emitters look like violations.
 *
 * Every one of those was invisible to an 8,000-test suite. This gate closes
 * the emitter-vs-schema axis; `schema-declared-types-parseable.test.js` (W5)
 * closes the declared-but-unparseable axis.
 *
 * Contract:
 *   - VIOLATION  -> hard fail. A literal payload provably lacks a required field.
 *   - UNANALYSABLE -> tolerated, but the count is pinned. These are payloads
 *     built via spread, a helper, or conditional assembly, where keys cannot be
 *     determined without executing the code. Pinning the count means the number
 *     can be driven DOWN over time but cannot silently grow — a new
 *     unanalysable site is a deliberate choice someone has to make explicit.
 *   - CLEAN -> counted, no assertion beyond the total staying sane.
 *
 * The pin is a ceiling, not an equality: lowering it (by making a site
 * analysable) should never fail the build. Raising it must be deliberate.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { sweep } = require('../bin/_tools/audit-emit-schema-conformance.js');

const repoRoot = path.join(__dirname, '..');

// Ratchet. Lower is better; this number must never rise without a stated reason.
//   84 -> 43 at v2.3.33 W9 (multi-hop const tracing, spread-of-literal merging)
//   43 -> 39 at v2.3.33 W9 (removed skipValidation from discover-custom-agents.js;
//                           its 3 schemas were stale and are now aligned to reality)
//
// The 39 residual sites, by construct:
//   13  payload is neither a literal nor traceable to one within its scope
//   13  the event type itself is computed, so no single schema applies
//   11  a top-level spread may supply the fields that look missing
//    2  writeAuditEvent factory shape, assembled at runtime by extraFieldsPicker
//
// None of these is a known defect — each is a construct static analysis cannot
// resolve without executing the code. They remain holes in this gate, so the
// number is worth driving down further; it is not worth rewriting correct
// emitters purely to satisfy the analyser.
const UNANALYSABLE_CEILING = 39;

describe('emit-site schema conformance (W7, v2.3.33)', () => {
  const result = sweep({ cwd: repoRoot });

  test('no emit site omits a field its schema declares required', () => {
    const violations = result.violations || [];
    const detail = violations
      .map((v) => `${v.file}:${v.line} [${v.type}] missing: ${(v.missing || []).join(', ')}`)
      .join('\n  ');
    assert.equal(
      violations.length,
      0,
      violations.length === 0
        ? ''
        : `${violations.length} emit site(s) omit a required field.\n  ${detail}\n` +
          'Decide per event whether the EMITTER should carry the field or the SCHEMA ' +
          'should not require it, and fix that side. Do not loosen a schema merely to ' +
          'make this pass — see the W3/W6 precedents in the file header.'
    );
  });

  test('the statically-opaque emit-site count has not grown', () => {
    const n = (result.unanalysable || []).length;
    assert.ok(
      n <= UNANALYSABLE_CEILING,
      `statically-opaque emit sites rose to ${n} (ceiling ${UNANALYSABLE_CEILING}). ` +
      'A payload built via spread/helper/conditional cannot be checked against its ' +
      'schema, so each one is a hole in this gate. Either build the payload as a ' +
      'literal, or raise the ceiling deliberately and record why.'
    );
  });

  test('the sweep actually inspected a meaningful number of sites', () => {
    // Guards against the sweep silently returning nothing — a passing gate that
    // checks zero sites is the failure mode this whole release is about.
    const total =
      (result.clean || []).length +
      (result.violations || []).length +
      (result.unanalysable || []).length;
    assert.ok(total > 200, `sweep inspected only ${total} emit sites; expected > 200`);
  });
});
