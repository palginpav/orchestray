#!/usr/bin/env node
'use strict';

/**
 * v223-p2-repo-map-injected.test.js — v2.2.3 Phase 2 W3 P1-6.
 *
 * Tests the per-delegation `repo_map_injected` and `repo_map_skipped`
 * events emitted by `bin/emit-compression-telemetry.js` (SubagentStart hook).
 *
 * Invariants:
 *   - `repo_map_injected` fires when the delegation prompt contains a
 *     `## Repository Map` heading and config has not disabled repo-map.
 *   - `repo_map_skipped` fires with `disabled_by_config` when
 *     `enable_repo_map: false` (top-level) or `repo_map.enabled: false`.
 *   - `repo_map_skipped` fires with `agent_opted_out` for the haiku-default
 *     opt-out list when no heading is in the prompt.
 *   - `repo_map_skipped` fires with `size_exceeded` when on-disk
 *     `.orchestray/kb/facts/repo-map.md` is bigger than configured cap.
 *   - Payload includes version, type, orchestration_id, timestamp,
 *     subagent_type, agent_id, repo_map_bytes, repo_map_tokens,
 *     repo_map_source.
 *   - subagent_type comes from the SubagentStart hook payload.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const HOOK_PATH = path.resolve(__dirname, '..', 'emit-compression-telemetry.js');
const SCHEMA_SRC = path.resolve(__dirname, '..', '..', 'agents', 'pm-reference', 'event-schemas.md');

const {
  handleSubagentStart,
  extractRepoMapSection,
  isRepoMapEnabled,
  inferSkipReason,
  hasNearMissRepoMapHeading,
  REPO_MAP_HEADING_RE,
  REPO_MAP_HEADING_CACHE_RE,
  REPO_MAP_OPT_OUT_AGENTS,
} = require(HOOK_PATH);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject({ config = null, repoMapBytes = null, transcriptPrompt = null } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v223-p2-rmi-'));
  const orch = path.join(tmp, '.orchestray');
  fs.mkdirSync(path.join(orch, 'audit'), { recursive: true });
  fs.mkdirSync(path.join(orch, 'state'), { recursive: true });
  fs.mkdirSync(path.join(orch, 'kb', 'facts'), { recursive: true });

  // Mirror real schema source so the emit-time validator does NOT take the
  // "schema unreadable -> validation skipped" path. This catches any
  // missing-required-field defects in our emit code.
  const pmRef = path.join(tmp, 'agents', 'pm-reference');
  fs.mkdirSync(pmRef, { recursive: true });
  fs.copyFileSync(SCHEMA_SRC, path.join(pmRef, 'event-schemas.md'));

  // Active orchestration marker.
  fs.writeFileSync(
    path.join(orch, 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-rmi' })
  );

  if (config !== null) {
    fs.writeFileSync(
      path.join(orch, 'config.json'),
      JSON.stringify(config, null, 2)
    );
  }

  if (typeof repoMapBytes === 'number' && repoMapBytes > 0) {
    fs.writeFileSync(
      path.join(orch, 'kb', 'facts', 'repo-map.md'),
      'x'.repeat(repoMapBytes)
    );
  }

  let transcriptPath = null;
  if (transcriptPrompt !== null) {
    const transcriptDir = path.join(tmp, 'transcripts');
    fs.mkdirSync(transcriptDir, { recursive: true });
    transcriptPath = path.join(transcriptDir, 'subagent.jsonl');
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: transcriptPrompt },
    }) + '\n');
  }

  return { tmp, transcriptPath };
}

function readEvents(tmp) {
  const p = path.join(tmp, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function findEvent(events, type) {
  return events.find((e) => e.type === type) || null;
}

function buildPromptWithMap(extra = '') {
  return [
    'task_subject: build a thing',
    '',
    '## Repository Map',
    '',
    '`src/`',
    '- index.ts (function main, function init)',
    '- util.ts (function helper)',
    '',
    extra ? extra : '',
    '## Acceptance Rubric',
    '',
    'foo',
  ].join('\n');
}

function buildPromptWithCachePointer() {
  return [
    'task_subject: build a thing',
    '',
    '## Repository Map (unchanged this orchestration)',
    '',
    'See `.orchestray/kb/facts/repo-map.md` (hash `abcd1234`).',
    '',
    '## Acceptance Rubric',
    '',
    'bar',
  ].join('\n');
}

function buildPromptWithDeltaMarker() {
  return [
    'task_subject: build a thing',
    '',
    '## Repository Map',
    '```yaml',
    'repo_map_delta:',
    '  added: []',
    '  removed: []',
    '```',
    '',
    '## Acceptance Rubric',
    '',
    'baz',
  ].join('\n');
}

function buildPromptWithoutMap() {
  return [
    'task_subject: small task',
    '',
    '## Acceptance Rubric',
    '',
    'no map here',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// extractRepoMapSection unit
// ---------------------------------------------------------------------------

describe('extractRepoMapSection', () => {

  test('returns null when no heading present', () => {
    const r = extractRepoMapSection('# task\n\n## Acceptance\n\nfoo');
    assert.equal(r, null);
  });

  test('returns fresh source for full map heading', () => {
    const prompt = buildPromptWithMap();
    const r = extractRepoMapSection(prompt);
    assert.ok(r, 'expected section');
    assert.equal(r.source, 'fresh');
    assert.match(r.text, /## Repository Map/);
    assert.ok(r.text.length > 0);
  });

  test('returns cache source for "(unchanged this orchestration)" heading', () => {
    const prompt = buildPromptWithCachePointer();
    const r = extractRepoMapSection(prompt);
    assert.ok(r);
    assert.equal(r.source, 'cache');
  });

  test('returns cache source when body contains repo_map_delta marker', () => {
    const prompt = buildPromptWithDeltaMarker();
    const r = extractRepoMapSection(prompt);
    assert.ok(r);
    assert.equal(r.source, 'cache');
  });

  test('does NOT match prose mentions of "Repository Map" mid-sentence', () => {
    const prompt = 'See the Repository Map for context.\n\n## Acceptance\n\nfoo';
    const r = extractRepoMapSection(prompt);
    assert.equal(r, null);
  });

  test('section ends at next ## heading', () => {
    const prompt = buildPromptWithMap();
    const r = extractRepoMapSection(prompt);
    assert.ok(r);
    assert.ok(!r.text.includes('## Acceptance Rubric'));
  });
});

// ---------------------------------------------------------------------------
// isRepoMapEnabled unit
// ---------------------------------------------------------------------------

describe('isRepoMapEnabled', () => {

  test('defaults to true when config missing', () => {
    const { tmp } = makeProject({ config: null });
    assert.equal(isRepoMapEnabled(tmp), true);
  });

  test('returns false when enable_repo_map: false', () => {
    const { tmp } = makeProject({ config: { enable_repo_map: false } });
    assert.equal(isRepoMapEnabled(tmp), false);
  });

  test('returns false when repo_map.enabled: false', () => {
    const { tmp } = makeProject({ config: { repo_map: { enabled: false } } });
    assert.equal(isRepoMapEnabled(tmp), false);
  });

  test('returns true when enable_repo_map: true', () => {
    const { tmp } = makeProject({ config: { enable_repo_map: true } });
    assert.equal(isRepoMapEnabled(tmp), true);
  });
});

// ---------------------------------------------------------------------------
// repo_map_injected on Agent spawn
// ---------------------------------------------------------------------------

describe('repo_map_injected event', () => {

  test('fires when prompt contains ## Repository Map heading (fresh source)', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithMap(),
    });
    const r = handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_id: 'agent-abc-123',
      agent_transcript_path: transcriptPath,
    });
    assert.ok(r.eventsEmitted.includes('repo_map_injected'));
    const ev = findEvent(readEvents(tmp), 'repo_map_injected');
    assert.ok(ev, 'expected repo_map_injected event');
    assert.equal(ev.version, 1);
    assert.equal(ev.subagent_type, 'developer');
    assert.equal(ev.agent_id, 'agent-abc-123');
    assert.equal(ev.repo_map_source, 'fresh');
    assert.ok(ev.repo_map_bytes > 0, 'repo_map_bytes must be >0');
    assert.ok(ev.repo_map_tokens > 0, 'repo_map_tokens must be >0');
    assert.equal(ev.repo_map_tokens, Math.ceil(ev.repo_map_bytes / 4));
    assert.equal(ev.orchestration_id, 'orch-test-rmi');
    assert.ok(typeof ev.timestamp === 'string' && ev.timestamp.length > 0);
  });

  test('fires with cache source when heading is "(unchanged this orchestration)"', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithCachePointer(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'reviewer',
      agent_transcript_path: transcriptPath,
    });
    const ev = findEvent(readEvents(tmp), 'repo_map_injected');
    assert.ok(ev);
    assert.equal(ev.repo_map_source, 'cache');
    assert.equal(ev.subagent_type, 'reviewer');
  });

  test('fires with cache source when body contains repo_map_delta marker', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithDeltaMarker(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const ev = findEvent(readEvents(tmp), 'repo_map_injected');
    assert.ok(ev);
    assert.equal(ev.repo_map_source, 'cache');
  });

  test('does NOT fire repo_map_injected when no heading in prompt', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const ev = findEvent(readEvents(tmp), 'repo_map_injected');
    assert.equal(ev, null);
  });
});

// ---------------------------------------------------------------------------
// repo_map_skipped event
// ---------------------------------------------------------------------------

describe('repo_map_skipped event', () => {

  test('fires with disabled_by_config when enable_repo_map: false', () => {
    const { tmp, transcriptPath } = makeProject({
      config: { enable_repo_map: false },
      transcriptPrompt: buildPromptWithMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_id: 'agent-disabled',
      agent_transcript_path: transcriptPath,
    });
    const events = readEvents(tmp);
    const skip = findEvent(events, 'repo_map_skipped');
    assert.ok(skip, 'expected repo_map_skipped');
    assert.equal(skip.skip_reason, 'disabled_by_config');
    assert.equal(skip.subagent_type, 'developer');
    assert.equal(skip.agent_id, 'agent-disabled');
    // Must NOT also emit injected when config-disabled even if prompt has heading.
    const inj = findEvent(events, 'repo_map_injected');
    assert.equal(inj, null);
  });

  test('fires with disabled_by_config when repo_map.enabled: false', () => {
    const { tmp, transcriptPath } = makeProject({
      config: { repo_map: { enabled: false } },
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'disabled_by_config');
  });

  test('fires with agent_opted_out for haiku-scout when no heading in prompt', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'haiku-scout',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'agent_opted_out');
    assert.equal(skip.subagent_type, 'haiku-scout');
  });

  test('opt-out list covers all haiku-default agents', () => {
    assert.ok(REPO_MAP_OPT_OUT_AGENTS.has('haiku-scout'));
    // v2.2.3 P4 W2: orchestray-housekeeper stripped; pm-router added (A3 gateway).
    assert.ok(REPO_MAP_OPT_OUT_AGENTS.has('pm-router'));
    assert.ok(REPO_MAP_OPT_OUT_AGENTS.has('project-intent'));
    assert.ok(REPO_MAP_OPT_OUT_AGENTS.has('pattern-extractor'));
    assert.ok(!REPO_MAP_OPT_OUT_AGENTS.has('orchestray-housekeeper'),
      'orchestray-housekeeper removed from opt-out list (agent stripped)');
  });

  test('fires with size_exceeded when on-disk repo-map exceeds cap', () => {
    const { tmp, transcriptPath } = makeProject({
      config: { repo_map: { enabled: true, max_inject_bytes: 100 } },
      repoMapBytes: 5000, // 5000 > cap 100 → size_exceeded
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'size_exceeded');
  });

  test('fires with error when no heading + non-opt-out agent + no size cap', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'error');
    assert.equal(skip.subagent_type, 'developer');
  });

  test('does NOT also emit repo_map_injected on skip', () => {
    const { tmp, transcriptPath } = makeProject({
      config: { enable_repo_map: false },
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const events = readEvents(tmp);
    assert.equal(findEvent(events, 'repo_map_injected'), null);
    assert.ok(findEvent(events, 'repo_map_skipped'));
  });
});

// ---------------------------------------------------------------------------
// Schema validation surrogate guard
// ---------------------------------------------------------------------------

describe('schema validation', () => {

  test('repo_map_injected emits do not produce schema-validation surrogates', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const events = readEvents(tmp);
    const surrogates = events.filter(
      (e) => e.type === 'schema_shadow_validation_block' || e.type === 'schema_unknown_type_warn'
    );
    assert.equal(surrogates.length, 0,
      'unexpected validation surrogate(s):\n' +
      surrogates.map((s) => JSON.stringify(s)).join('\n'));
  });

  test('repo_map_skipped emits do not produce schema-validation surrogates', () => {
    const { tmp, transcriptPath } = makeProject({
      config: { enable_repo_map: false },
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const events = readEvents(tmp);
    const surrogates = events.filter(
      (e) => e.type === 'schema_shadow_validation_block' || e.type === 'schema_unknown_type_warn'
    );
    assert.equal(surrogates.length, 0,
      'unexpected validation surrogate(s):\n' +
      surrogates.map((s) => JSON.stringify(s)).join('\n'));
  });
});

// ---------------------------------------------------------------------------
// inferSkipReason unit
// ---------------------------------------------------------------------------

describe('inferSkipReason', () => {

  test('returns error when no config cap set', () => {
    const { tmp } = makeProject({ config: { enable_repo_map: true } });
    assert.equal(inferSkipReason(tmp), 'error');
  });

  test('returns error when on-disk map smaller than cap', () => {
    const { tmp } = makeProject({
      config: { repo_map: { max_inject_bytes: 10000 } },
      repoMapBytes: 100,
    });
    assert.equal(inferSkipReason(tmp), 'error');
  });

  test('returns size_exceeded when on-disk map exceeds cap', () => {
    const { tmp } = makeProject({
      config: { repo_map: { max_inject_bytes: 50 } },
      repoMapBytes: 1000,
    });
    assert.equal(inferSkipReason(tmp), 'size_exceeded');
  });

  test('returns template_drift when promptText has near-miss heading', () => {
    const { tmp } = makeProject({ config: { enable_repo_map: true } });
    const drifted = '### Repository Map\n\nfoo\n\n## Acceptance Rubric\n';
    assert.equal(inferSkipReason(tmp, drifted), 'template_drift');
  });

  test('size_exceeded wins over template_drift when both apply', () => {
    const { tmp } = makeProject({
      config: { repo_map: { max_inject_bytes: 50 } },
      repoMapBytes: 1000,
    });
    const drifted = '### Repository Map\n\nfoo\n';
    assert.equal(inferSkipReason(tmp, drifted), 'size_exceeded');
  });

  test('returns error when promptText has no near-miss heading', () => {
    const { tmp } = makeProject({ config: { enable_repo_map: true } });
    assert.equal(inferSkipReason(tmp, 'task: build a thing\n\n## Acceptance\n'), 'error');
  });
});

// ---------------------------------------------------------------------------
// hasNearMissRepoMapHeading unit (v2.2.3 P2 follow-up)
// ---------------------------------------------------------------------------

describe('hasNearMissRepoMapHeading', () => {

  test('matches "### Repository Map" (h3 instead of h2)', () => {
    assert.equal(hasNearMissRepoMapHeading('### Repository Map\n\nfoo'), true);
  });

  test('matches lowercase "## repository map"', () => {
    assert.equal(hasNearMissRepoMapHeading('## repository map\n\nfoo'), true);
  });

  test('matches indented "   ## Repository Map"', () => {
    assert.equal(hasNearMissRepoMapHeading('   ## Repository Map\n\nfoo'), true);
  });

  test('matches alternate "## Repo Map"', () => {
    assert.equal(hasNearMissRepoMapHeading('## Repo Map\n\nfoo'), true);
  });

  test('matches uppercase "## REPOSITORY MAP"', () => {
    assert.equal(hasNearMissRepoMapHeading('## REPOSITORY MAP\n\nfoo'), true);
  });

  test('does NOT match prose mention "the Repository Map for context"', () => {
    assert.equal(hasNearMissRepoMapHeading('See the Repository Map for context.\n'), false);
  });

  test('does NOT match unrelated text', () => {
    assert.equal(hasNearMissRepoMapHeading('## Acceptance Rubric\n\nfoo'), false);
  });

  test('returns false on null or empty', () => {
    assert.equal(hasNearMissRepoMapHeading(null), false);
    assert.equal(hasNearMissRepoMapHeading(''), false);
    assert.equal(hasNearMissRepoMapHeading(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// repo_map_skipped template_drift integration (v2.2.3 P2 follow-up)
// ---------------------------------------------------------------------------

describe('repo_map_skipped template_drift', () => {

  function buildPromptWithDriftedHeading(heading) {
    return [
      'task_subject: build a thing',
      '',
      heading,
      '',
      'src/ index.ts',
      '',
      '## Acceptance Rubric',
      '',
      'foo',
    ].join('\n');
  }

  test('emits template_drift on "### Repository Map" (h3)', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithDriftedHeading('### Repository Map'),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'template_drift');
    assert.equal(skip.subagent_type, 'developer');
  });

  test('emits template_drift on lowercase "## repository map"', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithDriftedHeading('## repository map'),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'template_drift');
  });

  test('emits template_drift on indented "   ## Repository Map"', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithDriftedHeading('   ## Repository Map'),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'template_drift');
  });

  test('emits template_drift on "## Repo Map" alternate name', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithDriftedHeading('## Repo Map'),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'template_drift');
  });

  test('still emits error when no heading and no near-miss', () => {
    const { tmp, transcriptPath } = makeProject({
      transcriptPrompt: buildPromptWithoutMap(),
    });
    handleSubagentStart({
      cwd: tmp,
      agent_type: 'developer',
      agent_transcript_path: transcriptPath,
    });
    const skip = findEvent(readEvents(tmp), 'repo_map_skipped');
    assert.ok(skip);
    assert.equal(skip.skip_reason, 'error');
  });
});
