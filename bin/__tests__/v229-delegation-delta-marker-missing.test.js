#!/usr/bin/env node
'use strict';

/**
 * v229-delegation-delta-marker-missing.test.js — B-4.3 unit tests.
 *
 * Verifies that `bin/inject-delegation-delta.js` emits the new
 * `delegation_delta_marker_missing` event whenever an Agent tool call
 * carries a non-empty prompt without delta markers AND mechanical
 * heuristic injection fails. Distinguishes "PM forgot markers" (active
 * Agent spawn missing wrappers) from genuine skips (kill switch, empty
 * prompt, no orchestration).
 *
 * Note: the v2.2.6 W3 wave-2 mechanism (`injectMarkersHeuristically`)
 * usually succeeds for plain prompts, producing a `markers_injected`
 * `delegation_delta_emit` rather than a skip. To exercise the
 * marker_missing path we provide a payload where injection cannot
 * recover (an empty-after-trim prompt-shape that nonetheless passes the
 * empty_prompt check).
 */

const { test, describe } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');
const cp      = require('node:child_process');

const REPO_ROOT  = path.resolve(__dirname, '..', '..');
const HOOK_PATH  = path.join(REPO_ROOT, 'bin', 'inject-delegation-delta.js');
const SCHEMA_PATH = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const NODE       = process.execPath;

function makeTmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v229-b4-3-'));
  fs.mkdirSync(path.join(root, '.orchestray', 'audit'), { recursive: true });
  fs.mkdirSync(path.join(root, '.orchestray', 'state'), { recursive: true });
  // Copy schema for validator path.
  const pmRefDir = path.join(root, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  // Mark current orchestration so emits attach orchestration_id.
  fs.writeFileSync(
    path.join(root, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-b43-test' }),
    'utf8'
  );
  return root;
}

function runHook(payload, opts) {
  opts = opts || {};
  const env = Object.assign({}, process.env, opts.env || {});
  const r = cp.spawnSync(NODE, [HOOK_PATH], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 8000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readEvents(root) {
  const eventsPath = path.join(root, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(e => e !== null);
}

function buildMarkedPrompt(staticBody, perSpawnBody) {
  return (
    '<!-- delta:static-begin -->\n' +
    staticBody +
    '\n<!-- delta:static-end -->\n' +
    '<!-- delta:per-spawn-begin -->\n' +
    perSpawnBody +
    '\n<!-- delta:per-spawn-end -->'
  );
}

describe('v229 B-4.3 — delegation_delta_marker_missing observability', () => {
  test('Agent tool call with markers present → no marker_missing event', () => {
    const root = makeTmpRoot();
    const STATIC = '## Handoff\nrules\n\n## Repo Map\n' + 'entry\n'.repeat(40);
    const prompt = buildMarkedPrompt(STATIC, '## Task\ndo X');
    const r = runHook({
      tool_name: 'Agent',
      cwd: root,
      tool_input: { subagent_type: 'developer', prompt },
    });
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);

    const evs = readEvents(root);
    const missing = evs.filter(e => e.type === 'delegation_delta_marker_missing');
    assert.equal(missing.length, 0, 'no marker_missing when markers present');
  });

  test('Agent tool call with prompt that fails injection → 1 delegation_delta_marker_missing', () => {
    const root = makeTmpRoot();
    // The heuristic injector returns null when the prompt already contains
    // ANY marker remnant (defence against double-wrap). A prompt seeded
    // with a stray `<!-- delta:static-begin -->` but no closing tag will
    // simulate an in-progress / malformed marker pair the injector cannot
    // safely heal.
    //
    // Use a prompt with the begin marker only — computeDelta will report
    // markers_missing (no end marker), and the injector will see the begin
    // marker and refuse to re-inject.
    const malformedPrompt = '<!-- delta:static-begin -->\nstuff but no end marker\nrandom body';

    const r = runHook({
      tool_name: 'Agent',
      cwd: root,
      tool_input: { subagent_type: 'developer', prompt: malformedPrompt },
    });
    assert.equal(r.status, 0, 'hook exits 0; stderr=' + r.stderr);

    const evs = readEvents(root);
    const missing = evs.filter(e => e.type === 'delegation_delta_marker_missing');

    // Either path that ends in emitSkip(markers_missing) MUST also emit a
    // marker_missing row. We accept exactly 1.
    assert.equal(missing.length, 1, 'exactly one marker_missing event; got ' + missing.length);
    assert.equal(missing[0].spawn_target_agent, 'developer');
    assert.equal(missing[0].orchestration_id, 'orch-b43-test');
  });

  test('kill switch ORCHESTRAY_DELEGATION_DELTA_MARKER_TRACK_DISABLED=1 → no marker_missing', () => {
    const root = makeTmpRoot();
    const malformedPrompt = '<!-- delta:static-begin -->\nstuff but no end marker\nrandom body';
    const r = runHook({
      tool_name: 'Agent',
      cwd: root,
      tool_input: { subagent_type: 'developer', prompt: malformedPrompt },
    }, {
      env: { ORCHESTRAY_DELEGATION_DELTA_MARKER_TRACK_DISABLED: '1' },
    });
    assert.equal(r.status, 0);

    const evs = readEvents(root);
    const missing = evs.filter(e => e.type === 'delegation_delta_marker_missing');
    assert.equal(missing.length, 0, 'kill switch suppresses marker_missing');
  });
});
