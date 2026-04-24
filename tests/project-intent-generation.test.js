#!/usr/bin/env node
'use strict';

/**
 * project-intent-generation.test.js — R-RCPT integration tests (v2.1.12)
 *
 * Exercises bin/_lib/project-intent.js and the injectProjectIntent() sibling
 * in bin/_lib/repo-map-delta.js.
 *
 * Test coverage map:
 *   AC-01  First-run generation: file created with 5 fields + locked header
 *   AC-02  Cache hit: mtime unchanged when both hashes match
 *   AC-03  Invalidation: README hash change triggers regeneration
 *   AC-04  Low-confidence: missing README → low_confidence:true, fields empty
 *   AC-04b Low-confidence: < 100 word README → low_confidence:true
 *   AC-05  Config gate: enable_goal_inference:false → skipped; enable_repo_map:false → skipped
 *   AC-06  Delegation injection: high-confidence → block returned; low-confidence → ''
 *   AC-08  Size gate: < 10 tracked files → stub with low_confidence:true
 *
 * Infrastructure choice: path (a) — mechanical extraction, no separate LLM turn.
 * Tests assert specific field values against fixture READMEs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

// Module under test
const {
  generateProjectIntent,
  readProjectIntent,
  isLowConfidence,
  _hash7,
  _parseIntentHeader,
  _wordCount,
} = require('../bin/_lib/project-intent');

const { injectProjectIntent } = require('../bin/_lib/repo-map-delta');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a minimal temp git repo with the given README content (or none).
 * Optionally writes package.json and CLAUDE.md.
 * Returns the project root path.
 *
 * NOTE: We init a real git repo so `git rev-parse HEAD` and `git ls-files`
 * work correctly in the module. We commit a controlled set of files so the
 * file count is predictable.
 *
 * @param {object} opts
 * @param {string|null} [opts.readmeContent]   null = don't create README
 * @param {object|null}  [opts.pkg]            package.json contents, null = skip
 * @param {string|null}  [opts.claudeMd]       CLAUDE.md content, null = skip
 * @param {number}       [opts.extraFiles]     Number of extra empty tracked files to add
 * @returns {string}
 */
function makeRepo(opts) {
  const {
    readmeContent = null,
    pkg = null,
    claudeMd = null,
    extraFiles = 0,
  } = opts || {};

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-rcpt-'));

  // Init git
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });

  // Track files
  const filesToAdd = [];

  if (readmeContent !== null) {
    fs.writeFileSync(path.join(dir, 'README.md'), readmeContent, 'utf8');
    filesToAdd.push('README.md');
  }

  if (pkg !== null) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');
    filesToAdd.push('package.json');
  }

  if (claudeMd !== null) {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), claudeMd, 'utf8');
    filesToAdd.push('CLAUDE.md');
  }

  // Add extra files to control file count
  for (let i = 0; i < extraFiles; i++) {
    const name = `file${i}.js`;
    fs.writeFileSync(path.join(dir, name), `// file ${i}\n`, 'utf8');
    filesToAdd.push(name);
  }

  // Commit everything if there are files
  if (filesToAdd.length > 0) {
    execSync(`git add ${filesToAdd.join(' ')}`, { cwd: dir });
    execSync('git commit -q -m "init"', { cwd: dir });
  } else {
    // Need at least one commit so git rev-parse HEAD works
    fs.writeFileSync(path.join(dir, '.gitkeep'), '', 'utf8');
    execSync('git add .gitkeep', { cwd: dir });
    execSync('git commit -q -m "init"', { cwd: dir });
  }

  return dir;
}

/**
 * Clean up a temp directory.
 * @param {string} dir
 */
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Read project-intent.md from a repo. Returns null if missing.
 * @param {string} dir
 * @returns {string|null}
 */
