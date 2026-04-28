#!/usr/bin/env node
'use strict';

/**
 * v2.1.14 R-HCAP regression tests — artifact body cap & detail pointer.
 *
 * Covers:
 *   1. Validator passes silently when artifact body <= 2,500 tokens.
 *   2. Validator emits handoff_body_warn (threshold "warn") for 2,500 < body <= 5,000.
 *   3. Validator emits handoff_body_warn (threshold "block_would_have_fired") when
 *      body > 5,000 AND no detail_artifact AND hard_block: false.
 *   4. Validator emits handoff_body_block AND exits 2 when body > 5,000 AND
 *      no detail_artifact AND hard_block: true.
 *   5. Validator emits handoff_body_warn only (no block) when body > 5,000 AND
 *      detail_artifact is set.
 *   6. Validator no-ops when handoff_body_cap.enabled: false.
 *   7. handoff-contract.md contains §10.
 *   8. event-schemas.md has both new event types with version: 1.
 *   9. Config schema accepts and validates the handoff_body_cap top-level key.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.resolve(REPO_ROOT, 'bin', 'validate-task-completion.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(stdinData) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: stdinData,
    encoding: 'utf8',
    timeout: 8000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-hcap-test-'));
}

function readEventsJsonl(dir) {
  const p = path.join(dir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/**
 * Generate a string of approximately `tokens` tokens using the
 * 4-bytes-per-token heuristic (tokens * 4 = bytes).
 *
 * @param {number} tokens
 * @returns {string}
 */
function makeContent(tokens) {
  // Each 'x' is 1 byte; 4 bytes = 1 token.
  return 'x'.repeat(tokens * 4);
}

/**
 * Build a T15-style SubagentStop payload with a design_artifact path pointing
 * to an artifact file on disk. Optionally includes detail_artifact.
 *
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.artifactPath - Full path to the artifact file.
 * @param {string} [opts.detailArtifactPath] - Full path to the detail_artifact file (optional).
 * @returns {string} JSON string
 */
function makePayload(opts) {
  const relArtifact = path.relative(opts.cwd, opts.artifactPath);
  const sr = {
    status: 'success',
    summary: 'Test summary',
    files_changed: [],
    files_read: ['some-file.js'],
    issues: [],
    assumptions: [],
    design_artifact: relArtifact,
    // v2.2.9 B-2.1: architect role now requires design_doc_path and
    // acceptance_rubric in addition to the 5 base fields.
    design_doc_path: relArtifact,
    acceptance_rubric: 'Pass: all criteria met in design doc.',
  };
  if (opts.detailArtifactPath) {
    sr.detail_artifact = path.relative(opts.cwd, opts.detailArtifactPath);
  }

  return JSON.stringify({
    hook_event_name: 'SubagentStop',
    subagent_type: 'architect',
    cwd: opts.cwd,
    output: '## Structured Result\n```json\n' + JSON.stringify(sr) + '\n```\n',
  });
}

/**
 * Write a config.json in the tmp dir with handoff_body_cap settings.
 *
 * @param {string} tmpDir
 * @param {object} capConfig
 */
function writeCapConfig(tmpDir, capConfig) {
  const confDir = path.join(tmpDir, '.orchestray');
  fs.mkdirSync(confDir, { recursive: true });
  fs.writeFileSync(
    path.join(confDir, 'config.json'),
    JSON.stringify({ handoff_body_cap: capConfig })
  );
}

// ---------------------------------------------------------------------------
// Test 1: body <= 2,500 tokens → pass silently
// ---------------------------------------------------------------------------

