#!/usr/bin/env node
'use strict';

/**
 * kb-refs-sweep.js — Dry-run broken KB reference detector.
 *
 * Scans .orchestray/kb/**\/*.md and .orchestray/patterns/**\/*.md for three
 * categories of broken references:
 *
 *   1. @orchestray:kb://<slug>      — slug must exist in kb/index.json
 *   2. @orchestray:pattern://<slug> — file must exist in patterns/ or shared/patterns/
 *   3. Bare-slug refs               — conservative "See also: <slug>"-style context only
 *
 * Outputs:
 *   - .orchestray/kb/artifacts/kb-sweep-{YYYYMMDD-HHMMZ}.md  (sweep report, UTC timestamp)
 *   - .orchestray/state/kb-sweep-snapshot.json               (machine-readable summary)
 *   - .orchestray/state/kb-sweep-last-run.json               (throttle stamp)
 *
 * Emits audit events via atomicAppendJsonl:
 *   kb_refs_sweep_complete | kb_refs_sweep_skipped
 *
 * CLI: node bin/kb-refs-sweep.js [--window-days=N] [--force] [--dry-run]
 *   --force         Skip throttle check (always run).
 *   --dry-run       Scan but do NOT write artefact, snapshot, or throttle stamp.
 *                   Useful for CI smoke tests.
 *   --window-days=N Days of throttle window (default: 1; production default: 7).
 *
 * Fail-open discipline: every error path records a degraded-journal entry and
 * exits 0. Never throws to the caller.
 *
 * v2.1.6 — W6 self-maintaining foundations (Pillar C).
 */

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { writeEvent }             = require('./_lib/audit-event-writer');
const { recordDegradation }       = require('./_lib/degraded-journal');
const { resolveSafeCwd }          = require('./_lib/resolve-project-cwd');
const { loadAutoLearningConfig }  = require('./_lib/config-schema');
const { detectAllBareSlugs }      = require('./_lib/kb-slug-detector');
const { readFileBounded }         = require('./_lib/file-read-bounded');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

/** Per-file read cap for .md files (512 KiB). Files larger than this are skipped. */
const MAX_MD_FILE_BYTES = 512 * 1024;

/** Default throttle window in days. */
const DEFAULT_WINDOW_DAYS = 1;

/**
 * Source strings for the per-line reference regexes.
 * Constructed per _scanFile call (not module-scope /g) to avoid the
 * SEC-06 .lastIndex statefulness footgun on future parallel refactors.
 */
const KB_REF_RE_SOURCE      = /@orchestray:kb:\/\/([A-Za-z0-9_-]+)/;
const PATTERN_REF_RE_SOURCE = /@orchestray:pattern:\/\/([A-Za-z0-9_-]+)/;

/**
 * Bare-slug detection is delegated to bin/_lib/kb-slug-detector.js (K4 two-signal rule).
 * A bare-slug reference is flagged only when BOTH signals fire:
 *   Signal 1: prefix phrase on the current or previous line, OR slug inside a link target.
 *   Signal 2: slug sits in a list item, table cell, or link target/title.
 * The ignore-list (from config + .orchestray/kb/slug-ignore.txt) is merged and injected
 * at scan time. See detectAllBareSlugs in kb-slug-detector.js for the full rule.
 */

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function _parseArgs(argv) {
  const args = { windowDays: DEFAULT_WINDOW_DAYS, force: false, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      const m = /^--window-days=(\d+)$/.exec(arg);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && n >= 1) args.windowDays = n;
      }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Timestamp helper
// ---------------------------------------------------------------------------

/**
 * Returns a UTC timestamp string YYYYMMDD-HHMMZ, consistent with the UTC ISO
 * string used in the generated_at frontmatter field. Avoids local-vs-UTC
 * mismatch on non-UTC servers.
 * @returns {string}
 */
function _nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    '-' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    'Z'
  );
}

// ---------------------------------------------------------------------------
// Atomic JSON write helper (tmp + rename)
// ---------------------------------------------------------------------------

