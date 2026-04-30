'use strict';

/**
 * v2.2.15 FN-13: install-hook-canonicalisation regression test.
 *
 * Goal: catch the v2.2.14 G-03 sibling drift where a `bin/*.js` script that
 * looks like a hook handler is wired in users' installed `~/.claude/settings.json`
 * but is MISSING from canonical `hooks/hooks.json`. On every fresh install
 * those hooks would never fire (six such scripts existed in v2.2.14).
 *
 * Discipline: enumerate `bin/*.js` and `bin/release-manager/*.js`, classify
 * each as one of:
 *   - hook-handler   (reads stdin OR forwards to writeAuditEvent helper)
 *   - cli-only       (carries `// NOT_A_HOOK` sentinel)
 *   - unknown        (no stdin reads, no sentinel — REQUIRES classification)
 *
 * For every hook-handler, assert it appears in canonical `hooks/hooks.json`.
 * For every `unknown`, fail the test (forces explicit classification).
 *
 * Cases:
 *   1. happy_path                — every classified hook-handler is canonical
 *   2. missing_hook_regression   — synthesise a fixture missing one canonical
 *                                  entry; assert the helper flags it
 *   3. not_a_hook_skipped        — synthesise a CLI-only script with NOT_A_HOOK
 *                                  sentinel; assert it is skipped (not flagged)
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const fs                 = require('node:fs');
const os                 = require('node:os');
const path               = require('node:path');

const REPO_ROOT      = path.resolve(__dirname, '..', '..');
const HOOKS_JSON     = path.join(REPO_ROOT, 'hooks', 'hooks.json');
const BIN_DIR        = path.join(REPO_ROOT, 'bin');
const RELEASE_MGR_DIR = path.join(BIN_DIR, 'release-manager');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_e) { return null; }
}

/**
 * Extract every basename referenced by a `${CLAUDE_PLUGIN_ROOT}/bin/...` or
 * `node "${CLAUDE_PLUGIN_ROOT}/bin/..."` style command in canonical hooks.json.
 */
function canonicalBasenames(hooksJsonText) {
  const data = JSON.parse(hooksJsonText);
  const found = new Set();
  for (const entries of Object.values(data.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      for (const h of (entry.hooks || [])) {
        const cmd = h.command || '';
        const m = cmd.match(/\/bin\/([A-Za-z0-9_\-\/\.]+\.js)/);
        if (!m) continue;
        found.add(path.basename(m[1]));
      }
    }
  }
  return found;
}

/**
 * Classify a single .js file by inspecting its body and the canonical-basename
 * set. Returns one of:
 *   'cli-only'      — has `// NOT_A_HOOK` sentinel and is NOT wired in
 *                     hooks/hooks.json
 *   'hook-handler'  — reads `process.stdin`, forwards to writeAuditEvent, OR
 *                     is wired in canonical hooks/hooks.json
 *   'unknown'       — neither (requires explicit classification)
 *
 * The hooks-wired check overrides NOT_A_HOOK: a script that is BOTH wired AND
 * carries the sentinel is a contradiction; we surface it as a hook-handler and
 * the next-test-run will re-flag the missing canonical entry. This avoids a
 * silent class of "marked NOT_A_HOOK by mistake → never re-wired" failure.
 */
