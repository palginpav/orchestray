#!/usr/bin/env node
'use strict';

/**
 * release-readiness.js — Pre-release sweep CLI.
 *
 * Checks that the v2.1.9 release infrastructure is wired and live before
 * cutting a tag. Called from release-manager agent and optionally from
 * /orchestray:update post-install sweep.
 *
 * Checks:
 *   (a) bin/validate-task-subject.js is wired in hooks/hooks.json under
 *       PreToolUse matcher "Agent".
 *   (b) bin/validate-task-completion.js is wired under both TaskCompleted
 *       AND SubagentStop.
 *   (c) At least 10 of the 13 target agent prompts reference
 *       agents/pm-reference/handoff-contract.md.
 *   (d) All 5 specialists exist (specialists/*.md).
 *   (e) A recent agent_metrics.jsonl entry contains structural_score.
 *       Skipped if the file has fewer than 5 entries.
 *
 * Exit codes:
 *   0 — all checks pass (or skipped with a note)
 *   1 — one or more checks failed
 *
 * Usage:
 *   node bin/release-readiness.js [--json] [--project-root=PATH]
 */

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv       = process.argv.slice(2);
let jsonMode     = false;
let projectRoot  = process.cwd();

for (const arg of argv) {
  if (arg === '--json') {
    jsonMode = true;
  } else if (arg.startsWith('--project-root=')) {
    projectRoot = arg.slice('--project-root='.length);
  }
}

// ---------------------------------------------------------------------------
// Check implementations
// ---------------------------------------------------------------------------

/**
 * (a) validate-task-subject.js is wired in hooks.json PreToolUse matcher "Agent".
 */
function checkTaskSubjectWired(root) {
  try {
    const hooksPath = path.join(root, 'hooks', 'hooks.json');
    if (!fs.existsSync(hooksPath)) {
      return { pass: false, note: 'hooks/hooks.json not found' };
    }
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const preToolUseHooks = hooks.hooks && hooks.hooks.PreToolUse;
    if (!Array.isArray(preToolUseHooks)) {
      return { pass: false, note: 'hooks.PreToolUse not found or not array' };
    }

    // Check if validate-task-subject.js appears in any PreToolUse hook
    // with a matcher that includes "Agent"
    const hooksJson = fs.readFileSync(hooksPath, 'utf8');
    const hasSubject = hooksJson.includes('validate-task-subject.js');
    if (!hasSubject) {
      return { pass: false, note: 'validate-task-subject.js not found in hooks/hooks.json' };
    }

    // Verify it's under a PreToolUse block that has an "Agent" matcher
    for (const block of preToolUseHooks) {
      if (!block.matcher) continue;
      if (!block.matcher.includes('Agent')) continue;
      const blockHooks = block.hooks || [];
      for (const h of blockHooks) {
        if (h.command && h.command.includes('validate-task-subject')) {
          return { pass: true, note: 'wired under PreToolUse[Agent]' };
        }
      }
    }

    // Found in file but not under Agent matcher PreToolUse
    return { pass: false, note: 'validate-task-subject.js found in hooks.json but not under PreToolUse[Agent]' };
  } catch (err) {
    return { pass: false, note: 'error reading hooks.json: ' + err.message };
  }
}

/**
 * (b) validate-task-completion.js wired under TaskCompleted AND SubagentStop.
 */
function checkTaskCompletionWired(root) {
  try {
    const hooksPath = path.join(root, 'hooks', 'hooks.json');
    if (!fs.existsSync(hooksPath)) {
      return { pass: false, note: 'hooks/hooks.json not found' };
    }
    const hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const h = hooks.hooks || {};

    function isWiredIn(eventKey) {
      const blocks = h[eventKey];
      if (!Array.isArray(blocks)) return false;
      for (const block of blocks) {
        const blockHooks = block.hooks || [];
        for (const bh of blockHooks) {
          if (bh.command && bh.command.includes('validate-task-completion')) return true;
        }
      }
      return false;
    }

    const inTaskCompleted = isWiredIn('TaskCompleted');
    const inSubagentStop  = isWiredIn('SubagentStop');

    if (inTaskCompleted && inSubagentStop) {
      return { pass: true, note: 'wired under TaskCompleted and SubagentStop' };
    }
    const missing = [];
    if (!inTaskCompleted) missing.push('TaskCompleted');
    if (!inSubagentStop)  missing.push('SubagentStop');
    return { pass: false, note: 'not wired under: ' + missing.join(', ') };
  } catch (err) {
    return { pass: false, note: 'error: ' + err.message };
  }
}

/**
 * (c) At least 10 of 13 target agent prompts reference handoff-contract.md.
 *
 * Target agents: pm, architect, developer, reviewer, refactorer, tester,
 *               debugger, documenter, inventor, researcher, security-engineer,
 *               release-manager, (ux-critic or platform-oracle as the 13th)
 */
