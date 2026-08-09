#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/warn-ungranted-tool-mention.js
 *
 * PreToolUse:Agent advisory hook (v2.3.23) — warns when a delegation prompt
 * names an mcp__orchestray__* tool the target agent's tools: frontmatter does
 * not grant. Never blocks.
 *
 * Strategy: drive the script via spawnSync with stdin piped, `cwd` passed as
 * a top-level field on the event payload (resolveSafeCwd honours it) so every
 * filesystem side effect — agent-definition lookup and the audit event write
 * — is confined to a per-test tmpdir, never the real repo.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', 'bin', 'warn-ungranted-tool-mention.js');
const hook = require('../bin/warn-ungranted-tool-mention');

const cleanup = [];
afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }
});

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2323-ungranted-tool-'));
  cleanup.push(dir);
  return dir;
}

// Symlinks the REAL event-schemas.md/.shadow.json into the sandbox so the
// hook's emitted event is validated against the actual v2.3.23 schema entry,
// not the fail-open "schema unreadable" branch.
function linkSchemas(dir) {
  const schemaDir = path.join(__dirname, '..', 'agents', 'pm-reference');
  const sandboxSchemaDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(sandboxSchemaDir, { recursive: true });
  for (const f of ['event-schemas.md', 'event-schemas.shadow.json']) {
    const src = path.join(schemaDir, f);
    const dst = path.join(sandboxSchemaDir, f);
    try { fs.symlinkSync(src, dst); }
    catch (_e) { try { fs.copyFileSync(src, dst); } catch (_e2) { /* best effort */ } }
  }
}

function writeAgentFile(dir, role, frontmatterToolsLine) {
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents', role + '.md'),
    '---\nname: ' + role + '\ndescription: fixture\n' + frontmatterToolsLine + '\n---\n\nFixture body.\n'
  );
}

function run(payload, { env } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    // Force ORCHESTRAY_TEST=1 regardless of whether this file is run under the
    // full `npm test` (which sets it via tests/helpers/setup.js) or standalone
    // (`node --test tests/warn-ungranted-tool-mention.test.js`) — without it,
    // hook-stdin.js's fixture harvest is armed by default and a malformed/
    // cwd-less payload would leak a real fixture into this repo's own
    // .orchestray/fixtures/warn-ungranted-tool-mention/.
    env: Object.assign({}, process.env, { ORCHESTRAY_TEST: '1' }, env || {}),
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function readAuditEvents(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch (_e) { return null; } })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Unit — extractMentionedTools
// ---------------------------------------------------------------------------

