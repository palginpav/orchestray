#!/usr/bin/env node
'use strict';

/**
 * Tests for `bin/learn-doc.js` and the `/orchestray:learn-doc` /
 * `/orchestray:distill` slash-command contract.
 *
 * Covers:
 *   A. resolveExpiryDays — Claude Code branch (14 days)
 *   B. resolveExpiryDays — Anthropic Platform branch (30 days)
 *   C. resolveExpiryDays — default/other branch (90 days)
 *   D. resolveExpiryDays — unparseable URL fallback (90 days)
 *   E. resolveSourceTier labels align with expiry branches
 *   F. slugify — stable, filesystem-safe slugs
 *   G. writeSkillPack — creates `.orchestray/skills/learn-doc/<slug>.md`
 *   H. writeSkillPack — frontmatter contains url, tier, expiry stamps
 *   I. CLI smoke — `node bin/learn-doc.js --url ... --content ...`
 *   J. Alias contract — skills/orchestray:distill/SKILL.md exists and
 *      references the canonical flow.
 *   K. Alias determinism — mocked invocations of learn-doc vs distill
 *      produce byte-identical output for the same URL + body + fixed clock.
 *   L. Both SKILL.md entries declare `disable-model-invocation: true`.
 *
 * No real WebFetch calls are made: we bypass the fetch and pass the
 * "distilled" body in directly. The per-URL fidelity gate is owned by the
 * release-manager; these tests pin the contract around expiry, slug, write
 * path, and alias registration.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LEARN_DOC_SCRIPT = path.join(REPO_ROOT, 'bin', 'learn-doc.js');
const LEARN_DOC_SKILL = path.join(REPO_ROOT, 'skills', 'orchestray:learn-doc', 'SKILL.md');
const DISTILL_SKILL = path.join(REPO_ROOT, 'skills', 'orchestray:distill', 'SKILL.md');
const DISTILLER_PROMPT = path.join(REPO_ROOT, 'skills', 'orchestray:learn-doc', 'distiller.md');

const {
  resolveExpiryDays,
  resolveSourceTier,
  slugify,
  writeSkillPack,
  renderSkillPack,
  EXPIRY_DAYS,
} = require(LEARN_DOC_SCRIPT);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const cleanup = [];

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-learn-doc-test-'));
  cleanup.push(dir);
  return dir;
}

function cleanupAll() {
  while (cleanup.length) {
    const dir = cleanup.pop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  }
}

// Run cleanup at the end of the file (node:test has no global afterAll,
// so we register one per describe block).

// ---------------------------------------------------------------------------
// A. Claude Code branch → 14 days
// ---------------------------------------------------------------------------
describe('resolveExpiryDays — Claude Code branch', () => {
  test('code.claude.com/docs/... → 14', () => {
    assert.strictEqual(resolveExpiryDays('https://code.claude.com/docs/en/sub-agents'), 14);
    assert.strictEqual(resolveExpiryDays('https://code.claude.com/docs/en/hooks'), 14);
  });

  test('docs.anthropic.com/en/docs/claude-code/... → 14', () => {
    assert.strictEqual(
      resolveExpiryDays('https://docs.anthropic.com/en/docs/claude-code/sub-agents'),
      14
    );
  });

  test('code.claude.com without /docs/ → NOT 14 (falls through)', () => {
    // /pricing is not a docs path → hits the default tier.
    assert.strictEqual(resolveExpiryDays('https://code.claude.com/pricing'), 90);
  });
});

// ---------------------------------------------------------------------------
// B. Anthropic Platform branch → 30 days
// ---------------------------------------------------------------------------
describe('resolveExpiryDays — Anthropic Platform branch', () => {
  test('platform.claude.com/docs/... → 30', () => {
    assert.strictEqual(
      resolveExpiryDays('https://platform.claude.com/docs/en/about-claude/pricing'),
      30
    );
  });

  test('docs.anthropic.com/en/... (non-claude-code) → 30', () => {
    assert.strictEqual(
      resolveExpiryDays('https://docs.anthropic.com/en/docs/intro'),
      30
    );
    assert.strictEqual(
      resolveExpiryDays('https://docs.anthropic.com/en/api/messages'),
      30
    );
  });
});

// ---------------------------------------------------------------------------
// C. Default / other tier → 90 days
// ---------------------------------------------------------------------------
describe('resolveExpiryDays — default/other branch', () => {
  test('arbitrary domain → 90', () => {
    assert.strictEqual(resolveExpiryDays('https://example.com/blog/post'), 90);
    assert.strictEqual(resolveExpiryDays('https://github.com/foo/bar'), 90);
  });

  test('mdn, nodejs.org, etc. → 90', () => {
    assert.strictEqual(
      resolveExpiryDays('https://developer.mozilla.org/en-US/docs/Web/API/fetch'),
      90
    );
    assert.strictEqual(resolveExpiryDays('https://nodejs.org/api/fs.html'), 90);
  });
});

// ---------------------------------------------------------------------------
// D. Unparseable URL fallback
// ---------------------------------------------------------------------------
describe('resolveExpiryDays — unparseable fallback', () => {
  test('empty / null / undefined → 90', () => {
    assert.strictEqual(resolveExpiryDays(''), 90);
    assert.strictEqual(resolveExpiryDays(null), 90);
    assert.strictEqual(resolveExpiryDays(undefined), 90);
  });

  test('garbage string → 90', () => {
    assert.strictEqual(resolveExpiryDays('not a url'), 90);
    assert.strictEqual(resolveExpiryDays('javascript:alert(1)'), 90);
  });

  test('EXPIRY_DAYS constants are exported and distinct', () => {
    assert.strictEqual(EXPIRY_DAYS.CLAUDE_CODE, 14);
    assert.strictEqual(EXPIRY_DAYS.ANTHROPIC_PLATFORM, 30);
    assert.strictEqual(EXPIRY_DAYS.DEFAULT, 90);
  });
});

// ---------------------------------------------------------------------------
// E. resolveSourceTier labels match branches
// ---------------------------------------------------------------------------
describe('resolveSourceTier', () => {
  test('maps each branch to the right label', () => {
    assert.strictEqual(
      resolveSourceTier('https://code.claude.com/docs/en/sub-agents'),
      'claude-code'
    );
    assert.strictEqual(
      resolveSourceTier('https://platform.claude.com/docs/en/about-claude/pricing'),
      'anthropic-platform'
    );
    assert.strictEqual(resolveSourceTier('https://example.com/'), 'other');
    assert.strictEqual(resolveSourceTier('not a url'), 'other');
  });
});

// ---------------------------------------------------------------------------
// F. slugify — filesystem-safe, deterministic
// ---------------------------------------------------------------------------
describe('slugify', () => {
  test('produces stable slugs for the same URL', () => {
    const a = slugify('https://code.claude.com/docs/en/sub-agents');
    const b = slugify('https://code.claude.com/docs/en/sub-agents');
    assert.strictEqual(a, b);
    assert.match(a, /^[a-z0-9-]+$/);
  });

  test('lowercases and collapses non-word characters', () => {
    const slug = slugify('https://Example.COM/Foo_Bar/Baz?q=1');
    assert.match(slug, /^[a-z0-9-]+$/);
    assert.ok(slug.includes('example-com'));
  });

  test('different URLs produce different slugs', () => {
    const a = slugify('https://code.claude.com/docs/en/sub-agents');
    const b = slugify('https://code.claude.com/docs/en/hooks');
    assert.notStrictEqual(a, b);
  });

  test('slug length is bounded (≤ 120 chars)', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(500);
    assert.ok(slugify(longUrl).length <= 120);
  });

  test('garbage URL still yields a non-empty slug', () => {
    const s = slugify('not a url');
    assert.ok(typeof s === 'string' && s.length > 0);
  });
});

// ---------------------------------------------------------------------------
// G+H. writeSkillPack — creates file with correct frontmatter
// ---------------------------------------------------------------------------
describe('writeSkillPack', () => {
  test('writes to .orchestray/skills/learn-doc/<slug>.md with full frontmatter', () => {
    const dir = makeProject();
    const fixedNow = new Date('2026-04-24T00:00:00.000Z');
    const url = 'https://code.claude.com/docs/en/sub-agents';
    const body = '# Distilled\n\nSample skill-pack body.\n';

    const { outputPath, slug, expiryDays, expiresAt } = writeSkillPack({
      url,
      body,
      title: 'Sub-agents',
      projectDir: dir,
      now: fixedNow,
    });

    // File exists under the expected cache path.
    assert.ok(fs.existsSync(outputPath));
    assert.ok(outputPath.endsWith(path.join('.orchestray', 'skills', 'learn-doc', `${slug}.md`)));

    // Expiry math lines up with the Claude Code tier (14 days).
    assert.strictEqual(expiryDays, 14);
    const expectedExpiry = new Date(fixedNow.getTime() + 14 * 86400_000).toISOString();
    assert.strictEqual(expiresAt, expectedExpiry);

    // Frontmatter contains the load-bearing fields.
    const contents = fs.readFileSync(outputPath, 'utf8');
    assert.match(contents, /^---\n/);
    assert.match(contents, new RegExp(`source_url: ${url.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
    assert.match(contents, /source_tier: claude-code/);
    assert.match(contents, /expiry_days: 14/);
    assert.match(contents, new RegExp(`fetched_at: ${fixedNow.toISOString()}`));
    assert.match(contents, new RegExp(`expires_at: ${expectedExpiry}`));
    assert.match(contents, /disable-model-invocation: true/);
    // Body preserved after frontmatter.
    assert.ok(contents.includes('Sample skill-pack body.'));
    // Cleanup.
    cleanupAll();
  });

  test('other-tier URL gets 90-day expiry and "other" tier label', () => {
    const dir = makeProject();
    const fixedNow = new Date('2026-04-24T00:00:00.000Z');
    const { expiryDays, outputPath } = writeSkillPack({
      url: 'https://example.com/post',
      body: 'Hello world.\n',
      projectDir: dir,
      now: fixedNow,
    });
    assert.strictEqual(expiryDays, 90);
    const contents = fs.readFileSync(outputPath, 'utf8');
    assert.match(contents, /source_tier: other/);
    assert.match(contents, /expiry_days: 90/);
    cleanupAll();
  });

  test('throws when url is missing', () => {
    assert.throws(
      () => writeSkillPack({ url: '', body: 'x', projectDir: makeProject() }),
      /url is required/
    );
    cleanupAll();
  });

  test('escapes frontmatter-breaking "---" sequences in body', () => {
    const dir = makeProject();
    const body = '# Body\n\n---\nlooks like frontmatter\n---\n\ntail\n';
    const { outputPath } = writeSkillPack({
      url: 'https://example.com/x',
      body,
      projectDir: dir,
      now: new Date('2026-04-24T00:00:00.000Z'),
    });
    const contents = fs.readFileSync(outputPath, 'utf8');
    // Only ONE frontmatter fence pair (two `---` lines at the start).
    const fenceCount = contents.split('\n').filter((ln) => ln === '---').length;
    assert.strictEqual(fenceCount, 2, 'should have exactly one frontmatter fence pair');
    cleanupAll();
  });
});

// ---------------------------------------------------------------------------
// I. CLI smoke
// ---------------------------------------------------------------------------
describe('learn-doc CLI', () => {
  test('--url + --content writes the skill pack and exits 0', () => {
    const dir = makeProject();
    const res = spawnSync(
      process.execPath,
      [
        LEARN_DOC_SCRIPT,
        '--url', 'https://code.claude.com/docs/en/hooks',
        '--content', '# Hooks\n\nHook reference body.\n',
        '--title', 'Hooks reference',
        '--project-dir', dir,
        '--now', '2026-04-24T00:00:00.000Z',
      ],
      { encoding: 'utf8' }
    );
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    const outFile = path.join(
      dir,
      '.orchestray',
      'skills',
      'learn-doc',
      `${slugify('https://code.claude.com/docs/en/hooks')}.md`
    );
    assert.ok(fs.existsSync(outFile));
    const contents = fs.readFileSync(outFile, 'utf8');
    assert.match(contents, /expiry_days: 14/);
    assert.match(contents, /Hook reference body/);
    cleanupAll();
  });

  test('missing --url exits 1 with a usage error', () => {
    const res = spawnSync(
      process.execPath,
      [LEARN_DOC_SCRIPT, '--content', 'x'],
      { encoding: 'utf8' }
    );
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /--url is required/);
  });

  test('both --content and --content-file is a usage error', () => {
    const dir = makeProject();
    const tmp = path.join(dir, 'body.md');
    fs.writeFileSync(tmp, 'x');
    const res = spawnSync(
      process.execPath,
      [
        LEARN_DOC_SCRIPT,
        '--url', 'https://example.com/',
        '--content', 'x',
        '--content-file', tmp,
      ],
      { encoding: 'utf8' }
    );
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /--content OR --content-file/);
    cleanupAll();
  });

  test('--content-file path is read from disk', () => {
    const dir = makeProject();
    const tmp = path.join(dir, 'body.md');
    fs.writeFileSync(tmp, '# FromFile\n\nContent-from-file body.\n');
    const res = spawnSync(
      process.execPath,
      [
        LEARN_DOC_SCRIPT,
        '--url', 'https://example.com/',
        '--content-file', tmp,
        '--project-dir', dir,
        '--now', '2026-04-24T00:00:00.000Z',
      ],
      { encoding: 'utf8' }
    );
    assert.strictEqual(res.status, 0, `stderr: ${res.stderr}`);
    const outFile = path.join(
      dir,
      '.orchestray',
      'skills',
      'learn-doc',
      `${slugify('https://example.com/')}.md`
    );
    const contents = fs.readFileSync(outFile, 'utf8');
    assert.match(contents, /Content-from-file body/);
    cleanupAll();
  });
});

// ---------------------------------------------------------------------------
// J+L. Alias contract — skill files exist and carry the right frontmatter
// ---------------------------------------------------------------------------
describe('slash-command alias contract', () => {
  test('learn-doc SKILL.md declares disable-model-invocation: true', () => {
    const src = fs.readFileSync(LEARN_DOC_SKILL, 'utf8');
    assert.match(src, /^---/);
    assert.match(src, /name: learn-doc/);
    assert.match(src, /disable-model-invocation: true/);
  });

  test('distill SKILL.md exists as an alias, points at learn-doc', () => {
    const src = fs.readFileSync(DISTILL_SKILL, 'utf8');
    assert.match(src, /name: distill/);
    assert.match(src, /disable-model-invocation: true/);
    // Must reference the canonical skill to avoid divergent behavior.
    assert.match(src, /orchestray:learn-doc/);
    // Must reference the canonical cache path so both entry points share state.
    assert.match(src, /\.orchestray\/skills\/learn-doc/);
  });

  test('distiller prompt exists and declares all five contract sections', () => {
    const src = fs.readFileSync(DISTILLER_PROMPT, 'utf8');
    assert.match(src, /### 1\. Purpose/);
    assert.match(src, /### 2\. Key Concepts/);
    // Section 3 is either Canonical Examples or Canonical Patterns depending on source.
    assert.match(src, /### 3\. Canonical (Examples|Patterns)/);
    assert.match(src, /### 4\. Gotchas/);
    assert.match(src, /### 5\. Source Anchors/);
  });
});

// ---------------------------------------------------------------------------
// K. Alias determinism — both entry points produce identical output
// ---------------------------------------------------------------------------
describe('alias determinism (mocked WebFetch)', () => {
  // The slash commands themselves are prompts, not executable code, so we
  // simulate both entry points by invoking the underlying bin/learn-doc.js
  // with the same URL + distilled body + clock. If both entry points are
  // wired to the same bin script (per the SKILL.md specs), this byte-equality
  // check is exactly the invariant we need.
  test('same URL + body + clock → byte-identical skill packs', () => {
    const dir1 = makeProject();
    const dir2 = makeProject();
    const url = 'https://code.claude.com/docs/en/sub-agents';
    const body = '# Distilled\n\nMocked distilled body, same for both aliases.\n';
    const fixedNow = new Date('2026-04-24T00:00:00.000Z');

    const a = writeSkillPack({ url, body, projectDir: dir1, now: fixedNow });
    const b = writeSkillPack({ url, body, projectDir: dir2, now: fixedNow });

    const fileA = fs.readFileSync(a.outputPath, 'utf8');
    const fileB = fs.readFileSync(b.outputPath, 'utf8');
    assert.strictEqual(fileA, fileB, 'learn-doc and distill must emit byte-identical skill packs');

    // Confirm both wrote under the SAME relative path within their project.
    const relA = path.relative(dir1, a.outputPath);
    const relB = path.relative(dir2, b.outputPath);
    assert.strictEqual(relA, relB);
    cleanupAll();
  });

  test('renderSkillPack is stable for the same inputs', () => {
    const url = 'https://platform.claude.com/docs/en/about-claude/pricing';
    const body = 'body';
    const fixedNow = new Date('2026-04-24T00:00:00.000Z');
    const a = renderSkillPack({ url, title: 'Pricing', body, now: fixedNow });
    const b = renderSkillPack({ url, title: 'Pricing', body, now: fixedNow });
    assert.strictEqual(a, b);
    // Sanity: Platform tier → 30 days.
    assert.match(a, /expiry_days: 30/);
    assert.match(a, /source_tier: anthropic-platform/);
  });
});

// Final safety net: drain any lingering temp dirs if an assertion threw.
process.on('exit', cleanupAll);
