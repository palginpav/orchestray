#!/usr/bin/env node
'use strict';

/**
 * Tests for v2.1.10 R1 — compression telemetry hook on SubagentStart.
 *
 * Covers:
 *   AC-01: script exists, has shebang, exits 0 on every invocation regardless of input
 *   AC-02: hooks.json registers the script for SubagentStart (schema-valid JSON)
 *   AC-03: after mock payload with three markers, events.jsonl has all three event types
 *   AC-05: ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1 exits 0 without appending
 *
 * Also covers:
 *   - countOccurrences helper counts correctly
 *   - readDelegationPrompt reads first user message from transcript JSONL
 *   - isTelemetryEnabled respects config.json key
 *   - empty prompt text → no events emitted
 *   - malformed stdin → exit 0 (AC-01 edge case)
 *   - match_count reflects actual occurrence count per event
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.resolve(__dirname, '..', 'emit-compression-telemetry.js');

const {
  handleSubagentStart,
  readDelegationPrompt,
  countOccurrences,
  isTelemetryEnabled,
  CITE_CACHE_MARKER,
  SPEC_SKETCH_RE,
  REPO_MAP_DELTA_RE,
} = require(HOOK);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal project dir with optional transcript and config.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.transcriptContent] - Raw transcript JSONL content.
 *   If null, no transcript file is written. If undefined, creates a minimal one.
 * @param {object|null} [opts.config] - config.json object; null to omit.
 * @param {boolean} [opts.withOrchestration] - If true, write current-orchestration.json.
 * @returns {{ tmp: string, transcriptPath: string|null }}
 */
function makeProjectDir({ transcriptContent, config = null, withOrchestration = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ect-r1-'));
  const orchestrayDir = path.join(tmp, '.orchestray');
  const auditDir = path.join(orchestrayDir, 'audit');
  const stateDir = path.join(orchestrayDir, 'state');
  fs.mkdirSync(auditDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  if (withOrchestration) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: 'orch-test-r1' })
    );
  }

  if (config !== null) {
    fs.writeFileSync(
      path.join(orchestrayDir, 'config.json'),
      JSON.stringify(config, null, 2)
    );
  }

  let transcriptPath = null;
  if (transcriptContent !== null) {
    const transcriptDir = path.join(tmp, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    transcriptPath = path.join(transcriptDir, 'subagent.jsonl');
    const content = transcriptContent !== undefined
      ? transcriptContent
      : buildTranscript('Hello world');
    fs.writeFileSync(transcriptPath, content);
  }

  return { tmp, transcriptPath };
}

/**
 * Build a minimal transcript JSONL string with a user message.
 *
 * @param {string} promptText
 * @returns {string}
 */
function buildTranscript(promptText) {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: promptText },
    uuid: 'test-uuid',
    timestamp: new Date().toISOString(),
  }) + '\n';
}

/**
 * Build a prompt containing all three compression markers.
 *
 * @returns {string}
 */
function buildAllMarkersPrompt() {
  return [
    'task_subject: test agent task',
    '',
    '## Context from Prior Agent',
    CITE_CACHE_MARKER + ' pattern-foo] — some cached pattern body',
    CITE_CACHE_MARKER + ' pattern-bar] — another cached pattern body',
    '',
    '## Spec Sketch',
    '```yaml',
    'spec_sketch:',
    '  status: completed',
    '  files_changed: []',
    '```',
    '',
    '## Repository Map',
    '```yaml',
    'repo_map_delta:',
    '  added: []',
    '  removed: []',
    '```',
  ].join('\n');
}

/**
 * Read events.jsonl from a project dir, returning parsed events.
 *
 * @param {string} tmp
 * @returns {object[]}
 */
