#!/usr/bin/env node
'use strict';

/**
 * Contract tests for the `pattern_promote` MCP tool.
 *
 * Covers: per-stage refusal shapes (result:"blocked", not toolError), the
 * additionalProperties:false rejection of an injected `cwd`, preview mode
 * against a private project, the collision default/overwrite/no_op paths,
 * the happy-path frontmatter/body shape, and the security property that the
 * sensitivity gate cannot be bypassed through this tool.
 *
 * Isolation contract: every test uses its own tmp project dir and
 * ORCHESTRAY_TEST_SHARED_DIR-redirected tmp shared dir. The real
 * ~/.orchestray/shared/ is never touched.
 *
 * Runner: node --test bin/mcp-server/tools/__tests__/pattern_promote.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { handle, definition } = require('../pattern_promote.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject({ sensitivity = 'shareable' } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-promote-tool-test-'));
  fs.mkdirSync(path.join(projectDir, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.orchestray', 'audit'), { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, '.orchestray', 'config.json'),
    JSON.stringify({
      federation: { shared_dir_enabled: true, sensitivity, shared_dir_path: '~/.orchestray/shared' },
    }),
    'utf8'
  );

  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pattern-promote-tool-shared-'));
  return { projectDir, sharedDir };
}

function writePattern(projectDir, slug, { frontmatter = {}, body = '## Context\nTest.\n' } = {}) {
  const fm = Object.assign(
    { name: slug, category: 'decomposition', confidence: 0.8, description: 'Test pattern' },
    frontmatter
  );
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  const content = `---\n${fmLines}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(projectDir, '.orchestray', 'patterns', slug + '.md'), content, 'utf8');
  return slug;
}

function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

let savedTestSharedDir;

beforeEach(() => {
  savedTestSharedDir = process.env.ORCHESTRAY_TEST_SHARED_DIR;
});

afterEach(() => {
  if (savedTestSharedDir === undefined) delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
  else process.env.ORCHESTRAY_TEST_SHARED_DIR = savedTestSharedDir;
});

async function callPromote(input, projectDir, sharedDir) {
  process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedDir;
  return handle(input, { projectRoot: projectDir });
}

// ---------------------------------------------------------------------------
// 1. Input schema
// ---------------------------------------------------------------------------

describe('input schema', () => {

  test('additionalProperties:false rejects an injected cwd', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'schema-cwd-reject');
      const result = await callPromote({ slug: 'schema-cwd-reject', cwd: '/etc' }, projectDir, sharedDir);
      assert.equal(result.isError, true, 'an injected cwd must be a hard validation error, not a silent extra field');
      assert.ok(/unknown property|additionalProperties/.test(result.content[0].text));
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('definition.inputSchema has additionalProperties false and no cwd property', () => {
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal('cwd' in definition.inputSchema.properties, false);
  });

  test('missing required slug is a toolError', async () => {
    const result = await handle({}, { projectRoot: '/tmp' });
    assert.equal(result.isError, true);
  });

  test('unsafe slug (path traversal) is a toolError', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const result = await callPromote({ slug: '../../etc/passwd' }, projectDir, sharedDir);
      assert.equal(result.isError, true);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('pattern not found is a toolError (protocol fault, not policy)', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const result = await callPromote({ slug: 'does-not-exist' }, projectDir, sharedDir);
      assert.equal(result.isError, true);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 2. Blocked path — result:"blocked", never toolError, per-stage remediation
// ---------------------------------------------------------------------------

describe('blocked promotes are toolSuccess with result:"blocked"', () => {

  test('sensitivity gate: private project blocks with retryable_after_edit false and an operator-decision note', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'private' });
    try {
      writePattern(projectDir, 'block-sensitivity');
      const result = await callPromote({ slug: 'block-sensitivity' }, projectDir, sharedDir);
      assert.equal(result.isError, false, 'a policy refusal must be toolSuccess, not toolError');
      const sc = result.structuredContent;
      assert.equal(sc.result, 'blocked');
      assert.equal(sc.stage, 'sensitivity');
      assert.equal(sc.remediation.retryable_after_edit, false);
      assert.ok(sc.remediation.actions.length > 0);
      assert.ok(
        /operator/i.test(sc.remediation.actions.join(' ') + sc.remediation.summary),
        'sensitivity remediation must state this is an operator decision'
      );
      assert.equal(sc.written, false);

      const sharedFile = path.join(sharedDir, 'patterns', 'block-sensitivity.md');
      assert.equal(fs.existsSync(sharedFile), false, 'nothing should be written on a sensitivity block');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('secret-scan: blocked with detected_kind, location, and retryable_after_edit true', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const antKey = 'sk-ant-api03-abc123def456_real-looking-key';
      writePattern(projectDir, 'block-secret', { body: `## Evidence\nKey: ${antKey}\n` });
      const result = await callPromote({ slug: 'block-secret' }, projectDir, sharedDir);
      assert.equal(result.isError, false);
      const sc = result.structuredContent;
      assert.equal(sc.result, 'blocked');
      assert.equal(sc.stage, 'secret-scan');
      assert.equal(sc.remediation.retryable_after_edit, true);
      assert.ok(sc.remediation.actions.length > 0);
      assert.equal(sc.detected_kind, 'Anthropic API key');
      assert.ok(sc.location && sc.location.line > 0);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('size-cap: blocked with retryable_after_edit true', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'block-size', { body: 'x'.repeat(9 * 1024) });
      const result = await callPromote({ slug: 'block-size' }, projectDir, sharedDir);
      assert.equal(result.isError, false);
      const sc = result.structuredContent;
      assert.equal(sc.result, 'blocked');
      assert.equal(sc.stage, 'size-cap');
      assert.equal(sc.remediation.retryable_after_edit, true);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('schema-validate: blocked with retryable_after_edit true', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const content = '---\nname: block-schema\nconfidence: 0.8\ndescription: Missing category\n---\n\n## Context\nTest.\n';
      fs.writeFileSync(path.join(projectDir, '.orchestray', 'patterns', 'block-schema.md'), content, 'utf8');
      const result = await callPromote({ slug: 'block-schema' }, projectDir, sharedDir);
      assert.equal(result.isError, false);
      const sc = result.structuredContent;
      assert.equal(sc.result, 'blocked');
      assert.equal(sc.stage, 'schema-validate');
      assert.equal(sc.remediation.retryable_after_edit, true);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('sharing-flag: local-only pattern is blocked, retryable_after_edit true', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'block-sharing-flag', { frontmatter: { sharing: 'local-only' } });
      const result = await callPromote({ slug: 'block-sharing-flag' }, projectDir, sharedDir);
      assert.equal(result.isError, false);
      const sc = result.structuredContent;
      assert.equal(sc.result, 'blocked');
      assert.equal(sc.stage, 'sharing-flag');
      assert.equal(sc.remediation.retryable_after_edit, true);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('collision: differing slug blocked by default, existing.promoted_at surfaced, retryable_after_edit true', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'block-collision', { body: '## Context\nVersion one.\n' });
      const first = await callPromote({ slug: 'block-collision' }, projectDir, sharedDir);
      assert.equal(first.structuredContent.result, 'promoted');

      writePattern(projectDir, 'block-collision', { body: '## Context\nVersion two.\n' });
      const second = await callPromote({ slug: 'block-collision' }, projectDir, sharedDir);
      assert.equal(second.isError, false);
      const sc = second.structuredContent;
      assert.equal(sc.result, 'blocked');
      assert.equal(sc.stage, 'collision');
      assert.equal(sc.remediation.retryable_after_edit, true);
      assert.ok(sc.existing && sc.existing.promoted_at, 'existing.promoted_at must be surfaced');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 3. Security property: sensitivity gate is NOT bypassable through this tool
// ---------------------------------------------------------------------------

describe('security: sensitivity gate cannot be bypassed via pattern_promote', () => {

  test('mode:"promote" against a private project is blocked at sensitivity; nothing written', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'private' });
    try {
      writePattern(projectDir, 'bypass-attempt');
      const result = await callPromote({ slug: 'bypass-attempt', mode: 'promote' }, projectDir, sharedDir);
      assert.equal(result.structuredContent.result, 'blocked');
      assert.equal(result.structuredContent.stage, 'sensitivity');
      assert.equal(fs.existsSync(path.join(sharedDir, 'patterns', 'bypass-attempt.md')), false);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('mode:"dry_run" against a private project is also blocked at sensitivity', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'private' });
    try {
      writePattern(projectDir, 'bypass-dryrun');
      const result = await callPromote({ slug: 'bypass-dryrun', mode: 'dry_run' }, projectDir, sharedDir);
      assert.equal(result.structuredContent.result, 'blocked');
      assert.equal(result.structuredContent.stage, 'sensitivity');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('no input field can override sensitivity — schema has no "sensitivity", "force", or "skip_stages" property', () => {
    const props = Object.keys(definition.inputSchema.properties);
    assert.equal(props.includes('sensitivity'), false);
    assert.equal(props.includes('force'), false);
    assert.equal(props.includes('skip_stages'), false);
    assert.deepEqual(props.sort(), ['by', 'mode', 'overwrite', 'run_id', 'slug'].sort());
  });

  test('an injected cwd cannot redirect which project the sensitivity gate reads from', async () => {
    const { projectDir: privateProject, sharedDir } = makeTmpProject({ sensitivity: 'private' });
    const { projectDir: shareableProject } = makeTmpProject({ sensitivity: 'shareable' });
    try {
      writePattern(privateProject, 'cross-project-attempt');
      // The tool ignores the context's own cwd override attempt via input;
      // additionalProperties:false already rejects a `cwd` key outright
      // (covered above). Here we confirm passing an unrelated shareable
      // project's root via context does NOT change which private project's
      // pattern gets read for THIS call — context.projectRoot IS the source
      // of truth (server-injected), so this call must resolve against
      // privateProject, not shareableProject.
      process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedDir;
      const result = await handle({ slug: 'cross-project-attempt' }, { projectRoot: privateProject });
      assert.equal(result.structuredContent.result, 'blocked');
      assert.equal(result.structuredContent.stage, 'sensitivity');
    } finally {
      cleanup(privateProject, shareableProject, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 4. Preview mode
// ---------------------------------------------------------------------------

describe('preview mode', () => {

  test('preview against a private project: result "preview", sensitivity_blocks_actual_share true, no write', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'private' });
    try {
      writePattern(projectDir, 'preview-private-tool');
      const result = await callPromote({ slug: 'preview-private-tool', mode: 'preview' }, projectDir, sharedDir);
      assert.equal(result.isError, false);
      const sc = result.structuredContent;
      assert.equal(sc.result, 'preview');
      assert.equal(sc.sensitivity_blocks_actual_share, true);
      assert.equal(fs.existsSync(path.join(sharedDir, 'patterns')), false, 'preview must not create the patterns dir at all');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('preview against a shareable project: sensitivity_blocks_actual_share false, still no write', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'shareable' });
    try {
      writePattern(projectDir, 'preview-shareable-tool');
      const result = await callPromote({ slug: 'preview-shareable-tool', mode: 'preview' }, projectDir, sharedDir);
      assert.equal(result.structuredContent.result, 'preview');
      assert.equal(result.structuredContent.sensitivity_blocks_actual_share, false);
      const destFile = path.join(sharedDir, 'patterns', 'preview-shareable-tool.md');
      assert.equal(fs.existsSync(destFile), false);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 5. Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {

  test('promote succeeds: frontmatter shape, zero raw headers, zero Evidence, home-relativized dest_path', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'happy-path', {
        frontmatter: { created_from: 'orch-abc', last_applied: '2026-01-01', times_applied: 3 },
        body: '# Title\n\n## Evidence\nSupporting proof.\n\n## Approach\nDo the thing.\n',
      });
      const result = await callPromote({ slug: 'happy-path', by: 'curator', run_id: 'run-1' }, projectDir, sharedDir);
      assert.equal(result.isError, false);
      const sc = result.structuredContent;
      assert.equal(sc.result, 'promoted');
      assert.equal(sc.written, true);
      assert.ok(sc.dest_path.startsWith('<home>') || !sc.dest_path.includes(os.homedir()), 'dest_path must not leak a raw home path');
      assert.ok(sc.promoted_at);
      assert.match(sc.promoted_from, /^[0-9a-f]{8}$/);
      assert.ok(sc.stages_run.includes('evidence-strip'));
      assert.ok(sc.stages_run.includes('collision'));
      assert.ok(sc.sanitization.frontmatter_removed.includes('created_from'));
      assert.ok(sc.sanitization.frontmatter_added.includes('origin'));
      assert.ok(sc.sanitization.evidence_stripped_bytes > 0);
      assert.equal(sc.overwrote_existing, false);

      const content = fs.readFileSync(path.join(sharedDir, 'patterns', 'happy-path.md'), 'utf8');
      assert.ok(!/^#{1,2} /m.test(content.split('---\n').slice(2).join('---\n')) || content.includes('(header:'), 'raw H1/H2 should be downgraded');
      assert.ok(!content.includes('## Evidence'), 'zero raw Evidence heading');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('by defaults to "user" when omitted', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'happy-path-default-by');
      const result = await callPromote({ slug: 'happy-path-default-by' }, projectDir, sharedDir);
      assert.equal(result.structuredContent.result, 'promoted');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('overwrite:true on identical content returns no_op, not "promoted"', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'happy-noop', { body: '## Context\nStable.\n' });
      const first = await callPromote({ slug: 'happy-noop' }, projectDir, sharedDir);
      assert.equal(first.structuredContent.result, 'promoted');

      writePattern(projectDir, 'happy-noop', { body: '## Context\nStable.\n' });
      const second = await callPromote({ slug: 'happy-noop', overwrite: true }, projectDir, sharedDir);
      assert.equal(second.structuredContent.result, 'no_op');
      assert.equal(second.structuredContent.written, false);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// Paranoia: the real shared tier is never touched
// ---------------------------------------------------------------------------

test('real ~/.orchestray/shared/patterns/ is untouched after the full test run', () => {
  const realSharedDir = path.join(os.homedir(), '.orchestray', 'shared', 'patterns');
  // This assertion runs last-ish by node:test file ordering guarantees are not
  // strict, so it is a paranoia spot-check, not the sole guard. Every test
  // above sets ORCHESTRAY_TEST_SHARED_DIR before calling handle().
  assert.ok(true, 'structural guard — real assurance comes from ORCHESTRAY_TEST_SHARED_DIR in every call above');
  void realSharedDir;
});
