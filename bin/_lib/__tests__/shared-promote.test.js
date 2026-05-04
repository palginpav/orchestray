#!/usr/bin/env node
'use strict';

/**
 * Adversarial test battery for bin/_lib/shared-promote.js.
 *
 * Covers the 7-stage sanitization pipeline against:
 *   - Secret-scan patterns (Anthropic, OpenAI, AWS, hex-entropy)
 *   - Path/identity strip
 *   - Prompt-injection (H1/H2 downgrade)
 *   - Size cap
 *   - Schema validation
 *   - Sensitivity gate
 *   - Atomic write
 *   - Fuzz harness (deterministic)
 *
 * Runner: node --test bin/_lib/__tests__/shared-promote.test.js
 *
 * Isolation contract:
 *   - Every test creates its own tmp dir via mkdtempSync.
 *   - ORCHESTRAY_TEST_SHARED_DIR is set per-test and restored afterwards.
 *   - The real ~/.orchestray/shared/ is never touched.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { promotePattern, _projectHash } = require('../shared-promote.js');

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

/**
 * Create a fully wired tmp project directory with:
 *   - .orchestray/patterns/
 *   - .orchestray/config.json  (federation.sensitivity set by caller)
 * Returns { projectDir, sharedDir } where sharedDir is the redirected
 * ORCHESTRAY_TEST_SHARED_DIR temp path.
 */
function makeTmpProject({ sensitivity = 'shareable' } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-promote-test-'));
  fs.mkdirSync(path.join(projectDir, '.orchestray', 'patterns'), { recursive: true });

  // Write config with the requested sensitivity.
  const config = {
    federation: {
      shared_dir_enabled: true,
      sensitivity,
      shared_dir_path: '~/.orchestray/shared',
    },
  };
  fs.writeFileSync(
    path.join(projectDir, '.orchestray', 'config.json'),
    JSON.stringify(config),
    'utf8'
  );

  // Redirect shared writes to an isolated temp dir.
  const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-shared-test-'));

  return { projectDir, sharedDir };
}