function readEvents(tmp) {
  const eventsPath = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  const content = fs.readFileSync(eventsPath, 'utf8');
  return content.split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/**
 * Run the hook via spawnSync.
 *
 * @param {object} payload - stdin JSON payload.
 * @param {object} [extraEnv] - Extra env overrides.
 * @returns {{ status: number, stdout: string, stderr: string }}
 */
function runHook(payload, extraEnv = {}) {
  const env = Object.assign({}, process.env, extraEnv);
  delete env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
  Object.assign(env, extraEnv);
  const res = spawnSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ---------------------------------------------------------------------------
// AC-01: script exists, has shebang, exits 0 on every invocation
// ---------------------------------------------------------------------------

describe('R1 AC-01 — script exists and is always exit-0', () => {

  test('hook script file exists at expected path', () => {
    assert.ok(fs.existsSync(HOOK), `Hook not found at ${HOOK}`);
  });

  test('first line of script is a node shebang', () => {
    const content = fs.readFileSync(HOOK, 'utf8');
    const firstLine = content.split('\n')[0];
    assert.ok(firstLine.startsWith('#!/usr/bin/env node'), `Expected shebang, got: ${firstLine}`);
  });

  test('exits 0 with empty object stdin', () => {
    const r = runHook({});
    assert.equal(r.status, 0, `Expected exit 0, got ${r.status}; stderr=${r.stderr}`);
  });

  test('exits 0 with malformed stdin', () => {
    const res = spawnSync('node', [HOOK], {
      input: 'not-json-at-all{{{',
      env: process.env,
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(res.status, 0, `Malformed stdin must exit 0; stderr=${res.stderr}`);
  });

  test('exits 0 with missing transcript', () => {
    const { tmp } = makeProjectDir({ transcriptContent: null });
    try {
      const r = runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: '/nonexistent/path.jsonl' });
      assert.equal(r.status, 0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stdout is { continue: true }', () => {
    const r = runHook({});
    const parsed = JSON.parse(r.stdout.trim());
    assert.deepEqual(parsed, { continue: true });
  });

});

// ---------------------------------------------------------------------------
// AC-02: hooks.json registers script for SubagentStart
// ---------------------------------------------------------------------------

describe('R1 AC-02 — hooks.json registration', () => {

  test('hooks.json is valid JSON', () => {
    const hooksPath = path.resolve(__dirname, '..', '..', 'hooks', 'hooks.json');
    assert.doesNotThrow(() => {
      JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    }, 'hooks.json must be valid JSON');
  });

  test('SubagentStart block contains emit-compression-telemetry.js', () => {
    const hooksPath = path.resolve(__dirname, '..', '..', 'hooks', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const subagentStartEntries = hooks.hooks.SubagentStart || [];
    const commands = subagentStartEntries.flatMap((entry) =>
      (entry.hooks || []).map((h) => h.command || '')
    );
    const registered = commands.some((cmd) => cmd.includes('emit-compression-telemetry.js'));
    assert.ok(registered, 'emit-compression-telemetry.js must be registered in SubagentStart');
  });

  test('existing SubagentStart entries are still present (no collision)', () => {
    const hooksPath = path.resolve(__dirname, '..', '..', 'hooks', 'hooks.json');
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const commands = (hooks.hooks.SubagentStart || []).flatMap((entry) =>
      (entry.hooks || []).map((h) => h.command || '')
    );
    assert.ok(
      commands.some((c) => c.includes('audit-event.js')),
      'audit-event.js must still be registered in SubagentStart'
    );
    assert.ok(
      commands.some((c) => c.includes('collect-context-telemetry.js')),
      'collect-context-telemetry.js must still be registered in SubagentStart'
    );
  });

});

// ---------------------------------------------------------------------------
// AC-03: all three event types emitted when all markers present
// ---------------------------------------------------------------------------

describe('R1 AC-03 — events emitted for all three compression markers', () => {

  test('emits cite_cache_hit, spec_sketch_generated, repo_map_delta_injected', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(buildAllMarkersPrompt()),
    });
    try {
      const r = runHook({
        cwd: tmp,
        agent_type: 'developer',
        agent_transcript_path: transcriptPath,
      });
      assert.equal(r.status, 0, `Hook exited non-zero; stderr=${r.stderr}`);

      const events = readEvents(tmp);
      const eventTypes = events.map((e) => e.type);
      assert.ok(eventTypes.includes('cite_cache_hit'), 'cite_cache_hit event must be emitted');
      assert.ok(eventTypes.includes('spec_sketch_generated'), 'spec_sketch_generated event must be emitted');
      assert.ok(eventTypes.includes('repo_map_delta_injected'), 'repo_map_delta_injected event must be emitted');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cite_cache_hit match_count reflects occurrence count', () => {
    const prompt = [
      CITE_CACHE_MARKER + ' pattern-a]',
      CITE_CACHE_MARKER + ' pattern-b]',
      CITE_CACHE_MARKER + ' pattern-c]',
    ].join('\n');
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(prompt),
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      const hitEvent = events.find((e) => e.type === 'cite_cache_hit');
      assert.ok(hitEvent, 'cite_cache_hit event must be present');
      assert.equal(hitEvent.match_count, 3, 'match_count must be 3 for three occurrences');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('one event per type even with multiple marker occurrences (not one per occurrence)', () => {
    const prompt = buildAllMarkersPrompt();
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(prompt),
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      const citeCacheEvents = events.filter((e) => e.type === 'cite_cache_hit');
      assert.equal(citeCacheEvents.length, 1, 'must emit exactly one cite_cache_hit event (not one per occurrence)');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('event carries orchestration_id from current-orchestration.json', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(CITE_CACHE_MARKER + ' foo]'),
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      const hitEvent = events.find((e) => e.type === 'cite_cache_hit');
      assert.ok(hitEvent, 'cite_cache_hit event must be present');
      assert.equal(hitEvent.orchestration_id, 'orch-test-r1', 'orchestration_id must come from current-orchestration.json');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('event carries subagent_type from payload', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(CITE_CACHE_MARKER + ' foo]'),
    });
    try {
      runHook({ cwd: tmp, agent_type: 'architect', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      const hitEvent = events.find((e) => e.type === 'cite_cache_hit');
      assert.ok(hitEvent, 'cite_cache_hit event must be present');
      assert.equal(hitEvent.subagent_type, 'architect');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no events emitted when no markers present', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript('implement the feature as described'),
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      const compressionEvents = events.filter((e) =>
        ['cite_cache_hit', 'spec_sketch_generated', 'repo_map_delta_injected'].includes(e.type)
      );
      assert.equal(compressionEvents.length, 0, 'no compression events must be emitted when markers absent');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('spec_sketch_generated not emitted for prose mention without line anchor', () => {
    // "spec_sketch: field is documented" appears mid-sentence — the pattern
    // still matches because `\s*spec_sketch:` allows leading whitespace.
    // This test validates the pattern anchors to line boundaries, not
    // arbitrary substring position. If this is truly mid-line (preceded by
    // non-whitespace), it should NOT match.
    const prompt = 'The spec_sketch: field describes the output schema.';
    // Note: this does NOT start with whitespace before spec_sketch:, but the
    // regex is /^\s*spec_sketch:/m. The ^ with /m anchors to line-start, and
    // `\s*` allows leading whitespace. Since this line DOES start with "The",
    // the pattern should NOT match.
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(prompt),
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      const specEvents = events.filter((e) => e.type === 'spec_sketch_generated');
      assert.equal(specEvents.length, 0, 'mid-sentence spec_sketch: must NOT trigger spec_sketch_generated');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('spec_sketch_generated emitted when spec_sketch: is at line start', () => {
    const prompt = 'spec_sketch:\n  status: completed';
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(prompt),
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      const specEvents = events.filter((e) => e.type === 'spec_sketch_generated');
      assert.equal(specEvents.length, 1, 'spec_sketch: at line start must trigger spec_sketch_generated');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// AC-05: ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1 suppresses all emission
// ---------------------------------------------------------------------------

describe('R1 AC-05 — ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED kill-switch', () => {

  test('ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1 exits 0 without appending', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(buildAllMarkersPrompt()),
    });
    try {
      const r = runHook(
        { cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath },
        { ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED: '1' }
      );
      assert.equal(r.status, 0, `Expected exit 0; stderr=${r.stderr}`);
      const events = readEvents(tmp);
      assert.equal(events.length, 0, 'kill-switch must prevent any event from being appended');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('config telemetry_enabled: false suppresses emission', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(buildAllMarkersPrompt()),
      config: { context_compression_v218: { telemetry_enabled: false } },
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      assert.equal(events.length, 0, 'config telemetry_enabled:false must suppress all events');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('config telemetry_enabled: true does not suppress emission', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(CITE_CACHE_MARKER + ' foo]'),
      config: { context_compression_v218: { telemetry_enabled: true } },
    });
    try {
      runHook({ cwd: tmp, agent_type: 'developer', agent_transcript_path: transcriptPath });
      const events = readEvents(tmp);
      assert.ok(events.length > 0, 'config telemetry_enabled:true must allow emission');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Unit: countOccurrences helper
// ---------------------------------------------------------------------------

describe('R1 unit — countOccurrences', () => {

  test('counts zero occurrences when marker absent', () => {
    assert.equal(countOccurrences('hello world', CITE_CACHE_MARKER), 0);
  });

  test('counts single occurrence', () => {
    assert.equal(countOccurrences('text ' + CITE_CACHE_MARKER + ' end', CITE_CACHE_MARKER), 1);
  });

  test('counts multiple non-overlapping occurrences', () => {
    const text = [CITE_CACHE_MARKER + ' a', CITE_CACHE_MARKER + ' b', CITE_CACHE_MARKER + ' c'].join('\n');
    assert.equal(countOccurrences(text, CITE_CACHE_MARKER), 3);
  });

});

// ---------------------------------------------------------------------------
// Unit: readDelegationPrompt
// ---------------------------------------------------------------------------

describe('R1 unit — readDelegationPrompt', () => {

  test('returns null for null path', () => {
    assert.equal(readDelegationPrompt(null), null);
  });

  test('returns null for non-existent path', () => {
    assert.equal(readDelegationPrompt('/nonexistent/path.jsonl'), null);
  });

  test('reads flat { role: "user", content } shape', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-'));
    try {
      const p = path.join(tmp, 'transcript.jsonl');
      fs.writeFileSync(p, JSON.stringify({ role: 'user', content: 'flat shape content' }) + '\n');
      assert.equal(readDelegationPrompt(p), 'flat shape content');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reads nested { type: "user", message: { content } } shape', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-'));
    try {
      const p = path.join(tmp, 'transcript.jsonl');
      fs.writeFileSync(p, buildTranscript('nested shape content'));
      assert.equal(readDelegationPrompt(p), 'nested shape content');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null when no user message in transcript', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-'));
    try {
      const p = path.join(tmp, 'transcript.jsonl');
      fs.writeFileSync(p, JSON.stringify({ type: 'permission-mode', permissionMode: 'bypass' }) + '\n');
      assert.equal(readDelegationPrompt(p), null);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handles array content blocks (content as array of {type,text} objects)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-'));
    try {
      const p = path.join(tmp, 'transcript.jsonl');
      fs.writeFileSync(p, JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'block one' },
            { type: 'text', text: 'block two' },
          ],
        },
      }) + '\n');
      const result = readDelegationPrompt(p);
      assert.ok(result && result.includes('block one'), 'must include first text block');
      assert.ok(result && result.includes('block two'), 'must include second text block');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Unit: isTelemetryEnabled
// ---------------------------------------------------------------------------

describe('R1 unit — isTelemetryEnabled', () => {

  test('returns true when no config or env override', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ite-'));
    const originalEnv = process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
    delete process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
    try {
      assert.equal(isTelemetryEnabled(tmp), true);
    } finally {
      if (originalEnv !== undefined) {
        process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns false when ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED=1', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ite-'));
    const originalEnv = process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
    process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED = '1';
    try {
      assert.equal(isTelemetryEnabled(tmp), false);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
      } else {
        process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns false when config.telemetry_enabled is false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ite-'));
    const originalEnv = process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
    delete process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
    try {
      fs.mkdirSync(path.join(tmp, '.orchestray'), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, '.orchestray', 'config.json'),
        JSON.stringify({ context_compression_v218: { telemetry_enabled: false } })
      );
      assert.equal(isTelemetryEnabled(tmp), false);
    } finally {
      if (originalEnv !== undefined) {
        process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});

// ---------------------------------------------------------------------------
// Unit: handleSubagentStart
// ---------------------------------------------------------------------------

describe('R1 unit — handleSubagentStart', () => {

  test('emits only repo_map_skipped when prompt has no compression markers (v2.2.3 W3 P1-6)', () => {
    // v2.2.3 W3 P1-6: every Agent spawn must produce one of repo_map_injected
    // or repo_map_skipped. A prompt with no `## Repository Map` heading and a
    // non-opt-out agent type produces repo_map_skipped(reason='error') so the
    // mismatch between repo_map_built and repo_map_injected is auditable.
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript('ordinary task with no compression markers'),
    });
    try {
      const result = handleSubagentStart({ cwd: tmp, agent_transcript_path: transcriptPath, agent_type: 'developer' });
      // No A/B/C compression markers -> none of those three fire.
      assert.ok(!result.eventsEmitted.includes('cite_cache_hit'));
      assert.ok(!result.eventsEmitted.includes('spec_sketch_generated'));
      assert.ok(!result.eventsEmitted.includes('repo_map_delta_injected'));
      // P1-6: per-spawn skip telemetry MUST fire.
      assert.deepEqual(result.eventsEmitted, ['repo_map_skipped']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns all three event names when all markers present', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(buildAllMarkersPrompt()),
    });
    try {
      const result = handleSubagentStart({ cwd: tmp, agent_transcript_path: transcriptPath, agent_type: 'developer' });
      assert.ok(result.eventsEmitted.includes('cite_cache_hit'));
      assert.ok(result.eventsEmitted.includes('spec_sketch_generated'));
      assert.ok(result.eventsEmitted.includes('repo_map_delta_injected'));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns empty eventsEmitted when kill-switch is set', () => {
    const { tmp, transcriptPath } = makeProjectDir({
      transcriptContent: buildTranscript(buildAllMarkersPrompt()),
    });
    const originalEnv = process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
    process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED = '1';
    try {
      const result = handleSubagentStart({ cwd: tmp, agent_transcript_path: transcriptPath, agent_type: 'developer' });
      assert.deepEqual(result.eventsEmitted, []);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED;
      } else {
        process.env.ORCHESTRAY_COMPRESSION_TELEMETRY_DISABLED = originalEnv;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
