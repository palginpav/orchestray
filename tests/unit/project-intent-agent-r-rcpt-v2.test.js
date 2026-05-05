'use strict';

/**
 * project-intent-agent-r-rcpt-v2.test.js — R-RCPT-V2 (v2.1.13)
 *
 * Covers the R-RCPT-V2 work-item:
 *
 *   A. agents/project-intent.md exists with correct frontmatter
 *      (model: haiku, effort: low, tools: Read).
 *
 *   B. Legacy-output parity: the agent's documented block format must match
 *      what bin/_lib/project-intent.js produces for the same inputs, byte-for-byte.
 *      This is verified by feeding a fixture repo through generateProjectIntent()
 *      and asserting the resulting file matches the locked shape the agent
 *      markdown promises.
 *
 *   C. Fallback event: emitProjectIntentFallbackEvent() writes a
 *      `project_intent_fallback_no_agent` event to .orchestray/audit/events.jsonl
 *      with canonical `type` + `timestamp` fields and the current
 *      orchestration_id.
 *
 *   D. Fallback event is fail-open on missing current-orchestration.json
 *      (orchestration_id: null) and never throws.
 *
 *   E. install.js sentinel now carries restart_gated_features:
 *      ["project-intent-agent"] — checked via static grep on the source.
 *
 *   F. PM agent tools list now spawns project-intent via Agent(...).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '../..');

const { emitProjectIntentFallbackEvent } = require(
  path.join(ROOT, 'bin', '_lib', 'project-intent-fallback-event.js')
);
const { generateProjectIntent } = require(
  path.join(ROOT, 'bin', '_lib', 'project-intent.js')
);

// ───────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────

const cleanup = [];

afterEach(() => {
  for (const d of cleanup.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

function makeTmpProject(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rcpt-v2-'));
  cleanup.push(dir);
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  if (orchId) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );
  }
  return { dir, auditDir, eventsPath: path.join(auditDir, 'events.jsonl') };
}

function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return [];
  return fs.readFileSync(eventsPath, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

/**
 * Create a minimal git repo with the given files and commit them.
 * @returns {string} project root
 */
function makeGitRepo({ files }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rcpt-v2-git-'));
  cleanup.push(dir);
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });

  const names = [];
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    names.push(name);
  }
  execSync(`git add ${names.join(' ')}`, { cwd: dir });
  execSync('git commit -q -m "init"', { cwd: dir });
  return dir;
}

// ───────────────────────────────────────────────────────────────────────────
// A. agent file exists with correct frontmatter
// ───────────────────────────────────────────────────────────────────────────

