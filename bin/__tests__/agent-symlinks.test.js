#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/agent-symlinks.js — custom-agent symlink lifecycle.
 *
 * Runner: node --test bin/__tests__/agent-symlinks.test.js
 *
 * Cases:
 *  #1 Fresh: missing <agentsDir>/<name>.md → created
 *  #2 Idempotent: existing symlink at correct target → kept
 *  #3 Source-deleted: stale symlink (basename not in validNames) → swept
 *  #4 Foreign file: regular file at <agentsDir>/<name>.md → skipped, not clobbered
 *  #5 Invalid agent (not in validAgents) → no symlink created
 *  #6 Wrong target inside source dir → retargeted
 *  #7 Symlink pointing OUTSIDE source dir → skipped (managed elsewhere)
 *  #8 Sweep does NOT touch specialist symlinks (different sibling dir)
 */

const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { syncCustomAgentSymlinks } = require('../_lib/agent-symlinks');

let tmpRoot;
let sourceDir;
let agentsDir;
let specialistsDir; // sibling to sourceDir, like real install
let warnings;

function setupDirs() {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-symlinks-'));
  sourceDir      = path.join(tmpRoot, 'orchestray', 'custom-agents');
  agentsDir      = path.join(tmpRoot, 'agents');
  specialistsDir = path.join(tmpRoot, 'orchestray', 'specialists');
  fs.mkdirSync(sourceDir,      { recursive: true });
  fs.mkdirSync(agentsDir,      { recursive: true });
  fs.mkdirSync(specialistsDir, { recursive: true });
  warnings = [];
}

function teardown() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
}

function captureWarn(msg) { warnings.push(msg); }

function writeAgent(name, body) {
  const p = path.join(sourceDir, name + '.md');
  fs.writeFileSync(p, body || '---\nname: ' + name + '\n---\n', 'utf8');
  return { name, source_path: p };
}

describe('agent-symlinks', () => {
  beforeEach(() => { teardown(); setupDirs(); });
  after(teardown);

  test('#1 fresh symlink created for valid agent', () => {
    const rec = writeAgent('my-translator');
    const r = syncCustomAgentSymlinks({
      validAgents: [rec], sourceDir, agentsDir, warn: captureWarn,
    });
    assert.equal(r.created, 1);
    assert.equal(r.errors,  0);
    const link = path.join(agentsDir, 'my-translator.md');
    const lstats = fs.lstatSync(link);
    assert.ok(lstats.isSymbolicLink(), 'should be a symlink');
    assert.equal(fs.readlinkSync(link), rec.source_path);
  });

  test('#2 idempotent: re-running keeps existing correct symlink', () => {
    const rec = writeAgent('my-agent');
    syncCustomAgentSymlinks({ validAgents: [rec], sourceDir, agentsDir, warn: captureWarn });
    const r2 = syncCustomAgentSymlinks({
      validAgents: [rec], sourceDir, agentsDir, warn: captureWarn,
    });
    assert.equal(r2.kept,    1);
    assert.equal(r2.created, 0);
    assert.equal(r2.errors,  0);
  });

  test('#3 source-deleted: stale symlink is swept', () => {
    const rec = writeAgent('gone-agent');
    syncCustomAgentSymlinks({ validAgents: [rec], sourceDir, agentsDir, warn: captureWarn });
    // Now the agent goes away (file deleted, validation removes it from set).
    fs.unlinkSync(rec.source_path);
    const r = syncCustomAgentSymlinks({
      validAgents: [], sourceDir, agentsDir, warn: captureWarn,
    });
    assert.equal(r.swept, 1);
    assert.ok(!fs.existsSync(path.join(agentsDir, 'gone-agent.md')));
  });

  test('#4 foreign regular file: not clobbered, skipped with warn', () => {
    const rec = writeAgent('squat');
    const link = path.join(agentsDir, 'squat.md');
    fs.writeFileSync(link, '# user wrote this themselves\n', 'utf8');
    const r = syncCustomAgentSymlinks({
      validAgents: [rec], sourceDir, agentsDir, warn: captureWarn,
    });
    assert.equal(r.skipped, 1);
    assert.equal(r.created, 0);
    // File still there, untouched.
    assert.equal(fs.readFileSync(link, 'utf8'), '# user wrote this themselves\n');
    assert.ok(warnings.some(w => /not a symlink/.test(w)), 'should warn about user-managed file');
  });

  test('#5 invalid (not in validAgents): no symlink created', () => {
    writeAgent('rejected'); // file exists in sourceDir but record NOT passed
    const r = syncCustomAgentSymlinks({
      validAgents: [], sourceDir, agentsDir, warn: captureWarn,
    });
    assert.equal(r.created, 0);
    assert.ok(!fs.existsSync(path.join(agentsDir, 'rejected.md')));
  });

  test('#6 wrong target inside source dir: retargeted', () => {
    const rec = writeAgent('mover');
    // Pre-create a symlink pointing at a DIFFERENT file inside sourceDir.
    const otherPath = path.join(sourceDir, 'other.md');
    fs.writeFileSync(otherPath, '---\nname: other\n---\n', 'utf8');
    const link = path.join(agentsDir, 'mover.md');
    fs.symlinkSync(otherPath, link, 'file');
    const r = syncCustomAgentSymlinks({
      validAgents: [rec], sourceDir, agentsDir, warn: captureWarn,
    });
    assert.equal(r.retargeted, 1);
    assert.equal(fs.readlinkSync(link), rec.source_path);
  });

  test('#7 symlink outside source dir: skipped, not retargeted', () => {
    const rec = writeAgent('claimed');
    // Pre-create a symlink pointing OUTSIDE sourceDir (simulates another installer).
    const outsideTarget = path.join(tmpRoot, 'somewhere-else.md');
    fs.writeFileSync(outsideTarget, '# foreign\n', 'utf8');
    const link = path.join(agentsDir, 'claimed.md');
    fs.symlinkSync(outsideTarget, link, 'file');
    const r = syncCustomAgentSymlinks({
      validAgents: [rec], sourceDir, agentsDir, warn: captureWarn,
    });
    assert.equal(r.skipped, 1);
    assert.equal(r.retargeted, 0);
    assert.equal(fs.readlinkSync(link), outsideTarget,
                 'foreign symlink target must be untouched');
    assert.ok(warnings.some(w => /managed elsewhere/.test(w)));
  });

  test('#8 specialist symlinks (different sibling dir) are not swept', () => {
    // Specialist symlink: agentsDir/translator.md -> specialistsDir/translator.md
    const specPath = path.join(specialistsDir, 'translator.md');
    fs.writeFileSync(specPath, '---\nname: translator\n---\n', 'utf8');
    const specLink = path.join(agentsDir, 'translator.md');
    fs.symlinkSync(specPath, specLink, 'file');

    // Run the helper with NO valid custom agents.
    const r = syncCustomAgentSymlinks({
      validAgents: [], sourceDir, agentsDir, warn: captureWarn,
    });
    // Sweep should NOT touch the specialist link (target is outside sourceDir).
    assert.equal(r.swept, 0);
    assert.ok(fs.lstatSync(specLink).isSymbolicLink(), 'specialist symlink must survive');
    assert.equal(fs.readlinkSync(specLink), specPath);
  });
});
