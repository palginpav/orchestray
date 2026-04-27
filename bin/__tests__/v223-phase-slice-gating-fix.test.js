#!/usr/bin/env node
'use strict';

/**
 * v223-phase-slice-gating-fix.test.js — v2.2.3 P0-4 (I-PHASE-GATE-SILENT).
 *
 * Bug: `bin/inject-active-phase-slice.js` emitted
 * `phase_slice_fallback{ reason: 'no_active_orchestration' }` whenever its
 * UserPromptSubmit hook fired outside an orchestration window (session start,
 * idle PM turns, etc.). W3 §E telemetry showed 46/48 fallback events were
 * this noise reason, drowning the legitimate fault signals
 * (`unrecognized_phase`, `slice_file_missing:*`).
 *
 * Fix: silently no-op when (a) orchestration.md does not exist OR (b)
 * orchestration.md exists but has no parseable `phase:` line. Continue to
 * emit fallback for the legitimate cases (unknown phase value, missing slice
 * file on disk).
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');
const { spawnSync }      = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, 'bin', 'inject-active-phase-slice.js');
const EVENTS_REL = path.join('.orchestray', 'audit', 'events.jsonl');
const SLICES_REL = path.join('agents', 'pm-reference');
const SLICE_FILES = ['phase-decomp.md', 'phase-execute.md', 'phase-verify.md', 'phase-close.md'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a temp repo containing the audit-event-writer dependencies and (by
 * default) the slice files the hook copies. Tests can opt out of slice-file
 * staging by passing { slicesPresent: false } to exercise the
 * `slice_file_missing:*` fault path.
 */
function makeRepo(opts = {}) {
  const slicesPresent = opts.slicesPresent !== false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-phase-slice-'));

  fs.mkdirSync(path.join(dir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin', '_lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, SLICES_REL), { recursive: true });

  // Copy audit-event-writer + transitive deps so the hook's emit path can
  // actually write events.jsonl. We mirror the same support files
  // v222-bucket-a-fixes.test.js relies on.
  const libsToCopy = [
    'audit-event-writer.js',
    'atomic-append.js',
    'resolve-project-cwd.js',
    'orchestration-state.js',
    'constants.js',
    'schema-emit-validator.js',
    'load-schema-shadow.js',
  ];
  for (const lib of libsToCopy) {
    const src = path.join(REPO_ROOT, 'bin', '_lib', lib);
    const dst = path.join(dir, 'bin', '_lib', lib);
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }

  // Copy event-schemas.md so schema-emit-validator can find it (fail-open if
  // missing; we still copy to keep validation non-degraded).
  const schemaSrc = path.join(REPO_ROOT, SLICES_REL, 'event-schemas.md');
  const schemaDst = path.join(dir, SLICES_REL, 'event-schemas.md');
  if (fs.existsSync(schemaSrc)) fs.copyFileSync(schemaSrc, schemaDst);

  if (slicesPresent) {
    for (const slice of SLICE_FILES) {
      const src = path.join(REPO_ROOT, SLICES_REL, slice);
      const dst = path.join(dir, SLICES_REL, slice);
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    }
  }

  return dir;
}

function writeOrch(cwd, content) {
  fs.writeFileSync(path.join(cwd, '.orchestray', 'state', 'orchestration.md'), content);
}

function readEvents(cwd) {
  const p = path.join(cwd, EVENTS_REL);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch (_e) { return null; }
    })
    .filter(Boolean);
}

/**
 * Count "fallback emit attempts" — counts both raw `phase_slice_fallback`
 * events AND the `schema_shadow_validation_block` surrogates the audit
 * gateway substitutes when the raw event fails schema validation. Tests
 * care about emit *intent*, not the gateway's downstream handling. The
 * gateway's surrogate shape is documented in audit-event-writer.js.
 *
 * Also extracts the `reason` field from either event shape so callers can
 * assert on it uniformly. For the surrogate, reason lives in the
 * `original_payload` field if present; otherwise we synthesize from the
 * blocked_event_type's known emit sites (limited to this hook here, so we
 * fall through to "<surrogate>" which still proves a fallback was attempted).
 */
