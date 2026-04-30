#!/usr/bin/env node
'use strict';

/**
 * v2.2.18 W9 — Schema field-alignment micro-fixes tests.
 *
 * Covers:
 *   1. `ts` → `timestamp` rename: the new dossier_compensation_inject and
 *      dossier_compensation_skipped events use `timestamp` not `ts`.
 *   2. orchestration_start.task relaxed to optional: schema validator accepts
 *      an orchestration_start event with task: null.
 *   3. ox state init warns when --task not provided (exit code 0, stderr has msg).
 *   4. End-to-end: dossier_compensation events emitted by _tryDossierCompensation
 *      use `timestamp` field (auto-filled by audit-event-writer).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'inject-resilience-dossier.js');
const OX   = path.resolve(__dirname, '..', 'ox.js');

const {
  _tryDossierCompensation,
} = require(HOOK);

const {
  buildDossier,
  serializeDossier,
} = require('../_lib/resilience-dossier-schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProjectDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v2218-w9-'));
  fs.mkdirSync(path.join(tmp, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.orchestray', 'state'), { recursive: true });
  return tmp;
}

function writeEvents(cwd, events) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(p, existing + lines);
}

function readAllEvents(cwd) {
  const p = path.join(cwd, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_e) { /* skip */ }
  }
  return out;
}

function buildDossierString(orchId = 'orch-w9-test') {
  const { serialized } = serializeDossier(buildDossier({
    orchestration: {
      id: orchId,
      phase: 'executing',
      status: 'in_progress',
      complexity_score: 5,
    },
    task_ids: { pending: ['W1'], completed: [], failed: [] },
  }));
  return serialized;
}

function minimalCfg() {
  return { enabled: true, kill_switch: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('W9 schema micro-fixes', () => {

  test('1. dossier_compensation events use timestamp not ts', () => {
    const tmp = makeProjectDir();
    try {
      const content = buildDossierString();
      const dossierPath = path.join(tmp, '.orchestray', 'state', 'resilience-dossier.json');
      fs.writeFileSync(dossierPath, content);

      // Pre-stage orphan.
      writeEvents(tmp, [
        { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w9-test' },
      ]);

      // Run compensation.
      const output = _tryDossierCompensation(tmp, dossierPath, minimalCfg());
      assert.ok(output !== null, 'expected compensation to fire');

      // Check emitted events use `timestamp` not `ts`.
      const events = readAllEvents(tmp);
      const compInject = events.find((e) => e.type === 'dossier_compensation_inject');
      assert.ok(compInject, 'expected dossier_compensation_inject event');
      // The audit-event-writer auto-fills `timestamp`. Verify it is present and well-formed.
      assert.ok(typeof compInject.timestamp === 'string', 'expected timestamp field (string)');
      assert.ok(!('ts' in compInject), 'must not have ts field — only timestamp');

      // ISO 8601 sanity check.
      assert.ok(!Number.isNaN(Date.parse(compInject.timestamp)), 'timestamp must be parseable as date');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('2. orchestration_start.task is optional — validator accepts task:null', () => {
    // This test asserts the SCHEMA ALLOWS task=null.
    // The writeEvent audit-event-writer will auto-fill orchestration_id and timestamp,
    // but task=null is intentionally passed and must not be blocked.
    const tmp = makeProjectDir();
    try {
      // Write an orchestration_start event with task=null via the writer.
      const { writeEvent } = require('../_lib/audit-event-writer');
      // Should not throw.
      assert.doesNotThrow(() => {
        writeEvent({
          type: 'orchestration_start',
          version: 1,
          orchestration_id: 'orch-task-null-test',
          task: null,
          started_at: new Date().toISOString(),
          schema_version: 1,
        }, { cwd: tmp });
      }, 'writeEvent must accept orchestration_start with task=null');

      // Verify the event was written.
      const events = readAllEvents(tmp);
      const startEv = events.find((e) => e.type === 'orchestration_start');
      assert.ok(startEv, 'orchestration_start event must be written');
      assert.equal(startEv.task, null, 'task field must be null');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('3. ox state init without --task warns on stderr, exits 0', () => {
    const tmp = makeProjectDir();
    try {
      // Create the required directory structure ox.js needs.
      // ox.js calls projectRoot() which uses resolveSafeCwd. We need a .orchestray dir.
      // ox state init requires no active orchestration — tmp is fresh.

      const result = spawnSync(process.execPath, [OX, 'state', 'init', 'orch-test-no-task'], {
        cwd: tmp,
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: tmp }),
        encoding: 'utf8',
        timeout: 10000,
      });

      // Exit code 0 (warn-only, not an error).
      assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);

      // Stderr contains the recommendation.
      assert.ok(
        result.stderr.includes('--task is recommended'),
        `expected stderr warning about --task, got: ${result.stderr}`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('4. ox state init with --task does NOT warn on stderr', () => {
    const tmp = makeProjectDir();
    try {
      const result = spawnSync(process.execPath, [OX, 'state', 'init', 'orch-test-with-task', '--task=my-task'], {
        cwd: tmp,
        env: Object.assign({}, process.env, { CLAUDE_PLUGIN_ROOT: tmp }),
        encoding: 'utf8',
        timeout: 10000,
      });

      assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
      // No task warning.
      assert.ok(
        !result.stderr.includes('--task is recommended'),
        `unexpected --task warning in stderr: ${result.stderr}`
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('5. dossier_compensation_skipped also uses timestamp not ts', () => {
    const tmp = makeProjectDir();
    try {
      // Trigger kill-switch path to emit dossier_compensation_skipped.
      process.env.ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED = '1';

      const dossierPath = path.join(tmp, '.orchestray', 'state', 'resilience-dossier.json');
      fs.writeFileSync(dossierPath, buildDossierString());
      writeEvents(tmp, [
        { type: 'dossier_written', timestamp: new Date().toISOString(), orchestration_id: 'orch-w9-test' },
      ]);

      _tryDossierCompensation(tmp, dossierPath, minimalCfg());

      const events = readAllEvents(tmp);
      const skip = events.find((e) => e.type === 'dossier_compensation_skipped');
      assert.ok(skip, 'expected dossier_compensation_skipped event');
      assert.ok(typeof skip.timestamp === 'string', 'expected timestamp field');
      assert.ok(!('ts' in skip), 'must not have ts field — only timestamp');
    } finally {
      delete process.env.ORCHESTRAY_DOSSIER_COMPENSATION_DISABLED;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