function _atomicWriteJson(destPath, data) {
  // Include process.pid in tmp suffix to avoid collision under concurrent invocations.
  const tmp = destPath + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, destPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Throttle check
// ---------------------------------------------------------------------------

/**
 * Returns true if the sweep should be skipped (throttled).
 * If lastRunPath is unreadable, returns false (run is allowed).
 *
 * @param {string} lastRunPath
 * @param {number} windowDays
 * @returns {boolean}
 */
function _isThrottled(lastRunPath, windowDays) {
  try {
    const raw = fs.readFileSync(lastRunPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data.last_run_at) return false;
    const last = new Date(data.last_run_at).getTime();
    if (Number.isNaN(last)) return false;
    const diffDays = (Date.now() - last) / (1000 * 60 * 60 * 24);
    return diffDays < windowDays;
  } catch (_e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Audit event emitter
// ---------------------------------------------------------------------------

function _emitEvent(cwd, type, fields) {
  try {
    writeEvent(Object.assign({ type, schema_version: SCHEMA_VERSION }, fields), { cwd });
  } catch (_e) {
    // Audit failure is non-fatal.
  }
}

// ---------------------------------------------------------------------------
// File scanner helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under a directory.
 * Returns an empty array if the directory does not exist.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function _collectMdFiles(dir) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(..._collectMdFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
  } catch (_e) {
    // Missing directory — return empty.
  }
  return results;
}

/**
 * Sanitize a matched_text string for safe interpolation into a markdown table/list.
 * Replaces pipe chars (which break markdown tables), control chars, and newlines with
 * safe equivalents; truncates to 120 characters.
 *
 * @param {string} text
 * @returns {string}
 */
function _sanitizeMatchedText(text) {
  return String(text)
    .replace(/\|/g, '\\|')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 120);
}

/**
 * Scan a single file for broken references.
 *
 * Returns an array of finding objects:
 *   { source_file, line, matched_text, reference_type, target_slug, issue_reason }
 *
 * Skips the file silently if it cannot be read, recording a degraded-journal entry.
 * Skips files with malformed frontmatter but still scans the body lines.
 *
 * @param {string} filePath        - Absolute path to the .md file.
 * @param {Set<string>} kbSlugs    - Known KB slugs from index.json.
 * @param {Set<string>} patSlugs   - Known pattern slugs (from patterns/ + shared/patterns/).
 * @param {string} projectRoot     - For degraded-journal.
 * @param {string[]} [ignoreList]  - Slugs to suppress (merged from config + slug-ignore.txt).
 * @returns {{ findings: Array<object>, skippedMalformed: boolean }}
 */
function _scanFile(filePath, kbSlugs, patSlugs, projectRoot, ignoreList) {
  const findings = [];
  let skippedMalformed = false;
  const effectiveIgnoreList = Array.isArray(ignoreList) ? ignoreList : [];

  // C3-04: Guard against oversized files.
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_MD_FILE_BYTES) {
      recordDegradation({
        kind: 'kb_refs_sweep_file_oversize',
        severity: 'warn',
        detail: { file: filePath, size: stat.size, cap: MAX_MD_FILE_BYTES, dedup_key: 'oversize|' + filePath },
        projectRoot,
      });
      return { findings, skippedMalformed: false };
    }
  } catch (_statErr) {
    // stat failed (e.g., ENOENT) — let readFileSync handle it below.
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    recordDegradation({
      kind: 'kb_refs_sweep_file_read_error',
      severity: 'warn',
      detail: { file: filePath, error: String(err.message || err), dedup_key: filePath },
      projectRoot,
    });
    return { findings, skippedMalformed: false };
  }

  // Validate frontmatter presence (--- delimiters). If missing, note it but continue.
  const hasFrontmatter = /^---\r?\n[\s\S]*?\r?\n---/.test(content);
  if (!hasFrontmatter) {
    skippedMalformed = true;
    recordDegradation({
      kind: 'kb_refs_sweep_malformed_frontmatter',
      severity: 'info',
      detail: { file: filePath, dedup_key: 'malformed|' + filePath },
      projectRoot,
    });
    // Still scan the body for references — "malformed" only means no frontmatter.
  }

  const lines = content.split(/\r?\n/);

  // Track code-fence state so we do not flag slug-shaped identifiers inside fences.
  let inCodeFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Toggle code-fence state on ``` or ~~~ fence markers.
    if (/^```|^~~~/.test(line.trimStart())) {
      inCodeFence = !inCodeFence;
    }

    // --- @orchestray:kb://<slug> ---
    // Fresh regex instance per line — avoids SEC-06 .lastIndex statefulness.
    const kbRefRe = new RegExp(KB_REF_RE_SOURCE.source, 'g');
    let m;
    while ((m = kbRefRe.exec(line)) !== null) {
      const slug = m[1];
      if (!kbSlugs.has(slug)) {
        findings.push({
          source_file: filePath,
          line: lineNo,
          matched_text: m[0],
          reference_type: 'kb_ref',
          target_slug: slug,
          issue_reason: 'slug not in kb/index.json',
        });
      }
    }

    // --- @orchestray:pattern://<slug> ---
    const patRefRe = new RegExp(PATTERN_REF_RE_SOURCE.source, 'g');
    while ((m = patRefRe.exec(line)) !== null) {
      const slug = m[1];
      if (!patSlugs.has(slug)) {
        findings.push({
          source_file: filePath,
          line: lineNo,
          matched_text: m[0],
          reference_type: 'pattern_ref',
          target_slug: slug,
          issue_reason: 'no file for pattern slug',
        });
      }
    }

    // --- Bare-slug K4 two-signal scan ---
    // Skip bare-slug detection inside code fences (identifiers are not references).
    if (!inCodeFence) {
      const prevLine = i > 0 ? lines[i - 1] : '';
      const hits = detectAllBareSlugs(line, prevLine, false, effectiveIgnoreList);
      for (const hit of hits) {
        // Only flag if slug is not in either KB or patterns (same guard as before).
        if (!kbSlugs.has(hit.slug) && !patSlugs.has(hit.slug)) {
          findings.push({
            source_file: filePath,
            line: lineNo,
            matched_text: hit.slug,
            reference_type: 'bare_ref',
            target_slug: hit.slug,
            issue_reason: 'bare slug not found in kb/index.json or patterns/',
          });
        }
      }
    }
  }

  return { findings, skippedMalformed };
}