describe('A — project-intent agent file', () => {

  const AGENT_PATH = path.join(ROOT, 'agents', 'project-intent.md');

  test('agents/project-intent.md exists', () => {
    assert.ok(fs.existsSync(AGENT_PATH), 'agent file must exist');
  });

  test('frontmatter declares model: haiku', () => {
    const content = fs.readFileSync(AGENT_PATH, 'utf8');
    assert.match(content, /^model:\s*haiku\s*$/m, 'frontmatter must set model: haiku');
  });

  test('frontmatter declares effort: low', () => {
    const content = fs.readFileSync(AGENT_PATH, 'utf8');
    assert.match(content, /^effort:\s*low\s*$/m, 'frontmatter must set effort: low');
  });

  test('frontmatter restricts tools to Read only', () => {
    const content = fs.readFileSync(AGENT_PATH, 'utf8');
    const match = content.match(/^tools:\s*(.+)$/m);
    assert.ok(match, 'tools: line required');
    // Tool list may be comma-separated or a bracketed array; normalize and assert Read is the only entry.
    const tools = match[1]
      .replace(/[\[\]]/g, '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    assert.deepEqual(tools, ['Read'], `tools must be exactly [Read], got: ${JSON.stringify(tools)}`);
  });

  test('agent name frontmatter is project-intent', () => {
    const content = fs.readFileSync(AGENT_PATH, 'utf8');
    assert.match(content, /^name:\s*project-intent\s*$/m);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. Legacy-output parity — locked v2.1.12 block shape
// ───────────────────────────────────────────────────────────────────────────
//
// The agent markdown promises an exact output shape. We assert that the
// existing bin/_lib/project-intent.js (the fallback / canonical reference)
// still produces blocks in that shape when run on a controlled fixture repo.
// If either drifts, this test fires and R-RCPT-V2's parity AC is broken.

describe('B — legacy-output parity (block shape locked)', () => {

  test('high-confidence block matches the locked v2.1.12 shape', () => {
    const longReadme =
      '# Orchestray\n\n' +
      'A Claude Code plugin that orchestrates multiple specialized AI agents to ' +
      'handle complex tasks. It assigns roles, coordinates their work, and ' +
      'produces audited output. The core value is maximizing task execution ' +
      'efficiency by decomposing work across agents while preserving and ' +
      'reusing context. Users get better results faster than single-agent ' +
      'Claude Code usage because the orchestrator routes each subtask to the ' +
      'specialist best suited to handle it, with cost-aware model selection.\n\n' +
      '## Constraints\n\n' +
      '- Platform: Must work as a Claude Code plugin and cannot modify the ' +
      'Claude Code internals directly.\n' +
      '- Integration: Limited to Claude Code extension points only (hooks, ' +
      'skills, agents, MCP).\n' +
      '- Context: Must be context-efficient since the whole point is saving ' +
      'tokens rather than burning more of them.\n' +
      '- Persistence: State must survive session restarts using file-based ' +
      'storage under the project directory.\n\n' +
      '## Tech Stack\n\nNode.js, node:test for testing, no heavy external ' +
      'dependencies, plain JSON for configuration.\n';

    const repo = makeGitRepo({
      files: {
        'README.md': longReadme,
        'package.json': JSON.stringify({
          name: 'orchestray',
          description: 'Multi-agent orchestration plugin for Claude Code',
          main: 'bin/install.js',
          scripts: { test: 'node --test' },
        }, null, 2),
        'CLAUDE.md': '# CLAUDE.md\nNotes.\n',
        // Pad to >= 10 tracked files so AC-08 size gate is satisfied
        'a.js': '', 'b.js': '', 'c.js': '', 'd.js': '',
        'e.js': '', 'f.js': '', 'g.js': '',
      },
    });

    const result = generateProjectIntent({
      projectRoot: repo,
      enableGoalInference: true,
      enableRepoMap: true,
    });

    assert.equal(result.skipped, false);
    assert.equal(result.lowConfidence, false);
    const content = fs.readFileSync(result.filePath, 'utf8');

    // Locked header shape: `# Project Intent` + HTML comment with 4 keys, separated by `|`.
    assert.match(content, /^# Project Intent$/m, 'must start with H1 "Project Intent"');
    assert.match(
      content,
      /<!--\s*generated:\s*\S+\s*\|\s*repo-hash:\s*[0-9a-f]{7}\s*\|\s*readme-hash:\s*[0-9a-f]{7}\s*\|\s*low_confidence:\s*false\s*-->/,
      'must carry the locked header with ts + repo-hash + readme-hash + low_confidence'
    );

    // All five fields in fixed order.
    assert.match(content, /^\*\*Domain:\*\*/m);
    assert.match(content, /^\*\*Primary user problem:\*\*/m);
    assert.match(content, /^\*\*Key architectural constraint:\*\*/m);
    assert.match(content, /^\*\*Tech stack summary:\*\*/m);
    assert.match(content, /^\*\*Entry points:\*\*/m);

    // Field ORDER must be exactly this (bit-identity requirement):
    const lines = content.split('\n');
    const fieldIdx = {
      domain: lines.findIndex(l => l.startsWith('**Domain:**')),
      problem: lines.findIndex(l => l.startsWith('**Primary user problem:**')),
      constraint: lines.findIndex(l => l.startsWith('**Key architectural constraint:**')),
      tech: lines.findIndex(l => l.startsWith('**Tech stack summary:**')),
      entry: lines.findIndex(l => l.startsWith('**Entry points:**')),
    };
    assert.ok(fieldIdx.domain < fieldIdx.problem, 'Domain before Primary user problem');
    assert.ok(fieldIdx.problem < fieldIdx.constraint, 'Primary user problem before Constraint');
    assert.ok(fieldIdx.constraint < fieldIdx.tech, 'Constraint before Tech stack');
    assert.ok(fieldIdx.tech < fieldIdx.entry, 'Tech stack before Entry points');
  });

  test('low-confidence block has empty fields (parity with v2.1.12)', () => {
    // Repo with enough files (>=10) but no README.
    const files = { 'package.json': '{"name":"x"}' };
    for (let i = 0; i < 12; i++) files[`f${i}.js`] = '';
    const repo = makeGitRepo({ files });

    const result = generateProjectIntent({
      projectRoot: repo,
      enableGoalInference: true,
      enableRepoMap: true,
    });

    assert.equal(result.lowConfidence, true);
    const content = fs.readFileSync(result.filePath, 'utf8');
    assert.match(content, /low_confidence:\s*true/);
    // All five field values must be empty strings after the `:` + one space.
    // (The agent spec promises byte-identical behavior on this gate.)
    assert.match(content, /^\*\*Domain:\*\* $/m);
    assert.match(content, /^\*\*Primary user problem:\*\* $/m);
    assert.match(content, /^\*\*Key architectural constraint:\*\* $/m);
    assert.match(content, /^\*\*Tech stack summary:\*\* $/m);
    assert.match(content, /^\*\*Entry points:\*\* $/m);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C. Fallback event — canonical shape
// ───────────────────────────────────────────────────────────────────────────

describe('C — project_intent_fallback_no_agent event', () => {

  test('writes event with canonical type + timestamp + orchestration_id', () => {
    const orchId = 'orch-rcpt-v2-C';
    const { dir, eventsPath } = makeTmpProject(orchId);

    const ok = emitProjectIntentFallbackEvent({
      cwd: dir,
      reason: 'agent_unavailable',
      detail: { agent_file_found: false },
    });

    assert.equal(ok, true);
    const events = readEvents(eventsPath);
    assert.equal(events.length, 1);
    const ev = events[0];

    // Canonical v2.1.13 event-naming fields.
    assert.equal(ev.type, 'project_intent_fallback_no_agent');
    assert.match(ev.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
    assert.equal(ev.orchestration_id, orchId);
    assert.equal(ev.reason, 'agent_unavailable');
    assert.deepEqual(ev.detail, { agent_file_found: false });
    assert.equal(ev.source, 'pm-step-2.7a');
  });

  test('emits event with orchestration_id: null when no orchestration is active', () => {
    // No current-orchestration.json written.
    const { dir, eventsPath } = makeTmpProject(null);
    const ok = emitProjectIntentFallbackEvent({ cwd: dir, reason: 'spawn_error' });
    assert.equal(ok, true);
    const events = readEvents(eventsPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].orchestration_id, null);
    assert.equal(events[0].reason, 'spawn_error');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D. Fail-open contract
// ───────────────────────────────────────────────────────────────────────────

describe('D — fallback event fail-open', () => {

  test('does not throw on missing cwd', () => {
    // Should return false, never throw.
    assert.doesNotThrow(() => {
      const ok = emitProjectIntentFallbackEvent({ cwd: null });
      assert.equal(ok, false);
    });
  });

  test('does not throw on bogus cwd', () => {
    assert.doesNotThrow(() => {
      emitProjectIntentFallbackEvent({ cwd: 12345 });
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E. install.js sentinel carries restart_gated_features
// ───────────────────────────────────────────────────────────────────────────

describe('E — install.js sentinel advertises restart_gated_features', () => {

  test('install.js source carries restart_gated_features: ["project-intent-agent"]', () => {
    const installSrc = fs.readFileSync(path.join(ROOT, 'bin', 'install.js'), 'utf8');
    // Look for the array literal inside the sentinelData construction block.
    assert.match(
      installSrc,
      /restart_gated_features:\s*\[\s*['"]project-intent-agent['"]\s*\]/,
      'install.js sentinelData must declare restart_gated_features: ["project-intent-agent"]'
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F. PM agent tools list includes project-intent
// ───────────────────────────────────────────────────────────────────────────

describe('F — pm.md frontmatter exposes project-intent as spawnable', () => {

  test('pm.md Agent(...) tool list contains project-intent', () => {
    // v2.3.1: pm.md no longer carries a parenthetical Agent(...) allowlist.
    // The canonical set moved to bin/_lib/canonical-agents.js (single source of truth).
    // This test now asserts project-intent is in CANONICAL_AGENTS.
    const { CANONICAL_AGENTS } = require(path.join(ROOT, 'bin', '_lib', 'canonical-agents.js'));
    assert.ok(
      CANONICAL_AGENTS.has('project-intent'),
      'project-intent must be in CANONICAL_AGENTS (bin/_lib/canonical-agents.js)'
    );
  });

  test('pm.md Step 2.7a delegates to the project-intent agent', () => {
    const pmSrc = fs.readFileSync(path.join(ROOT, 'agents', 'pm.md'), 'utf8');
    // Step 2.7a section must name the agent as the preferred path.
    const stepMatch = pmSrc.match(/2\.7a\.[\s\S]*?(?=\n\d+\.|\n---)/);
    assert.ok(stepMatch, 'Step 2.7a section must exist in pm.md');
    const section = stepMatch[0];
    assert.match(section, /project-intent/, 'Step 2.7a must reference the project-intent agent');
    assert.match(section, /project_intent_fallback_no_agent/, 'Step 2.7a must document the fallback event');
  });
});
