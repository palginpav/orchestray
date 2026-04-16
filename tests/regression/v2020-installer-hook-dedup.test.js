#!/usr/bin/env node
'use strict';

/**
 * v2.0.20 regression — `bin/install.js` `mergeHooks()` hook-level dedup.
 *
 * Background (bug fixed in v2.0.20):
 *   The prior entry-level dedup in `mergeHooks()` checked whether ANY hook
 *   basename in a new (event, matcher) entry already existed at the target.
 *   If any single basename matched, the ENTIRE new entry was skipped — any
 *   NEW hooks inside that entry were silently lost.
 *
 *   Concrete failure: v2.0.19 added `collect-context-telemetry.js` as a
 *   SECOND hook inside the existing SubagentStart entry (alongside
 *   `audit-event.js`). v2.0.18 users who ran `/orchestray:update` kept their
 *   old `audit-event.js` hook, the dedup matched on it, and
 *   `collect-context-telemetry.js` was dropped without warning. Same story
 *   for SubagentStop and the pre/post `Agent|Explore|Task` matchers —
 *   four silent drops that disabled the subagent status bar segment.
 *
 * The fix: hook-level dedup. For each new entry, compute the set of
 * Orchestray-origin basenames already installed at the same (event, matcher)
 * pair, filter the new entry's hooks to those NOT present, and append the
 * survivors to the matching existing entry (or push a new entry if none
 * exists). Non-Orchestray hooks (no "orchestray" in the command) never block
 * an Orchestray install.
 *
 * Scenarios covered here:
 *   1. Silent-drop repro — post-fix, the second hook is preserved.
 *   2. Partial dedup — `audit-event.js` preserved verbatim (no duplicate),
 *      `collect-context-telemetry.js` appended alongside it.
 *   3. Full idempotency — installer run twice yields identical settings.json.
 *   4. Different matcher is a distinct entry — same script basename under
 *      two matchers co-exists.
 *   5. Non-Orchestray existing hook doesn't block — another plugin's hook
 *      in the same (event, matcher) slot is treated as a peer, not a dupe.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, '..', '..', 'bin', 'install.js');
const PKG_ROOT = path.resolve(__dirname, '..', '..');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-hookdedup-test-'));
}

function runInstall(tmpDir) {
  const result = spawnSync(process.execPath, [SCRIPT, '--local'], {
    encoding: 'utf8',
    timeout: 20000,
    cwd: tmpDir,
    env: { ...process.env },
  });
  return result;
}

function readSettings(tmpDir) {
  const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

function writePreexistingSettings(tmpDir, settings) {
  const claudeDir = path.join(tmpDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n'
  );
}

// Given a hooks-event entries array, return the set of script basenames
// contributed by commands whose path contains "orchestray".
function orchestrayBasenamesAt(entries, matcher) {
  const out = new Set();
  for (const entry of entries || []) {
    if (entry.matcher !== matcher) continue;
    for (const h of entry.hooks || []) {
      if (!h.command || !h.command.includes('orchestray')) continue;
      const m = h.command.match(/\/bin\/([^\s"']+)/);
      if (m) out.add(path.basename(m[1]));
    }
  }
  return out;
}

describe('v2.0.20 — mergeHooks() silent-drop repro (the bug that motivated the fix)', () => {
  test('installing beside a pre-existing audit-event.js hook preserves BOTH audit-event.js and collect-context-telemetry.js under SubagentStart', () => {
    // The real hooks.json SubagentStart entry has two hooks — audit-event.js
    // and collect-context-telemetry.js, no matcher. Seed the user's
    // settings.json with only audit-event.js (the v2.0.18 shape) and assert
    // the second hook lands after install. Against the old entry-level
    // dedup this case DROPPED collect-context-telemetry.js silently; against
    // the new hook-level dedup both survive.
    // Simulate the v2.0.18 → v2.0.19 update shape: the pre-existing hook path
    // contains "orchestray" because it was installed by an earlier Orchestray
    // version. The dedup logic keys on commands containing "orchestray" — a
    // pre-existing hook without that marker is treated as a foreign peer,
    // not an old Orchestray install.
    const tmpDir = makeTmpDir();
    try {
      const priorOrchestrayCommand =
        'node "/home/u/.claude/orchestray/bin/audit-event.js" start';
      writePreexistingSettings(tmpDir, {
        hooks: {
          SubagentStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: priorOrchestrayCommand,
                  timeout: 5,
                },
              ],
            },
          ],
        },
      });

      const result = runInstall(tmpDir);
      assert.equal(result.status, 0, `install failed: ${result.stderr}`);

      const settings = readSettings(tmpDir);
      const names = orchestrayBasenamesAt(settings.hooks.SubagentStart, undefined);

      assert.ok(
        names.has('audit-event.js'),
        `audit-event.js must remain installed, got: ${[...names].join(', ')}`
      );
      assert.ok(
        names.has('collect-context-telemetry.js'),
        `collect-context-telemetry.js MUST be present after merge (this is the repro) — got: ${[...names].join(', ')}`
      );

      // Exactly one audit-event.js occurrence — the pre-existing one. We never
      // re-add a hook whose basename was already present under this matcher.
      const auditCount = settings.hooks.SubagentStart
        .filter(e => e.matcher === undefined)
        .flatMap(e => (e.hooks || []).map(h => h.command || ''))
        .filter(c => c.includes('audit-event.js'))
        .length;
      assert.equal(
        auditCount,
        1,
        `audit-event.js should appear exactly once (the pre-existing hook), got ${auditCount}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('v2.0.20 — partial dedup (existing hook kept verbatim, new hook appended)', () => {
  test('pre-existing audit-event.js survives and collect-context-telemetry.js is appended without duplicating audit-event.js', () => {
    const tmpDir = makeTmpDir();
    try {
      // Pre-existing command has "orchestray" in the path (v2.0.18 user shape)
      // so the dedup logic recognizes it as an already-installed Orchestray
      // hook and skips re-adding it.
      const priorCommand =
        'node "/home/u/.claude/orchestray/bin/audit-event.js" start';
      writePreexistingSettings(tmpDir, {
        hooks: {
          SubagentStart: [
            {
              hooks: [
                { type: 'command', command: priorCommand, timeout: 5 },
              ],
            },
          ],
        },
      });

      const result = runInstall(tmpDir);
      assert.equal(result.status, 0, `install failed: ${result.stderr}`);

      const settings = readSettings(tmpDir);
      const entries = settings.hooks.SubagentStart;

      // Count audit-event.js occurrences across all no-matcher entries.
      const auditCommands = entries
        .filter(e => e.matcher === undefined)
        .flatMap(e => (e.hooks || []).map(h => h.command || ''))
        .filter(c => c.includes('audit-event.js'));
      assert.equal(
        auditCommands.length,
        1,
        `audit-event.js must appear exactly once, got ${auditCommands.length}: ${JSON.stringify(auditCommands)}`
      );

      // The pre-existing command must be preserved VERBATIM (not rewritten to
      // the Orchestray bin path).
      assert.ok(
        auditCommands[0] === priorCommand,
        `pre-existing hook command must be untouched, got: ${auditCommands[0]}`
      );

      // collect-context-telemetry.js must be present exactly once.
      const telemetryCommands = entries
        .filter(e => e.matcher === undefined)
        .flatMap(e => (e.hooks || []).map(h => h.command || ''))
        .filter(c => c.includes('collect-context-telemetry.js'));
      assert.equal(
        telemetryCommands.length,
        1,
        `collect-context-telemetry.js must appear exactly once, got ${telemetryCommands.length}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('v2.0.20 — full idempotency (install twice, no duplicates)', () => {
  test('running the installer twice produces identical settings.json', () => {
    const tmpDir = makeTmpDir();
    try {
      const first = runInstall(tmpDir);
      assert.equal(first.status, 0, `first install failed: ${first.stderr}`);
      const afterFirst = fs.readFileSync(
        path.join(tmpDir, '.claude', 'settings.json'),
        'utf8'
      );

      const second = runInstall(tmpDir);
      assert.equal(second.status, 0, `second install failed: ${second.stderr}`);
      const afterSecond = fs.readFileSync(
        path.join(tmpDir, '.claude', 'settings.json'),
        'utf8'
      );

      assert.equal(
        afterSecond,
        afterFirst,
        'settings.json must be byte-identical after a second install — any diff is a duplicate-hook regression'
      );

      // Spot-check: no Orchestray basename appears more than once under any
      // (event, matcher) pair.
      const settings = JSON.parse(afterSecond);
      for (const [event, entries] of Object.entries(settings.hooks || {})) {
        const perMatcherBasenameCounts = new Map();
        for (const entry of entries) {
          const m = entry.matcher;
          for (const h of entry.hooks || []) {
            if (!h.command || !h.command.includes('orchestray')) continue;
            const match = h.command.match(/\/bin\/([^\s"']+)/);
            if (!match) continue;
            const name = path.basename(match[1]);
            const key = `${event}:${m === undefined ? '<none>' : m}:${name}`;
            perMatcherBasenameCounts.set(key, (perMatcherBasenameCounts.get(key) || 0) + 1);
          }
        }
        for (const [key, count] of perMatcherBasenameCounts) {
          assert.equal(count, 1, `duplicate hook detected: ${key} appeared ${count} times`);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('v2.0.20 — different matcher is a distinct entry', () => {
  test('PreToolUse `Agent|Explore|Task` and `Read` live in separate entries after install', () => {
    const tmpDir = makeTmpDir();
    try {
      const result = runInstall(tmpDir);
      assert.equal(result.status, 0, `install failed: ${result.stderr}`);

      const settings = readSettings(tmpDir);
      const pre = settings.hooks.PreToolUse;
      assert.ok(Array.isArray(pre), 'PreToolUse must be an array');

      const agentEntry = pre.find(e => e.matcher === 'Agent|Explore|Task');
      const readEntry  = pre.find(e => e.matcher === 'Read');

      assert.ok(agentEntry, 'PreToolUse must contain an Agent|Explore|Task entry');
      assert.ok(readEntry,  'PreToolUse must contain a Read entry');
      assert.notEqual(
        agentEntry,
        readEntry,
        'Agent|Explore|Task and Read must be distinct entries'
      );

      // Sanity: neither entry leaked into the other. gate-agent-spawn.js
      // belongs only under Agent|Explore|Task; context-shield.js belongs
      // only under Read.
      const agentNames = (agentEntry.hooks || []).map(h => {
        const m = (h.command || '').match(/\/bin\/([^\s"']+)/);
        return m ? path.basename(m[1]) : null;
      });
      const readNames = (readEntry.hooks || []).map(h => {
        const m = (h.command || '').match(/\/bin\/([^\s"']+)/);
        return m ? path.basename(m[1]) : null;
      });

      assert.ok(
        agentNames.includes('gate-agent-spawn.js'),
        `Agent|Explore|Task entry should include gate-agent-spawn.js, got: ${agentNames.join(', ')}`
      );
      assert.ok(
        !readNames.includes('gate-agent-spawn.js'),
        'Read entry must NOT include gate-agent-spawn.js'
      );
      assert.ok(
        readNames.includes('context-shield.js'),
        `Read entry should include context-shield.js, got: ${readNames.join(', ')}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('v2.0.20 — non-Orchestray existing hook does not block install', () => {
  test('a SubagentStart hook from another plugin is preserved AND all Orchestray SubagentStart hooks land', () => {
    const tmpDir = makeTmpDir();
    try {
      const foreignCommand = 'node /absolute/other-plugin/bin/other-plugin-hook.js';
      writePreexistingSettings(tmpDir, {
        hooks: {
          SubagentStart: [
            {
              hooks: [
                { type: 'command', command: foreignCommand, timeout: 5 },
              ],
            },
          ],
        },
      });

      const result = runInstall(tmpDir);
      assert.equal(result.status, 0, `install failed: ${result.stderr}`);

      const settings = readSettings(tmpDir);
      const entries = settings.hooks.SubagentStart;

      // The foreign hook must still be present.
      const allCommands = entries.flatMap(e => (e.hooks || []).map(h => h.command || ''));
      assert.ok(
        allCommands.includes(foreignCommand),
        `foreign plugin hook must be preserved, got: ${JSON.stringify(allCommands)}`
      );

      // Every Orchestray SubagentStart hook from the source hooks.json must
      // be present. We read the source to learn the expected set rather than
      // hardcoding names here, so the test stays honest as hooks.json evolves.
      const srcHooks = JSON.parse(
        fs.readFileSync(path.join(PKG_ROOT, 'hooks', 'hooks.json'), 'utf8')
      );
      const expected = (srcHooks.hooks.SubagentStart || [])
        .filter(e => e.matcher === undefined)
        .flatMap(e => (e.hooks || []).map(h => {
          const m = (h.command || '').match(/\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/(\S+)/);
          return m ? path.basename(m[1]) : null;
        }))
        .filter(Boolean);

      assert.ok(
        expected.length > 0,
        'sanity: hooks.json SubagentStart must contribute at least one hook'
      );

      const installedOrchestrayNames = orchestrayBasenamesAt(entries, undefined);
      for (const name of expected) {
        assert.ok(
          installedOrchestrayNames.has(name),
          `expected Orchestray hook ${name} to land under SubagentStart alongside a foreign hook — got: ${[...installedOrchestrayNames].join(', ')}`
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
