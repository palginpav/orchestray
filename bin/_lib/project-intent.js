'use strict';

/**
 * project-intent.js — Mechanical goal-inference helper (R-RCPT, v2.1.12).
 *
 * Generates .orchestray/kb/facts/project-intent.md from README.md,
 * package.json, and CLAUDE.md using grep + file reads (no third-party parsers,
 * no separate LLM turns — path (a) per the architect's recommendation).
 *
 * Format (locked per scope proposal §1 R-RCPT):
 *
 *   # Project Intent
 *   <!-- generated: {ISO ts} | repo-hash: {7-char} | readme-hash: {7-char} -->
 *
 *   **Domain:** <one phrase>
 *   **Primary user problem:** <one sentence>
 *   **Key architectural constraint:** <one sentence>
 *   **Tech stack summary:** <language, framework, test runner>
 *   **Entry points:** <comma-separated key files, max 3>
 *
 * When README is missing OR < 100 words: sets low_confidence: true in the header;
 * fields may be empty strings; block is NOT injected into delegation prompts.
 *
 * When git ls-files count < 10: writes a stub with low_confidence: true and skips
 * inference (AC-08).
 *
 * Staleness keys:
 *   - repo-hash: first 7 chars of `git rev-parse HEAD` (mirrors repo-map-protocol.md)
 *   - readme-hash: sha256 of first 50 lines of README.md (7-char hex prefix)
 *
 * Config gate: enable_goal_inference (AC-05). Defaults to enable_repo_map value.
 * If enable_repo_map is false → enable_goal_inference is implicitly false.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const INTENT_KB_PATH = path.join('.orchestray', 'kb', 'facts', 'project-intent.md');
const MIN_FILE_COUNT = 10;   // AC-08 minimum project size gate
const MIN_README_WORDS = 100; // AC-04 minimum README word count for high-confidence

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Resolve the intent file path.
 * @param {string} [projectRoot]
 * @returns {string}
 */
function _intentPath(projectRoot) {
  return path.join(projectRoot || process.cwd(), INTENT_KB_PATH);
}

/**
 * Compute sha256 hex prefix (7 chars) of a string.
 * @param {string} content
 * @returns {string}
 */
function _hash7(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 7);
}

/**
 * Run a shell command synchronously and return trimmed stdout.
 * Returns '' on error.
 * @param {string} cmd
 * @param {string} [cwd]
 * @returns {string}
 */
function _exec(cmd, cwd) {
  try {
    return execSync(cmd, {
      cwd: cwd || process.cwd(),
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8').trim();
  } catch (_) {
    return '';
  }
}

/**
 * Count words in a string.
 * @param {string} text
 * @returns {number}
 */
function _wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Read first N lines of a file. Returns '' on error.
 * @param {string} filePath
 * @param {number} lineCount
 * @returns {string}
 */
function _readFirstLines(filePath, lineCount) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.split('\n').slice(0, lineCount).join('\n');
  } catch (_) {
    return '';
  }
}

/**
 * Read a file fully. Returns '' on error.
 * @param {string} filePath
 * @returns {string}
 */
function _readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * Parse header comment from project-intent.md to extract hashes.
 * Returns null if parsing fails.
 * @param {string} content
 * @returns {{ repoHash: string, readmeHash: string, lowConfidence: boolean } | null}
 */
function _parseIntentHeader(content) {
  // <!-- generated: {ISO ts} | repo-hash: {7-char} | readme-hash: {7-char} -->
  const match = content.match(/<!--\s*generated:[^|]+\|\s*repo-hash:\s*([0-9a-f]{7})\s*\|\s*readme-hash:\s*([0-9a-f]{7})(?:\s*\|\s*low_confidence:\s*(true|false))?\s*-->/);
  if (!match) return null;
  return {
    repoHash: match[1],
    readmeHash: match[2],
    lowConfidence: match[3] === 'true',
  };
}

// ---------------------------------------------------------------------------
// Mechanical inference helpers
// ---------------------------------------------------------------------------

/**
 * Extract domain phrase from README content.
 * Strategy: first non-empty heading after the title, or first sentence of description.
 * @param {string} readme
 * @param {object} pkg  parsed package.json or {}
 * @returns {string}
 */