describe('R-HCAP: body <= 2,500 tokens → pass silently', () => {
  test('exits 0 and emits no handoff_body_warn when body is small', () => {
    const tmpDir = makeTmpDir();
    try {
      const artifactPath = path.join(tmpDir, 'small-artifact.md');
      fs.writeFileSync(artifactPath, makeContent(100)); // 100 tokens — well under limit
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      const { status, stderr } = run(payload);
      assert.equal(status, 0, 'should exit 0 for small artifact');
      assert.ok(!stderr.includes('R-HCAP'), 'should not emit R-HCAP warning for small artifact');
      const events = readEventsJsonl(tmpDir);
      const warnEvents = events.filter(e => e.type === 'handoff_body_warn' || e.type === 'handoff_body_block');
      assert.equal(warnEvents.length, 0, 'no handoff_body_* events for small artifact');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('exits 0 when body is exactly at warn_tokens boundary (2,500)', () => {
    const tmpDir = makeTmpDir();
    try {
      const artifactPath = path.join(tmpDir, 'boundary-artifact.md');
      fs.writeFileSync(artifactPath, makeContent(2500));
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      const { status } = run(payload);
      assert.equal(status, 0, 'exactly at boundary should pass');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2: 2,500 < body <= 5,000 → handoff_body_warn with threshold "warn"
// ---------------------------------------------------------------------------

describe('R-HCAP: 2,500 < body <= 5,000 → handoff_body_warn (threshold: warn)', () => {
  test('exits 0 and emits handoff_body_warn for mid-range artifact', () => {
    const tmpDir = makeTmpDir();
    try {
      const artifactPath = path.join(tmpDir, 'mid-artifact.md');
      fs.writeFileSync(artifactPath, makeContent(3000)); // 3,000 tokens
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      const { status, stderr } = run(payload);
      assert.equal(status, 0, 'should exit 0 for mid-range artifact (warn only)');
      const events = readEventsJsonl(tmpDir);
      const warnEvents = events.filter(e => e.type === 'handoff_body_warn');
      assert.equal(warnEvents.length, 1, 'exactly one handoff_body_warn event');
      assert.equal(warnEvents[0].threshold_breached, 'warn', 'threshold_breached should be "warn"');
      assert.ok(warnEvents[0].body_tokens > 2500, 'body_tokens should be > 2500');
      assert.equal(typeof warnEvents[0].has_detail_artifact, 'boolean');
      assert.ok(stderr.includes('R-HCAP'), 'stderr should mention R-HCAP');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('warn event includes file, body_tokens, has_detail_artifact fields', () => {
    const tmpDir = makeTmpDir();
    try {
      const artifactPath = path.join(tmpDir, 'warn-fields.md');
      fs.writeFileSync(artifactPath, makeContent(3500));
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      run(payload);
      const events = readEventsJsonl(tmpDir);
      const warnEvent = events.find(e => e.type === 'handoff_body_warn');
      assert.ok(warnEvent, 'handoff_body_warn event must exist');
      assert.ok(typeof warnEvent.file === 'string' && warnEvent.file.length > 0, 'file field required');
      assert.ok(typeof warnEvent.body_tokens === 'number', 'body_tokens must be a number');
      assert.ok(typeof warnEvent.has_detail_artifact === 'boolean', 'has_detail_artifact must be boolean');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: body > 5,000, no detail_artifact, hard_block: false →
//         handoff_body_warn (threshold: block_would_have_fired)
// ---------------------------------------------------------------------------

describe('R-HCAP: body > 5,000, no detail_artifact, hard_block: false → soft warn', () => {
  test('exits 0 and emits block_would_have_fired warn (default hard_block: false)', () => {
    const tmpDir = makeTmpDir();
    try {
      const artifactPath = path.join(tmpDir, 'large-artifact.md');
      fs.writeFileSync(artifactPath, makeContent(6000)); // 6,000 tokens — over block threshold
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      const { status, stderr } = run(payload);
      // Default config has hard_block: false
      assert.equal(status, 0, 'should exit 0 when hard_block is false');
      const events = readEventsJsonl(tmpDir);
      const warnEvents = events.filter(e => e.type === 'handoff_body_warn');
      assert.equal(warnEvents.length, 1, 'one handoff_body_warn event');
      assert.equal(warnEvents[0].threshold_breached, 'block_would_have_fired');
      assert.equal(warnEvents[0].has_detail_artifact, false);
      assert.ok(stderr.includes('block_would_have_fired') || stderr.includes('hard_block'), 'stderr should mention block would have fired');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('no block events emitted when hard_block is false', () => {
    const tmpDir = makeTmpDir();
    try {
      const artifactPath = path.join(tmpDir, 'large-no-block.md');
      fs.writeFileSync(artifactPath, makeContent(7000));
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      run(payload);
      const events = readEventsJsonl(tmpDir);
      const blockEvents = events.filter(e => e.type === 'handoff_body_block');
      assert.equal(blockEvents.length, 0, 'no handoff_body_block events when hard_block: false');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 4: body > 5,000, no detail_artifact, hard_block: true → block + exit 2
// ---------------------------------------------------------------------------

describe('R-HCAP: body > 5,000, no detail_artifact, hard_block: true → block exit 2', () => {
  test('exits 2 and emits handoff_body_block when hard_block is true', () => {
    const tmpDir = makeTmpDir();
    try {
      writeCapConfig(tmpDir, { hard_block: true });
      const artifactPath = path.join(tmpDir, 'large-hardblock.md');
      fs.writeFileSync(artifactPath, makeContent(6000));
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      const { status, stderr } = run(payload);
      assert.equal(status, 2, 'should exit 2 when hard_block is true');
      const events = readEventsJsonl(tmpDir);
      const blockEvents = events.filter(e => e.type === 'handoff_body_block');
      assert.equal(blockEvents.length, 1, 'one handoff_body_block event');
      assert.equal(blockEvents[0].threshold_breached, 'block');
      assert.equal(blockEvents[0].has_detail_artifact, false);
      assert.ok(stderr.includes('detail_artifact'), 'stderr should mention remediation via detail_artifact');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  test('block event includes file and body_tokens', () => {
    const tmpDir = makeTmpDir();
    try {
      writeCapConfig(tmpDir, { hard_block: true });
      const artifactPath = path.join(tmpDir, 'block-fields.md');
      fs.writeFileSync(artifactPath, makeContent(6500));
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      run(payload);
      const events = readEventsJsonl(tmpDir);
      const blockEvent = events.find(e => e.type === 'handoff_body_block');
      assert.ok(blockEvent, 'handoff_body_block event must exist');
      assert.ok(typeof blockEvent.file === 'string', 'file field required');
      assert.ok(typeof blockEvent.body_tokens === 'number', 'body_tokens required');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 5: body > 5,000 AND detail_artifact is set → warn only (no block)
// ---------------------------------------------------------------------------

describe('R-HCAP: body > 5,000 with detail_artifact → warn only, no block', () => {
  test('exits 0 and emits warn (not block) when detail_artifact is set', () => {
    const tmpDir = makeTmpDir();
    try {
      writeCapConfig(tmpDir, { hard_block: true }); // hard_block: true but detail_artifact present
      const artifactPath = path.join(tmpDir, 'large-with-detail.md');
      fs.writeFileSync(artifactPath, makeContent(6000));
      const detailPath = path.join(tmpDir, 'detail.md');
      fs.writeFileSync(detailPath, 'Detail content');
      const payload = makePayload({ cwd: tmpDir, artifactPath, detailArtifactPath: detailPath });
      const { status } = run(payload);
      assert.equal(status, 0, 'should exit 0 when detail_artifact is set, even with hard_block: true');
      const events = readEventsJsonl(tmpDir);
      const blockEvents = events.filter(e => e.type === 'handoff_body_block');
      assert.equal(blockEvents.length, 0, 'no block events when detail_artifact is present');
      const warnEvents = events.filter(e => e.type === 'handoff_body_warn');
      assert.equal(warnEvents.length, 1, 'one warn event when body is large but detail_artifact is set');
      assert.equal(warnEvents[0].has_detail_artifact, true, 'has_detail_artifact should be true');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 6: handoff_body_cap.enabled: false → no-op
// ---------------------------------------------------------------------------

describe('R-HCAP: enabled: false → no-op', () => {
  test('does not check body size when enabled is false', () => {
    const tmpDir = makeTmpDir();
    try {
      writeCapConfig(tmpDir, { enabled: false });
      const artifactPath = path.join(tmpDir, 'huge-disabled.md');
      fs.writeFileSync(artifactPath, makeContent(50000)); // 50,000 tokens — way over limit
      const payload = makePayload({ cwd: tmpDir, artifactPath });
      const { status, stderr } = run(payload);
      assert.equal(status, 0, 'should exit 0 when body-cap is disabled');
      assert.ok(!stderr.includes('R-HCAP'), 'should not emit any R-HCAP output when disabled');
      const events = readEventsJsonl(tmpDir);
      const capEvents = events.filter(e =>
        e.type === 'handoff_body_warn' || e.type === 'handoff_body_block'
      );
      assert.equal(capEvents.length, 0, 'no body-cap events when enabled: false');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Test 7: handoff-contract.md contains §10
// ---------------------------------------------------------------------------

describe('R-HCAP: handoff-contract.md §10 presence', () => {
  test('handoff-contract.md contains §10 heading and detail_artifact pointer', () => {
    const contractPath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'handoff-contract.md');
    const content = fs.readFileSync(contractPath, 'utf8');
    assert.ok(
      content.includes('## 10.'),
      'handoff-contract.md must contain a §10 section'
    );
    assert.ok(
      content.includes('detail_artifact'),
      'handoff-contract.md §10 must mention detail_artifact'
    );
    assert.ok(
      content.includes('2,000') && content.includes('token'),
      'handoff-contract.md §10 must state the 2,000-token body cap'
    );
    assert.ok(
      content.includes('handoff_body_cap'),
      'handoff-contract.md §10 must document the handoff_body_cap config key'
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8: event-schemas.md has both new event types with version: 1
// ---------------------------------------------------------------------------

describe('R-HCAP: event-schemas.md documents new event types', () => {
  test('event-schemas.md contains handoff_body_warn with version: 1', () => {
    const schemasPath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
    const content = fs.readFileSync(schemasPath, 'utf8');
    assert.ok(
      content.includes('handoff_body_warn'),
      'event-schemas.md must document handoff_body_warn'
    );
    // Check for version: 1 near the handoff_body_warn section
    const warnIdx = content.indexOf('handoff_body_warn');
    const warnSection = content.slice(warnIdx, warnIdx + 2000);
    assert.ok(
      warnSection.includes('"version": 1'),
      'handoff_body_warn schema must have version: 1'
    );
  });

  test('event-schemas.md contains handoff_body_block with version: 1', () => {
    const schemasPath = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
    const content = fs.readFileSync(schemasPath, 'utf8');
    assert.ok(
      content.includes('handoff_body_block'),
      'event-schemas.md must document handoff_body_block'
    );
    const blockIdx = content.indexOf('handoff_body_block');
    // Find the second occurrence (schema JSON, not the heading)
    const blockSection = content.slice(blockIdx, blockIdx + 3000);
    assert.ok(
      blockSection.includes('"version": 1'),
      'handoff_body_block schema must have version: 1'
    );
  });

  test('both event types are in KNOWN_EVENT_TYPES in validate-task-completion.js', () => {
    const { KNOWN_EVENT_TYPES } = require(SCRIPT);
    assert.ok(KNOWN_EVENT_TYPES.has('handoff_body_warn'), 'KNOWN_EVENT_TYPES must include handoff_body_warn');
    assert.ok(KNOWN_EVENT_TYPES.has('handoff_body_block'), 'KNOWN_EVENT_TYPES must include handoff_body_block');
  });
});

// ---------------------------------------------------------------------------
// Test 9: Config schema accepts and validates handoff_body_cap key
// ---------------------------------------------------------------------------

describe('R-HCAP: config schema validates handoff_body_cap', () => {
  const {
    DEFAULT_HANDOFF_BODY_CAP,
    loadHandoffBodyCapConfig,
    validateHandoffBodyCapConfig,
  } = require(path.resolve(REPO_ROOT, 'bin', '_lib', 'config-schema.js'));

  test('DEFAULT_HANDOFF_BODY_CAP has all four required keys', () => {
    assert.ok(DEFAULT_HANDOFF_BODY_CAP, 'DEFAULT_HANDOFF_BODY_CAP must exist');
    assert.equal(DEFAULT_HANDOFF_BODY_CAP.enabled, true);
    assert.equal(DEFAULT_HANDOFF_BODY_CAP.warn_tokens, 2500);
    assert.equal(DEFAULT_HANDOFF_BODY_CAP.block_tokens, 5000);
    assert.equal(DEFAULT_HANDOFF_BODY_CAP.hard_block, false);
  });

  test('validateHandoffBodyCapConfig accepts valid config', () => {
    const result = validateHandoffBodyCapConfig({
      enabled: true,
      warn_tokens: 2500,
      block_tokens: 5000,
      hard_block: false,
    });
    assert.ok(result.valid, 'valid config should pass validation');
  });

  test('validateHandoffBodyCapConfig rejects non-boolean enabled', () => {
    const result = validateHandoffBodyCapConfig({ enabled: 'yes' });
    assert.ok(!result.valid, 'non-boolean enabled should fail validation');
    assert.ok(result.errors.some(e => e.includes('enabled')));
  });

  test('validateHandoffBodyCapConfig rejects non-integer warn_tokens', () => {
    const result = validateHandoffBodyCapConfig({ warn_tokens: 'many' });
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('warn_tokens')));
  });

  test('validateHandoffBodyCapConfig rejects block_tokens < warn_tokens', () => {
    const result = validateHandoffBodyCapConfig({ warn_tokens: 3000, block_tokens: 2000 });
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('block_tokens')));
  });

  test('validateHandoffBodyCapConfig emits did-you-mean for misspelled keys', () => {
    const result = validateHandoffBodyCapConfig({ warn_threshold: 2500 });
    assert.ok(!result.valid);
    assert.ok(result.errors.some(e => e.includes('warn_threshold') && e.includes('warn_tokens')));
  });

  test('loadHandoffBodyCapConfig returns defaults when no config file exists', () => {
    const config = loadHandoffBodyCapConfig(os.tmpdir());
    assert.equal(config.enabled, DEFAULT_HANDOFF_BODY_CAP.enabled);
    assert.equal(config.warn_tokens, DEFAULT_HANDOFF_BODY_CAP.warn_tokens);
    assert.equal(config.block_tokens, DEFAULT_HANDOFF_BODY_CAP.block_tokens);
    assert.equal(config.hard_block, DEFAULT_HANDOFF_BODY_CAP.hard_block);
  });

  test('loadHandoffBodyCapConfig merges file values with defaults', () => {
    const tmpDir = makeTmpDir();
    try {
      writeCapConfig(tmpDir, { hard_block: true });
      const config = loadHandoffBodyCapConfig(tmpDir);
      assert.equal(config.hard_block, true, 'file value should override default');
      assert.equal(config.enabled, true, 'unspecified keys should use defaults');
      assert.equal(config.warn_tokens, 2500, 'unspecified keys should use defaults');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Additional: estimateTokens helper
// ---------------------------------------------------------------------------

describe('R-HCAP: estimateTokens helper', () => {
  const { estimateTokens } = require(SCRIPT);

  test('estimateTokens returns ~token count for known string', () => {
    // 40 bytes = 10 tokens at 4 bytes/token
    const count = estimateTokens('x'.repeat(40));
    assert.equal(count, 10, '40 bytes should be 10 tokens');
  });

  test('estimateTokens handles empty string', () => {
    assert.equal(estimateTokens(''), 0);
  });
});
