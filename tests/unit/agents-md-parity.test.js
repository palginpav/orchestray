#!/usr/bin/env node
'use strict';

/**
 * agents-md-parity.test.js — R-AGENTS-MD (W10, v2.1.13)
 *
 * Verifies AGENTS.md (open-convention file; see https://agents.md) is read
 * alongside CLAUDE.md when mechanical project-intent inference runs.
 *
 * Acceptance (from W10 scope):
 *   (a) project-intent agent references AGENTS.md in its input list.
 *   (b) a synthetic repo with AGENTS.md produces a project-intent block whose
 *       architectural-constraint field reflects content from the AGENTS.md
 *       Build/Run section.
 *
 * Graceful-skip: the same code path MUST NOT fail when AGENTS.md is absent
 * (the existing project-intent-generation.test.js suite covers that case;
 * here we only add the parity checks).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const { generateProjectIntent } = require('../../bin/_lib/project-intent');

// ---------------------------------------------------------------------------
// Helpers (lightweight clones of project-intent-generation.test.js — kept
// local so this test file stays self-contained and can be moved if W4's
// project-intent agent implementation changes fixture layout).
// ---------------------------------------------------------------------------

function makeRepo(opts) {
  const {
    readmeContent = null,
    pkg = null,
    claudeMd = null,
    agentsMd = null,
    extraFiles = 0,
  } = opts || {};

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-agmd-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });

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
  if (agentsMd !== null) {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), agentsMd, 'utf8');
    filesToAdd.push('AGENTS.md');
  }
  for (let i = 0; i < extraFiles; i++) {
    const name = `file${i}.js`;
    fs.writeFileSync(path.join(dir, name), `// file ${i}\n`, 'utf8');
    filesToAdd.push(name);
  }

  if (filesToAdd.length > 0) {
    execSync(`git add ${filesToAdd.join(' ')}`, { cwd: dir });
    execSync('git commit -q -m "init"', { cwd: dir });
  } else {
    fs.writeFileSync(path.join(dir, '.gitkeep'), '', 'utf8');
    execSync('git add .gitkeep', { cwd: dir });
    execSync('git commit -q -m "init"', { cwd: dir });
  }
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

function readIntent(dir) {
  const p = path.join(dir, '.orchestray', 'kb', 'facts', 'project-intent.md');
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// README that meets the ≥100-word + git-tracked thresholds but has no
// "constraint / must / requires / only" phrasing itself — so the arch
// constraint field is forced to come from CLAUDE.md / AGENTS.md.
const NEUTRAL_README = `# Demo Project

A demonstration project used by the W10 parity test. It shows how the
Orchestray project-intent helper mechanically distils a short summary from
top-level repo metadata for downstream delegation prompts.

This description intentionally avoids the constraint-trigger words used by
the mechanical inference so that the architectural-constraint field is
sourced from AGENTS.md instead of the README itself. That lets us prove
AGENTS.md actually participates in inference.

## Overview

Some additional prose to push the word count comfortably past the 100-word
threshold. Mechanical inference only triggers when the README is long
enough and the tracked file count is high enough.
`;

// ---------------------------------------------------------------------------
// (a) agent-definition check: project-intent agent references AGENTS.md
// ---------------------------------------------------------------------------

describe('W10 (a): project-intent agent definition references AGENTS.md', () => {
  test('agents/project-intent.md mentions AGENTS.md in its input list', () => {
    const agentMdPath = path.join(__dirname, '..', '..', 'agents', 'project-intent.md');
    assert.ok(fs.existsSync(agentMdPath), 'agents/project-intent.md must exist');
    const content = fs.readFileSync(agentMdPath, 'utf8');
    assert.ok(
      /AGENTS\.md/.test(content),
      'agents/project-intent.md must reference AGENTS.md in the read list',
    );
    // Also mention the canonical convention site so a future maintainer can
    // trace the decision.
    assert.ok(
      /agents\.md/i.test(content),
      'agents/project-intent.md should cite the agents.md convention',
    );
  });
});

// ---------------------------------------------------------------------------
// (b) behavioural parity: AGENTS.md content surfaces in the inferred block
// ---------------------------------------------------------------------------

describe('W10 (b): AGENTS.md participates in mechanical inference', () => {
  test('architectural constraint field is populated from AGENTS.md Build/Run section', () => {
    // AGENTS.md content that contains a trigger phrase the _inferArchConstraint
    // regex accepts ("requires"). CLAUDE.md is intentionally absent so the
    // match can only come from AGENTS.md.
    const AGENTS_MD = [
      '# Agent Guidance',
      '',
      '## Build/Run',
      '',
      'This project requires Node.js 20 LTS and has no build step.',
      '',
      '## Testing',
      '',
      'Run the suite with `node --test`.',
      '',
      '## Architecture',
      '',
      'Single-package, no monorepo tooling.',
      '',
    ].join('\n');

    const dir = makeRepo({
      readmeContent: NEUTRAL_README,
      pkg: { name: 'demo', description: 'Demo project', scripts: { test: 'node --test' } },
      claudeMd: null,
      agentsMd: AGENTS_MD,
      extraFiles: 12, // total tracked files >= 10 (AC-08 gate)
    });

    try {
      const result = generateProjectIntent({ projectRoot: dir });
      assert.equal(result.skipped, false, 'inference should run');
      assert.equal(result.lowConfidence, false, 'README is long enough for high-confidence');

      const content = readIntent(dir);
      assert.ok(content, 'project-intent.md must be written');

      // The arch-constraint field picks up the AGENTS.md Build/Run line.
      // _inferArchConstraint's regex stops at the first `.` so the captured
      // substring is "This project requires Node." — we assert on "requires"
      // specifically since that token can only come from the AGENTS.md
      // fixture in this test (the neutral README was authored to omit it).
      const archLine = (content.match(/^\*\*Key architectural constraint:\*\*\s*(.*)$/m) || [])[1] || '';
      assert.ok(
        /requires/i.test(archLine),
        `architectural constraint must be sourced from AGENTS.md Build/Run; got: "${archLine}"`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('missing AGENTS.md does not break inference (graceful skip)', () => {
    // Regression guard: ensure the new AGENTS.md read path is strictly additive.
    const dir = makeRepo({
      readmeContent: NEUTRAL_README,
      pkg: { name: 'demo', description: 'Demo project', scripts: { test: 'node --test' } },
      claudeMd: '# CLAUDE\n\nThis project must work as a Claude Code plugin and cannot modify internals.\n',
      agentsMd: null, // AGENTS.md absent
      extraFiles: 12,
    });

    try {
      const result = generateProjectIntent({ projectRoot: dir });
      assert.equal(result.skipped, false);
      assert.equal(result.lowConfidence, false);

      const content = readIntent(dir);
      assert.ok(content);
      // CLAUDE.md still drives the arch constraint when AGENTS.md is absent.
      const archLine = (content.match(/^\*\*Key architectural constraint:\*\*\s*(.*)$/m) || [])[1] || '';
      assert.ok(
        /must work|cannot modify/i.test(archLine),
        `fallback to CLAUDE.md expected when AGENTS.md missing; got: "${archLine}"`,
      );
    } finally {
      cleanup(dir);
    }
  });
});