/** Write a valid pattern file to the tmp project. Returns the slug. */
function writePattern(projectDir, slug, { frontmatter = {}, body = '' } = {}) {
  const fm = Object.assign(
    {
      name: slug,
      category: 'decomposition',
      confidence: 0.8,
      description: 'Test pattern',
    },
    frontmatter
  );

  const fmLines = Object.entries(fm)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}: ${v}`;
      return `${k}: ${v}`;
    })
    .join('\n');

  const content = `---\n${fmLines}\n---\n\n${body}\n`;
  fs.writeFileSync(
    path.join(projectDir, '.orchestray', 'patterns', slug + '.md'),
    content,
    'utf8'
  );
  return slug;
}

/**
 * Run promotePattern with full isolation:
 *   - Sets ORCHESTRAY_TEST_SHARED_DIR to sharedDir
 *   - Passes cwd: projectDir
 *   - Restores env after call
 */
async function runPromote(slug, projectDir, sharedDir, extraOpts = {}) {
  const prev = process.env.ORCHESTRAY_TEST_SHARED_DIR;
  process.env.ORCHESTRAY_TEST_SHARED_DIR = sharedDir;
  try {
    return await promotePattern(slug, { cwd: projectDir, ...extraOpts });
  } finally {
    if (prev === undefined) {
      delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
    } else {
      process.env.ORCHESTRAY_TEST_SHARED_DIR = prev;
    }
  }
}

/** Clean up a list of tmp directories. */
function cleanup(...dirs) {
  for (const d of dirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

// ---------------------------------------------------------------------------
// 1. Anthropic key regex
// ---------------------------------------------------------------------------

describe('1. Anthropic key regex', () => {

  test('real-looking Anthropic key in Evidence section is REJECTED at stage 3', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = `## Context\nSome context.\n\n## Evidence\nFound key: sk-ant-api03-abc123def456_real-looking-key\n`;
      writePattern(projectDir, 'ant-key-positive', { body });
      const result = await runPromote('ant-key-positive', projectDir, sharedDir);
      assert.equal(result.ok, false, 'should reject Anthropic key');
      assert.equal(result.stage, 'secret-scan');
      assert.ok(result.error.includes('Anthropic API key'), `error should name the kind, got: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('Anthropic key inside a fenced code block is REJECTED (no code-block exemption)', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\n```\nconfig_key=sk-ant-api03-abc123def456_real-looking-key\n```\n';
      writePattern(projectDir, 'ant-key-fenced', { body });
      const result = await runPromote('ant-key-fenced', projectDir, sharedDir);
      assert.equal(result.ok, false, 'fenced code block should not exempt secrets');
      assert.equal(result.stage, 'secret-scan');
      assert.ok(result.error.includes('Anthropic API key'));
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('Anthropic key inside a bash fenced block is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\n```bash\nexport ANT_KEY=sk-ant-api03-abc123def456_real-looking-key\n```\n';
      writePattern(projectDir, 'ant-key-bash', { body });
      const result = await runPromote('ant-key-bash', projectDir, sharedDir);
      assert.equal(result.ok, false, 'bash block should not exempt secrets');
      assert.equal(result.stage, 'secret-scan');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('Anthropic key inside HTML comment is REJECTED (comments do not bypass)', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\n<!-- key: sk-ant-api03-abc123def456_real-looking-key -->\n';
      writePattern(projectDir, 'ant-key-comment', { body });
      const result = await runPromote('ant-key-comment', projectDir, sharedDir);
      assert.equal(result.ok, false, 'HTML comment should not exempt secrets');
      assert.equal(result.stage, 'secret-scan');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('escape hatch on same line as Anthropic key allows PROMOTION', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\nsk-ant-api03-abc123def456_real-looking-key <!-- secret-scan: allow -->\n';
      writePattern(projectDir, 'ant-key-escaped', { body });
      const result = await runPromote('ant-key-escaped', projectDir, sharedDir);
      assert.equal(result.ok, true, `escape hatch should allow promotion, got error: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('sk-ant- prefix without long suffix is NOT flagged (too short to match)', async () => {
    // The regex requires {10,} after sk-ant- so very short suffixes do not match.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nMention of sk-ant- prefix only (9 chars: sk-ant-abc) is fine.\n';
      writePattern(projectDir, 'ant-key-too-short', { body });
      const result = await runPromote('ant-key-too-short', projectDir, sharedDir);
      // "sk-ant-abc" has 3 chars after "sk-ant-" — below the 10-char threshold.
      assert.equal(result.ok, true, 'too-short sk-ant- suffix should not be flagged');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 2. OpenAI project key regex
// ---------------------------------------------------------------------------

describe('2. OpenAI project key regex', () => {

  test('real-looking OpenAI project key is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\nAPI key used: sk-proj-abc123XYZ789abc123XYZ789\n';
      writePattern(projectDir, 'oai-key-positive', { body });
      const result = await runPromote('oai-key-positive', projectDir, sharedDir);
      assert.equal(result.ok, false, 'should reject OpenAI project key');
      assert.equal(result.stage, 'secret-scan');
      assert.ok(result.error.includes('OpenAI project key'), `error should name the kind, got: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('sk-proj- with suffix shorter than 10 chars is NOT flagged', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      // "sk-proj-abc" has 3 chars after "sk-proj-" — below the 10-char threshold.
      const body = '## Context\nSee sk-proj-abc in the docs (not a real key).\n';
      writePattern(projectDir, 'oai-key-too-short', { body });
      const result = await runPromote('oai-key-too-short', projectDir, sharedDir);
      assert.equal(result.ok, true, 'too-short sk-proj- suffix should not be flagged');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('escape hatch on same line as OpenAI key allows PROMOTION', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\nsk-proj-abc123XYZ789abc123XYZ789 <!-- secret-scan: allow -->\n';
      writePattern(projectDir, 'oai-key-escaped', { body });
      const result = await runPromote('oai-key-escaped', projectDir, sharedDir);
      assert.equal(result.ok, true, `escape hatch should allow promotion, got error: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 3. Hex-key entropy check
// ---------------------------------------------------------------------------

describe('3. Hex-key entropy check', () => {

  test('high-entropy 64-char hex string is REJECTED', async () => {
    // Constructed to have maximum hex entropy (all 16 hex chars cycling, entropy = 4.0).
    // Important: placed standalone (not prefixed with "key:") so it goes to the hex
    // entropy checker rather than the generic API key pattern. Both would reject it,
    // but this test specifically exercises the hex entropy path.
    const highEntropyHex = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      // "value: <hex>" — "value" is not in the generic key/token/secret/... list,
      // so this line reaches the hex entropy checker rather than the generic pattern.
      const body = `## Evidence\nvalue: ${highEntropyHex}\n`;
      writePattern(projectDir, 'hex-entropy-positive', { body });
      const result = await runPromote('hex-entropy-positive', projectDir, sharedDir);
      assert.equal(result.ok, false, 'high-entropy hex should be rejected');
      assert.equal(result.stage, 'secret-scan');
      assert.ok(
        result.error.includes('hex-encoded secret') || result.error.includes('high entropy'),
        `error should mention entropy/hex, got: ${result.error}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('commit SHA (40 hex chars, high entropy) trips the hex entropy gate — known false positive', async () => {
    // IMPORTANT: Commit SHAs are long hex strings and WILL match the hex entropy
    // gate. This is the INTENDED behavior per B1's design comments. Users must
    // explicitly use the escape hatch for known false positives like SHAs.
    // B1 documented this in shared-promote.js line 88:
    //   "Commit SHAs are also long hex strings and will match — the escape hatch
    //    handles known false positives like SHAs."
    const commitSha = 'a1b2c3d4e5f6789012345678901234567890abcd'; // 40-char hex
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = `## Evidence\nApplied at commit ${commitSha}\n`;
      writePattern(projectDir, 'commit-sha-rejected', { body });
      const result = await runPromote('commit-sha-rejected', projectDir, sharedDir);
      // This SHOULD be rejected — commit SHAs trip the entropy gate.
      // This is the known false positive behavior. The escape hatch is the fix.
      assert.equal(result.ok, false, 'commit SHA should trip hex entropy gate (known false positive — use escape hatch)');
      assert.equal(result.stage, 'secret-scan');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('escape hatch allows commit SHA through (workaround for false positive)', async () => {
    const commitSha = 'a1b2c3d4e5f6789012345678901234567890abcd';
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = `## Evidence\nApplied at commit ${commitSha} <!-- secret-scan: allow -->\n`;
      writePattern(projectDir, 'commit-sha-escaped', { body });
      const result = await runPromote('commit-sha-escaped', projectDir, sharedDir);
      assert.equal(result.ok, true, `escape hatch should allow commit SHA through, got error: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('8-char hex string (below 32-char threshold) is NOT flagged', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nShort hex ref: a1b2c3d4\n';
      writePattern(projectDir, 'hex-too-short', { body });
      const result = await runPromote('hex-too-short', projectDir, sharedDir);
      assert.equal(result.ok, true, '8-char hex is below the 32-char threshold and should not be flagged');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('32+ char non-hex high-entropy string is NOT flagged by the hex entropy regex', async () => {
    // Mixed-case alphanumerics are NOT pure hex — the hex regex [0-9a-fA-F]{32,}
    // won't match if it contains non-hex chars like g-z. This tests the hex-ONLY
    // nature of the check. (The generic API key pattern may still catch it if
    // prefixed by key/token/secret; we use a standalone placement here.)
    const nonHexHighEntropy = 'xQzR7mNpKvLsWtYuHjFgCbAeIdOqSwPx'; // 32 chars, not hex
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = `## Context\nSome value: ${nonHexHighEntropy}\n`;
      writePattern(projectDir, 'non-hex-high-entropy', { body });
      const result = await runPromote('non-hex-high-entropy', projectDir, sharedDir);
      assert.equal(result.ok, true, 'non-hex string should not be flagged by the hex entropy regex');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('low-entropy hex string (all same digit, 32+ chars) is NOT flagged', async () => {
    const lowEntropyHex = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 'a's, entropy ≈ 0
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = `## Context\nFiller: ${lowEntropyHex}\n`;
      writePattern(projectDir, 'hex-low-entropy', { body });
      const result = await runPromote('hex-low-entropy', projectDir, sharedDir);
      assert.equal(result.ok, true, 'low-entropy hex (all same char) should not be flagged');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 4. AWS access key
// ---------------------------------------------------------------------------

describe('4. AWS access key (AKIA...)', () => {

  test('AKIA followed by 16 uppercase alphanumeric chars is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\naws_access_key_id: AKIAIOSFODNN7EXAMPLE\n';
      writePattern(projectDir, 'aws-key-positive', { body });
      const result = await runPromote('aws-key-positive', projectDir, sharedDir);
      assert.equal(result.ok, false, 'AWS access key ID should be rejected');
      assert.equal(result.stage, 'secret-scan');
      assert.ok(result.error.includes('AWS access key ID'), `error should name the kind, got: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('AKIA with only 15 chars after (below 16 threshold) is NOT flagged', async () => {
    // AKIA[0-9A-Z]{16} — needs exactly 16 chars after AKIA.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nCode: AKIA123456789AB (15 chars — not a real key)\n';
      writePattern(projectDir, 'aws-key-too-short', { body });
      const result = await runPromote('aws-key-too-short', projectDir, sharedDir);
      assert.equal(result.ok, true, 'AKIA with 15-char suffix should not be flagged');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('escape hatch on same line as AWS key allows PROMOTION', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Evidence\nAKIAIOSFODNN7EXAMPLE <!-- secret-scan: allow -->\n';
      writePattern(projectDir, 'aws-key-escaped', { body });
      const result = await runPromote('aws-key-escaped', projectDir, sharedDir);
      assert.equal(result.ok, true, `escape hatch should allow AWS key through, got error: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 5. Path / identity strip (stage 4)
// ---------------------------------------------------------------------------

describe('5. Path/identity strip', () => {

  test('/home/<user>/ path is stripped from sanitized output', async () => {
    // Path strip is two-pass: first /home/<user>/ → <home>/, then any
    // remaining absolute path → <path>. Final: "<home><path>".
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nSource: /home/palgin/orchestray/bin/something.js\n';
      writePattern(projectDir, 'path-home-unix', { body });
      const result = await runPromote('path-home-unix', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true, `should promote successfully, got: ${result.error}`);
      assert.ok(
        !result.sanitizedBody.includes('/home/palgin/'),
        'home path should be stripped from sanitized body'
      );
      // After two-pass strip: <home>/ (step 1) then <path> (step 4) absorbs the rest.
      // Final: "<home><path>" with no /home/palgin/ present.
      assert.ok(
        result.sanitizedBody.includes('<home>'),
        `body should contain <home> marker, got: ${result.sanitizedBody}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('/Users/<user>/ macOS path is stripped from sanitized output', async () => {
    // Same two-pass behavior as unix: /Users/palgin/ → <home>/ then residual
    // absolute path → <path>. Final: "<home><path>".
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nFile at /Users/palgin/project/file.js\n';
      writePattern(projectDir, 'path-home-mac', { body });
      const result = await runPromote('path-home-mac', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(!result.sanitizedBody.includes('/Users/palgin/'), 'macOS home path should be stripped');
      assert.ok(result.sanitizedBody.includes('<home>'), `body should contain <home> marker, got: ${result.sanitizedBody}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('Windows C:\\Users\\<user>\\ path is stripped', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nPath: C:\\Users\\palgin\\project\\file.js\n';
      writePattern(projectDir, 'path-windows', { body });
      const result = await runPromote('path-windows', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        !result.sanitizedBody.includes('C:\\Users\\palgin\\'),
        'Windows home path should be stripped'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('git remote SSH URL is stripped to <git-remote>', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nCloned from git@github.com:palgin/orchestray.git\n';
      writePattern(projectDir, 'path-git-remote', { body });
      const result = await runPromote('path-git-remote', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        !result.sanitizedBody.includes('palgin/orchestray'),
        'git remote should be stripped'
      );
      assert.ok(
        result.sanitizedBody.includes('<git-remote>'),
        `body should contain <git-remote>, got: ${result.sanitizedBody}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('git remote HTTPS URL is stripped to <git-remote>', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nRepo: https://github.com/palgin/orchestray\n';
      writePattern(projectDir, 'path-git-https', { body });
      const result = await runPromote('path-git-https', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(!result.sanitizedBody.includes('palgin/orchestray'));
      assert.ok(result.sanitizedBody.includes('<git-remote>'));
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('/opt/shared/something (non-user path) is stripped to <path>', async () => {
    // B1 strips all absolute paths that look like real paths (contain 2+ segments).
    // The implementation replaces /opt/shared/something with <path>.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nShared lib at /opt/shared/something\n';
      writePattern(projectDir, 'path-opt', { body });
      const result = await runPromote('path-opt', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
          // The regex: /(?<!\w)(\/[a-zA-Z0-9_.~-]+(?:\/[a-zA-Z0-9_.~-]+)+)/g
      // /opt/shared/something matches this pattern.
      assert.ok(
        !result.sanitizedBody.includes('/opt/shared/something'),
        'non-user absolute path with multiple segments should be stripped'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('path preceded by ( bracket is still stripped (lookbehind edge case)', async () => {
    // B1 uses a (?<!\w) negative lookbehind. '(' is not a word char, so the
    // path after '(' should still be matched and stripped.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nSee error at (/run/user/1000/something.sock)\n';
      writePattern(projectDir, 'path-bracket-prefix', { body });
      const result = await runPromote('path-bracket-prefix', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        !result.sanitizedBody.includes('/run/user/1000/something.sock'),
        'path after ( bracket should be stripped (lookbehind does not exclude non-word chars)'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('path preceded by [ bracket is still stripped', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\nError: [/var/log/app/error.log] not found\n';
      writePattern(projectDir, 'path-square-bracket', { body });
      const result = await runPromote('path-square-bracket', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(!result.sanitizedBody.includes('/var/log/app/error.log'));
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 6. Prompt-injection defense (H1/H2 downgrade)
// ---------------------------------------------------------------------------

describe('6. Prompt-injection defense (H1/H2 downgrade)', () => {

  test('# Title (H1) in body is downgraded to (header: Title)', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '# Injected Title\n\nSome content.\n';
      writePattern(projectDir, 'injection-h1', { body });
      const result = await runPromote('injection-h1', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        !result.sanitizedBody.includes('# Injected Title'),
        'H1 should be downgraded'
      );
      assert.ok(
        result.sanitizedBody.includes('(header: Injected Title)'),
        `H1 should become (header: ...), got: ${result.sanitizedBody}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('## Section (H2) in body is downgraded to (header: Section)', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\n\nSome text.\n## Approach\n\nMore.\n';
      writePattern(projectDir, 'injection-h2', { body });
      const result = await runPromote('injection-h2', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(!result.sanitizedBody.includes('## Context'), 'H2 Context should be downgraded');
      assert.ok(!result.sanitizedBody.includes('## Approach'), 'H2 Approach should be downgraded');
      assert.ok(result.sanitizedBody.includes('(header: Context)'));
      assert.ok(result.sanitizedBody.includes('(header: Approach)'));
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('### Subsection (H3) is preserved intact', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\n\n### Deep Subsection\n\nContent.\n';
      writePattern(projectDir, 'injection-h3-preserved', { body });
      const result = await runPromote('injection-h3-preserved', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        result.sanitizedBody.includes('### Deep Subsection'),
        `H3 should be preserved, got: ${result.sanitizedBody}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('#### H4 and deeper are preserved intact', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '#### Deep Level\n\nContent.\n';
      writePattern(projectDir, 'injection-h4-preserved', { body });
      const result = await runPromote('injection-h4-preserved', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(result.sanitizedBody.includes('#### Deep Level'), 'H4 should be preserved');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('inline # in prose ("issue #42") is NOT downgraded', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\n\nFixes issue #42 and ticket #100.\n';
      writePattern(projectDir, 'injection-inline-hash', { body });
      const result = await runPromote('injection-inline-hash', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        result.sanitizedBody.includes('issue #42'),
        'inline # in prose should not be downgraded'
      );
      assert.ok(result.sanitizedBody.includes('ticket #100'));
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('`#define` in backtick inline code is NOT downgraded', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '## Context\n\nUse `#define MAX 100` in C.\n';
      writePattern(projectDir, 'injection-backtick-hash', { body });
      const result = await runPromote('injection-backtick-hash', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        result.sanitizedBody.includes('`#define MAX 100`'),
        'backtick inline code with # should not be downgraded'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('YAML frontmatter --- delimiters are not affected by H1/H2 downgrade', async () => {
    // The body passed to _downgradeTopHeaders starts AFTER the closing ---.
    // Frontmatter lines like "---" must never be transformed.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'injection-frontmatter-safe', {
        body: '## Context\n\nTest body.\n',
      });
      const result = await runPromote('injection-frontmatter-safe', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      // Read the output file to check frontmatter is intact — use destPath from dry run
      // (dry run reports destPath but does not write). Check sanitizedBody only starts
      // with the body content, not the frontmatter block.
      assert.ok(
        !result.sanitizedBody.startsWith('---'),
        'sanitizedBody should be the body only, not include frontmatter --- lines'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('bare # without a space (not CommonMark heading) is NOT downgraded', async () => {
    // Per CommonMark, "# " (with space) is a heading. Bare "#text" is not.
    // B1's regex: /^(#{1,2})(?!#) +(.+)$/gm requires a space after the hashes.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '#notaheading\n\nSome content.\n';
      writePattern(projectDir, 'injection-bare-hash', { body });
      const result = await runPromote('injection-bare-hash', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.ok(
        result.sanitizedBody.includes('#notaheading'),
        'bare # without space is not a heading and should be preserved'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 7. Size cap (stage 6)
// ---------------------------------------------------------------------------

describe('7. Size cap', () => {

  test('pattern body at 7 KB is PROMOTED (under the 8 KB limit)', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = 'x'.repeat(7 * 1024);
      writePattern(projectDir, 'size-under-cap', { body });
      const result = await runPromote('size-under-cap', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true, `7 KB body should be under the cap, got: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('pattern body that makes parsed body exactly 8192 bytes is PROMOTED (at the boundary, <= check)', async () => {
    // At the boundary (sizeBytes <= SIZE_CAP_BYTES) is allowed.
    //
    // IMPORTANT: writePattern creates a file whose parsed body is:
    //   "\n\n" + body_text + "\n"  (3 extra bytes from the frontmatter closing newline + trailing newline)
    // So to land the parsed body AT exactly 8192 bytes, the body_text must be
    // 8192 - 3 = 8189 bytes.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = 'x'.repeat(8189); // parsed body = "\n\n" + 8189 x's + "\n" = 8192 bytes
      writePattern(projectDir, 'size-at-cap', { body });
      const result = await runPromote('size-at-cap', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true, `body at exactly 8192 bytes (parsed) should pass (<= cap), got: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('pattern body that makes parsed body 8193 bytes is REJECTED', async () => {
    // 8190 body_text bytes → "\n\n" + 8190 + "\n" = 8193 bytes (1 over cap).
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = 'x'.repeat(8190);
      writePattern(projectDir, 'size-one-over', { body });
      const result = await runPromote('size-one-over', projectDir, sharedDir);
      assert.equal(result.ok, false, '8193-byte parsed body should be rejected');
      assert.equal(result.stage, 'size-cap');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('oversized body error message includes actual size and recovery action', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      // 8704 bytes ≈ 8.5 KB
      const body = 'x'.repeat(8704);
      writePattern(projectDir, 'size-8pt5', { body });
      const result = await runPromote('size-8pt5', projectDir, sharedDir);
      assert.equal(result.ok, false);
      // Error must mention the actual size.
      assert.ok(
        /8\.\d+KB/.test(result.error) || /8\.5/.test(result.error),
        `error should include actual size, got: ${result.error}`
      );
      // Error must mention the limit.
      assert.ok(
        result.error.includes('8KB') || result.error.includes('8 KB'),
        `error should include the 8KB limit, got: ${result.error}`
      );
      // Error must include a recovery action.
      assert.ok(
        result.error.includes('trim') || result.error.includes('split') || result.error.includes('reduce'),
        `error should include recovery advice, got: ${result.error}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 8. Schema validate (stage 7)
// ---------------------------------------------------------------------------

describe('8. Schema validation (frontmatter)', () => {

  test('frontmatter missing "category" field is REJECTED with field-specific error', async () => {
    // Must write the file directly — the writePattern() helper injects default
    // values for all required fields, which would mask the missing-field condition.
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const content = '---\nname: schema-no-category\nconfidence: 0.8\ndescription: Missing category\n---\n\n## Context\nTest.\n';
      fs.writeFileSync(path.join(projectDir, '.orchestray', 'patterns', 'schema-no-category.md'), content, 'utf8');
      const result = await runPromote('schema-no-category', projectDir, sharedDir);
      assert.equal(result.ok, false, 'missing category should be rejected');
      assert.equal(result.stage, 'schema-validate');
      assert.ok(
        result.error.includes('category'),
        `error should mention 'category', got: ${result.error}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('frontmatter missing "name" field is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const content = '---\ncategory: decomposition\nconfidence: 0.8\ndescription: Missing name\n---\n\n## Context\nTest.\n';
      fs.writeFileSync(path.join(projectDir, '.orchestray', 'patterns', 'schema-no-name.md'), content, 'utf8');
      const result = await runPromote('schema-no-name', projectDir, sharedDir);
      assert.equal(result.ok, false);
      assert.equal(result.stage, 'schema-validate');
      assert.ok(result.error.includes('name'), `error should mention 'name', got: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('frontmatter missing "description" field is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const content = '---\nname: schema-no-desc\ncategory: decomposition\nconfidence: 0.8\n---\n\n## Context\nTest.\n';
      fs.writeFileSync(path.join(projectDir, '.orchestray', 'patterns', 'schema-no-desc.md'), content, 'utf8');
      const result = await runPromote('schema-no-desc', projectDir, sharedDir);
      assert.equal(result.ok, false);
      assert.equal(result.stage, 'schema-validate');
      assert.ok(result.error.includes('description'), `error should mention 'description', got: ${result.error}`);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('frontmatter with invalid category enum value is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'schema-bad-category', {
        frontmatter: {
          name: 'schema-bad-category',
          category: 'invented-category',
          confidence: 0.8,
          description: 'Bad category value',
        },
        body: '## Context\nTest.\n',
      });
      const result = await runPromote('schema-bad-category', projectDir, sharedDir);
      assert.equal(result.ok, false, 'invalid category should be rejected');
      assert.equal(result.stage, 'schema-validate');
      assert.ok(
        result.error.includes('invented-category') || result.error.includes('category'),
        `error should mention the bad value or field, got: ${result.error}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('confidence value above 1 is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'schema-confidence-high', {
        frontmatter: {
          name: 'schema-confidence-high',
          category: 'decomposition',
          confidence: 1.5,
          description: 'Confidence too high',
        },
        body: '## Context\nTest.\n',
      });
      const result = await runPromote('schema-confidence-high', projectDir, sharedDir);
      assert.equal(result.ok, false, 'confidence > 1 should be rejected');
      assert.equal(result.stage, 'schema-validate');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('confidence value below 0 is REJECTED', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'schema-confidence-neg', {
        frontmatter: {
          name: 'schema-confidence-neg',
          category: 'decomposition',
          confidence: -0.1,
          description: 'Negative confidence',
        },
        body: '## Context\nTest.\n',
      });
      const result = await runPromote('schema-confidence-neg', projectDir, sharedDir);
      assert.equal(result.ok, false, 'confidence < 0 should be rejected');
      assert.equal(result.stage, 'schema-validate');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('complete valid frontmatter across all allowed category values is PROMOTED', async () => {
    const validCategories = ['decomposition', 'routing', 'specialization', 'anti-pattern', 'design-preference'];
    for (const category of validCategories) {
      const { projectDir, sharedDir } = makeTmpProject();
      try {
        const slug = `schema-valid-${category}`;
        writePattern(projectDir, slug, {
          frontmatter: {
            name: slug,
            category,
            confidence: 0.75,
            description: `Valid pattern for category ${category}`,
          },
          body: '## Context\nTest.\n',
        });
        const result = await runPromote(slug, projectDir, sharedDir, { dryRun: true });
        assert.equal(
          result.ok,
          true,
          `category '${category}' should be valid, got error: ${result.error}`
        );
      } finally {
        cleanup(projectDir, sharedDir);
      }
    }
  });

});

// ---------------------------------------------------------------------------
// 9. Sensitivity gate (stage 2)
// ---------------------------------------------------------------------------

describe('9. Sensitivity gate', () => {

  test('project with sensitivity "private" (default) REJECTS promotion', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'private' });
    try {
      writePattern(projectDir, 'sensitivity-private', {
        body: '## Context\nTest.\n',
      });
      const result = await runPromote('sensitivity-private', projectDir, sharedDir);
      assert.equal(result.ok, false, 'private sensitivity should block promotion');
      assert.equal(result.stage, 'sensitivity');
      assert.ok(
        result.error.includes('private') || result.error.includes('sensitivity'),
        `error should mention sensitivity/private, got: ${result.error}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('project with no config.json uses private default and REJECTS promotion', async () => {
    // When config.json is absent, loadFederationConfig returns DEFAULT_FEDERATION
    // with sensitivity: 'private'. This tests the fail-open default.
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-promote-test-'));
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-shared-test-'));
    try {
      fs.mkdirSync(path.join(projectDir, '.orchestray', 'patterns'), { recursive: true });
      // No config.json written — defaults to private.
      writePattern(projectDir, 'sensitivity-no-config', {
        body: '## Context\nTest.\n',
      });
      const result = await runPromote('sensitivity-no-config', projectDir, sharedDir);
      assert.equal(result.ok, false, 'missing config should default to private and reject');
      assert.equal(result.stage, 'sensitivity');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('project with sensitivity "shareable" PASSES stage 2', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'shareable' });
    try {
      writePattern(projectDir, 'sensitivity-shareable', {
        body: '## Context\nTest.\n',
      });
      const result = await runPromote('sensitivity-shareable', projectDir, sharedDir, { dryRun: true });
      // Should pass stage 2 (may still fail later stages — dryRun avoids write)
      assert.notEqual(result.stage, 'sensitivity', 'shareable project should pass stage 2');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// 10. Atomic write (stage write)
// ---------------------------------------------------------------------------

describe('10. Atomic write', () => {

  test('successful promotion writes the file to ORCHESTRAY_TEST_SHARED_DIR/patterns/{slug}.md', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'atomic-write-success', {
        body: '## Context\nShould be written.\n',
      });
      const result = await runPromote('atomic-write-success', projectDir, sharedDir);
      assert.equal(result.ok, true, `promote should succeed, got: ${result.error}`);

      const destFile = path.join(sharedDir, 'patterns', 'atomic-write-success.md');
      assert.ok(
        fs.existsSync(destFile),
        `destination file should exist at ${destFile}`
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('the .tmp file is gone after a successful atomic write', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'atomic-write-no-tmp', {
        body: '## Context\nShould clean up tmp.\n',
      });
      await runPromote('atomic-write-no-tmp', projectDir, sharedDir);

      const tmpFile = path.join(sharedDir, 'patterns', 'atomic-write-no-tmp.md.tmp');
      assert.equal(
        fs.existsSync(tmpFile),
        false,
        '.tmp file should be removed after successful atomic rename'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('promoted file contains sanitized content (home path stripped, headers downgraded)', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const body = '# Title\n\n## Context\n\nFound at /home/palgin/orchestray/bin/x.js\n';
      writePattern(projectDir, 'atomic-write-content', { body });
      const result = await runPromote('atomic-write-content', projectDir, sharedDir);
      assert.equal(result.ok, true);

      const content = fs.readFileSync(
        path.join(sharedDir, 'patterns', 'atomic-write-content.md'),
        'utf8'
      );
      assert.ok(!content.includes('/home/palgin/'), 'promoted file should not contain home path');
      assert.ok(!content.includes('# Title'), 'promoted file should not contain raw H1');
      assert.ok(content.includes('(header: Title)'), 'promoted file should contain downgraded H1');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('dryRun=true does not write any file', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'atomic-dry-run', {
        body: '## Context\nDry run test.\n',
      });
      const result = await runPromote('atomic-dry-run', projectDir, sharedDir, { dryRun: true });
      assert.equal(result.ok, true);
      assert.equal(result.dryRun, true);

      const destFile = path.join(sharedDir, 'patterns', 'atomic-dry-run.md');
      assert.equal(
        fs.existsSync(destFile),
        false,
        'dryRun should not write the file'
      );
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('promoted file frontmatter contains origin=shared and promoted_at', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'atomic-write-fm', {
        body: '## Context\nTest frontmatter.\n',
      });
      await runPromote('atomic-write-fm', projectDir, sharedDir);

      const content = fs.readFileSync(
        path.join(sharedDir, 'patterns', 'atomic-write-fm.md'),
        'utf8'
      );
      assert.ok(content.includes('origin: shared'), 'promoted file should have origin: shared');
      assert.ok(content.includes('promoted_at:'), 'promoted file should have promoted_at field');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('project-local metadata fields (created_from, last_applied, times_applied) are stripped from promoted frontmatter', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'atomic-write-strip-local', {
        frontmatter: {
          name: 'atomic-write-strip-local',
          category: 'decomposition',
          confidence: 0.8,
          description: 'Strip local fields',
          created_from: 'orch-abc123',
          last_applied: '2026-01-01T00:00:00.000Z',
          times_applied: 5,
        },
        body: '## Context\nTest.\n',
      });
      await runPromote('atomic-write-strip-local', projectDir, sharedDir);

      const content = fs.readFileSync(
        path.join(sharedDir, 'patterns', 'atomic-write-strip-local.md'),
        'utf8'
      );
      assert.ok(!content.includes('created_from'), 'created_from should be stripped');
      assert.ok(!content.includes('times_applied'), 'times_applied should be stripped');
      // last_applied is a known field name — check it's not in promoted copy
      // Note: 'last_applied' might appear in body text; check frontmatter only.
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        assert.ok(!fmMatch[1].includes('last_applied'), 'last_applied should be stripped from frontmatter');
      }
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('real ~/.orchestray/shared/patterns/ is untouched after test run', async () => {
    // Paranoia check: the env override must fully redirect writes.
    const realSharedDir = path.join(os.homedir(), '.orchestray', 'shared', 'patterns');
    const beforeFiles = fs.existsSync(realSharedDir)
      ? fs.readdirSync(realSharedDir)
      : [];

    const { projectDir, sharedDir } = makeTmpProject();
    try {
      writePattern(projectDir, 'paranoia-no-real-write', { body: '## Context\nTest.\n' });
      await runPromote('paranoia-no-real-write', projectDir, sharedDir);
    } finally {
      cleanup(projectDir, sharedDir);
    }

    const afterFiles = fs.existsSync(realSharedDir)
      ? fs.readdirSync(realSharedDir)
      : [];
    assert.deepEqual(
      afterFiles.sort(),
      beforeFiles.sort(),
      'real ~/.orchestray/shared/patterns/ must not be modified by tests'
    );
  });

});

// ---------------------------------------------------------------------------
// 11. Fuzz harness (deterministic, 100 iterations)
// ---------------------------------------------------------------------------

describe('11. Fuzz harness (deterministic PRNG, 100 iterations)', () => {

  /**
   * Simple seeded LCG PRNG (Numerical Recipes constants) for determinism.
   * Returns values in [0, 1).
   */
  function makePrng(seed) {
    let state = seed >>> 0;
    return function rand() {
      // LCG: Knuth's multiplicative congruential
      state = Math.imul(1664525, state) + 1013904223;
      state = state >>> 0;
      return state / 0x100000000;
    };
  }

  /** Build a random-ish but clearly valid Anthropic-key-shaped string. */
  function makeAntKey(rand) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789_-';
    let s = 'sk-ant-api03-';
    for (let i = 0; i < 20; i++) {
      s += chars[Math.floor(rand() * chars.length)];
    }
    return s;
  }

  /** Build a random-ish OpenAI-key-shaped string. */
  function makeOaiKey(rand) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789_-';
    let s = 'sk-proj-';
    for (let i = 0; i < 20; i++) {
      s += chars[Math.floor(rand() * chars.length)];
    }
    return s;
  }

  /** Build a high-entropy hex string (64 chars). */
  function makeHighEntropyHex(rand) {
    // Use crypto.randomBytes seeded via the prng value to get diverse hex.
    // We deterministically pick from a shuffled hex palette to ensure entropy.
    const palette = '0123456789abcdef';
    let s = '';
    // Build 64 chars cycling through all 16 hex chars to ensure entropy > 3.8
    for (let i = 0; i < 64; i++) {
      s += palette[Math.floor(rand() * 16)];
    }
    return s;
  }

  /** Build a benign body with no real secrets. */
  function makeBenignBody(rand, n) {
    const templates = [
      `## Context\nPattern number ${n}. No secrets here.\n\n## Approach\nUse parallel execution.\n`,
      `## Context\nRefactor approach ${n}. Standard text only.\n`,
      `## Context\nRouting strategy ${n}. Uses haiku for fast tasks.\n`,
      `## Context\nDecomposition pattern ${n}. Splits work into subtasks.\n`,
    ];
    return templates[Math.floor(rand() * templates.length)];
  }

  /** Inject a real secret at a random line position in the body. */
  function injectSecret(body, secret, rand) {
    const lines = body.split('\n');
    const pos = Math.floor(rand() * (lines.length + 1));
    lines.splice(pos, 0, secret);
    return lines.join('\n');
  }

  test('100 patterns: real secrets always rejected, benign decoys always promoted', async () => {
    const rand = makePrng(0xDEADBEEF);
    const ITERATIONS = 100;

    // Split: first 50 have a real planted secret, next 50 are benign.
    const secretCount = 50;
    const benignCount = 50;

    // Track results.
    let secretsRejected = 0;
    let benignPromoted = 0;
    const secretFailures = [];
    const benignFailures = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const { projectDir, sharedDir } = makeTmpProject();
      try {
        const isSecret = i < secretCount;
        const slug = `fuzz-${isSecret ? 'secret' : 'benign'}-${i}`;
        let body = makeBenignBody(rand, i);

        if (isSecret) {
          // Plant one of three secret types, rotating.
          let secret;
          const secretType = i % 3;
          if (secretType === 0) secret = makeAntKey(rand);
          else if (secretType === 1) secret = makeOaiKey(rand);
          else secret = 'hex_key=' + makeHighEntropyHex(rand);
          body = injectSecret(body, secret, rand);
        }

        writePattern(projectDir, slug, { body });
        const result = await runPromote(slug, projectDir, sharedDir, {
          dryRun: !isSecret, // benign patterns use dryRun to avoid fs churn
        });

        if (isSecret) {
          if (result.ok === false) {
            secretsRejected++;
          } else {
            secretFailures.push({ i, slug, body: body.slice(0, 120) });
          }
        } else {
          if (result.ok === true) {
            benignPromoted++;
          } else {
            benignFailures.push({ i, slug, error: result.error });
          }
        }
      } finally {
        cleanup(projectDir, sharedDir);
      }
    }

    // All secrets must be caught.
    assert.equal(
      secretsRejected,
      secretCount,
      `Expected all ${secretCount} secrets to be rejected; ` +
      `${secretFailures.length} slipped through: ${JSON.stringify(secretFailures.slice(0, 3))}`
    );

    // All benign patterns must be promoted.
    assert.equal(
      benignPromoted,
      benignCount,
      `Expected all ${benignCount} benign patterns to be promoted; ` +
      `${benignFailures.length} false positives: ${JSON.stringify(benignFailures.slice(0, 3))}`
    );
  });

});

// ---------------------------------------------------------------------------
// Stage 1 edge cases (read / parse)
// ---------------------------------------------------------------------------

describe('Stage 1 edge cases (read / parse)', () => {

  test('pattern with no frontmatter is REJECTED at stage 1', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      // Write a file without any --- delimiters.
      fs.writeFileSync(
        path.join(projectDir, '.orchestray', 'patterns', 'no-fm.md'),
        'Just plain text, no frontmatter.\n',
        'utf8'
      );
      const result = await runPromote('no-fm', projectDir, sharedDir);
      assert.equal(result.ok, false, 'missing frontmatter should be rejected');
      assert.equal(result.stage, 'read');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('non-existent pattern slug is REJECTED at stage 1 with read error', async () => {
    const { projectDir, sharedDir } = makeTmpProject();
    try {
      const result = await runPromote('does-not-exist', projectDir, sharedDir);
      assert.equal(result.ok, false);
      assert.equal(result.stage, 'read');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

});

// ---------------------------------------------------------------------------
// preview mode (v2.1.2 Bundle F Item 3)
// ---------------------------------------------------------------------------

describe('preview mode', () => {

  test('(a) preview returns ok: true with full PreviewReport when sanitization succeeds', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'shareable' });
    try {
      const body = `## Context\nUseful context.\n\n## Approach\nDo this thing.\n`;
      writePattern(projectDir, 'preview-clean', {
        body,
        frontmatter: { created_from: 'orch-123', last_applied: '2026-01-01', times_applied: 3 },
      });
      const result = await runPromote('preview-clean', projectDir, sharedDir, { preview: true });

      assert.equal(result.ok, true, 'preview should return ok: true');
      assert.equal(result.destPath, '<not-written>', 'destPath must signal no write');
      assert.ok(result.preview, 'preview field must be present');

      const rpt = result.preview;
      assert.equal(rpt.slug, 'preview-clean');
      assert.equal(rpt.sensitivity_blocks_actual_share, false);
      assert.equal(rpt.blocking_stage, null);

      // Frontmatter diff
      assert.ok(rpt.frontmatter.removed.includes('created_from'), 'created_from should be in removed');
      assert.ok(rpt.frontmatter.removed.includes('last_applied'), 'last_applied should be in removed');
      assert.ok(rpt.frontmatter.removed.includes('times_applied'), 'times_applied should be in removed');
      assert.equal(rpt.frontmatter.added.origin, 'shared');
      assert.ok(rpt.frontmatter.added.promoted_from, 'promoted_from should be added');
      assert.ok(rpt.frontmatter.added.promoted_at, 'promoted_at should be added');

      // Body
      assert.ok(typeof rpt.body.size_bytes === 'number' && rpt.body.size_bytes > 0);
      assert.equal(rpt.body.size_limit_bytes, 8192);

      // Secrets
      assert.equal(rpt.secrets_scan.clean, true);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('(b) preview bypasses sensitivity gate when sensitivity is private', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'private' });
    try {
      writePattern(projectDir, 'preview-private', { body: 'Context.\n\nApproach.\n' });
      const result = await runPromote('preview-private', projectDir, sharedDir, { preview: true });

      assert.equal(result.ok, true, 'preview should succeed even with private sensitivity');
      assert.equal(result.preview.sensitivity_blocks_actual_share, true,
        'sensitivity_blocks_actual_share must be true');
      assert.equal(result.preview.blocking_stage, null,
        'sensitivity gate should not set blocking_stage in preview');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('(c) preview surfaces blocking stage when secret detected', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'shareable' });
    try {
      const antKey = 'sk-ant-api03-secret-key-value-here';
      writePattern(projectDir, 'preview-secret', {
        body: `## Context\nContext.\n\n## Evidence\nKey: ${antKey}\n`,
      });
      const result = await runPromote('preview-secret', projectDir, sharedDir, { preview: true });

      assert.equal(result.ok, true, 'preview returns ok: true even on blocking stage');
      assert.equal(result.preview.blocking_stage, 'secret-scan',
        'blocking_stage must identify the failed stage');
      assert.ok(result.preview.blocking_reason, 'blocking_reason must be set');
      assert.equal(result.preview.secrets_scan.clean, false);
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('(d) preview does NOT write to disk', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'shareable' });
    try {
      writePattern(projectDir, 'preview-no-write', { body: 'Context.\n\nApproach.\n' });
      const result = await runPromote('preview-no-write', projectDir, sharedDir, { preview: true });

      assert.equal(result.ok, true);
      const destPath = path.join(sharedDir, 'patterns', 'preview-no-write.md');
      assert.equal(fs.existsSync(destPath), false, 'preview must not write the pattern file');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('(e) preview does NOT append to promote-log.jsonl', async () => {
    const { projectDir, sharedDir } = makeTmpProject({ sensitivity: 'shareable' });
    try {
      writePattern(projectDir, 'preview-no-log', { body: 'Context.\n\nApproach.\n' });
      const logPath = path.join(sharedDir, 'meta', 'promote-log.jsonl');
      await runPromote('preview-no-log', projectDir, sharedDir, { preview: true });

      assert.equal(fs.existsSync(logPath), false, 'promote-log.jsonl must not exist after preview');
    } finally {
      cleanup(projectDir, sharedDir);
    }
  });

  test('_projectHash is exported and stable for the same input', () => {
    const h1 = _projectHash('/some/project/path');
    const h2 = _projectHash('/some/project/path');
    assert.equal(h1, h2, '_projectHash must be deterministic');
    assert.match(h1, /^[0-9a-f]{8}$/, '_projectHash must return 8 hex chars');
  });

});
