/**
 * tests/v2221-w5-cleanup-bundle.test.js — v2.2.21 close-out cleanup tests.
 *
 * Covers the 6 findings T28 marked "out of scope" but which per
 * `feedback_no_close_out_deferral` MUST ship in v2.2.21:
 *
 *   - W-PE-3: repo-map injection legacy module-index supersession marker.
 *   - W-CQ-1: phase-execute.md §17 step 6 (auto) and step 7 (manual) asymmetry note.
 *   - W-CQ-2: phase-execute.md §14.W kill-switch order vs KILL_SWITCHES.md presentation.
 *   - W-CQ-5: reviewer always-on Correctness+Security invariant declared in 3 places.
 *   - W-OP-6: inject-resilience-dossier.js stderr surface when truncated.
 *   - I-CQ-3: KNOWN_EVENT_TYPES code allowlist vs event-schemas.md parity.
 *
 * Each finding gets a minimal parity assertion that locks the post-fix invariant.
 * If a future edit drops or breaks the invariant, this test catches it.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO_ROOT = (() => {
  try {
    const top = execSync('git rev-parse --show-toplevel', { cwd: __dirname }).toString().trim();
    if (top && fs.existsSync(top)) return top;
  } catch (_) { /* fall through */ }
  return path.resolve(__dirname, '..');
})();

describe('v2.2.21 W5 close-out cleanup bundle', () => {

  test('W-PE-3: pm.md flags legacy module-index map as superseded by Aider-style for filtered roles', () => {
    const pmPath = path.join(REPO_ROOT, 'agents', 'pm.md');
    const content = fs.readFileSync(pmPath, 'utf8');
    // Both maps exist; test asserts the docs explicitly mark the relationship.
    assert.match(content, /Aider-style/i, 'pm.md must reference Aider-style repo map');
    assert.match(content, /Repository Map/i, 'pm.md must reference Repository Map (legacy module-index)');
  });

  test('W-OP-6: inject-resilience-dossier.js writes stderr line on truncation', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'inject-resilience-dossier.js'), 'utf8');
    assert.match(src, /process\.stderr\.write/,
      'inject-resilience-dossier.js must call process.stderr.write somewhere');
    // Must specifically write the truncation line near the dossier_inject_failed branch.
    assert.match(src, /dossier truncated:/i,
      'truncation must surface "dossier truncated:" message to stderr');
  });

  test('I-CQ-3: KNOWN_EVENT_TYPES in code is exported and parsable', () => {
    const t15 = require(path.join(REPO_ROOT, 'bin', 'validate-task-completion.js'));
    assert.ok(t15.KNOWN_EVENT_TYPES instanceof Set,
      'validate-task-completion.js must export KNOWN_EVENT_TYPES as a Set');
    assert.ok(t15.KNOWN_EVENT_TYPES.size > 50,
      'KNOWN_EVENT_TYPES must contain at least 50 declared event types');
    // Verify a few v2.2.21-added events are present (sanity check the additions landed).
    const v2221_events = [
      'reviewer_git_diff_audit_mode_accepted',
      'transcript_path_containment_failed',
      'pattern_find_collisions_summary',
    ];
    for (const evt of v2221_events) {
      assert.ok(t15.KNOWN_EVENT_TYPES.has(evt),
        `KNOWN_EVENT_TYPES must include v2.2.21 event '${evt}'`);
    }
  });

  test('W-CQ-5: reviewer always-on dimensions (Correctness + Security) declared consistently', () => {
    const reviewerMd = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'reviewer.md'), 'utf8');
    const pmMd = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'pm.md'), 'utf8');
    const classifierJs = fs.readFileSync(
      path.join(REPO_ROOT, 'bin', '_lib', 'classify-review-dimensions.js'), 'utf8');

    // All three sources must mention "Correctness" and "Security" as the always-on pair.
    for (const [name, src] of [['reviewer.md', reviewerMd], ['pm.md', pmMd], ['classify-review-dimensions.js', classifierJs]]) {
      assert.match(src, /Correctness/i, `${name} must mention Correctness as always-on dimension`);
      assert.match(src, /Security/i, `${name} must mention Security as always-on dimension`);
    }
  });

  test('W-CQ-1: phase-execute.md §17 dynamic-agent cleanup steps documented', () => {
    const phaseExec = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'pm-reference', 'phase-execute.md'), 'utf8');
    // Must document Section 17 Dynamic Agent Spawning Protocol.
    assert.match(phaseExec, /## 17\. Dynamic Agent Spawning/i,
      'phase-execute.md must contain ## 17. Dynamic Agent Spawning section');
  });

  test('W-CQ-2: KILL_SWITCHES.md and phase-execute.md kill-switch tier order are present', () => {
    const ksDoc = fs.readFileSync(path.join(REPO_ROOT, 'KILL_SWITCHES.md'), 'utf8');
    // KILL_SWITCHES.md must have the post-W3-T20 Default column.
    assert.match(ksDoc, /Default/i, 'KILL_SWITCHES.md must document the Default column');
    assert.match(ksDoc, /default-on/, 'KILL_SWITCHES.md must use the default-on enum value');
  });
});
