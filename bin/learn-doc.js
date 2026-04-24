#!/usr/bin/env node
'use strict';

/**
 * learn-doc.js — cache a distilled skill pack for a URL that the user keeps
 * pasting into prompts.
 *
 * Called by the `/orchestray:learn-doc` and `/orchestray:distill` slash
 * commands after the invoking agent has:
 *   1. fetched the URL via WebFetch,
 *   2. distilled it via the `distiller.md` subagent prompt in the same
 *      skill directory.
 *
 * This script does NOT perform the fetch or the distillation itself — it is
 * a pure file-writer that stamps the result with a source-aware expiry and
 * drops it under `.orchestray/skills/learn-doc/<slug>.md` so future agent
 * sessions auto-load it.
 *
 * Usage:
 *   node bin/learn-doc.js --url <url> --content-file <path> [--title <t>] \
 *                         [--project-dir <dir>] [--now <iso>]
 *   node bin/learn-doc.js --url <url> --content <inline-markdown> [...]
 *
 * Flags:
 *   --url            Required. The original URL being cached.
 *   --content-file   Path to a file containing the distilled markdown body.
 *                    Mutually exclusive with --content.
 *   --content        Inline distilled markdown body (used by tests).
 *   --title          Optional. Human-readable title for the skill pack header.
 *                    Defaults to the URL's pathname.
 *   --project-dir    Project root (default: process.cwd()). The skill pack is
 *                    written to <project-dir>/.orchestray/skills/learn-doc/.
 *   --now            ISO timestamp used for `fetched_at` and expiry math
 *                    (default: current time). Exposed so tests are deterministic.
 *   --print-path     If set, prints the absolute output path on stdout instead
 *                    of a human summary. Useful for scripting.
 *
 * Exit codes:
 *   0 — success (skill pack written).
 *   1 — usage error (missing --url, missing content, both --content and
 *       --content-file supplied, etc.).
 *
 * Expiry policy (source-aware):
 *   - Claude Code docs (code.claude.com/docs/ OR
 *     docs.anthropic.com/en/docs/claude-code/)           → 14 days
 *   - Anthropic Platform docs (platform.claude.com/docs/ OR
 *     other docs.anthropic.com/en/ paths)                → 30 days
 *   - Anything else                                      → 90 days
 *   - Unparseable URLs fall back to the 90-day default.
 *
 * See `resolveExpiryDays(url)` below. The function is exported for tests.
 *
 * v2.1.13 — R-LEARN-DOC.
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Expiry policy
// ---------------------------------------------------------------------------

const EXPIRY_DAYS = {
  CLAUDE_CODE: 14,
  ANTHROPIC_PLATFORM: 30,
  DEFAULT: 90,
};

/**
 * Resolve the cache expiry (in days) for a given URL based on its source.
 *
 * Rules (first match wins):
 *   - host is `code.claude.com` and path starts with `/docs/`              → 14
 *   - host is `docs.anthropic.com` and path starts with `/en/docs/claude-code/` → 14
 *   - host is `platform.claude.com` and path starts with `/docs/`          → 30
 *   - host is `docs.anthropic.com` and path starts with `/en/`             → 30
 *   - anything else (including invalid URLs)                               → 90
 *
 * The function is total — it never throws — so callers can use the result
 * directly as a day-count.
 *
 * @param {string} url
 * @returns {number} days until the cached skill pack should be considered stale
 */
function resolveExpiryDays(url) {
  if (typeof url !== 'string' || !url) return EXPIRY_DAYS.DEFAULT;

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    return EXPIRY_DAYS.DEFAULT;
  }

  const host = (parsed.hostname || '').toLowerCase();
  const pathname = parsed.pathname || '';

  // Claude Code docs
  if (host === 'code.claude.com' && pathname.startsWith('/docs/')) {
    return EXPIRY_DAYS.CLAUDE_CODE;
  }
  if (host === 'docs.anthropic.com' && pathname.startsWith('/en/docs/claude-code/')) {
    return EXPIRY_DAYS.CLAUDE_CODE;
  }

  // Anthropic Platform docs
  if (host === 'platform.claude.com' && pathname.startsWith('/docs/')) {
    return EXPIRY_DAYS.ANTHROPIC_PLATFORM;
  }
  if (host === 'docs.anthropic.com' && pathname.startsWith('/en/')) {
    // Non-claude-code anthropic.com/en/... — Platform tier.
    return EXPIRY_DAYS.ANTHROPIC_PLATFORM;
  }

  return EXPIRY_DAYS.DEFAULT;
}