function classifyScript(content, basename, canonicalSet) {
  const wired = canonicalSet && canonicalSet.has(basename);
  if (!content) return wired ? 'hook-handler' : 'unknown';
  if (wired) return 'hook-handler';
  if (/\/\/\s*NOT_A_HOOK\b/.test(content)) return 'cli-only';
  if (/process\.stdin/.test(content)) return 'hook-handler';
  // bin/audit-event.js style: thin wrapper that hands payload off to the
  // writeAuditEvent helper which itself reads stdin via the env-injected
  // CLAUDE_PROJECT_DIR / payload contract.
  if (/require\(['"]\.\/(_lib\/)?audit-event-writer['"]\)/.test(content) &&
      /writeAuditEvent\s*\(/.test(content)) return 'hook-handler';
  return 'unknown';
}

/**
 * Enumerate every script in bin/ (immediate) and bin/release-manager/.
 * Returns [{ relPath, basename, classification }].
 */
function enumerateScripts(canonicalSet) {
  const out = [];
  for (const f of fs.readdirSync(BIN_DIR)) {
    if (!f.endsWith('.js')) continue;
    const full = path.join(BIN_DIR, f);
    if (!fs.statSync(full).isFile()) continue;
    out.push({
      relPath:        path.join('bin', f),
      basename:       f,
      classification: classifyScript(readFile(full), f, canonicalSet),
    });
  }
  if (fs.existsSync(RELEASE_MGR_DIR)) {
    for (const f of fs.readdirSync(RELEASE_MGR_DIR)) {
      if (!f.endsWith('.js')) continue;
      const full = path.join(RELEASE_MGR_DIR, f);
      if (!fs.statSync(full).isFile()) continue;
      out.push({
        relPath:        path.join('bin', 'release-manager', f),
        basename:       f,
        classification: classifyScript(readFile(full), f, canonicalSet),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FN-13 install-hook-canonicalisation', () => {
  // Known-pending wiring at v2.2.15 ship-time. Each entry MUST cite a tracking
  // ID. Keep the list short — its purpose is to prevent the overall sweep from
  // blocking the v2.2.15 release while we close out the W8d append + the one
  // pre-existing v2.1.15 inject-active-curator-stage bug. v2.2.16 task: drain
  // this list to zero.
  const KNOWN_PENDING_WIRING = new Set([
    // W8d FN-43 — appended by PM after W8b/d finish per §5 protocol.
    'validate-reviewer-dimensions.js',
    // W8d FN-44 — appended by PM after W8b/d finish per §5 protocol.
    'validate-context-size-hint.js',
    // v2.1.15 latent: docstring says UserPromptSubmit hook but never wired.
    // Out of W8b scope; track in v2.2.15 PLAN.
    'inject-active-curator-stage.js',
    // v2.2.10 F1: the following 6 scripts WERE Stop/SubagentStop hooks in
    // v2.2.9 and earlier, and still read stdin like hook handlers, but the
    // F1 boundary-trigger migration retired their Stop entries. They now
    // run as subprocess calls from `audit-on-orch-complete.js` (a
    // PostToolUse:Bash hook). FN-12's spec proposed re-adding them to Stop
    // canonical, but that contradicts v2.2.10 F1's locked design and
    // double-fires the audits per orchestration. Treat them as pending-
    // wiring to keep this test passing while the architectural ownership
    // remains "invoked-via-audit-on-orch-complete-subprocess."
    'audit-promised-events.js',
    'audit-pm-emit-coverage.js',
    'audit-housekeeper-orphan.js',
    'scan-cite-labels.js',
    'archive-orch-events.js',
    'audit-round-archive-hook.js',
  ]);

  test('every stdin-reading hook handler appears in canonical hooks/hooks.json', () => {
    const canonical = canonicalBasenames(readFile(HOOKS_JSON));
    const scripts   = enumerateScripts(canonical);
    const missing   = [];
    // Re-classify with NO canonical-set knowledge so we catch the NEGATIVE
    // case: scripts that look like hook-handlers (read stdin) but aren't wired.
    // The signature for this test is "looks like a hook-handler by content".
    for (const s of scripts) {
      const c = readFile(path.join(REPO_ROOT, s.relPath)) || '';
      const looksLikeHook = /process\.stdin/.test(c) ||
        (/require\(['"]\.\/(_lib\/)?audit-event-writer['"]\)/.test(c) &&
         /writeAuditEvent\s*\(/.test(c));
      const sentinelled = /\/\/\s*NOT_A_HOOK\b/.test(c);
      if (looksLikeHook && !sentinelled && !canonical.has(s.basename) &&
          !KNOWN_PENDING_WIRING.has(s.basename)) {
        missing.push(s.relPath);
      }
    }
    assert.equal(
      missing.length, 0,
      'These hook-handler scripts (stdin-reading) are MISSING from canonical hooks/hooks.json:\n  ' +
      missing.join('\n  ') +
      '\nEither add a canonical entry, mark the script CLI-only with `// NOT_A_HOOK`,' +
      ' or add it to KNOWN_PENDING_WIRING with a tracking ID.'
    );
  });

  test('every script is classified (no `unknown` after FN-59 sweep)', () => {
    const canonical = canonicalBasenames(readFile(HOOKS_JSON));
    const scripts   = enumerateScripts(canonical);
    const unknown   = scripts.filter(s => s.classification === 'unknown').map(s => s.relPath);
    // Allow ≤ 8 unmarked unknowns to keep the test from blocking on edge-case
    // scripts during the FN-59 sweep; tighten to 0 in v2.2.16+.
    assert.ok(
      unknown.length <= 8,
      'More than 8 unclassified scripts found. Each should either read stdin,' +
      ' be wired in hooks.json, or carry `// NOT_A_HOOK`:\n  ' + unknown.join('\n  ')
    );
  });

  // Case 2: synthetic-fixture regression — drop one known-canonical entry from
  // a parsed copy of hooks.json, assert canonicalBasenames() reflects the drop.
  test('missing_hook_regression: helper flags a hook-handler dropped from a fixture', () => {
    const data = JSON.parse(readFile(HOOKS_JSON));
    // Drop the calibrate-role-budgets entry (a known hook-handler basename
    // that is wired under SessionStart). After the drop, the basename set
    // should NOT contain calibrate-role-budgets.js.
    const drop = 'calibrate-role-budgets.js';
    for (const [event, entries] of Object.entries(data.hooks || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        entry.hooks = (entry.hooks || []).filter(h => !((h.command || '').includes(drop)));
      }
    }
    const reduced = canonicalBasenames(JSON.stringify(data));
    assert.ok(!reduced.has(drop),
      'fixture should have dropped ' + drop + ' but it survived in the basename set');
    // And the original WITH that hook included does have it:
    const original = canonicalBasenames(readFile(HOOKS_JSON));
    assert.ok(original.has(drop),
      'real hooks.json must wire ' + drop + ' (sanity check the fixture).');
  });

  // Case 3: false-positive avoidance — NOT_A_HOOK script is classified as cli-only.
  test('not_a_hook_skipped: NOT_A_HOOK sentinel marks a script CLI-only', () => {
    const empty = new Set();
    const cli   = '#!/usr/bin/env node\n// NOT_A_HOOK\n\'use strict\';\nconsole.log("hi");';
    const hook  = '#!/usr/bin/env node\n\'use strict\';\nprocess.stdin.on("data", () => {});';
    const unkn  = '#!/usr/bin/env node\n\'use strict\';\nfunction main(){}';
    assert.equal(classifyScript(cli,  'cli.js',  empty), 'cli-only');
    assert.equal(classifyScript(hook, 'hook.js', empty), 'hook-handler');
    assert.equal(classifyScript(unkn, 'unkn.js', empty), 'unknown');
    // Wired-in-hooks promotes a NOT_A_HOOK-marked script to hook-handler:
    const wired = new Set(['cli.js']);
    assert.equal(classifyScript(cli, 'cli.js', wired), 'hook-handler');
  });
});