function fallbackAttempts(events) {
  return events.filter((e) =>
    e.type === 'phase_slice_fallback' ||
    (e.type === 'schema_shadow_validation_block' &&
     e.blocked_event_type === 'phase_slice_fallback')
  );
}

function fallbackReason(event) {
  if (event.type === 'phase_slice_fallback') return event.reason;
  // Surrogate: reason is preserved in the original_payload if the gateway
  // includes it. If not, the test's spawn-context determines reason and we
  // return a sentinel that callers will recognize.
  if (event.original_payload && event.original_payload.reason) {
    return event.original_payload.reason;
  }
  return null; // unknown — caller falls back to context
}

/**
 * Spawn the hook as a subprocess (the production invocation path) and return
 * `{ stdout, events }`. The hook reads JSON from stdin per Claude Code's hook
 * contract; we feed `{}` since the handler does not depend on payload fields
 * for this path.
 */
function runHook(cwd) {
  const r = spawnSync('node', [HOOK_PATH], {
    cwd,
    input: '{}',
    encoding: 'utf8',
    timeout: 10000,
  });
  if (r.status !== 0) {
    throw new Error(
      'hook exited non-zero status=' + r.status +
      ' stdout=' + JSON.stringify(r.stdout) +
      ' stderr=' + JSON.stringify(r.stderr)
    );
  }
  return { stdout: r.stdout, events: readEvents(cwd) };
}

// ---------------------------------------------------------------------------
// Module-level handle() invocation (faster + isolates from stdin parsing)
// ---------------------------------------------------------------------------

const phaseSliceMod = require('../inject-active-phase-slice.js');

