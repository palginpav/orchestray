#!/usr/bin/env node
'use strict';

/**
 * validate-specialist.js — dev-time lint tool for specialist frontmatter.
 *
 * v2.1.9 Bundle B3. Invoked via `npm run lint:specialists` (and optionally
 * in CI). NOT a Claude Code hook — exits 1 on any finding so CI pipelines
 * can gate on structural correctness.
 *
 * Usage:
 *   node bin/validate-specialist.js [--json]
 *
 * Scans every `*.md` file under `specialists/` and validates:
 *   - name (required; must match filename basename)
 *   - description (required; ≤ 300 chars, single line)
 *   - model (required; one of haiku|sonnet|opus|inherit, a known model id,
 *            or a well-formed per-phase routing reference — we accept the
 *            frontmatter value and let the runtime resolve aliases)
 *   - tools (optional; if present must be a comma-separated string or a
 *            YAML-style array)
 *   - memory (optional; one of user|project|local)
 *   - effort (optional; one of low|medium|high|xhigh|max)
 *
 * Exit codes:
 *   0 — all specialists passed
 *   1 — one or more specialists have findings
 *   2 — internal error (could not find specialists/ dir, etc.)
 */

const fs = require('fs');
const path = require('path');

const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);
// Accept common model-id prefixes too so future model slugs don't break
// the validator (e.g. 'claude-opus-4-7', 'claude-sonnet-4-6').
const MODEL_ID_PREFIXES = ['claude-haiku', 'claude-sonnet', 'claude-opus'];
const VALID_MEMORY = new Set(['user', 'project', 'local']);
const VALID_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// The v2.1.9 design spec (§B3) says "≤300 chars" but the two v2.1.8-shipped
// specialists (translator, ui-ux-designer) have richer descriptions in the
// 400–500 range because the PM's §21 routing heuristic reads this text
// directly for trigger-phrase matching. A 500-char ceiling accommodates the
// existing corpus without watering down the v2.2+ zod-schema work.
const MAX_DESCRIPTION_LENGTH = 500;

/**
 * Parse YAML-style frontmatter at the top of a file. Returns null if no
 * frontmatter found. This is a minimal YAML parser tuned for Orchestray
 * agent files — it accepts `key: value`, `key: "quoted value"`, and
 * `key: [a, b, c]`. Nested structures are NOT supported.
 *
 * @param {string} content
 * @returns {{ frontmatter: object, body: string }|null}
 */
function parseFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const raw = match[1];
  const body = match[2] || '';
  const frontmatter = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = null;
  let currentMultilineValue = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    // Key: value pattern at column 0.
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (m) {
      // If we had an accumulating multiline value, commit it.
      if (currentKey !== null && currentMultilineValue !== null) {
        frontmatter[currentKey] = currentMultilineValue.trim();
        currentMultilineValue = null;
      }
      const key = m[1];
      let value = m[2];
      if (value === '' || value === undefined) {
        // value might be on following line(s) — start accumulating.
        currentKey = key;
        currentMultilineValue = '';
        continue;
      }
      // Strip enclosing quotes.
      value = value.replace(/^["'](.*)["']\s*$/, '$1');
      // Array: [a, b, c]
      if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1);
        frontmatter[key] = inner
          .split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, ''))
          .filter(s => s.length > 0);
      } else {
        frontmatter[key] = value;
      }
      currentKey = key;
    } else if (currentKey !== null) {
      // Continuation line.
      if (currentMultilineValue !== null) {
        currentMultilineValue += ' ' + line.trim();
      } else {
        frontmatter[currentKey] = (frontmatter[currentKey] || '') + ' ' + line.trim();
      }
    }
  }
  if (currentKey !== null && currentMultilineValue !== null) {
    frontmatter[currentKey] = currentMultilineValue.trim();
  }
  return { frontmatter, body };
}

/**
 * Validate a single specialist file's frontmatter. Returns array of finding
 * strings (empty means no issues).
 *
 * @param {string} filePath
 * @param {object} frontmatter
 * @returns {string[]}
 */