function checkHandoffContractRefs(root) {
  try {
    const agentsDir = path.join(root, 'agents');
    if (!fs.existsSync(agentsDir)) {
      return { pass: false, note: 'agents/ directory not found', count: 0, total: 13 };
    }

    const targetAgents = [
      'pm.md', 'architect.md', 'developer.md', 'reviewer.md', 'refactorer.md',
      'tester.md', 'debugger.md', 'documenter.md', 'inventor.md', 'researcher.md',
      'security-engineer.md', 'release-manager.md', 'ux-critic.md',
    ];

    let count = 0;
    const missing = [];
    for (const fname of targetAgents) {
      const fpath = path.join(agentsDir, fname);
      if (!fs.existsSync(fpath)) {
        missing.push(fname + ' (not found)');
        continue;
      }
      try {
        const content = fs.readFileSync(fpath, 'utf8');
        if (content.includes('agents/pm-reference/handoff-contract.md')) {
          count++;
        } else {
          missing.push(fname);
        }
      } catch (_e) {
        missing.push(fname + ' (read error)');
      }
    }

    const threshold = 10;
    if (count >= threshold) {
      return { pass: true, note: `${count}/13 agent prompts reference handoff-contract.md`, count, total: 13 };
    }
    return {
      pass: false,
      note: `only ${count}/13 reference handoff-contract.md (need ≥${threshold}); missing: ${missing.slice(0, 5).join(', ')}`,
      count,
      total: 13,
    };
  } catch (err) {
    return { pass: false, note: 'error: ' + err.message, count: 0, total: 13 };
  }
}

/**
 * (d) All 5 specialists exist.
 */
function checkSpecialistsExist(root) {
  try {
    const specialistsDir = path.join(root, 'specialists');
    if (!fs.existsSync(specialistsDir)) {
      return { pass: false, note: 'specialists/ directory not found', found: 0, required: 5 };
    }

    const files = fs.readdirSync(specialistsDir).filter((f) => f.endsWith('.md'));
    const found = files.length;

    if (found >= 5) {
      return { pass: true, note: `${found} specialists found`, found, required: 5 };
    }
    return {
      pass: false,
      note: `only ${found} specialist(s) found (need ≥5); found: ${files.join(', ')}`,
      found,
      required: 5,
    };
  } catch (err) {
    return { pass: false, note: 'error: ' + err.message, found: 0, required: 5 };
  }
}

/**
 * (e) A recent agent_metrics.jsonl entry contains structural_score.
 *     Skipped if the file has fewer than 5 entries.
 */
/**
 * (f) F-014 (v2.2.0 pre-ship cross-phase fix-pass): the
 * agents/pm-reference/event-schemas.shadow.json and
 * agents/pm-reference/event-schemas.tier2-index.json sidecars MUST both
 * declare a `_meta.source_hash` that matches the SHA-256 of the live
 * agents/pm-reference/event-schemas.md. Mismatch means the chunked-only
 * lookup path returns `{found:false, error:'stale_index'}` for every
 * `schema_get` call on a fresh install. With D-8 default-on, the PM has
 * NO fallback — the path is structurally dormant on day-1.
 *
 * Recovery: `node bin/regen-schema-shadow.js` regenerates the shadow;
 * the PostToolUse(Edit) hook also regens the tier2-index sidecar via
 * `bin/_lib/tier2-index.js::buildIndex`. Both must be re-staged before
 * tagging.
 */
function checkSchemaSidecarsFresh(root) {
  try {
    const crypto = require('node:crypto');
    const sourcePath  = path.join(root, 'agents', 'pm-reference', 'event-schemas.md');
    const shadowPath  = path.join(root, 'agents', 'pm-reference', 'event-schemas.shadow.json');
    const sidecarPath = path.join(root, 'agents', 'pm-reference', 'event-schemas.tier2-index.json');

    if (!fs.existsSync(sourcePath)) {
      // Skip in fixtures / non-orchestray repos that don't ship the
      // schema source. Real orchestray installs always have this file;
      // a missing source on a real repo will fail an upstream check.
      return {
        pass: true,
        skipped: true,
        note: 'event-schemas.md not present — skipping (non-orchestray fixture)',
      };
    }
    const sourceBuf = fs.readFileSync(sourcePath);
    const sourceSha = crypto.createHash('sha256').update(sourceBuf).digest('hex');

    const mismatches = [];
    for (const [label, p] of [['shadow', shadowPath], ['tier2-index', sidecarPath]]) {
      if (!fs.existsSync(p)) {
        mismatches.push(label + ': missing on disk (' + p + ')');
        continue;
      }
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        const declared = parsed && parsed._meta && parsed._meta.source_hash;
        if (!declared) {
          mismatches.push(label + ': _meta.source_hash absent');
          continue;
        }
        if (declared !== sourceSha) {
          mismatches.push(
            label + ': source_hash mismatch (declared ' + declared.slice(0, 12) +
            '..., expected ' + sourceSha.slice(0, 12) + '...)',
          );
        }
      } catch (err) {
        mismatches.push(label + ': parse error — ' + err.message);
      }
    }

    if (mismatches.length === 0) {
      return {
        pass: true,
        note: 'shadow + tier2-index source_hash match event-schemas.md (' + sourceSha.slice(0, 12) + '...)',
      };
    }
    return {
      pass: false,
      note: 'STALE SIDECAR(S) detected — fresh install would break chunked schema lookup. ' +
        mismatches.join('; ') + '. Recovery: node bin/regen-schema-shadow.js && ' +
        'node -e "require(\'./bin/_lib/tier2-index\').buildIndex({cwd:process.cwd()})" ' +
        '&& git add agents/pm-reference/event-schemas.shadow.json ' +
        'agents/pm-reference/event-schemas.tier2-index.json',
    };
  } catch (err) {
    return { pass: false, note: 'error checking schema sidecars: ' + err.message };
  }
}

