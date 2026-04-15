#!/usr/bin/env node
'use strict';

/**
 * T-S3 (v2.0.17-E): apply-pm-variant.js
 *
 * Reads .orchestray/config.json, gets `pm_prompt_variant` ('lean' | 'fat'),
 * and ensures agents/pm.md matches the requested variant.
 *
 * Behaviour:
 *   lean  — no-op: pm.md is already the lean version. Seeds .pm-lean-hash if
 *            absent so future 'fat' calls have a reference hash.
 *   fat   — copies agents/pm.old.md over agents/pm.md after a safety check.
 *            Safety check: hash current pm.md and compare to stored .pm-lean-hash.
 *            If they differ (user edited pm.md manually) and --force is NOT set,
 *            exit non-zero with a clear message. With --force, overwrite anyway.
 *
 * Idempotent:
 *   - .orchestray/state/.pm-variant stores the currently-applied variant.
 *   - If the stored variant already matches the requested one, no-op (exit 0).
 *
 * CLI:
 *   node bin/apply-pm-variant.js             # apply per current config
 *   node bin/apply-pm-variant.js --dry-run   # report what would happen, no writes
 *   node bin/apply-pm-variant.js --force     # override manual-edit guard
 *
 * Hash algorithm: SHA-256, first 16 hex chars (matches T10's pm-md-prefix-stability pattern).
 *
 * Exit codes:
 *   0 — success (applied or already in correct state)
 *   1 — manual-edit guard triggered (use --force to override)
 *   2 — missing source file (agents/pm.old.md not found when fat requested)
 *   3 — unrecognised pm_prompt_variant value in config
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ──────────────────────────────────────────────────────────────────────────────
// CLI flag parsing
// ──────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE   = args.includes('--force');

// ──────────────────────────────────────────────────────────────────────────────
// Path resolution
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Locate the project root (the directory containing .orchestray/config.json)
 * by walking up from CWD. Falls back to CWD if not found.
 *
 * @returns {string} Absolute project root path.
 */
function findProjectRoot() {
  let dir = process.cwd();
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.orchestray', 'config.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: use CWD (fresh installs may not have config yet).
  return process.cwd();
}

/**
 * Locate the agents/ directory. Search order (most-specific first):
 *   1. <projectRoot>/agents/          (repo/dev layout — highest priority so tests are isolated)
 *   2. <projectRoot>/.claude/agents/  (project-local Claude Code install)
 *   3. ~/.claude/agents/              (global Claude Code install)
 *
 * Returns the first candidate that contains BOTH pm.md AND pm.old.md.
 * Both files are shipped together by Orchestray; checking both ensures provenance
 * and prevents accidentally treating an unrelated project's agents/ directory as
 * an Orchestray agents dir.
 *
 * @param {string} projectRoot
 * @returns {string|null}
 */
function findAgentsDir(projectRoot) {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    path.join(projectRoot, 'agents'),
    path.join(projectRoot, '.claude', 'agents'),
    path.join(homeDir, '.claude', 'agents'),
  ];
  // Require BOTH pm.md and pm.old.md to confirm this is an Orchestray agents directory.
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'pm.md')) && fs.existsSync(path.join(dir, 'pm.old.md'))) {
      return dir;
    }
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Hash helpers (SHA-256 hex, first 16 chars — T10 pattern)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 of a file's contents, returning the first 16 hex chars.
 *
 * @param {string} filePath - Absolute path to file.
 * @returns {string} 16-char hex prefix of SHA-256 digest.
 */
function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ──────────────────────────────────────────────────────────────────────────────
// State file helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Read the .pm-variant marker file.
 * Returns null if absent or unreadable.
 *
 * @param {string} stateDir
 * @returns {string|null}
 */
function readVariantMarker(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, '.pm-variant'), 'utf8').trim();
  } catch (_e) {
    return null;
  }
}

/**
 * Write the .pm-variant marker file.
 *
 * @param {string} stateDir
 * @param {string} variant  - 'lean' | 'fat'
 */
function writeVariantMarker(stateDir, variant) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.pm-variant'), variant, 'utf8');
}

/**
 * Read the stored lean hash (.pm-lean-hash).
 * Returns null if absent or unreadable.
 *
 * @param {string} stateDir
 * @returns {string|null}
 */
function readLeanHash(stateDir) {
  try {
    return fs.readFileSync(path.join(stateDir, '.pm-lean-hash'), 'utf8').trim();
  } catch (_e) {
    return null;
  }
}

/**
 * Write the lean hash for future integrity checks.
 *
 * @param {string} stateDir
 * @param {string} hash
 */
function writeLeanHash(stateDir, hash) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.pm-lean-hash'), hash, 'utf8');
}

// ──────────────────────────────────────────────────────────────────────────────
// Config loader (fail-open)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Read pm_prompt_variant from .orchestray/config.json.
 * Accepts both string ('lean'/'fat') and object ({variant:'lean'/'fat'}) shapes.
 * Returns 'lean' on any parse failure (fail-open).
 *
 * @param {string} projectRoot
 * @returns {string} 'lean' | 'fat'
 */
function readVariantConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.orchestray', 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return 'lean';
    const val = parsed.pm_prompt_variant;
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object' && typeof val.variant === 'string') return val.variant;
    return 'lean';
  } catch (_e) {
    return 'lean';
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Core logic
// ──────────────────────────────────────────────────────────────────────────────

function main() {
  const projectRoot = findProjectRoot();
  const stateDir    = path.join(projectRoot, '.orchestray', 'state');
  const agentsDir   = findAgentsDir(projectRoot);

  const requestedVariant = readVariantConfig(projectRoot);

  // Validate the value from config.
  if (requestedVariant !== 'lean' && requestedVariant !== 'fat') {
    process.stderr.write(
      `[orchestray] apply-pm-variant: unrecognised pm_prompt_variant value: "${requestedVariant}"\n` +
      `  Valid values: "lean" | "fat"\n`
    );
    process.exit(3);
  }

  // ── lean: no-op for pm.md content, but seed .pm-lean-hash if absent ────────
  if (requestedVariant === 'lean') {
    if (DRY_RUN) {
      process.stdout.write('[orchestray] apply-pm-variant: variant=lean — no change needed\n');
      process.exit(0);
    }
    // Seed hash reference for future fat→lean safety checks.
    if (agentsDir) {
      const pmPath = path.join(agentsDir, 'pm.md');
      if (fs.existsSync(pmPath)) {
        const storedHash = readLeanHash(stateDir);
        if (!storedHash) {
          const hash = hashFile(pmPath);
          writeLeanHash(stateDir, hash);
        }
        // Update variant marker to 'lean'.
        writeVariantMarker(stateDir, 'lean');
      }
    }
    process.stdout.write('[orchestray] apply-pm-variant: variant=lean — no change needed\n');
    process.exit(0);
  }

  // ── fat: switch pm.md to pm.old.md content ──────────────────────────────────

  // We need an agentsDir with both pm.md and pm.old.md.
  if (!agentsDir) {
    process.stderr.write(
      '[orchestray] apply-pm-variant: could not locate an Orchestray agents directory ' +
      '(requires both pm.md and pm.old.md) in any expected location\n'
    );
    process.exit(2);
  }

  const pmPath    = path.join(agentsDir, 'pm.md');
  const pmOldPath = path.join(agentsDir, 'pm.old.md');

  if (!fs.existsSync(pmOldPath)) {
    process.stderr.write(
      `[orchestray] apply-pm-variant: fat variant requested but agents/pm.old.md not found at ${pmOldPath}\n`
    );
    process.exit(2);
  }

  if (!fs.existsSync(pmPath)) {
    process.stderr.write(
      `[orchestray] apply-pm-variant: agents/pm.md not found at ${pmPath}\n`
    );
    process.exit(2);
  }

  // Idempotency check: already fat?
  const currentMarker = readVariantMarker(stateDir);
  if (currentMarker === 'fat') {
    process.stdout.write('[orchestray] apply-pm-variant: variant=fat — already applied, no-op\n');
    process.exit(0);
  }

  // Seed the lean hash reference on first-ever call (if not already stored).
  let storedLeanHash = readLeanHash(stateDir);
  const currentPmHash = hashFile(pmPath);
  if (!storedLeanHash) {
    // First-ever call: assume current pm.md IS the lean version and record its hash.
    if (!DRY_RUN) {
      writeLeanHash(stateDir, currentPmHash);
    }
    storedLeanHash = currentPmHash;
  }

  // Manual-edit guard: compare current pm.md hash vs stored lean hash.
  if (currentPmHash !== storedLeanHash) {
    if (!FORCE) {
      process.stderr.write(
        '[orchestray] apply-pm-variant: pm.md has been manually edited since the lean hash was recorded.\n' +
        '  Refusing to overwrite. Re-run with --force to override this guard.\n' +
        `  Stored lean hash : ${storedLeanHash}\n` +
        `  Current pm.md hash: ${currentPmHash}\n`
      );
      process.exit(1);
    }
    // --force: proceed with a warning.
    process.stderr.write(
      '[orchestray] apply-pm-variant: WARNING — pm.md has been manually edited. Overwriting due to --force.\n'
    );
  }

  if (DRY_RUN) {
    process.stdout.write(
      `[orchestray] apply-pm-variant: --dry-run — would copy pm.old.md → pm.md (variant=fat)\n`
    );
    process.exit(0);
  }

  // F019: pre-copy hash comparison — skip the write if pm.md already matches pm.old.md.
  const pmOldHash = hashFile(pmOldPath);
  if (currentPmHash === pmOldHash) {
    process.stdout.write('[orchestray] apply-pm-variant: pm.md already matches pm.old.md — no-op (content identical)\n');
    // Still update the marker so idempotency holds.
    writeVariantMarker(stateDir, 'fat');
    process.exit(0);
  }

  // Back up current pm.md to pm.md.bak before overwriting.
  const pmBakPath = path.join(agentsDir, 'pm.md.bak');
  try {
    fs.copyFileSync(pmPath, pmBakPath);
  } catch (_e) {
    // Backup failure is non-fatal — proceed anyway.
    process.stderr.write('[orchestray] apply-pm-variant: WARNING — could not write pm.md.bak backup\n');
  }

  // Copy pm.old.md → pm.md
  fs.copyFileSync(pmOldPath, pmPath);

  // Update state markers.
  writeVariantMarker(stateDir, 'fat');

  process.stdout.write('[orchestray] apply-pm-variant: variant=fat applied — pm.md replaced with pm.old.md content\n');
  process.exit(0);
}

main();