// ---------------------------------------------------------------------------
// Load KB slugs from index.json
// ---------------------------------------------------------------------------

/**
 * Load slug set from kb/index.json.
 * Returns null if the index file is missing or malformed.
 *
 * @param {string} kbDir
 * @returns {Set<string>|null}
 */
function _loadKbSlugs(kbDir) {
  const indexPath = path.join(kbDir, 'index.json');
  // SEC-04 / LOW-R2-01: use bounded fd-based read to eliminate stat→read TOCTOU.
  const MAX_INDEX_BYTES = 10 * 1024 * 1024;
  try {
    const readResult = readFileBounded(indexPath, MAX_INDEX_BYTES);
    if (!readResult.ok) {
      if (readResult.reason === 'file_too_large') {
        recordDegradation({
          kind: 'file_too_large',
          severity: 'warn',
          detail: { file: indexPath, size_hint: readResult.size_hint, cap_bytes: MAX_INDEX_BYTES },
        });
      } else {
        recordDegradation({
          kind: 'file_read_failed',
          severity: 'warn',
          detail: { file: indexPath, err: readResult.err },
        });
      }
      return null;
    }
    const raw = readResult.content;
    const index = JSON.parse(raw);
    const slugs = new Set();
    if (Array.isArray(index.entries)) {
      for (const entry of index.entries) {
        if (entry.slug) slugs.add(entry.slug);
        // Also accept `id` as an alternate slug field (some entries use `id`).
        if (entry.id) slugs.add(entry.id);
      }
    }
    return slugs;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load pattern slugs from local patterns/ and shared/patterns/
// ---------------------------------------------------------------------------

/**
 * Collect known pattern slugs from the project patterns dir and optional shared dir.
 *
 * @param {string} cwd
 * @returns {Set<string>}
 */
function _loadPatternSlugs(cwd) {
  const slugs = new Set();

  // Local patterns.
  const localPatternsDir = path.join(cwd, '.orchestray', 'patterns');
  try {
    const entries = fs.readdirSync(localPatternsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        slugs.add(e.name.slice(0, -3)); // strip .md
      }
    }
  } catch (_e) {
    // Missing dir is acceptable.
  }

  // Shared patterns (federation tier — optional).
  const sharedPatternsDir = process.env.ORCHESTRAY_TEST_SHARED_DIR
    ? path.join(process.env.ORCHESTRAY_TEST_SHARED_DIR, 'patterns')
    : path.join(os.homedir(), '.orchestray', 'shared', 'patterns');
  try {
    const entries = fs.readdirSync(sharedPatternsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        slugs.add(e.name.slice(0, -3));
      }
    }
  } catch (_e) {
    // Shared dir not set up — acceptable.
  }

  return slugs;
}