function checkStructuralScoreLive(root) {
  try {
    const metricsPath = path.join(root, '.orchestray', 'metrics', 'agent_metrics.jsonl');
    if (!fs.existsSync(metricsPath)) {
      return { pass: true, skipped: true, note: 'agent_metrics.jsonl not found — skipping check (B4 not yet run)' };
    }

    const content = fs.readFileSync(metricsPath, 'utf8');
    const lines   = content.split('\n').filter((l) => l.trim());

    if (lines.length < 5) {
      return {
        pass:    true,
        skipped: true,
        note:    `agent_metrics.jsonl has only ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'} (need ≥5 to verify) — skipping`,
      };
    }

    // Check if any line contains a structural_score row
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row.row_type === 'structural_score' && typeof row.structural_score === 'number') {
          return { pass: true, note: 'structural_score row found in agent_metrics.jsonl' };
        }
      } catch (_e) { /* skip malformed */ }
    }

    return {
      pass: false,
      note: `${lines.length} entries in agent_metrics.jsonl but none have row_type=structural_score — B4 scorer may not be active`,
    };
  } catch (err) {
    return { pass: false, note: 'error reading agent_metrics.jsonl: ' + err.message };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const checks = [
  {
    id:    'a',
    label: 'validate-task-subject.js wired in PreToolUse[Agent]',
    run:   () => checkTaskSubjectWired(projectRoot),
  },
  {
    id:    'b',
    label: 'validate-task-completion.js wired under TaskCompleted AND SubagentStop',
    run:   () => checkTaskCompletionWired(projectRoot),
  },
  {
    id:    'c',
    label: 'Handoff contract references (≥10/13 agent prompts)',
    run:   () => checkHandoffContractRefs(projectRoot),
  },
  {
    id:    'd',
    label: 'All 5 specialists exist',
    run:   () => checkSpecialistsExist(projectRoot),
  },
  {
    id:    'e',
    label: 'structural_score present in agent_metrics.jsonl (B4 live)',
    run:   () => checkStructuralScoreLive(projectRoot),
  },
  {
    id:    'f',
    label: 'event-schemas.{shadow,tier2-index} _meta.source_hash matches live source SHA (F-014)',
    run:   () => checkSchemaSidecarsFresh(projectRoot),
  },
];

const results = checks.map((c) => {
  const r = c.run();
  return { id: c.id, label: c.label, ...r };
});

const failed  = results.filter((r) => !r.pass && !r.skipped);
const skipped = results.filter((r) => r.skipped);
const passed  = results.filter((r) => r.pass && !r.skipped);

if (jsonMode) {
  process.stdout.write(JSON.stringify({
    ok:      failed.length === 0,
    results,
    summary: {
      total:   results.length,
      passed:  passed.length,
      failed:  failed.length,
      skipped: skipped.length,
    },
  }, null, 2) + '\n');
} else {
  process.stdout.write('\nOrchestray Release Readiness Check\n');
  process.stdout.write('===================================\n\n');

  for (const r of results) {
    const mark = r.skipped ? '--' : (r.pass ? '✓' : '✗');
    const label = r.skipped ? '[SKIP]' : (r.pass ? '[PASS]' : '[FAIL]');
    process.stdout.write(`  ${mark} ${label} (${r.id}) ${r.label}\n`);
    if (r.note) {
      process.stdout.write(`       ${r.note}\n`);
    }
  }

  process.stdout.write('\n');
  process.stdout.write(`Summary: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped\n\n`);

  if (failed.length === 0) {
    process.stdout.write('Release readiness: PASS\n\n');
  } else {
    process.stdout.write(`Release readiness: FAIL (${failed.length} check${failed.length > 1 ? 's' : ''} failed)\n\n`);
  }
}

process.exit(failed.length === 0 ? 0 : 1);