describe('extractMentionedTools', () => {
  test('extracts a plain mention', () => {
    const found = hook.extractMentionedTools('Call mcp__orchestray__kb_write to persist this.');
    assert.deepEqual(found, ['mcp__orchestray__kb_write']);
  });

  test('dedupes repeated mentions, preserving first-seen order', () => {
    const found = hook.extractMentionedTools(
      'Use mcp__orchestray__kb_write.\nAgain, mcp__orchestray__kb_write. Also mcp__orchestray__kb_search.'
    );
    assert.deepEqual(found, ['mcp__orchestray__kb_write', 'mcp__orchestray__kb_search']);
  });

  test('excludes a negated line ("do NOT")', () => {
    const found = hook.extractMentionedTools('Do NOT call mcp__orchestray__kb_write directly.');
    assert.deepEqual(found, []);
  });

  test('excludes a negated line ("must not")', () => {
    const found = hook.extractMentionedTools('You must not use mcp__orchestray__kb_write here.');
    assert.deepEqual(found, []);
  });

  test('excludes a negated line ("cannot")', () => {
    const found = hook.extractMentionedTools('This agent cannot call mcp__orchestray__kb_write.');
    assert.deepEqual(found, []);
  });

  test('non-negated lines in the same prompt still extract', () => {
    const found = hook.extractMentionedTools(
      'Do NOT call mcp__orchestray__kb_write.\nInstead call mcp__orchestray__kb_search.'
    );
    assert.deepEqual(found, ['mcp__orchestray__kb_search']);
  });

  test('empty/non-string prompt returns []', () => {
    assert.deepEqual(hook.extractMentionedTools(''), []);
    assert.deepEqual(hook.extractMentionedTools(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// Unit — loadDeclaredTools (frontmatter parsing)
// ---------------------------------------------------------------------------

describe('loadDeclaredTools', () => {
  test('parses the flat comma form', () => {
    const dir = makeDir();
    writeAgentFile(dir, 'developer', 'tools: Read, Glob, mcp__orchestray__kb_search');
    assert.deepEqual(
      hook.loadDeclaredTools(dir, 'developer'),
      ['Read', 'Glob', 'mcp__orchestray__kb_search']
    );
  });

  // Regression pin (today's real bug): the bracket form's final entry must
  // not retain a trailing `]`.
  test('parses the YAML flow-sequence bracket form', () => {
    const dir = makeDir();
    writeAgentFile(dir, 'orchestray-housekeeper', 'tools: [Read, Glob, mcp__orchestray__history_query_events]');
    assert.deepEqual(
      hook.loadDeclaredTools(dir, 'orchestray-housekeeper'),
      ['Read', 'Glob', 'mcp__orchestray__history_query_events']
    );
  });

  test('returns null for a missing agent file (unknown subagent_type)', () => {
    const dir = makeDir();
    assert.equal(hook.loadDeclaredTools(dir, 'nonexistent-dynamic-specialist'), null);
  });

  test('returns null when frontmatter has no tools: line', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', 'broken.md'), '---\nname: broken\n---\nbody\n');
    assert.equal(hook.loadDeclaredTools(dir, 'broken'), null);
  });

  test('returns null when there is no frontmatter block at all', () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', 'nofm.md'), 'just a body, no frontmatter\n');
    assert.equal(hook.loadDeclaredTools(dir, 'nofm'), null);
  });
});

// ---------------------------------------------------------------------------
// Integration — the real incident
// ---------------------------------------------------------------------------

describe('hook integration', () => {
  test('real case: architect + prompt naming mcp__orchestray__kb_write produces exactly one warn event', () => {
    const dir = makeDir();
    linkSchemas(dir);
    // Use the real repo's architect.md verbatim — pins against the actual
    // shipped frontmatter, not a synthetic fixture.
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'agents', 'architect.md'),
      path.join(dir, 'agents', 'architect.md')
    );

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'architect',
        prompt: 'Design the schema, then persist your output via mcp__orchestray__kb_write.',
      },
    });

    assert.equal(status, 0, 'hook must never block: ' + stderr);
    assert.match(stderr, /WARN.*architect.*mcp__orchestray__kb_write/s);

    const events = readAuditEvents(dir).filter((e) => e.type === 'ungranted_tool_mention_warn');
    assert.equal(events.length, 1, 'expected exactly one warn event');
    assert.equal(events[0].agent_type, 'architect');
    assert.deepEqual(events[0].ungranted_tools, ['mcp__orchestray__kb_write']);
  });

  test('a granted tool produces no warning', () => {
    const dir = makeDir();
    linkSchemas(dir);
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'agents', 'architect.md'),
      path.join(dir, 'agents', 'architect.md')
    );

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'architect',
        prompt: 'Before designing, call mcp__orchestray__kb_search for prior art.',
      },
    });

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(readAuditEvents(dir).length, 0);
  });

  test('bracket-form frontmatter: granted tool at the closing-bracket position produces no warning', () => {
    // orchestray-housekeeper's real frontmatter is `tools: [Read, Glob,
    // mcp__orchestray__history_query_events]` — mcp__orchestray__history_query_events
    // sits immediately before `]`. A parser that splits on comma without
    // stripping brackets would retain a trailing `]` on this exact entry and
    // never match it, producing a false-positive warning.
    const dir = makeDir();
    linkSchemas(dir);
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'agents', 'orchestray-housekeeper.md'),
      path.join(dir, 'agents', 'orchestray-housekeeper.md')
    );

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'orchestray-housekeeper',
        prompt: 'Recompute the rollup using mcp__orchestray__history_query_events.',
      },
    });

    assert.equal(status, 0);
    assert.equal(stderr, '', 'bracket-form final entry must parse cleanly (no trailing ])');
    assert.equal(readAuditEvents(dir).length, 0);
  });

  test('bracket-form frontmatter: an ungranted tool still warns', () => {
    const dir = makeDir();
    linkSchemas(dir);
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'agents', 'orchestray-housekeeper.md'),
      path.join(dir, 'agents', 'orchestray-housekeeper.md')
    );

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'orchestray-housekeeper',
        prompt: 'Persist your findings via mcp__orchestray__kb_write.',
      },
    });

    assert.equal(status, 0);
    assert.match(stderr, /mcp__orchestray__kb_write/);
    const events = readAuditEvents(dir).filter((e) => e.type === 'ungranted_tool_mention_warn');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].ungranted_tools, ['mcp__orchestray__kb_write']);
  });

  test('unknown subagent_type (dynamic specialist) fails open silently', () => {
    const dir = makeDir();
    linkSchemas(dir);

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'dynamic-oncall-triage-specialist-9f2a',
        prompt: 'Investigate using mcp__orchestray__kb_write.',
      },
    });

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(readAuditEvents(dir).length, 0);
  });

  test('negated mention on the target agent produces no warning', () => {
    const dir = makeDir();
    linkSchemas(dir);
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'agents', 'architect.md'),
      path.join(dir, 'agents', 'architect.md')
    );

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: {
        subagent_type: 'architect',
        prompt: 'You do NOT have mcp__orchestray__kb_write — persist your design as a file instead.',
      },
    });

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(readAuditEvents(dir).length, 0);
  });

  test('non-Agent tool_name exits 0 with no event and no stderr', () => {
    const dir = makeDir();
    const { status, stderr } = run({
      tool_name: 'Write',
      cwd: dir,
      tool_input: { file_path: 'foo.md', content: 'mcp__orchestray__kb_write' },
    });
    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(readAuditEvents(dir).length, 0);
  });

  test('malformed stdin fails open (exit 0, no throw)', () => {
    const { status } = run('{not valid json');
    assert.equal(status, 0);
  });

  test('kill switch: ORCHESTRAY_UNGRANTED_TOOL_WARN_DISABLED=1 suppresses the warning', () => {
    const dir = makeDir();
    linkSchemas(dir);
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'agents', 'architect.md'),
      path.join(dir, 'agents', 'architect.md')
    );

    const { status, stderr } = run(
      {
        tool_name: 'Agent',
        cwd: dir,
        tool_input: { subagent_type: 'architect', prompt: 'Use mcp__orchestray__kb_write.' },
      },
      { env: { ORCHESTRAY_UNGRANTED_TOOL_WARN_DISABLED: '1' } }
    );

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(readAuditEvents(dir).length, 0);
  });

  test('kill switch: ungranted_tool_mention.enabled: false in config suppresses the warning', () => {
    const dir = makeDir();
    linkSchemas(dir);
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, '..', 'agents', 'architect.md'),
      path.join(dir, 'agents', 'architect.md')
    );
    fs.mkdirSync(path.join(dir, '.orchestray'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify({ ungranted_tool_mention: { enabled: false } })
    );

    const { status, stderr } = run({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'architect', prompt: 'Use mcp__orchestray__kb_write.' },
    });

    assert.equal(status, 0);
    assert.equal(stderr, '');
    assert.equal(readAuditEvents(dir).length, 0);
  });
});