function _inferDomain(readme, pkg) {
  // Try package description (most reliable, already one phrase)
  if (pkg.description && pkg.description.length > 5 && pkg.description.length < 200) {
    return pkg.description.trim().replace(/\.$/, '');
  }
  // Try first sub-heading from README
  const headingMatch = readme.match(/^##\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();
  // Try first non-empty paragraph sentence
  const paraMatch = readme.match(/^(?!#)[A-Z][^.\n]{10,100}\./m);
  if (paraMatch) return paraMatch[0].trim();
  return '';
}

/**
 * Extract primary user problem from README.
 * Strategy: look for "problem", "goal", "allows", "enables" sentences, else first paragraph.
 * @param {string} readme
 * @returns {string}
 */
function _inferUserProblem(readme) {
  const problemMatch = readme.match(/[A-Z][^.\n]*(?:problem|enables|allows|goal|purpose|designed to|helps)[^.\n]*\./i);
  if (problemMatch) return problemMatch[0].trim();
  // Fallback: second non-heading paragraph's first sentence
  const lines = readme.split('\n');
  let inPara = false;
  let paraCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) { inPara = false; continue; }
    if (trimmed === '') { inPara = false; continue; }
    if (!inPara) { inPara = true; paraCount++; }
    if (paraCount >= 2) {
      const sentMatch = trimmed.match(/[A-Z][^.]{10,200}\./);
      if (sentMatch) return sentMatch[0].trim();
    }
  }
  return '';
}

/**
 * Extract key architectural constraint from README or CLAUDE.md.
 * @param {string} readme
 * @param {string} claudeMd
 * @returns {string}
 */
function _inferArchConstraint(readme, claudeMd) {
  // Look for "constraint", "must", "cannot", "only", "requires" near architecture words
  const combined = (claudeMd || '') + '\n' + (readme || '');
  const constraintMatch = combined.match(/[A-Z][^.\n]*(?:constraint|must work|cannot|only work|requires|limitation)[^.\n]{5,150}\./i);
  if (constraintMatch) return constraintMatch[0].trim();
  // Fallback: "Platform:" or "Constraint" bullet
  const bulletMatch = combined.match(/[-*]\s+\*?\*?(?:Platform|Constraint)[^:]*:\*?\*?\s*([^\n.]+\.?)/i);
  if (bulletMatch) return bulletMatch[1].trim().replace(/\.$/, '') + '.';
  return '';
}

/**
 * Extract tech stack summary from package.json and README.
 * @param {object} pkg  parsed package.json or {}
 * @param {string} readme
 * @returns {string}
 */
function _inferTechStack(pkg, readme) {
  const parts = [];
  // Language from package.json existence = Node.js/JavaScript
  if (pkg.name !== undefined) {
    parts.push('Node.js/JavaScript');
  }
  // Test runner from scripts.test
  if (pkg.scripts && pkg.scripts.test) {
    if (pkg.scripts.test.includes('vitest')) parts.push('vitest');
    else if (pkg.scripts.test.includes('jest')) parts.push('jest');
    else if (pkg.scripts.test.includes('node --test') || pkg.scripts.test.includes('node:test')) parts.push('node:test');
    else if (pkg.scripts.test.includes('mocha')) parts.push('mocha');
  }
  // Key dependencies
  const deps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
  for (const dep of ['express', 'fastify', 'koa', 'hapi', 'next', 'react', 'vue', 'angular', 'svelte']) {
    if (deps.includes(dep)) { parts.push(dep); break; }
  }
  return parts.join(', ') || '';
}

/**
 * Find up to 3 key entry point files.
 * @param {string} projectRoot
 * @param {object} pkg
 * @returns {string}
 */
function _inferEntryPoints(projectRoot, pkg) {
  const candidates = [];
  // Package main/bin fields
  if (pkg.main) candidates.push(pkg.main);
  if (pkg.bin) {
    const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin);
    candidates.push(...bins);
  }
  // Common conventions
  for (const f of ['index.js', 'src/index.js', 'src/index.ts', 'lib/index.js', 'app.js']) {
    if (!candidates.includes(f)) {
      try {
        fs.accessSync(path.join(projectRoot, f));
        candidates.push(f);
      } catch (_) {}
    }
  }
  return candidates.slice(0, 3).join(', ');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate or return cached project-intent.md.
 *
 * @param {object} [options]
 * @param {string}  [options.projectRoot]      Defaults to process.cwd()
 * @param {boolean} [options.enableGoalInference]  Defaults to true
 * @param {boolean} [options.enableRepoMap]    If false, goal inference is also skipped
 * @returns {{ skipped: boolean, cached: boolean, lowConfidence: boolean, filePath: string }}
 */
function generateProjectIntent(options) {
  const {
    projectRoot = process.cwd(),
    enableGoalInference,
    enableRepoMap = true,
  } = options || {};

  // AC-05: enable_repo_map: false implies enable_goal_inference: false
  const effectiveEnable = enableRepoMap === false
    ? false
    : (enableGoalInference !== undefined ? enableGoalInference : true);

  if (!effectiveEnable) {
    return { skipped: true, cached: false, lowConfidence: false, filePath: _intentPath(projectRoot) };
  }

  const intentFile = _intentPath(projectRoot);

  // AC-08: minimum project size gate
  const fileCount = parseInt(_exec('git ls-files | wc -l', projectRoot), 10) || 0;
  if (fileCount < MIN_FILE_COUNT) {
    return _writeStub(projectRoot, intentFile, 'small_project');
  }

  // Compute current hashes
  const repoHash = (_exec('git rev-parse HEAD', projectRoot) || '').slice(0, 7) || 'unknown';
  const readmeAbsPath = path.join(projectRoot, 'README.md');
  const readmeFirst50 = _readFirstLines(readmeAbsPath, 50);
  const readmeHash = readmeFirst50 ? _hash7(readmeFirst50) : '0000000';
  const readmeFull = _readFile(readmeAbsPath);
  const readmeExists = readmeFull.length > 0;
  const readmeWordCount = _wordCount(readmeFull);

  // AC-04: low confidence check
  const lowConfidence = !readmeExists || readmeWordCount < MIN_README_WORDS;

  // AC-02 + AC-03: staleness check if file exists
  if (fs.existsSync(intentFile)) {
    const existingContent = _readFile(intentFile);
    const header = _parseIntentHeader(existingContent);
    if (header && header.repoHash === repoHash && header.readmeHash === readmeHash) {
      // AC-02: cache hit — file mtime unchanged
      return { skipped: false, cached: true, lowConfidence: header.lowConfidence, filePath: intentFile };
    }
    // AC-03: one or both hashes differ → regenerate (falls through)
  }

  // Low confidence: write stub with empty fields, do not attempt inference
  if (lowConfidence) {
    return _writeStub(projectRoot, intentFile, 'low_confidence', repoHash, readmeHash);
  }

  // Mechanical inference
  const pkgPath = path.join(projectRoot, 'package.json');
  let pkg = {};
  try { pkg = JSON.parse(_readFile(pkgPath)); } catch (_) {}

  const claudeMd = _readFile(path.join(projectRoot, 'CLAUDE.md'));

  const domain = _inferDomain(readmeFull, pkg);
  const userProblem = _inferUserProblem(readmeFull);
  const archConstraint = _inferArchConstraint(readmeFull, claudeMd);
  const techStack = _inferTechStack(pkg, readmeFull);
  const entryPoints = _inferEntryPoints(projectRoot, pkg);

  const ts = new Date().toISOString();
  const content = [
    '# Project Intent',
    `<!-- generated: ${ts} | repo-hash: ${repoHash} | readme-hash: ${readmeHash} | low_confidence: false -->`,
    '',
    `**Domain:** ${domain}`,
    `**Primary user problem:** ${userProblem}`,
    `**Key architectural constraint:** ${archConstraint}`,
    `**Tech stack summary:** ${techStack}`,
    `**Entry points:** ${entryPoints}`,
    '',
  ].join('\n');

  _ensureDir(path.dirname(intentFile));
  fs.writeFileSync(intentFile, content, 'utf8');

  return { skipped: false, cached: false, lowConfidence: false, filePath: intentFile };
}

/**
 * Write a stub project-intent.md with low_confidence: true.
 * @param {string} projectRoot
 * @param {string} intentFile
 * @param {string} reason   Informational (not written to file)
 * @param {string} [repoHash]
 * @param {string} [readmeHash]
 * @returns {{ skipped: boolean, cached: boolean, lowConfidence: boolean, filePath: string }}
 */
function _writeStub(projectRoot, intentFile, reason, repoHash, readmeHash) {
  const ts = new Date().toISOString();
  const rh = repoHash || 'unknown';
  const rdh = readmeHash || '0000000';
  const content = [
    '# Project Intent',
    `<!-- generated: ${ts} | repo-hash: ${rh} | readme-hash: ${rdh} | low_confidence: true -->`,
    '',
    '**Domain:** ',
    '**Primary user problem:** ',
    '**Key architectural constraint:** ',
    '**Tech stack summary:** ',
    '**Entry points:** ',
    '',
  ].join('\n');

  _ensureDir(path.dirname(intentFile));
  fs.writeFileSync(intentFile, content, 'utf8');

  return { skipped: false, cached: false, lowConfidence: true, filePath: intentFile };
}

/**
 * Read the project-intent.md file and return its content, or null if missing.
 * @param {string} [projectRoot]
 * @returns {string|null}
 */
function readProjectIntent(projectRoot) {
  const intentFile = _intentPath(projectRoot);
  if (!fs.existsSync(intentFile)) return null;
  return _readFile(intentFile);
}

/**
 * Parse the low_confidence flag from a project-intent.md content string.
 * @param {string} content
 * @returns {boolean}  true if low_confidence header is present and true
 */
function isLowConfidence(content) {
  if (!content) return true;
  const header = _parseIntentHeader(content);
  if (!header) return true;
  return header.lowConfidence === true;
}

function _ensureDir(dirPath) {
  try { fs.mkdirSync(dirPath, { recursive: true }); } catch (_) {}
}

module.exports = {
  generateProjectIntent,
  readProjectIntent,
  isLowConfidence,
  // Exported for tests
  _hash7,
  _parseIntentHeader,
  _wordCount,
};