// ---------------------------------------------------------------------------
// Load slug ignore list from .orchestray/kb/slug-ignore.txt
// ---------------------------------------------------------------------------

/**
 * Load the per-project slug ignore list from `.orchestray/kb/slug-ignore.txt`.
 * Lines starting with `#` are comments. Blank lines are ignored.
 * Each entry must match /^[a-z][a-z0-9-]{3,40}$/ or it is silently skipped.
 *
 * Returns an empty array if the file does not exist or cannot be read.
 *
 * @param {string} kbDir - Absolute path to `.orchestray/kb/`.
 * @returns {string[]}
 */
function _loadSlugIgnoreFile(kbDir) {
  const slugShape = /^[a-z][a-z0-9-]{3,40}$/;
  const filePath = path.join(kbDir, 'slug-ignore.txt');
  // SEC-04 / LOW-R2-01: use bounded fd-based read to eliminate stat→read TOCTOU.
  const MAX_IGNORE_BYTES = 1 * 1024 * 1024;
  try {
    const readResult = readFileBounded(filePath, MAX_IGNORE_BYTES);
    if (!readResult.ok) {
      if (readResult.reason === 'read_failed') {
        // ENOENT is acceptable — ignore list may not exist.
        return [];
      }
      // file_too_large
      recordDegradation({
        kind: 'file_too_large',
        severity: 'warn',
        detail: { file: filePath, size_hint: readResult.size_hint, cap_bytes: MAX_IGNORE_BYTES },
      });
      return [];
    }
    const raw = readResult.content;
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'))
      .filter((l) => slugShape.test(l));
  } catch (_e) {
    // File missing or unreadable — acceptable.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Artefact writers
// ---------------------------------------------------------------------------

/**
 * Format findings as a markdown table section.
 *
 * @param {string} title
 * @param {Array<object>} findings
 * @param {string} projectRoot  - For path relativization in display.
 * @returns {string}
 */
function _findingsTable(title, findings, projectRoot) {
  if (findings.length === 0) {
    return `### ${title}\n\nNo broken references found.\n`;
  }

  const rows = findings
    .map((f) => {
      const relPath = path.relative(projectRoot, f.source_file);
      return `| \`${relPath}\` | ${f.line} | \`${f.reference_type}\` | \`${f.target_slug}\` | ${f.issue_reason} |`;
    })
    .join('\n');

  return (
    `### ${title}\n\n` +
    `| Source | Line | Type | Target | Reason |\n` +
    `|--------|------|------|--------|--------|\n` +
    rows +
    '\n'
  );
}

/**
 * Build the sweep-report artefact body and write it atomically.
 *
 * @param {object} params
 * @param {string} params.artefactPath
 * @param {string} params.generatedAt
 * @param {Array<object>} params.brokenKbRefs
 * @param {Array<object>} params.brokenPatternRefs
 * @param {Array<object>} params.brokenBareRefs
 * @param {number} params.filesScanned
 * @param {string} params.projectRoot
 */
function _writeArtefact(params) {
  const {
    artefactPath,
    generatedAt,
    brokenKbRefs,
    brokenPatternRefs,
    brokenBareRefs,
    filesScanned,
    projectRoot,
  } = params;

  const totalBroken = brokenKbRefs.length + brokenPatternRefs.length + brokenBareRefs.length;

  const frontmatter = [
    '---',
    'status: sweep-report',
    'enforced: false',
    'source: kb-refs-sweep',
    `generated_at: ${generatedAt}`,
    `broken_kb_refs: ${brokenKbRefs.length}`,
    `broken_pattern_refs: ${brokenPatternRefs.length}`,
    `broken_bare_refs: ${brokenBareRefs.length}`,
    `files_scanned: ${filesScanned}`,
    `schema_version: ${SCHEMA_VERSION}`,
    '---',
  ].join('\n');

  const summary =
    `KB reference sweep scanned ${filesScanned} markdown file(s) and found ` +
    `${totalBroken} broken reference(s): ` +
    `${brokenKbRefs.length} broken @orchestray:kb:// ref(s), ` +
    `${brokenPatternRefs.length} broken @orchestray:pattern:// ref(s), ` +
    `${brokenBareRefs.length} broken bare-slug ref(s). ` +
    `This report is informational only — no files were modified.`;

  const kbTable = _findingsTable('Broken `@orchestray:kb://` References', brokenKbRefs, projectRoot);
  const patTable = _findingsTable('Broken `@orchestray:pattern://` References', brokenPatternRefs, projectRoot);
  const bareTable = _findingsTable('Broken Bare-Slug References', brokenBareRefs, projectRoot);

  let suggestedActions = '## Suggested Actions\n\n';
  if (totalBroken === 0) {
    suggestedActions += 'No broken references found. No action required.\n';
  } else {
    suggestedActions += '_SUGGESTED — NOT APPLIED_\n\n';
    for (const f of [...brokenKbRefs, ...brokenPatternRefs, ...brokenBareRefs]) {
      const relPath = path.relative(projectRoot, f.source_file);
      // C3-02: sanitize matched_text to prevent pipe chars / newlines from distorting markdown.
      const safeText = _sanitizeMatchedText(f.matched_text);
      suggestedActions +=
        `- Fix: update \`${relPath}:${f.line}\` to reference existing slug or remove the link ` +
        `(broken ref: \`${safeText}\`)\n`;
    }
  }

  const body = [
    `# KB Reference Sweep Report`,
    '',
    `## Summary`,
    '',
    summary,
    '',
    `## Broken References`,
    '',
    kbTable,
    patTable,
    bareTable,
    suggestedActions,
  ].join('\n');

  const content = frontmatter + '\n\n' + body;

  // Include process.pid in tmp suffix to avoid collision under concurrent invocations.
  const tmp = artefactPath + '.tmp.' + process.pid;
  try {
    fs.mkdirSync(path.dirname(artefactPath), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, artefactPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* swallow */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Read-only invariant guard (for tests)
// ---------------------------------------------------------------------------

/**
 * Snapshot {file → mtime+size} for a list of files.
 * Used only in tests to assert no KB/patterns files were modified.
 * Exported for test access.
 *
 * @param {string[]} files
 * @returns {Map<string, {mtimeMs: number, size: number}>}
 */
function _snapshotFiles(files) {
  const snap = new Map();
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      snap.set(f, { mtimeMs: st.mtimeMs, size: st.size });
    } catch (_e) {
      snap.set(f, null);
    }
  }
  return snap;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run the KB refs sweep.
 *
 * @param {object} [options]
 * @param {string}  [options.cwd]         - Override project root (for tests).
 * @param {number}  [options.windowDays]  - Throttle window in days (default: 1).
 * @param {boolean} [options.force]       - Skip throttle check.
 * @param {boolean} [options.dryRun]      - Scan only; do not write artefact/snapshot/stamp.
 * @returns {Promise<{
 *   status: 'complete'|'skipped',
 *   reason?: string,
 *   artefactPath?: string,
 *   filesScanned?: number,
 *   brokenKbRefs?: number,
 *   brokenPatternRefs?: number,
 *   brokenBareRefs?: number,
 * }>}
 */
async function runKbRefsSweep(options = {}) {
  const windowDays = options.windowDays != null ? options.windowDays : DEFAULT_WINDOW_DAYS;
  const force      = Boolean(options.force);
  const dryRun     = Boolean(options.dryRun);

  // Resolve project root.
  let cwd;
  try {
    if (options.cwd) {
      cwd = options.cwd;
    } else {
      // resolveSafeCwd accepts a string path.
      cwd = resolveSafeCwd(process.cwd());
    }
  } catch (err) {
    recordDegradation({ kind: 'kb_refs_sweep_init_error', severity: 'warn', detail: { error: String(err) } });
    return { status: 'skipped', reason: 'error' };
  }

  const kbDir       = path.join(cwd, '.orchestray', 'kb');
  const stateDir    = path.join(cwd, '.orchestray', 'state');
  const lastRunPath = path.join(stateDir, 'kb-sweep-last-run.json');

  // Config gate (W10 deferred from W7): honour auto_learning flags.
  // Fail-open: any error loading config allows the run to proceed.
  // Also collect config-level ignore_slugs for the bare-slug detector.
  let configIgnoreSlugs = [];
  try {
    const alConfig = loadAutoLearningConfig(cwd);
    if (alConfig.global_kill_switch) {
      _emitEvent(cwd, 'kb_refs_sweep_skipped', { reason: 'kill_switch' });
      return { status: 'skipped', reason: 'kill_switch' };
    }
    if (!alConfig.kb_refs_sweep.enabled && !force) {
      _emitEvent(cwd, 'kb_refs_sweep_skipped', { reason: 'feature_disabled' });
      return { status: 'skipped', reason: 'feature_disabled' };
    }
    if (Array.isArray(alConfig.kb_refs_sweep.ignore_slugs)) {
      configIgnoreSlugs = alConfig.kb_refs_sweep.ignore_slugs;
    }
  } catch (_configErr) {
    // Fail-open: if config loading throws, proceed with the run.
  }

  // Check KB directory exists.
  try {
    fs.accessSync(kbDir);
  } catch (_e) {
    _emitEvent(cwd, 'kb_refs_sweep_skipped', { reason: 'no_kb' });
    return { status: 'skipped', reason: 'no_kb' };
  }

  // Check index.json exists.
  const kbSlugs = _loadKbSlugs(kbDir);
  if (kbSlugs === null) {
    _emitEvent(cwd, 'kb_refs_sweep_skipped', { reason: 'no_index' });
    return { status: 'skipped', reason: 'no_index' };
  }

  // Throttle check.
  if (!force && _isThrottled(lastRunPath, windowDays)) {
    _emitEvent(cwd, 'kb_refs_sweep_skipped', { reason: 'throttled' });
    return { status: 'skipped', reason: 'throttled' };
  }

  // Load known pattern slugs.
  const patSlugs = _loadPatternSlugs(cwd);

  // Merge ignore list: config value + per-project slug-ignore.txt file.
  // File takes precedence as the per-project escape hatch; config is the JSON-based option.
  const fileIgnoreSlugs = _loadSlugIgnoreFile(kbDir);
  const mergedIgnoreList = Array.from(new Set([...configIgnoreSlugs, ...fileIgnoreSlugs]));

  // Collect all .md files to scan.
  const kbFiles       = _collectMdFiles(kbDir);
  const patternFiles  = _collectMdFiles(path.join(cwd, '.orchestray', 'patterns'));
  const allFiles      = [...kbFiles, ...patternFiles];

  // Run scan.
  const brokenKbRefs      = [];
  const brokenPatternRefs = [];
  const brokenBareRefs    = [];

  for (const file of allFiles) {
    const { findings } = _scanFile(file, kbSlugs, patSlugs, cwd, mergedIgnoreList);
    for (const f of findings) {
      if (f.reference_type === 'kb_ref') {
        brokenKbRefs.push(f);
      } else if (f.reference_type === 'pattern_ref') {
        brokenPatternRefs.push(f);
      } else {
        brokenBareRefs.push(f);
      }
    }
  }

  if (dryRun) {
    return {
      status: 'complete',
      dryRun: true,
      filesScanned: allFiles.length,
      brokenKbRefs: brokenKbRefs.length,
      brokenPatternRefs: brokenPatternRefs.length,
      brokenBareRefs: brokenBareRefs.length,
    };
  }

  // Write artefact.
  const generatedAt  = new Date().toISOString();
  const stamp        = _nowStamp();
  const artefactPath = path.join(kbDir, 'artifacts', `kb-sweep-${stamp}.md`);

  try {
    _writeArtefact({
      artefactPath,
      generatedAt,
      brokenKbRefs,
      brokenPatternRefs,
      brokenBareRefs,
      filesScanned: allFiles.length,
      projectRoot: cwd,
    });
  } catch (err) {
    recordDegradation({
      kind: 'kb_refs_sweep_write_error',
      severity: 'warn',
      detail: { error: String(err.message || err), dedup_key: 'sweep-write-' + stamp },
      projectRoot: cwd,
    });
    _emitEvent(cwd, 'kb_refs_sweep_skipped', { reason: 'error' });
    return { status: 'skipped', reason: 'error' };
  }

  // Write snapshot JSON (machine-readable summary).
  const snapshotPath = path.join(stateDir, 'kb-sweep-snapshot.json');
  try {
    _atomicWriteJson(snapshotPath, {
      generated_at: generatedAt,
      schema_version: SCHEMA_VERSION,
      files_scanned: allFiles.length,
      broken_kb_refs: brokenKbRefs,
      broken_pattern_refs: brokenPatternRefs,
      broken_bare_refs: brokenBareRefs,
    });
  } catch (err) {
    // Non-fatal: artefact was written; snapshot failure is degraded-only.
    recordDegradation({
      kind: 'kb_refs_sweep_snapshot_error',
      severity: 'info',
      detail: { error: String(err.message || err), dedup_key: 'sweep-snapshot-' + stamp },
      projectRoot: cwd,
    });
  }

  // Write throttle stamp.
  try {
    _atomicWriteJson(lastRunPath, { last_run_at: generatedAt, schema_version: SCHEMA_VERSION });
  } catch (_err) {
    // Non-fatal: sweep ran; throttle just won't be enforced for this run.
  }

  // Emit audit event.
  _emitEvent(cwd, 'kb_refs_sweep_complete', {
    files_scanned: allFiles.length,
    broken_kb_refs: brokenKbRefs.length,
    broken_pattern_refs: brokenPatternRefs.length,
    broken_bare_refs: brokenBareRefs.length,
    artefact_path: artefactPath,
    schema_version: SCHEMA_VERSION,
  });

  return {
    status: 'complete',
    artefactPath,
    filesScanned: allFiles.length,
    brokenKbRefs: brokenKbRefs.length,
    brokenPatternRefs: brokenPatternRefs.length,
    brokenBareRefs: brokenBareRefs.length,
  };
}

// ---------------------------------------------------------------------------
// Module exports (including test-only helpers)
// ---------------------------------------------------------------------------

module.exports = {
  runKbRefsSweep,
  // Exported for test isolation only:
  _isThrottled,
  _loadKbSlugs,
  _loadSlugIgnoreFile,
  _loadPatternSlugs,
  _snapshotFiles,
  _collectMdFiles,
  _scanFile,
  _writeArtefact,
  _nowStamp,
};

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const args = _parseArgs(process.argv);

  runKbRefsSweep({
    windowDays: args.windowDays,
    force: args.force,
    dryRun: args.dryRun,
  })
    .then((result) => {
      if (result.status === 'skipped') {
        process.stderr.write(`[kb-refs-sweep] skipped (reason: ${result.reason})\n`);
      } else {
        process.stderr.write(
          `[kb-refs-sweep] complete: ${result.filesScanned} file(s) scanned, ` +
          `${result.brokenKbRefs} broken kb, ` +
          `${result.brokenPatternRefs} broken pattern, ` +
          `${result.brokenBareRefs} broken bare refs\n`
        );
        if (result.artefactPath) {
          process.stderr.write(`[kb-refs-sweep] report: ${result.artefactPath}\n`);
        }
      }
      process.exit(0);
    })
    .catch((err) => {
      recordDegradation({ kind: 'kb_refs_sweep_uncaught', severity: 'warn', detail: { error: String(err) } });
      process.stderr.write('[kb-refs-sweep] uncaught error (fail-open): ' + String(err) + '\n');
      process.exit(0);
    });
}