function readIntent(dir) {
  const p = path.join(dir, '.orchestray', 'kb', 'facts', 'project-intent.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

/**
 * Get mtime of project-intent.md. Returns 0 if missing.
 * @param {string} dir
 * @returns {number}
 */
function intentMtime(dir) {
  const p = path.join(dir, '.orchestray', 'kb', 'facts', 'project-intent.md');
  try { return fs.statSync(p).mtimeMs; } catch (_) { return 0; }
}

// A README that is clearly ≥ 100 words
const LONG_README = `# My Awesome Plugin

A Claude Code plugin that automatically detects complex tasks and orchestrates
multiple specialized AI agents to handle them. It assigns roles (architect,
developer, reviewer, PM, etc.), coordinates their work adaptively, and
produces fully audited output — all without the user needing to manually
configure or trigger anything.

## Core Value

Maximize task execution efficiency by automatically decomposing work across
specialized agents while preserving and reusing context, so developers get
better results faster than single-agent usage.

## Constraints

- Platform: Must work as a Claude Code plugin — cannot modify internals.
- Integration: Limited to Claude Code extension points only.
- Context: Must be context-efficient — the whole point is saving tokens.
- Persistence: State must survive session restarts using file-based storage.

## Tech Stack

Node.js, node:test for testing, no heavy external dependencies.
`;

// A README with fewer than 100 words
const SHORT_README = 'A small plugin. It does things.';

// ---------------------------------------------------------------------------
// Unit tests: internal helpers
// ---------------------------------------------------------------------------

describe('_hash7', () => {
  test('returns 7-char hex string', () => {
    const h = _hash7('hello world');
    assert.match(h, /^[0-9a-f]{7}$/);
  });

  test('is deterministic', () => {
    assert.equal(_hash7('abc'), _hash7('abc'));
  });

  test('differs on different input', () => {
    assert.notEqual(_hash7('abc'), _hash7('def'));
  });
});

describe('_wordCount', () => {
  test('counts words in a simple sentence', () => {
    assert.equal(_wordCount('hello world foo'), 3);
  });

  test('handles empty string', () => {
    assert.equal(_wordCount(''), 0);
  });

  test('handles multiple spaces', () => {
    assert.equal(_wordCount('  hello   world  '), 2);
  });
});

describe('_parseIntentHeader', () => {
  test('parses a well-formed header', () => {
    const content = '# Project Intent\n<!-- generated: 2026-04-24T00:00:00.000Z | repo-hash: abc1234 | readme-hash: def5678 | low_confidence: false -->\n';
    const h = _parseIntentHeader(content);
    assert.ok(h);
    assert.equal(h.repoHash, 'abc1234');
    assert.equal(h.readmeHash, 'def5678');
    assert.equal(h.lowConfidence, false);
  });

  test('parses low_confidence: true', () => {
    const content = '<!-- generated: 2026-04-24T00:00:00.000Z | repo-hash: abc1234 | readme-hash: def5678 | low_confidence: true -->\n';
    const h = _parseIntentHeader(content);
    assert.ok(h);
    assert.equal(h.lowConfidence, true);
  });

  test('returns null on malformed header', () => {
    assert.equal(_parseIntentHeader('no header here'), null);
  });
});

describe('isLowConfidence', () => {
  test('returns true for null/undefined', () => {
    assert.equal(isLowConfidence(null), true);
    assert.equal(isLowConfidence(''), true);
  });

  test('returns true when header says low_confidence: true', () => {
    const content = '<!-- generated: 2026-04-24T00:00:00.000Z | repo-hash: abc1234 | readme-hash: def5678 | low_confidence: true -->\n';
    assert.equal(isLowConfidence(content), true);
  });

  test('returns false when header says low_confidence: false', () => {
    const content = '<!-- generated: 2026-04-24T00:00:00.000Z | repo-hash: abc1234 | readme-hash: def5678 | low_confidence: false -->\n';
    assert.equal(isLowConfidence(content), false);
  });
});

// ---------------------------------------------------------------------------
// Integration: generateProjectIntent
// ---------------------------------------------------------------------------

describe('AC-01: first-run generation', () => {
  test('creates project-intent.md with locked header and 5 fields', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'my-plugin', description: 'A Claude Code plugin', scripts: { test: 'node --test' } },
      extraFiles: 12, // ensure >= 10 files total
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir });
      assert.equal(result.skipped, false);
      assert.equal(result.cached, false);
      assert.equal(result.lowConfidence, false);

      const content = readIntent(dir);
      assert.ok(content, 'project-intent.md should exist');

      // Header format
      assert.ok(content.includes('# Project Intent'), 'must have title');
      assert.match(content, /<!-- generated: .+ \| repo-hash: [0-9a-f]{7} \| readme-hash: [0-9a-f]{7} \| low_confidence: false -->/);

      // 5 required fields present
      assert.ok(content.includes('**Domain:**'), 'must have Domain field');
      assert.ok(content.includes('**Primary user problem:**'), 'must have Primary user problem field');
      assert.ok(content.includes('**Key architectural constraint:**'), 'must have Key architectural constraint field');
      assert.ok(content.includes('**Tech stack summary:**'), 'must have Tech stack summary field');
      assert.ok(content.includes('**Entry points:**'), 'must have Entry points field');
    } finally {
      cleanup(dir);
    }
  });

  test('domain field is populated from package description', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test', description: 'Orchestration plugin for developers', scripts: { test: 'node --test' } },
      extraFiles: 12,
    });
    try {
      generateProjectIntent({ projectRoot: dir });
      const content = readIntent(dir);
      assert.ok(content.includes('Orchestration plugin for developers'), 'domain should include pkg description');
    } finally {
      cleanup(dir);
    }
  });

  test('tech stack summary mentions Node.js for npm projects', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test', scripts: { test: 'node --test tests/*.test.js' } },
      extraFiles: 12,
    });
    try {
      generateProjectIntent({ projectRoot: dir });
      const content = readIntent(dir);
      // Find the Tech stack summary line
      const line = content.split('\n').find(l => l.startsWith('**Tech stack summary:**'));
      assert.ok(line, 'Tech stack summary line should exist');
      assert.ok(line.includes('Node.js'), 'should mention Node.js');
    } finally {
      cleanup(dir);
    }
  });
});

describe('AC-02: cache hit — mtime unchanged on repeated call with same hashes', () => {
  test('mtime is unchanged on second call with no changes', (t) => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      // First generation
      generateProjectIntent({ projectRoot: dir });
      const mtime1 = intentMtime(dir);
      assert.ok(mtime1 > 0, 'file should exist after first run');

      // Sleep 2ms to ensure mtime would differ if the file were rewritten
      // (most filesystems have 1ms or better mtime resolution)
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait */ }

      // Second call — hashes should match → cache hit
      const result2 = generateProjectIntent({ projectRoot: dir });
      const mtime2 = intentMtime(dir);

      assert.equal(result2.cached, true, 'should report cache hit');
      assert.equal(mtime1, mtime2, 'file mtime must not change on cache hit');
    } finally {
      cleanup(dir);
    }
  });
});