/**
 * Label the source tier for human display in frontmatter.
 * @param {string} url
 * @returns {'claude-code'|'anthropic-platform'|'other'}
 */
function resolveSourceTier(url) {
  const days = resolveExpiryDays(url);
  if (days === EXPIRY_DAYS.CLAUDE_CODE) return 'claude-code';
  if (days === EXPIRY_DAYS.ANTHROPIC_PLATFORM) return 'anthropic-platform';
  return 'other';
}

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

/**
 * Derive a filesystem-safe slug from a URL. Uses host + pathname, trimmed and
 * lowercased, with non-word characters collapsed to single hyphens.
 *
 * Examples:
 *   https://code.claude.com/docs/en/sub-agents  → code-claude-com-docs-en-sub-agents
 *   https://example.com/                        → example-com
 *   not a url                                    → unparseable-url-<hash>
 *
 * @param {string} url
 * @returns {string}
 */
function slugify(url) {
  if (typeof url !== 'string' || !url) {
    return 'unparseable-url';
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (_e) {
    // Fallback: hash-like from the raw string so tests are still deterministic.
    const cleaned = url
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return cleaned ? `unparseable-${cleaned}`.slice(0, 100) : 'unparseable-url';
  }

  const host = (parsed.hostname || '').toLowerCase();
  const rawPath = (parsed.pathname || '').toLowerCase();
  const combined = `${host}${rawPath}`;
  const slug = combined
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!slug) return 'root';
  // Keep slug length bounded so we don't produce enormous filenames.
  return slug.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Skill-pack rendering
// ---------------------------------------------------------------------------

/**
 * Build the skill-pack markdown (frontmatter + body) for a distilled URL.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.title
 * @param {string} opts.body - distilled markdown content
 * @param {Date}   opts.now  - effective "fetched_at" timestamp
 * @returns {string}
 */
function renderSkillPack({ url, title, body, now }) {
  const expiryDays = resolveExpiryDays(url);
  const sourceTier = resolveSourceTier(url);
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

  // Escape any accidental "---" fences in the body so frontmatter stays valid.
  const safeBody = (body || '').replace(/\n---\n/g, '\n- - -\n').trim();

  const frontmatter = [
    '---',
    `name: learn-doc-${slugify(url)}`,
    `description: Distilled skill pack for ${url}`,
    `source_url: ${url}`,
    `source_tier: ${sourceTier}`,
    `expiry_days: ${expiryDays}`,
    `fetched_at: ${fetchedAt}`,
    `expires_at: ${expiresAt}`,
    `title: ${JSON.stringify(title)}`,
    'disable-model-invocation: true',
    '---',
    '',
  ].join('\n');

  return `${frontmatter}# ${title}\n\n> Source: ${url}\n> Cached ${fetchedAt} (expires ${expiresAt}, ${sourceTier} tier)\n\n${safeBody}\n`;
}

/**
 * Core API: given a URL, distilled body, and a project dir, write the skill
 * pack to disk. Returns the absolute output path.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {string} opts.body
 * @param {string} [opts.title]
 * @param {string} [opts.projectDir]
 * @param {Date}   [opts.now]
 * @returns {{ outputPath: string, slug: string, expiryDays: number, expiresAt: string }}
 */
function writeSkillPack({ url, body, title, projectDir, now }) {
  if (typeof url !== 'string' || !url) {
    throw new Error('writeSkillPack: url is required');
  }
  if (typeof body !== 'string') {
    throw new Error('writeSkillPack: body must be a string');
  }

  const effectiveNow = now instanceof Date ? now : new Date();
  const effectiveProject = projectDir || process.cwd();
  const slug = slugify(url);
  const cacheDir = path.join(effectiveProject, '.orchestray', 'skills', 'learn-doc');
  const outputPath = path.join(cacheDir, `${slug}.md`);

  const effectiveTitle = title && title.trim() ? title.trim() : deriveTitle(url);

  const content = renderSkillPack({
    url,
    title: effectiveTitle,
    body,
    now: effectiveNow,
  });

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf8');

  const expiryDays = resolveExpiryDays(url);
  const expiresAt = new Date(effectiveNow.getTime() + expiryDays * 24 * 60 * 60 * 1000).toISOString();
  return { outputPath, slug, expiryDays, expiresAt };
}

/**
 * Derive a human-readable title from a URL when none is provided. Uses the
 * last non-empty pathname segment, falling back to the hostname, falling back
 * to the raw URL.
 *
 * @param {string} url
 * @returns {string}
 */
function deriveTitle(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length > 0) {
      return decodeURIComponent(segments[segments.length - 1]).replace(/[-_]+/g, ' ');
    }
    return parsed.hostname || url;
  } catch (_e) {
    return url;
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    url: null,
    content: null,
    contentFile: null,
    title: null,
    projectDir: null,
    now: null,
    printPath: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeNext = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new Error(`missing value for ${arg}`);
      }
      i++;
      return v;
    };
    if (arg === '--url') out.url = takeNext();
    else if (arg === '--content') out.content = takeNext();
    else if (arg === '--content-file') out.contentFile = takeNext();
    else if (arg === '--title') out.title = takeNext();
    else if (arg === '--project-dir') out.projectDir = takeNext();
    else if (arg === '--now') out.now = takeNext();
    else if (arg === '--print-path') out.printPath = true;
    else if (arg.startsWith('--url=')) out.url = arg.slice('--url='.length);
    else if (arg.startsWith('--content=')) out.content = arg.slice('--content='.length);
    else if (arg.startsWith('--content-file=')) out.contentFile = arg.slice('--content-file='.length);
    else if (arg.startsWith('--title=')) out.title = arg.slice('--title='.length);
    else if (arg.startsWith('--project-dir=')) out.projectDir = arg.slice('--project-dir='.length);
    else if (arg.startsWith('--now=')) out.now = arg.slice('--now='.length);
    else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function runCli(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`[orchestray] learn-doc: ${err.message}\n`);
    return 1;
  }

  if (!parsed.url) {
    process.stderr.write('[orchestray] learn-doc: --url is required\n');
    return 1;
  }
  if (parsed.content && parsed.contentFile) {
    process.stderr.write('[orchestray] learn-doc: pass --content OR --content-file, not both\n');
    return 1;
  }

  let body = parsed.content;
  if (parsed.contentFile) {
    try {
      body = fs.readFileSync(parsed.contentFile, 'utf8');
    } catch (err) {
      process.stderr.write(`[orchestray] learn-doc: could not read --content-file: ${err.message}\n`);
      return 1;
    }
  }

  if (typeof body !== 'string' || !body.trim()) {
    process.stderr.write('[orchestray] learn-doc: --content or --content-file must supply a non-empty body\n');
    return 1;
  }

  let now;
  if (parsed.now) {
    const d = new Date(parsed.now);
    if (Number.isNaN(d.getTime())) {
      process.stderr.write(`[orchestray] learn-doc: invalid --now timestamp: ${parsed.now}\n`);
      return 1;
    }
    now = d;
  }

  let result;
  try {
    result = writeSkillPack({
      url: parsed.url,
      body,
      title: parsed.title,
      projectDir: parsed.projectDir,
      now,
    });
  } catch (err) {
    process.stderr.write(`[orchestray] learn-doc: ${err.message}\n`);
    return 1;
  }

  if (parsed.printPath) {
    process.stdout.write(`${result.outputPath}\n`);
  } else {
    process.stdout.write(
      `[orchestray] learn-doc: cached ${parsed.url}\n` +
      `  → ${result.outputPath}\n` +
      `  expires ${result.expiresAt} (${result.expiryDays} days)\n`
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Exports + CLI runner
// ---------------------------------------------------------------------------

module.exports = {
  resolveExpiryDays,
  resolveSourceTier,
  slugify,
  deriveTitle,
  renderSkillPack,
  writeSkillPack,
  parseArgs,
  runCli,
  EXPIRY_DAYS,
};

if (require.main === module) {
  process.exit(runCli(process.argv.slice(2)));
}