// ---------------------------------------------------------------------------
// inspectOrchestration unit tests — the new triage helper
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-4 — inspectOrchestration triage helper', () => {

  test('no orchestration.md → { exists: false, phase: null }', () => {
    const cwd = makeRepo();
    try {
      const r = phaseSliceMod.inspectOrchestration(cwd);
      assert.deepEqual(r, { exists: false, phase: null });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('orchestration.md present but no phase line → { exists: true, phase: null }', () => {
    const cwd = makeRepo();
    try {
      writeOrch(cwd, '# Orchestration\n\nNo phase reference here.\n');
      const r = phaseSliceMod.inspectOrchestration(cwd);
      assert.deepEqual(r, { exists: true, phase: null });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('YAML frontmatter `current_phase: execute` → { exists: true, phase: "execute" }', () => {
    const cwd = makeRepo();
    try {
      writeOrch(cwd, '---\ncurrent_phase: execute\n---\nbody');
      const r = phaseSliceMod.inspectOrchestration(cwd);
      assert.deepEqual(r, { exists: true, phase: 'execute' });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('bold-list `- **phase**: verify` → { exists: true, phase: "verify" }', () => {
    const cwd = makeRepo();
    try {
      writeOrch(cwd, '- **orchestration_id**: orch-foo\n- **phase**: verify\n');
      const r = phaseSliceMod.inspectOrchestration(cwd);
      assert.deepEqual(r, { exists: true, phase: 'verify' });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end hook subprocess tests — silent gate
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-4 — hook silently no-ops when no active orchestration', () => {

  test('no orchestration.md → exits cleanly with `{continue:true}` and NO event', () => {
    const cwd = makeRepo();
    try {
      const { stdout, events } = runHook(cwd);
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.continue, true,
        'hook must respond {continue:true}');
      assert.equal(parsed.hookSpecificOutput, undefined,
        'no slice was staged → no hookSpecificOutput');
      assert.equal(events.length, 0,
        'NO phase_slice_fallback event must fire when orchestration is absent; got: ' +
        JSON.stringify(events));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('orchestration.md without phase line → exits cleanly, NO event', () => {
    const cwd = makeRepo();
    try {
      writeOrch(cwd, '# Orchestration\n\nFreeform body, no phase reference.\n');
      const { stdout, events } = runHook(cwd);
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.continue, true);
      assert.equal(parsed.hookSpecificOutput, undefined);
      assert.equal(events.length, 0,
        'NO phase_slice_fallback event must fire when phase line is absent; got: ' +
        JSON.stringify(events));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end positive-path regression: active orchestration still injects
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-4 — active orchestration still injects (regression)', () => {

  test('active orch + valid phase → slice staged + `phase_slice_injected` event', () => {
    const cwd = makeRepo();
    try {
      writeOrch(cwd, '- **phase**: execute\n');
      const { stdout, events } = runHook(cwd);
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.continue, true);
      assert.ok(parsed.hookSpecificOutput,
        'expected hookSpecificOutput when slice staged; got: ' + stdout);
      assert.match(parsed.hookSpecificOutput.additionalContext, /phase-execute\.md/,
        'pointer must reference phase-execute.md');

      // Active phase slice file copied into state dir.
      const stagedPath = path.join(cwd, '.orchestray', 'state', 'active-phase-slice.md');
      assert.ok(fs.existsSync(stagedPath), 'active-phase-slice.md must exist');

      // Exactly one phase_slice_injected event, no fallback.
      const injected = events.filter((e) => e.type === 'phase_slice_injected');
      const fallback = events.filter((e) => e.type === 'phase_slice_fallback');
      assert.equal(injected.length, 1,
        'exactly one phase_slice_injected event expected; got ' + injected.length);
      assert.equal(fallback.length, 0,
        'no fallback should fire on positive path; got ' + JSON.stringify(fallback));
      assert.equal(injected[0].phase, 'execute');
      assert.equal(injected[0].slice_path, 'agents/pm-reference/phase-execute.md');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: legitimate fault signals still emit fallback
// ---------------------------------------------------------------------------

describe('v2.2.3 P0-4 — legitimate fault signals still emit fallback', () => {

  test('active orch + UNKNOWN phase value → fallback fires with `unrecognized_phase`', () => {
    const cwd = makeRepo();
    try {
      writeOrch(cwd, '- **phase**: zzz_not_a_real_phase\n');
      const { events } = runHook(cwd);
      const attempts = fallbackAttempts(events);
      assert.equal(attempts.length, 1,
        'unrecognized phase MUST still emit fallback (raw or surrogate); got ' +
        JSON.stringify(events));
      // If raw fallback survived schema validation, assert on its reason; if it
      // was rewritten to a surrogate, the spawn-context here is the only
      // unrecognized-phase path so the surrogate still proves the fault was
      // emitted. Either way, NO silent drop.
      const reason = fallbackReason(attempts[0]);
      if (reason !== null) {
        assert.equal(reason, 'unrecognized_phase');
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('active orch + valid phase + missing slice file → `slice_file_missing:*` fires', () => {
    const cwd = makeRepo({ slicesPresent: false });
    try {
      writeOrch(cwd, '- **phase**: execute\n');
      const { events } = runHook(cwd);
      const attempts = fallbackAttempts(events);
      assert.equal(attempts.length, 1,
        'missing slice file MUST still emit fallback (raw or surrogate); got ' +
        JSON.stringify(events));
      const reason = fallbackReason(attempts[0]);
      if (reason !== null) {
        assert.match(reason, /^slice_file_missing:phase-execute\.md$/);
      }
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('the dropped reason `no_active_orchestration` is NEVER emitted post-fix', () => {
    // Sweep: across all four "no active orchestration" code paths the hook
    // could plausibly hit, none should surface the deprecated reason.
    const scenarios = [
      { label: 'no orch.md', setup: () => {} },
      { label: 'orch.md no phase', setup: (cwd) => writeOrch(cwd, '# foo\n') },
      { label: 'orch.md empty', setup: (cwd) => writeOrch(cwd, '') },
    ];
    for (const sc of scenarios) {
      const cwd = makeRepo();
      try {
        sc.setup(cwd);
        const { events } = runHook(cwd);
        const dropped = events.filter(
          (e) => e.type === 'phase_slice_fallback' &&
                 e.reason === 'no_active_orchestration'
        );
        assert.equal(dropped.length, 0,
          `[${sc.label}] dropped reason must not emit; got ` + JSON.stringify(events));
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });
});
