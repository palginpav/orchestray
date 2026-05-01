#!/usr/bin/env node
'use strict';

/**
 * v2219-phase-slice-key-tolerance.test.js — T7 regression suite.
 *
 * Verifies that readPhaseFromOrchestration() accepts both `phase:` (PM's
 * actual write convention) and `current_phase:` (canonical YAML key) in
 * YAML frontmatter, with `current_phase:` winning when both are present.
 *
 * Sister parsers auto-commit-master-on-pm-stop.js:134 and
 * write-resilience-dossier.js:226 already did this; this suite locks in
 * the same behaviour for inject-active-phase-slice.js.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');

const phaseSliceMod = require('../inject-active-phase-slice.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-t7-'));
}

function setupOrchFile(cwd, content) {
  const stateDir = path.join(cwd, '.orchestray', 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'orchestration.md'), content);
}

// ---------------------------------------------------------------------------
// T7 — two-pass YAML frontmatter key tolerance
// ---------------------------------------------------------------------------

describe('v2.2.19 T7 — readPhaseFromOrchestration YAML key tolerance', () => {

  // Case 1: bare `phase:` key only (PM's actual write convention)
  test('YAML frontmatter `phase: decomposition` only → returns "decomposition"', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '---\nstatus: active\nphase: decomposition\n---\nbody');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'decomposition');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Case 2: canonical `current_phase:` key only (documented form)
  test('YAML frontmatter `current_phase: execute` only → returns "execute"', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '---\nstatus: active\ncurrent_phase: execute\n---\nbody');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'execute');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Case 3: both keys present — `current_phase:` wins
  test('YAML frontmatter both keys → current_phase wins', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(
        cwd,
        '---\nphase: decomposition\ncurrent_phase: execute\n---\nbody',
      );
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'execute');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Case 4: neither key present → null
  test('YAML frontmatter with neither phase key → null', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(cwd, '---\nstatus: active\norchestration_id: orch-abc\n---\nbody');
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), null);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Case 5: bold-list form `- **phase**: close` (Strategy 2 still works after
  // the Strategy 1 two-pass change)
  test('bold-list `- **phase**: close` → returns "close" via Strategy 2', () => {
    const cwd = makeRepo();
    try {
      setupOrchFile(
        cwd,
        '# Orchestration\n\n- **orchestration_id**: orch-foo\n- **phase**: close\n',
      );
      assert.equal(phaseSliceMod.readPhaseFromOrchestration(cwd), 'close');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
