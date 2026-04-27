#!/usr/bin/env node
'use strict';

/**
 * p22-scout-shadow-regression.test.js — P2.2 schema-shadow + marker parser.
 *
 * Two end-to-end checks:
 *   1. The schema parser at `bin/regen-schema-shadow.js` (function
 *      `parseEventSchemas`) recognises the new `### `scout_spawn` event`
 *      heading shape in `agents/pm-reference/event-schemas.md` and
 *      produces an entry in the shadow output.
 *   2. `bin/capture-pm-turn.js` parses the `[routing: B/scout]` marker
 *      from a synthetic transcript and writes the resulting `pm_turn`
 *      row with `routing_class: 'B'` and `inline_or_scout: 'scout'`.
 *
 * Runner: node --test bin/__tests__/p22-scout-shadow-regression.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EVENT_SCHEMAS_MD = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const CAPTURE_HOOK = path.resolve(__dirname, '..', 'capture-pm-turn.js');

const { parseEventSchemas } = require('../regen-schema-shadow.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p22-shadow-'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'metrics'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P2.2 — scout_spawn schema shadow + pm_turn marker parse', () => {

  test('event-schemas.md schema parser sees `scout_spawn` event', () => {
    const content = fs.readFileSync(EVENT_SCHEMAS_MD, 'utf8');
    const events = parseEventSchemas(content);
    assert.ok(Array.isArray(events),
      'parseEventSchemas must return an array');
    const slugs = events.map(e => e.slug);
    assert.ok(slugs.includes('scout_spawn'),
      'parseEventSchemas must extract `scout_spawn` from event-schemas.md after P2.2 row added.\n' +
      'Found ' + slugs.length + ' events; sample: ' + slugs.slice(0, 8).join(', ') + '...');
    const entry = events.find(e => e.slug === 'scout_spawn');
    assert.equal(typeof entry, 'object', 'scout_spawn entry must be an object');
    assert.equal(entry.version, 1, 'scout_spawn version should be 1');
  });

  // F-002 (v2.2.0 fix-pass): assert the two diagnostic event types are
  // registered. These events are emitted by bin/validate-task-completion.js
  // when a read-only-tier agent breaks the contract; if they are NOT in the
  // schema shadow, every emission will trigger schema_unknown_type_warn AND
  // nudge the 3-strike auto-disable counter (per
  // bin/_lib/audit-event-writer.js:295-307).
  test('event-schemas.md schema parser sees the two scout diagnostic events', () => {
    const content = fs.readFileSync(EVENT_SCHEMAS_MD, 'utf8');
    const events = parseEventSchemas(content);
    const slugs = events.map(e => e.slug);
    for (const slug of ['scout_forbidden_tool_blocked', 'scout_files_changed_blocked']) {
      assert.ok(slugs.includes(slug),
        'parseEventSchemas must extract `' + slug + '` from event-schemas.md.\n' +
        'Without the schema row, validate-task-completion.js emissions trip\n' +
        'schema_unknown_type_warn AND the 3-strike auto-disable counter.\n' +
        'Found ' + slugs.length + ' events; sample: ' + slugs.slice(0, 8).join(', ') + '...');
      const entry = events.find(e => e.slug === slug);
      assert.equal(typeof entry, 'object', slug + ' entry must be an object');
      assert.equal(entry.version, 1, slug + ' version should be 1');
    }
  });

  test('event-schemas.shadow.json contains the two scout diagnostic events', () => {
    const shadowPath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
    const shadow = JSON.parse(fs.readFileSync(shadowPath, 'utf8'));
    assert.ok(shadow && typeof shadow === 'object', 'shadow must parse as object');
    for (const key of ['scout_forbidden_tool_blocked', 'scout_files_changed_blocked']) {
      assert.ok(key in shadow,
        '`' + key + '` missing from event-schemas.shadow.json. Re-run\n' +
        '`node bin/regen-schema-shadow.js` after adding the schema row.');
      assert.equal(shadow[key].v, 1, key + ' shadow row version should be 1');
    }
  });

  test('capture-pm-turn parses [routing: B/scout] marker into pm_turn row', () => {
    // Build a synthetic transcript whose last assistant message body
    // contains the routing marker.
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const entries = [
      { role: 'user', content: 'ping' },
      {
        role: 'assistant',
        content: 'Reading /tmp/foo via Haiku scout — 22000 exceeds scout_min_bytes (12288). [routing: B/scout]',
        model: 'claude-opus-4-7',
        timestamp: '2026-04-26T18:30:00.000Z',
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        },
      },
    ];
    fs.writeFileSync(transcriptPath,
      entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    // Spawn capture-pm-turn.js with a Stop-event payload pointing at it.
    const payload = {
      hook_event_name: 'Stop',
      session_id: 'sess-p22-1',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    };
    const r = spawnSync('node', [CAPTURE_HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10_000,
      env: process.env,
    });
    assert.equal(r.status, 0, 'hook must exit 0 (fail-open); stderr=' + r.stderr);

    const metricsPath = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    assert.ok(fs.existsSync(metricsPath), 'agent_metrics.jsonl must be created');
    const rows = fs.readFileSync(metricsPath, 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse);
    const pmTurn = rows.find(r => r.row_type === 'pm_turn');
    assert.ok(pmTurn, 'expected a pm_turn row');
    assert.equal(pmTurn.routing_class, 'B', 'routing_class should be B');
    assert.equal(pmTurn.inline_or_scout, 'scout', 'inline_or_scout should be scout');
    assert.equal(pmTurn.schema_version, 2);
  });

  test('capture-pm-turn leaves routing fields null when no marker present', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    const entries = [
      { role: 'user', content: 'ping' },
      {
        role: 'assistant',
        content: 'No routing marker in this body.',
        model: 'claude-opus-4-7',
        timestamp: '2026-04-26T18:30:00.000Z',
        usage: {
          input_tokens: 100, output_tokens: 50,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        },
      },
    ];
    fs.writeFileSync(transcriptPath,
      entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

    const payload = {
      hook_event_name: 'Stop',
      session_id: 'sess-p22-2',
      transcript_path: transcriptPath,
      cwd: tmpDir,
    };
    const r = spawnSync('node', [CAPTURE_HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 10_000,
      env: process.env,
    });
    assert.equal(r.status, 0, 'stderr=' + r.stderr);

    const metricsPath = path.join(tmpDir, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    const rows = fs.readFileSync(metricsPath, 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse);
    const pmTurn = rows.find(r => r.row_type === 'pm_turn');
    assert.ok(pmTurn);
    assert.equal(pmTurn.routing_class, null, 'no marker → routing_class null');
    assert.equal(pmTurn.inline_or_scout, null, 'no marker → inline_or_scout null');
  });

});
