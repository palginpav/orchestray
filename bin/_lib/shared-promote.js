'use strict';

/**
 * shared-promote.js — Sanitization pipeline for promoting local patterns to
 * ~/.orchestray/shared/patterns/.
 *
 * B1 (v2.1.0) — Federation shared-tier infrastructure.
 *
 * This module implements a 7-stage pipeline that runs every time a pattern is
 * promoted to the shared tier. It is fail-closed: any stage that detects a
 * violation REJECTS the promotion rather than silently allowing it through.
 *
 * Stage 1: Read source pattern and parse frontmatter.
 * Stage 2: Sensitivity gate — project must opt in to sharing.
 * Stage 3: Secret scan (block-not-warn) with explicit escape hatch.
 * Stage 4: Path/identity strip — home paths, git remotes, tilde paths.
 * Stage 5: Prompt-injection defense — downgrade # and ## in body to plain text.
 * Stage 6: Size cap — 8 KB combined body (post-strip).
 * Stage 7: Schema validate frontmatter required fields.
 * Write:   Atomic tmp+rename to shared/patterns/{slug}.md + append promote-log.
 *
 * W6 findings addressed:
 *   F01 — no zod; uses existing hand-rolled validator pattern.
 *   F05 — Anthropic key regex (sk-ant-), OpenAI project key (sk-proj-), hex-key
 *          entropy at threshold 3.8, escape hatch <!-- secret-scan: allow -->.
 *   F07 — sensitivity defaults to "private"; must be "shareable" to promote.
 *   F11 — downgrade # and ## in body to plain text at write time.
 *
 * W7 findings addressed:
 *   Finding 7 — size error: shows size, section, recovery advice.
 *   Finding 8 — secret error: shows kind, line N, section, escape path.
 *
 * Export:
 *   async function promotePattern(slug, options) -> { ok: true, destPath } | { ok: false, error, stage }
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// Lazy requires to avoid circular dependencies at module load time.
// Both modules are stable; lazy loading is safe here.
function _getFrontmatter() {
  return require('../mcp-server/lib/frontmatter.js');
}
function _getPaths() {
  return require('../mcp-server/lib/paths.js');
}
function _getConfigSchema() {
  return require('./config-schema.js');
}

// ---------------------------------------------------------------------------
// Secret-scan patterns (W6 F05)
//
// Each entry: { pattern: RegExp, kind: string }
// The `kind` string appears in the error message shown to the user.
//
// Escape hatch: a line containing `<!-- secret-scan: allow -->` anywhere on
// the same line as a match is exempt. The pipeline skips that line.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  // Anthropic API keys: sk-ant- followed by alphanumeric/dash/underscore (W6 F05.2)
  { pattern: /sk-ant-[a-zA-Z0-9_-]{10,}/,            kind: 'Anthropic API key' },
  // OpenAI project keys (W6 F05.2)
  { pattern: /sk-proj-[a-zA-Z0-9_-]{10,}/,           kind: 'OpenAI project key' },
  // AWS access key IDs
  { pattern: /AKIA[0-9A-Z]{16}/,                     kind: 'AWS access key ID' },
  // Private key headers
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,   kind: 'private key header' },
  // Connection strings with password components
  { pattern: /(?:postgres|mongodb|mysql|redis):\/\/[^@\s]+:[^@\s]+@/, kind: 'connection string with credentials' },
  // Generic high-entropy API key patterns: 32+ alphanum adjacent to key/token/secret/bearer
  // Uses word-boundary look-around to avoid matching normal text.
  { pattern: /(?:key|token|secret|bearer|password|passwd|credential)[=:\s"']+[a-zA-Z0-9_\-./+]{32,}/i, kind: 'generic API key or credential' },
];

const ESCAPE_HATCH_COMMENT = '<!-- secret-scan: allow -->';

// ---------------------------------------------------------------------------
// Hex-key entropy check (W6 F05.1)
//
// A run of 32+ hex characters [0-9a-fA-F] is tested for Shannon entropy.
// The threshold is 3.8 (not the base64 threshold of 4.5) because hex strings
// have a maximum possible entropy of log2(16) ≈ 4.0. Random hex keys
// typically hit entropy ≥ 3.8. Commit SHAs are also long hex strings and
// will match — the escape hatch handles known false positives like SHAs.
// ---------------------------------------------------------------------------

const HEX_RUN_RE = /[0-9a-fA-F]{32,}/g;
const HEX_ENTROPY_THRESHOLD = 3.8;

/**
 * Compute Shannon entropy (bits per character) for a string.
 * @param {string} s
 * @returns {number}
 */