describe('AC-03: invalidation on README change', () => {
  test('regenerates when README content changes', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      // First generation
      generateProjectIntent({ projectRoot: dir });
      const content1 = readIntent(dir);
      const header1 = _parseIntentHeader(content1);

      // Modify README with new content (different hash)
      const newReadme = LONG_README + '\nSome extra content that changes the hash significantly.\n'.repeat(5);
      fs.writeFileSync(path.join(dir, 'README.md'), newReadme, 'utf8');
      execSync('git add README.md && git commit -q -m "update readme"', { cwd: dir });

      // Second call — readme-hash should differ → regenerate
      const result2 = generateProjectIntent({ projectRoot: dir });
      const content2 = readIntent(dir);
      const header2 = _parseIntentHeader(content2);

      assert.equal(result2.cached, false, 'should NOT report cache hit');
      // readme-hash or repo-hash must differ
      assert.ok(
        header1.readmeHash !== header2.readmeHash || header1.repoHash !== header2.repoHash,
        'at least one hash should differ after change'
      );
    } finally {
      cleanup(dir);
    }
  });
});

describe('AC-04: low-confidence gate', () => {
  test('missing README → low_confidence: true, fields empty strings', () => {
    const dir = makeRepo({
      readmeContent: null, // no README
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir });
      assert.equal(result.lowConfidence, true);
      const content = readIntent(dir);
      assert.ok(content, 'stub file should be written');
      assert.match(content, /low_confidence: true/);
      // Fields should be present but empty (no content after the field label)
      const domainLine = content.split('\n').find(l => l.startsWith('**Domain:**'));
      assert.ok(domainLine, 'Domain field should exist');
      // The field value after '**Domain:** ' should be empty (trim both sides)
      const domainValue = domainLine.replace('**Domain:**', '').trim();
      assert.equal(domainValue, '', 'Domain field value should be empty in low-confidence stub');
    } finally {
      cleanup(dir);
    }
  });

  test('README < 100 words → low_confidence: true', () => {
    const dir = makeRepo({
      readmeContent: SHORT_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir });
      assert.equal(result.lowConfidence, true);
      const content = readIntent(dir);
      assert.match(content, /low_confidence: true/);
    } finally {
      cleanup(dir);
    }
  });
});