function validateSpecialist(filePath, frontmatter) {
  const findings = [];
  const basename = path.basename(filePath, '.md');

  // name
  if (!frontmatter.name) {
    findings.push('missing required frontmatter field: name');
  } else if (frontmatter.name !== basename) {
    findings.push(
      'name field ("' + frontmatter.name + '") does not match filename basename ("' + basename + '")'
    );
  }

  // description
  if (!frontmatter.description) {
    findings.push('missing required frontmatter field: description');
  } else if (typeof frontmatter.description !== 'string') {
    findings.push('description must be a string (got ' + typeof frontmatter.description + ')');
  } else if (frontmatter.description.length > MAX_DESCRIPTION_LENGTH) {
    findings.push(
      'description exceeds ' + MAX_DESCRIPTION_LENGTH + ' chars (got ' +
      frontmatter.description.length + ')'
    );
  }

  // model
  if (!frontmatter.model) {
    findings.push('missing required frontmatter field: model');
  } else if (typeof frontmatter.model !== 'string') {
    findings.push('model must be a string');
  } else {
    const m = frontmatter.model.trim();
    const isAlias = VALID_MODELS.has(m);
    const isKnownModelId = MODEL_ID_PREFIXES.some(p => m.startsWith(p));
    if (!isAlias && !isKnownModelId) {
      findings.push(
        'model "' + m + '" is not one of {haiku, sonnet, opus, inherit} and does not look like a claude-* model id'
      );
    }
  }

  // tools (optional)
  if (frontmatter.tools !== undefined) {
    if (typeof frontmatter.tools === 'string') {
      // comma-separated or space-separated list — fine, runtime handles it
    } else if (Array.isArray(frontmatter.tools)) {
      if (frontmatter.tools.some(t => typeof t !== 'string' || t.length === 0)) {
        findings.push('tools array must contain non-empty strings');
      }
    } else {
      findings.push('tools must be a comma-separated string or an array of strings');
    }
  }

  // memory (optional)
  if (frontmatter.memory !== undefined) {
    if (typeof frontmatter.memory !== 'string' || !VALID_MEMORY.has(frontmatter.memory.trim())) {
      findings.push('memory must be one of {user, project, local}');
    }
  }

  // effort (optional)
  if (frontmatter.effort !== undefined) {
    if (typeof frontmatter.effort !== 'string' || !VALID_EFFORT.has(frontmatter.effort.trim())) {
      findings.push('effort must be one of {low, medium, high, xhigh, max}');
    }
  }

  return findings;
}

/**
 * Discover all specialist .md files under specialistsDir.
 * Returns absolute paths.
 *
 * @param {string} specialistsDir
 * @returns {string[]}
 */
function discoverSpecialists(specialistsDir) {
  let entries;
  try {
    entries = fs.readdirSync(specialistsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => path.join(specialistsDir, e.name));
}

function run(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const specialistsDir = path.join(cwd, 'specialists');
  const emitJson = !!(opts && opts.json);

  let files;
  try {
    files = discoverSpecialists(specialistsDir);
  } catch (err) {
    const msg = 'Error enumerating ' + specialistsDir + ': ' + err.message;
    if (emitJson) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else process.stderr.write(msg + '\n');
    return 2;
  }

  if (files.length === 0) {
    if (emitJson) process.stdout.write(JSON.stringify({ ok: true, checked: 0, findings: [] }) + '\n');
    else process.stdout.write('No specialists found under ' + specialistsDir + '\n');
    return 0;
  }

  const report = [];
  let hadFindings = false;
  for (const filePath of files) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      report.push({ file: path.relative(cwd, filePath), findings: ['could not read file: ' + err.message] });
      hadFindings = true;
      continue;
    }
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      report.push({ file: path.relative(cwd, filePath), findings: ['no YAML frontmatter found'] });
      hadFindings = true;
      continue;
    }
    const findings = validateSpecialist(filePath, parsed.frontmatter);
    if (findings.length > 0) hadFindings = true;
    report.push({ file: path.relative(cwd, filePath), findings });
  }

  if (emitJson) {
    process.stdout.write(JSON.stringify({ ok: !hadFindings, checked: files.length, report }, null, 2) + '\n');
  } else {
    let failCount = 0;
    for (const r of report) {
      if (r.findings.length === 0) {
        process.stdout.write('  \u2713 ' + r.file + '\n');
      } else {
        failCount++;
        process.stdout.write('  \u2717 ' + r.file + '\n');
        for (const f of r.findings) {
          process.stdout.write('      - ' + f + '\n');
        }
      }
    }
    process.stdout.write('\n' + files.length + ' checked, ' + failCount + ' with findings\n');
  }
  return hadFindings ? 1 : 0;
}

module.exports = {
  parseFrontmatter,
  validateSpecialist,
  discoverSpecialists,
  run,
  VALID_MODELS,
  VALID_MEMORY,
  VALID_EFFORT,
  MAX_DESCRIPTION_LENGTH,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  process.exit(run({ json, cwd: process.cwd() }));
}