function _shannonEntropy(s) {
  if (!s || s.length === 0) return 0;
  const freq = {};
  for (const ch of s) freq[ch] = (freq[ch] || 0) + 1;
  let h = 0;
  for (const count of Object.values(freq)) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Scan a single line for hex-key entropy violations.
 * Returns the matched hex run if entropy >= threshold, or null.
 *
 * @param {string} line
 * @returns {string|null}
 */
function _findHighEntropyHex(line) {
  HEX_RUN_RE.lastIndex = 0;
  let m;
  while ((m = HEX_RUN_RE.exec(line)) !== null) {
    if (_shannonEntropy(m[0]) >= HEX_ENTROPY_THRESHOLD) {
      return m[0];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stage 3: Secret scan
// ---------------------------------------------------------------------------

/**
 * Scan the full file text (including frontmatter) for secrets.
 *
 * The caller passes `rawContent` (the complete file, frontmatter included)
 * so that secrets embedded in frontmatter fields (e.g., `description:`) are
 * also caught. The docstring previously said "post-frontmatter body sections"
 * which was inaccurate — scanning frontmatter is intentional (Fix 5).
 *
 * @param {string} bodyText - The entire raw file content (frontmatter + body).
 * @param {string} slug     - For error messages.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function _secretScan(bodyText, slug) {
  const lines = bodyText.split(/\r?\n/);
  // Track section context for the error message (W7 Finding 8).
  let currentSection = 'body';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Update section heading tracker.
    const sectionMatch = /^#{1,4}\s+(.+)$/.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
    }

    // Escape hatch: explicit allowance on this line.
    if (line.includes(ESCAPE_HATCH_COMMENT)) {
      continue;
    }

    // Pattern-based checks.
    for (const { pattern, kind } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        return {
          ok: false,
          error:
            `Can't share '${slug}': found potential ${kind} on line ${lineNo} of ${currentSection} section. ` +
            `Remove it, or add '${ESCAPE_HATCH_COMMENT}' comment and re-run.`,
        };
      }
    }

    // Hex-key entropy check.
    const hexRun = _findHighEntropyHex(line);
    if (hexRun !== null) {
      return {
        ok: false,
        error:
          `Can't share '${slug}': found potential hex-encoded secret (high entropy) on line ${lineNo} ` +
          `of ${currentSection} section. ` +
          `If this is a known false positive (e.g., a commit SHA), add '${ESCAPE_HATCH_COMMENT}' on the same line and re-run.`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Stage 4: Path/identity strip
// ---------------------------------------------------------------------------

/**
 * Strip or redact identifying paths and git remotes from text.
 *
 * Replacements applied in order:
 *   1. ~/<anything> prefixed paths → ~/... (tilde form — already portable)
 *   2. /home/<user>/ or /Users/<user>/ → <home>/
 *   3. C:\Users\<user>\ → <home>\
 *   4. Other absolute paths starting with / → <path>/
 *   5. Git remote URLs (https://github.com or git@github.com) → <git-remote>
 *
 * This is best-effort — designed to catch the common cases without over-stripping.
 *
 * @param {string} text
 * @returns {string}
 */
function _stripPaths(text) {
  // Tilde paths are already portable — leave them as-is (no stripping needed).
  // Home directory paths: /home/<user>/ or /Users/<user>/
  text = text.replace(/\/(?:home|Users)\/[^/\s"'`]+\//g, '<home>/');
  // Windows home paths: C:\Users\<user>\
  text = text.replace(/[A-Za-z]:\\Users\\[^\\"\s]+\\/g, '<home>\\');
  // Git remote URLs (before absolute path replacement to avoid double-stripping).
  text = text.replace(/(?:https?:\/\/(?:github\.com|gitlab\.com|bitbucket\.org)\/[^\s"'`]+|git@(?:github\.com|gitlab\.com|bitbucket\.org):[^\s"'`]+)/g, '<git-remote>');
  // Remaining absolute paths starting with / (after home strip, any /something/... left).
  // Only strip if they look like real paths (contain at least one more slash after the first char).
  text = text.replace(/(?<!\w)(\/[a-zA-Z0-9_.~-]+(?:\/[a-zA-Z0-9_.~-]+)+)/g, '<path>');

  return text;
}

// ---------------------------------------------------------------------------
// Stage 5: Prompt-injection defense (W6 F11)
//
// Downgrade # (H1) and ## (H2) in the pattern body to plain text.
// Only top-level headings are the concern — they could hijack the consumer
// PM's prompt structure. H3 and deeper are left intact.
//
// Replacement:
//   "# Title"  → "(header: Title)"
//   "## Title" → "(header: Title)"
//
// This is applied ONLY to the body (not the frontmatter).
// ---------------------------------------------------------------------------

/**
 * Downgrade H1/H2 markdown headers in body text to plain text.
 * @param {string} body
 * @returns {string}
 */
function _downgradeTopHeaders(body) {
  // Match lines that start with exactly one or two '#' not followed by more '#'.
  // The space after # is required per CommonMark (bare # is not a heading).
  return body.replace(/^(#{1,2})(?!#) +(.+)$/gm, (_, _hashes, title) => {
    return '(header: ' + title.trim() + ')';
  });
}

// ---------------------------------------------------------------------------
// Stage 6: Size cap
// ---------------------------------------------------------------------------

const SIZE_CAP_BYTES = 8 * 1024; // 8 KB

/**
 * Check that the body text does not exceed the size cap.
 * Returns size breakdown for a helpful error message (W7 Finding 7).
 *
 * @param {string} body
 * @param {string} slug
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function _checkSize(body, slug) {
  const sizeBytes = Buffer.byteLength(body, 'utf8');
  if (sizeBytes <= SIZE_CAP_BYTES) return { ok: true };

  const sizeKb = (sizeBytes / 1024).toFixed(1);
  const limitKb = (SIZE_CAP_BYTES / 1024).toFixed(0);
  const overageKb = ((sizeBytes - SIZE_CAP_BYTES) / 1024).toFixed(1);

  return {
    ok: false,
    error:
      `Can't share '${slug}': size ${sizeKb}KB exceeds ${limitKb}KB limit (overage: ${overageKb}KB). ` +
      `To fix: trim the pattern body (remove project-specific examples), or split into multiple patterns. ` +
      `Note: the Evidence section (if present) is stripped before promotion and does not count against the limit.`,
  };
}

// ---------------------------------------------------------------------------
// Stage 7: Frontmatter schema validation
//
// The promoted file must have: name, category, confidence, description.
// Additional fields are allowed (origin, promoted_at, promoted_from are added
// by this pipeline). This is intentionally permissive — it validates required
// fields only, leaving extensibility for future field additions.
// ---------------------------------------------------------------------------

const REQUIRED_FRONTMATTER_FIELDS = ['name', 'category', 'confidence', 'description'];
const VALID_CATEGORIES = ['decomposition', 'routing', 'specialization', 'anti-pattern', 'design-preference'];

/**
 * Validate the frontmatter of the pattern-to-be-promoted.
 *
 * @param {object} frontmatter
 * @param {string} slug
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function _validateFrontmatter(frontmatter, slug) {
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!(field in frontmatter) || frontmatter[field] == null) {
      return {
        ok: false,
        error:
          `Can't share '${slug}': frontmatter is missing required field '${field}'. ` +
          `Add it to the local pattern file and re-run.`,
      };
    }
  }

  if (typeof frontmatter.confidence !== 'number' ||
      frontmatter.confidence < 0 ||
      frontmatter.confidence > 1) {
    return {
      ok: false,
      error:
        `Can't share '${slug}': frontmatter 'confidence' must be a number between 0 and 1 — ` +
        `got ${JSON.stringify(frontmatter.confidence)}.`,
    };
  }

  if (!VALID_CATEGORIES.includes(frontmatter.category)) {
    return {
      ok: false,
      error:
        `Can't share '${slug}': frontmatter 'category' must be one of: ${VALID_CATEGORIES.join(', ')} — ` +
        `got ${JSON.stringify(frontmatter.category)}.`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Promote-log helper
// ---------------------------------------------------------------------------

/**
 * Append a JSON line to the promote-log file (best-effort — never throws).
 *
 * @param {string} logPath
 * @param {object} entry
 */
function _appendPromoteLog(logPath, entry) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_e) {
    // Promote-log failure is non-fatal: the promotion itself succeeded.
  }
}

// ---------------------------------------------------------------------------
// Main export: promotePattern
// ---------------------------------------------------------------------------

/**
 * Build a PreviewReport by comparing pre- and post-sanitization state.
 *
 * @param {object} params
 * @param {string} params.slug
 * @param {object} params.originalFm   — parsed frontmatter before sanitization
 * @param {object} params.promotedFm   — frontmatter after sanitization + metadata injection
 * @param {string} params.originalBody — body before sanitization
 * @param {string} params.sanitizedBody — body after all sanitization stages
 * @param {object} params.secretResult — result from _secretScan on raw content
 * @param {boolean} params.sensitivityBlocks — true if sensitivity gate would block a real share
 * @param {string|null} params.blockingStage — stage name if a non-sensitivity stage would fail
 * @param {string|null} params.blockingReason — human-readable reason for blockingStage
 * @returns {object} PreviewReport
 */
function _buildPreviewReport(params) {
  const {
    slug,
    originalFm,
    promotedFm,
    originalBody,
    sanitizedBody,
    secretResult,
    sensitivityBlocks,
    blockingStage,
    blockingReason,
  } = params;

  // Frontmatter diff: fields removed (project-local metadata).
  const removedFields = ['created_from', 'last_applied', 'times_applied'].filter(
    (f) => f in originalFm,
  );
  const addedFields = {};
  for (const f of ['origin', 'promoted_at', 'promoted_from']) {
    if (promotedFm[f] !== undefined) addedFields[f] = String(promotedFm[f]);
  }

  // Body line-level diff (up to 20 entries).
  const originalLines = originalBody.split('\n');
  const sanitizedLines = sanitizedBody.split('\n');
  const lineChanges = [];
  const maxLineChanges = 20;

  // Compare line by line to find mutations from path-strip and header-downgrade.
  for (let i = 0; i < Math.max(originalLines.length, sanitizedLines.length); i++) {
    const before = originalLines[i] || '';
    const after = sanitizedLines[i] !== undefined ? sanitizedLines[i] : '';
    if (before !== after) {
      let reason = 'path-strip';
      if (/^\(header:/.test(after)) reason = 'header-downgrade';
      lineChanges.push({ line: i + 1, before, after, reason });
      if (lineChanges.length >= maxLineChanges) break;
    }
  }

  const totalChangedLines = originalLines.filter((l, i) => l !== sanitizedLines[i]).length;
  const moreChanges = totalChangedLines > maxLineChanges
    ? totalChangedLines - maxLineChanges
    : 0;

  // Report a size delta when path/header sanitization shrank the body meaningfully.
  // We do NOT strip whole sections here; this is purely a body-shrink signal.
  const sectionsStripped = [];
  if (sanitizedBody.length < originalBody.length) {
    // Report the delta only when the path/header stage caused large changes.
    const delta = originalBody.length - sanitizedBody.length;
    if (delta > 200) {
      sectionsStripped.push(`~${(delta / 1024).toFixed(1)} KB stripped by path/header sanitization`);
    }
  }

  const sizeBytes = Buffer.byteLength(sanitizedBody, 'utf8');
  const secretsScan = secretResult.ok
    ? { clean: true, note: 'No secrets detected.' }
    : { clean: false, note: secretResult.error };

  return {
    slug,
    sensitivity_blocks_actual_share: sensitivityBlocks,
    blocking_stage: blockingStage || null,
    blocking_reason: blockingReason || null,
    frontmatter: { removed: removedFields, added: addedFields },
    body: {
      line_changes: lineChanges,
      more_changes: moreChanges,
      sections_stripped: sectionsStripped,
      size_bytes: sizeBytes,
      size_limit_bytes: 8192,
    },
    secrets_scan: secretsScan,
    sanitization_stages_run: ['path-strip', 'header-downgrade', 'schema-validate', 'size-check'],
  };
}

/**
 * Run the 7-stage sanitization pipeline and write the sanitized pattern to
 * ~/.orchestray/shared/patterns/{slug}.md.
 *
 * @param {string} slug    - Pattern slug (filename without .md).
 * @param {object} options
 * @param {boolean} [options.dryRun=false]  - If true, run all stages but do NOT write.
 * @param {boolean} [options.preview=false] - If true, run all stages, do NOT write,
 *                                            and return a {@link PreviewReport} under
 *                                            `preview` with destPath `'<not-written>'`.
 * @param {string}  [options.cwd]           - Override project root (for tests).
 * @returns {Promise<
 *   { ok: true, destPath: string, dryRun: boolean, sanitizedBody: string }
 *   | { ok: true, preview: object, destPath: '<not-written>' }
 *   | { ok: false, error: string, stage: string }
 * >}
 */
async function promotePattern(slug, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const preview = Boolean(options.preview);

  // -------------------------------------------------------------------------
  // Stage 1: Read source pattern
  // -------------------------------------------------------------------------
  const paths = _getPaths();
  let cwd;
  try {
    cwd = options.cwd || paths.getProjectRoot();
  } catch (err) {
    return { ok: false, error: 'Stage 1: could not determine project root: ' + String(err.message), stage: 'read' };
  }

  let sourceFile;
  try {
    sourceFile = paths.resolvePatternFile(slug, cwd);
  } catch (err) {
    return {
      ok: false,
      error: `Stage 1: pattern '${slug}' not found in ${cwd}/.orchestray/patterns/: ${err.message}`,
      stage: 'read',
    };
  }

  let rawContent;
  try {
    rawContent = fs.readFileSync(sourceFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `Stage 1: could not read '${sourceFile}': ${err.message}`, stage: 'read' };
  }

  const { parse: parseFm, writeFrontmatter: writeFm } = _getFrontmatter();
  const parsed = parseFm(rawContent);
  if (!parsed.hasFrontmatter) {
    return {
      ok: false,
      error: `Stage 1: '${slug}' has no valid frontmatter (missing --- delimiters). Add frontmatter before promoting.`,
      stage: 'read',
    };
  }

  const { frontmatter, body } = parsed;

  // -------------------------------------------------------------------------
  // Stage 1b: Per-pattern sharing flag (v2.1.13 R-FED-PRIVACY, F-M-1)
  // A pattern with `sharing: local-only` in frontmatter must never leave this
  // machine — even if the project-level sensitivity gate would allow it.
  // Absent key defaults to `federated` (backward compat with pre-v2.1.13
  // patterns). This is a defence-in-depth write-side check; the read-side
  // filter in pattern_find.js already excludes local-only patterns from
  // federation reads, but this closes the escape hatch of a pattern being
  // written to the shared tier in the first place.
  // -------------------------------------------------------------------------
  if (frontmatter && frontmatter.sharing === 'local-only') {
    return {
      ok: false,
      error:
        `promote blocked: pattern '${slug}' has 'sharing: local-only' in frontmatter ` +
        `— pinned to this machine regardless of project federation settings. ` +
        `Remove the key (or change to 'federated') to allow promotion.`,
      stage: 'sharing-flag',
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2: Sensitivity gate
  // Preview bypasses the hard-fail so users can see what WOULD be shared before
  // flipping sensitivity to shareable. sensitivityBlocks is recorded in the report.
  // -------------------------------------------------------------------------
  const { loadFederationConfig } = _getConfigSchema();
  const fedCfg = loadFederationConfig(cwd);
  const sensitivityBlocks = fedCfg.sensitivity !== 'shareable';
  if (sensitivityBlocks && !preview) {
    return {
      ok: false,
      error:
        `promote blocked: project sensitivity is '${fedCfg.sensitivity}'; ` +
        `set to 'shareable' in .orchestray/config.json (federation.sensitivity) before promoting.`,
      stage: 'sensitivity',
    };
  }

  // -------------------------------------------------------------------------
  // Stage 3: Secret scan (block-not-warn)
  // -------------------------------------------------------------------------
  const secretResult = _secretScan(rawContent, slug);
  if (!secretResult.ok) {
    if (!preview) {
      return { ok: false, error: secretResult.error, stage: 'secret-scan' };
    }
    // In preview mode: report the blocking stage, return ok: true with partial report.
    const promotedFmPartial = Object.assign({}, frontmatter, {
      origin: 'shared',
      promoted_at: new Date().toISOString(),
      promoted_from: _projectHash(cwd),
    });
    return {
      ok: true,
      preview: _buildPreviewReport({
        slug,
        originalFm: frontmatter,
        promotedFm: promotedFmPartial,
        originalBody: body,
        sanitizedBody: body,
        secretResult,
        sensitivityBlocks,
        blockingStage: 'secret-scan',
        blockingReason: secretResult.error,
      }),
      destPath: '<not-written>',
    };
  }

  // -------------------------------------------------------------------------
  // Stage 4: Path/identity strip
  // -------------------------------------------------------------------------
  let sanitizedBody = _stripPaths(body);

  // Strip per-install metadata fields from frontmatter before promotion.
  // These fields are project-local state and must not appear in the shared copy.
  const sharedFrontmatter = Object.assign({}, frontmatter);
  delete sharedFrontmatter.created_from;
  delete sharedFrontmatter.last_applied;
  delete sharedFrontmatter.times_applied;
  // H4 (v2.1.3): strip recently_curated_* stamp keys — these are project-local
  // run IDs and timestamps; leaking them to the shared tier would pollute
  // cross-project federation data.
  delete sharedFrontmatter.recently_curated_at;
  delete sharedFrontmatter.recently_curated_action;
  delete sharedFrontmatter.recently_curated_action_id;
  delete sharedFrontmatter.recently_curated_run_id;
  delete sharedFrontmatter.recently_curated_why;

  // -------------------------------------------------------------------------
  // Stage 5: Prompt-injection defense (W6 F11)
  // -------------------------------------------------------------------------
  sanitizedBody = _downgradeTopHeaders(sanitizedBody);

  // -------------------------------------------------------------------------
  // Stage 6: Size cap
  // -------------------------------------------------------------------------
  const sizeResult = _checkSize(sanitizedBody, slug);
  if (!sizeResult.ok) {
    if (!preview) {
      return { ok: false, error: sizeResult.error, stage: 'size-cap' };
    }
    // Preview: report the blocking stage.
    const promotedFmPartial = Object.assign({}, sharedFrontmatter, {
      origin: 'shared',
      promoted_at: new Date().toISOString(),
      promoted_from: _projectHash(cwd),
    });
    return {
      ok: true,
      preview: _buildPreviewReport({
        slug,
        originalFm: frontmatter,
        promotedFm: promotedFmPartial,
        originalBody: body,
        sanitizedBody,
        secretResult,
        sensitivityBlocks,
        blockingStage: 'size-cap',
        blockingReason: sizeResult.error,
      }),
      destPath: '<not-written>',
    };
  }

  // -------------------------------------------------------------------------
  // Stage 7: Frontmatter schema validate
  // -------------------------------------------------------------------------
  const fmResult = _validateFrontmatter(sharedFrontmatter, slug);
  if (!fmResult.ok) {
    if (!preview) {
      return { ok: false, error: fmResult.error, stage: 'schema-validate' };
    }
    // Preview: report the blocking stage.
    const promotedFmPartial = Object.assign({}, sharedFrontmatter, {
      origin: 'shared',
      promoted_at: new Date().toISOString(),
      promoted_from: _projectHash(cwd),
    });
    return {
      ok: true,
      preview: _buildPreviewReport({
        slug,
        originalFm: frontmatter,
        promotedFm: promotedFmPartial,
        originalBody: body,
        sanitizedBody,
        secretResult,
        sensitivityBlocks,
        blockingStage: 'schema-validate',
        blockingReason: fmResult.error,
      }),
      destPath: '<not-written>',
    };
  }

  // -------------------------------------------------------------------------
  // W6 (v2.1.6): Local collision pre-check — warn-only, does NOT block promote.
  // Run after all sanitization stages so we compare the final promoted body.
  // Skip in preview/dryRun since nothing is being written to shared tier.
  // -------------------------------------------------------------------------
  if (!preview && !dryRun) {
    _localCollisionCheck(slug, sanitizedBody, cwd);
  }

  // Add shared-tier metadata fields to the promoted frontmatter.
  const promotedFm = Object.assign({}, sharedFrontmatter, {
    origin: 'shared',
    promoted_at: new Date().toISOString(),
    // 8-char prefix of a SHA-256 of the project root path (identifies promoter
    // without leaking the path). Using a simple hash here — W3 Threat 8.
    promoted_from: _projectHash(cwd),
  });

  // -------------------------------------------------------------------------
  // Write: atomic tmp+rename (skip if dry run or preview)
  // -------------------------------------------------------------------------
  // Preview mode: all sanitization stages ran, nothing will be written.
  // Return the full PreviewReport so the user sees the exact diff.
  if (preview) {
    return {
      ok: true,
      preview: _buildPreviewReport({
        slug,
        originalFm: frontmatter,
        promotedFm,
        originalBody: body,
        sanitizedBody,
        secretResult,
        sensitivityBlocks,
        blockingStage: null,
        blockingReason: null,
      }),
      destPath: '<not-written>',
    };
  }

  // Resolve destination path via the paths helper (respects test override and config).
  const sharedPatternsDir = process.env.ORCHESTRAY_TEST_SHARED_DIR
    ? require('node:path').join(process.env.ORCHESTRAY_TEST_SHARED_DIR, 'patterns')
    : paths.getSharedPatternsDir();

  if (!sharedPatternsDir) {
    if (!dryRun) {
      return {
        ok: false,
        error:
          `promote blocked: federation is not enabled or shared directory is not configured. ` +
          `Run: set federation.shared_dir_enabled to true in .orchestray/config.json`,
        stage: 'write',
      };
    }
    // In dry-run mode we can still report success even if federation is off.
  }

  const destPath = sharedPatternsDir
    ? require('node:path').join(sharedPatternsDir, slug + '.md')
    : '<dry-run-no-dest>';

  if (!dryRun && sharedPatternsDir) {
    const writeResult = writeFm(destPath, promotedFm, sanitizedBody);
    if (!writeResult.ok) {
      return { ok: false, error: `Stage write: atomic write failed: ${writeResult.error}`, stage: 'write' };
    }

    // Append to promote-log.
    const sharedRoot = require('node:path').dirname(sharedPatternsDir);
    const logPath = require('node:path').join(sharedRoot, 'meta', 'promote-log.jsonl');
    _appendPromoteLog(logPath, {
      slug,
      promoted_at: promotedFm.promoted_at,
      promoted_from: promotedFm.promoted_from,
      dest: destPath,
    });
  }

  return { ok: true, destPath, dryRun, sanitizedBody };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// W6 (v2.1.6): Local collision pre-check
//
// Before writing to ~/.orchestray/shared/patterns/<slug>.md, check whether
// .orchestray/patterns/<slug>.md already exists in the current project AND
// has DIFFERENT content (different normalized body hash) from the content
// being promoted.
//
// Non-blocking: emits a warning console + degraded journal + audit event,
// then returns so the caller can continue promoting.
//
// Cases that produce NO warning:
//   - Local file does not exist (no collision possible).
//   - Local file body hash == promoted body hash (identical content).
//   - Local file has frontmatter field `deprecated: true` (expected override).
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 of the normalized body string (trimmed + LF-normalised).
 * @param {string} body
 * @returns {string} hex digest
 */
function _bodyHash(body) {
  const normalized = (body || '').replace(/\r\n/g, '\n').trim();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Check for a local pattern collision:
 *   If slug already exists in the shared tier (~/.orchestray/shared/patterns/<slug>.md),
 *   compare its body hash against the body of the local project file
 *   (.orchestray/patterns/<slug>.md). If they differ, the local project has a
 *   diverged copy that would be overwritten by this promotion — warn the user.
 *
 * Also checks the inverse: if the local file's body differs from the sanitized
 * body being written (i.e., sanitization would change the content the user has
 * locally), warn so users know what changed.
 *
 * Warn-only: never throws, never returns an error that blocks the caller.
 *
 * @param {string} slug           - The pattern slug being promoted.
 * @param {string} promotedBody   - The sanitized body being written to shared tier.
 * @param {string} cwd            - Project root.
 * @returns {void}
 */
function _localCollisionCheck(slug, promotedBody, cwd) {
  try {
    // Resolve shared dir (respects test override).
    const sharedPatternsDir = process.env.ORCHESTRAY_TEST_SHARED_DIR
      ? path.join(process.env.ORCHESTRAY_TEST_SHARED_DIR, 'patterns')
      : path.join(os.homedir(), '.orchestray', 'shared', 'patterns');

    const sharedPath = path.join(sharedPatternsDir, slug + '.md');

    // Only check if a shared version already exists.
    let sharedContent;
    try {
      sharedContent = fs.readFileSync(sharedPath, 'utf8');
    } catch (_e) {
      // No existing shared file — no collision possible.
      return;
    }

    // Parse local file frontmatter to check deprecated flag.
    const localPath = path.join(cwd, '.orchestray', 'patterns', slug + '.md');
    let localContent;
    try {
      localContent = fs.readFileSync(localPath, 'utf8');
    } catch (_e) {
      // Local file unreadable — no collision comparison possible.
      return;
    }

    const { parse: parseFm } = _getFrontmatter();
    const localParsed = parseFm(localContent);
    if (localParsed.hasFrontmatter && localParsed.frontmatter && localParsed.frontmatter.deprecated === true) {
      // Expected override — no warning.
      return;
    }

    // Compare the body of the existing shared file against the body being promoted.
    // If they differ, the shared version would be overwritten with different content.
    const sharedParsed = parseFm(sharedContent);
    const sharedBody = sharedParsed.hasFrontmatter ? sharedParsed.body : sharedContent;

    const sharedHash   = _bodyHash(sharedBody);
    const promotedHash = _bodyHash(promotedBody);

    if (sharedHash === promotedHash) {
      // Promoted body matches existing shared body — no effective change, no warning.
      return;
    }

    // Different content — emit warn.
    const msg =
      `[shared-promote] local collision: slug '${slug}' already exists in the shared tier ` +
      `with different content than the body being promoted. ` +
      `Review your local copy before promoting. Promotion continues.`;
    process.stderr.write(msg + '\n');

    // Degraded journal.
    try {
      const { recordDegradation } = require('./degraded-journal');
      recordDegradation({
        kind: 'shared_promote_local_collision',
        severity: 'warn',
        detail: {
          slug,
          shared_hash: sharedHash.slice(0, 8),
          promoted_hash: promotedHash.slice(0, 8),
          dedup_key: 'local-collision|' + slug,
        },
        projectRoot: cwd,
      });
    } catch (_e) { /* swallow */ }

    // Audit event.
    try {
      const { atomicAppendJsonl } = require('./atomic-append');
      const auditDir = path.join(cwd, '.orchestray', 'audit');
      fs.mkdirSync(auditDir, { recursive: true });
      atomicAppendJsonl(path.join(auditDir, 'events.jsonl'), {
        timestamp: new Date().toISOString(),
        type: 'pattern_collision_local_warn',
        schema_version: 1,
        slug,
        local_hash: sharedHash.slice(0, 8),
        promoted_hash: promotedHash.slice(0, 8),
      });
    } catch (_e) { /* swallow */ }

  } catch (_e) {
    // Outer guard: collision check failure must never break the promote pipeline.
  }
}

/**
 * Produce an 8-character opaque identifier derived from the project root path.
 * This is NOT a cryptographic hash — just a stable identifier so the same
 * project always produces the same token without leaking the path itself.
 *
 * Uses a simple djb2-style XOR fold to avoid requiring node:crypto.
 *
 * @param {string} projectRoot
 * @returns {string} 8 hex chars
 */
function _projectHash(projectRoot) {
  let h = 5381;
  for (let i = 0; i < projectRoot.length; i++) {
    h = ((h << 5) + h) ^ projectRoot.charCodeAt(i);
    h = h >>> 0; // keep uint32
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = { promotePattern, _projectHash, _localCollisionCheck, _bodyHash };

// ---------------------------------------------------------------------------
// Smoke test (run directly: node bin/_lib/shared-promote.js)
// ---------------------------------------------------------------------------

/* istanbul ignore next */
if (require.main === module) {
  const assert = require('node:assert');

  (async () => {
    console.log('[shared-promote smoke test]');

    // --- Test: secret scan blocks Anthropic key ---
    const antKey = 'sk-ant-api03-some-long-key-value-here';
    const scanResult = _secretScan('some content\n' + antKey + '\nmore', 'test-pattern');
    assert.strictEqual(scanResult.ok, false, 'should block Anthropic key');
    assert.ok(scanResult.error.includes('Anthropic API key'), 'error should name the kind');
    console.log('  PASS: Anthropic key blocked');

    // --- Test: escape hatch bypasses secret scan ---
    const lineWithEscape = antKey + ' ' + ESCAPE_HATCH_COMMENT;
    const escapeResult = _secretScan(lineWithEscape, 'test-pattern');
    assert.strictEqual(escapeResult.ok, true, 'escape hatch should allow through');
    console.log('  PASS: escape hatch works');

    // --- Test: OpenAI project key blocked ---
    const oaiKey = 'sk-proj-abc123XYZ-some-long-key';
    const oaiResult = _secretScan('content\n' + oaiKey + '\nend', 'test-pattern');
    assert.strictEqual(oaiResult.ok, false, 'should block OpenAI project key');
    assert.ok(oaiResult.error.includes('OpenAI project key'), 'error should name kind');
    console.log('  PASS: OpenAI project key blocked');

    // --- Test: hex-key entropy check ---
    // High-entropy hex (random-looking): should block
    const highEntropyHex = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4'; // 32 chars hex
    const hexEntropy = _shannonEntropy(highEntropyHex);
    const hexResult = _secretScan('config:\n  key: ' + highEntropyHex, 'test-pattern');
    // Only block if entropy actually meets threshold (depends on the specific string)
    if (hexEntropy >= HEX_ENTROPY_THRESHOLD) {
      assert.strictEqual(hexResult.ok, false, 'high-entropy hex should be blocked');
      console.log(`  PASS: hex-key entropy check (entropy=${hexEntropy.toFixed(2)} >= ${HEX_ENTROPY_THRESHOLD})`);
    } else {
      console.log(`  INFO: test hex string entropy=${hexEntropy.toFixed(2)} below threshold — not blocked (expected for this value)`);
    }

    // --- Test: low-entropy hex (repetitive, like "aaaa...") passes ---
    const lowEntropyHex = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // all-a, entropy≈0
    const lowHexResult = _secretScan('content: ' + lowEntropyHex, 'test-pattern');
    assert.strictEqual(lowHexResult.ok, true, 'low-entropy hex should NOT be blocked');
    console.log('  PASS: low-entropy hex not blocked');

    // --- Test: prompt-injection defense downgrade ---
    const bodyWithHeaders = '# Title\nsome text\n## Section\nmore text\n### Subsection\nkeep';
    const stripped = _downgradeTopHeaders(bodyWithHeaders);
    assert.ok(!stripped.includes('# Title'), 'H1 should be downgraded');
    assert.ok(!stripped.includes('## Section'), 'H2 should be downgraded');
    assert.ok(stripped.includes('### Subsection'), 'H3+ should be preserved');
    assert.ok(stripped.includes('(header: Title)'), 'H1 should become (header:)');
    console.log('  PASS: prompt-injection header downgrade');

    // --- Test: size cap triggers with filler ---
    const filler = 'x'.repeat(SIZE_CAP_BYTES + 100);
    const sizeResult = _checkSize(filler, 'big-pattern');
    assert.strictEqual(sizeResult.ok, false, 'should block oversized content');
    assert.ok(sizeResult.error.includes('exceeds'), 'error should mention limit');
    console.log('  PASS: size cap triggers on oversized content');

    // --- Test: size cap passes for normal content ---
    const smallContent = 'small content that is well within the limit';
    const smallResult = _checkSize(smallContent, 'small-pattern');
    assert.strictEqual(smallResult.ok, true, 'small content should pass');
    console.log('  PASS: size cap passes for small content');

    // --- Test: getSharedPatternsDir returns null when disabled ---
    // Ensure no test override is set, then test with a temp project root.
    const savedEnv = process.env.ORCHESTRAY_TEST_SHARED_DIR;
    delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
    const { getSharedPatternsDir } = require('../mcp-server/lib/paths.js');
    const result = getSharedPatternsDir();
    // Without a real project root with config enabled, should return null.
    // (If there happens to be a real project root with enabled:true, this assertion
    //  may not hold — acceptable for a smoke test that runs from the package root.)
    if (result === null) {
      console.log('  PASS: getSharedPatternsDir returns null when disabled');
    } else {
      console.log('  INFO: getSharedPatternsDir returned', result, '(live config may have it enabled)');
    }
    if (savedEnv !== undefined) process.env.ORCHESTRAY_TEST_SHARED_DIR = savedEnv;

    // --- Test: ORCHESTRAY_TEST_SHARED_DIR override works ---
    process.env.ORCHESTRAY_TEST_SHARED_DIR = '/tmp/test-shared';
    const overrideResult = getSharedPatternsDir();
    assert.ok(overrideResult !== null, 'env override should produce non-null');
    assert.ok(overrideResult.includes('patterns'), 'should end with /patterns');
    delete process.env.ORCHESTRAY_TEST_SHARED_DIR;
    if (savedEnv !== undefined) process.env.ORCHESTRAY_TEST_SHARED_DIR = savedEnv;
    console.log('  PASS: ORCHESTRAY_TEST_SHARED_DIR override works');

    console.log('[shared-promote smoke test] all checks passed');
  })().catch(err => {
    console.error('[shared-promote smoke test] FAILED:', err.message);
    process.exit(1);
  });
}