describe('AC-05: config gate', () => {
  test('enable_goal_inference: false → skipped', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir, enableGoalInference: false });
      assert.equal(result.skipped, true, 'should be skipped when disabled');
      // File should not be created
      const intentFile = path.join(dir, '.orchestray', 'kb', 'facts', 'project-intent.md');
      assert.equal(fs.existsSync(intentFile), false, 'file should not be created when skipped');
    } finally {
      cleanup(dir);
    }
  });

  test('enable_repo_map: false → goal inference also skipped', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir, enableRepoMap: false });
      assert.equal(result.skipped, true, 'should be skipped when repo_map is disabled');
    } finally {
      cleanup(dir);
    }
  });

  test('enable_goal_inference: true with enable_repo_map: true → not skipped', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir, enableGoalInference: true, enableRepoMap: true });
      assert.equal(result.skipped, false);
    } finally {
      cleanup(dir);
    }
  });
});

describe('AC-06: delegation prompt injection via injectProjectIntent', () => {
  test('returns ## Project Intent block when file exists and low_confidence is false', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'my-plugin', description: 'Orchestration plugin', scripts: { test: 'node --test' } },
      extraFiles: 12,
    });
    try {
      generateProjectIntent({ projectRoot: dir });
      const block = injectProjectIntent({ projectRoot: dir });
      assert.ok(block.startsWith('## Project Intent'), 'block should start with ## Project Intent heading');
      assert.ok(block.includes('**Domain:**'), 'block should include Domain field');
      assert.ok(block.includes('**Primary user problem:**'), 'block should include user problem field');
    } finally {
      cleanup(dir);
    }
  });

  test('returns empty string when file is missing', () => {
    const dir = makeRepo({ readmeContent: LONG_README, extraFiles: 5 });
    try {
      // Do NOT call generateProjectIntent — file should be missing
      const block = injectProjectIntent({ projectRoot: dir });
      assert.equal(block, '', 'should return empty string when file missing');
    } finally {
      cleanup(dir);
    }
  });

  test('returns empty string when low_confidence is true', () => {
    const dir = makeRepo({
      readmeContent: null, // triggers low_confidence
      extraFiles: 12,
    });
    try {
      generateProjectIntent({ projectRoot: dir });
      const block = injectProjectIntent({ projectRoot: dir });
      assert.equal(block, '', 'should return empty string for low_confidence block');
    } finally {
      cleanup(dir);
    }
  });

  test('injection is additive — does not interfere with repo map', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      generateProjectIntent({ projectRoot: dir });
      const intentBlock = injectProjectIntent({ projectRoot: dir });
      const repoMapBlock = '## Repository Map\n\nSome content here.';
      // Both blocks can exist side-by-side
      const combined = intentBlock + '\n\n' + repoMapBlock;
      assert.ok(combined.includes('## Project Intent'), 'combined should have intent block');
      assert.ok(combined.includes('## Repository Map'), 'combined should have repo map block');
    } finally {
      cleanup(dir);
    }
  });
});

describe('AC-08: minimum project size gate', () => {
  test('< 10 tracked files → stub with low_confidence: true, no field inference', () => {
    // makeRepo with extraFiles=0 creates: README, package.json = 2 files + .gitkeep if needed
    // but won't reach 10. Use just a couple of files.
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 2, // total tracked ~4 files — below threshold
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir });
      assert.equal(result.lowConfidence, true, 'small repo should be low_confidence');
      const content = readIntent(dir);
      assert.ok(content, 'stub file should be written');
      assert.match(content, /low_confidence: true/);
    } finally {
      cleanup(dir);
    }
  });

  test('>= 10 tracked files → normal generation attempted', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test', description: 'A plugin' },
      extraFiles: 12, // well above threshold
    });
    try {
      const result = generateProjectIntent({ projectRoot: dir });
      assert.equal(result.skipped, false);
      assert.equal(result.lowConfidence, false, 'large enough repo should be high-confidence');
    } finally {
      cleanup(dir);
    }
  });
});

describe('readProjectIntent', () => {
  test('returns null when file does not exist', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-no-intent-'));
    try {
      const result = readProjectIntent(dir);
      assert.equal(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('returns file content when file exists', () => {
    const dir = makeRepo({
      readmeContent: LONG_README,
      pkg: { name: 'test' },
      extraFiles: 12,
    });
    try {
      generateProjectIntent({ projectRoot: dir });
      const content = readProjectIntent(dir);
      assert.ok(content, 'should return content');
      assert.ok(content.includes('# Project Intent'), 'should include title');
    } finally {
      cleanup(dir);
    }
  });
});
