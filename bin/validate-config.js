#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * bin/validate-config.js — boot-time validator for
 *   - `.orchestray/config.json`
 *   - `.orchestray/patterns/*.md` frontmatter
 *   - `specialists/*.md` frontmatter
 *
 * v2.1.13 R-ZOD. Runs all three validations against the on-disk artifacts
 * and prints a per-file summary. Exits non-zero when any file fails.
 *
 * Exit codes:
 *   0 — every file that exists passes
 *   1 — one or more files failed validation
 *   2 — internal error (I/O, JSON parse failure, etc.)
 *
 * Usage:
 *   node bin/validate-config.js            # pretty output
 *   node bin/validate-config.js --json     # machine-readable output
 *   node bin/validate-config.js --cwd ROOT # scan a different root
 *
 * Missing files are treated as PASS (not every install has every artifact).
 */

const fs = require('fs');
const path = require('path');

const {
  configSchema,
  patternFrontmatterSchema,
  specialistFrontmatterSchema,
  validate,
} = require('../schemas');

// Use the block-sequence-aware parser in schemas/_yaml.js. The existing
// parser in `bin/validate-specialist.js` concatenates block-sequence
// continuation lines into a single string, which breaks array validation.
const { parseFrontmatter } = require('../schemas/_yaml.js');

/**
 * @param {string} cwd
 * @returns {{ ok: boolean, label: string, issues?: Array<object>, message?: string, skipped?: string }}
 */
function validateConfigFile(cwd) {
  const p = path.join(cwd, '.orchestray', 'config.json');
  if (!fs.existsSync(p)) return { ok: true, label: p, skipped: 'not present' };
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { ok: false, label: p, message: 'read error: ' + err.message, issues: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      label: p,
      message: 'JSON parse error: ' + err.message,
      issues: [{ path: '<root>', message: 'invalid JSON: ' + err.message, got: undefined }],
    };
  }
  return Object.assign({ label: p }, validate(configSchema, parsed, p));
}

function validatePatternFiles(cwd) {
  const dir = path.join(cwd, '.orchestray', 'patterns');
  if (!fs.existsSync(dir)) return [];
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => path.join(dir, n));
  } catch (err) {
    return [{ ok: false, label: dir, message: 'readdir error: ' + err.message, issues: [] }];
  }
  const results = [];
  for (const fp of files) {
    let raw;
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch (err) {
      results.push({ ok: false, label: fp, message: 'read error: ' + err.message, issues: [] });
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      results.push({
        ok: false,
        label: fp,
        message: 'no YAML frontmatter block',
        issues: [{ path: '<frontmatter>', message: 'missing YAML frontmatter', got: undefined }],
      });
      continue;
    }
    results.push(
      Object.assign(
        { label: fp },
        validate(patternFrontmatterSchema, parsed.frontmatter, fp)
      )
    );
  }
  return results;
}

function validateSpecialistFiles(cwd) {
  const dir = path.join(cwd, 'specialists');
  if (!fs.existsSync(dir)) return [];
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .map((n) => path.join(dir, n));
  } catch (err) {
    return [{ ok: false, label: dir, message: 'readdir error: ' + err.message, issues: [] }];
  }
  const results = [];
  for (const fp of files) {
    let raw;
    try {
      raw = fs.readFileSync(fp, 'utf8');
    } catch (err) {
      results.push({ ok: false, label: fp, message: 'read error: ' + err.message, issues: [] });
      continue;
    }
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      results.push({
        ok: false,
        label: fp,
        message: 'no YAML frontmatter block',
        issues: [{ path: '<frontmatter>', message: 'missing YAML frontmatter', got: undefined }],
      });
      continue;
    }
    // Enforce filename ↔ name match here (same invariant validate-specialist.js
    // already enforces). The zod schema alone cannot see the filename.
    const basename = path.basename(fp, '.md');
    if (parsed.frontmatter && parsed.frontmatter.name &&
        parsed.frontmatter.name !== basename) {
      results.push({
        ok: false,
        label: fp,
        message: 'frontmatter.name "' + parsed.frontmatter.name +
          '" does not match filename basename "' + basename + '"',
        issues: [{
          path: 'name',
          message: 'must match filename basename "' + basename + '"',
          got: parsed.frontmatter.name,
        }],
      });
      continue;
    }
    results.push(
      Object.assign(
        { label: fp },
        validate(specialistFrontmatterSchema, parsed.frontmatter, fp)
      )
    );
  }
  return results;
}

function run(opts) {
  const cwd = (opts && opts.cwd) || process.cwd();
  const json = !!(opts && opts.json);

  const configResult = validateConfigFile(cwd);
  const patternResults = validatePatternFiles(cwd);
  const specialistResults = validateSpecialistFiles(cwd);

  const allResults = [
    { group: 'config', results: [configResult] },
    { group: 'patterns', results: patternResults },
    { group: 'specialists', results: specialistResults },
  ];

  let totalChecked = 0;
  let totalFail = 0;
  for (const g of allResults) {
    for (const r of g.results) {
      totalChecked++;
      if (!r.ok && !r.skipped) totalFail++;
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: totalFail === 0,
      checked: totalChecked,
      failed: totalFail,
      groups: allResults,
    }, null, 2) + '\n');
    return totalFail === 0 ? 0 : 1;
  }

  // Pretty output
  for (const g of allResults) {
    process.stdout.write('\n[' + g.group + '] (' + g.results.length + ' file(s))\n');
    for (const r of g.results) {
      if (r.skipped) {
        process.stdout.write('  · ' + relativize(cwd, r.label) + ' — ' + r.skipped + '\n');
      } else if (r.ok) {
        process.stdout.write('  ✓ ' + relativize(cwd, r.label) + '\n');
      } else {
        process.stdout.write('  ✗ ' + relativize(cwd, r.label) + '\n');
        if (r.message && !Array.isArray(r.issues)) {
          process.stdout.write('      ' + r.message + '\n');
        }
        if (Array.isArray(r.issues)) {
          for (const iss of r.issues) {
            const gotStr = iss.got === undefined ? '' : ' (got ' + safeJson(iss.got) + ')';
            process.stdout.write('      - ' + iss.path + ': ' + iss.message + gotStr + '\n');
          }
        }
      }
    }
  }
  process.stdout.write('\n' + totalChecked + ' checked, ' + totalFail + ' with findings\n');
  return totalFail === 0 ? 0 : 1;
}

function relativize(cwd, p) {
  try {
    return path.relative(cwd, p) || p;
  } catch (_) {
    return p;
  }
}

function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    if (s && s.length > 120) return s.slice(0, 117) + '...';
    return s;
  } catch (_) {
    return '[unserializable]';
  }
}

module.exports = {
  run,
  validateConfigFile,
  validatePatternFiles,
  validateSpecialistFiles,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  let cwd = process.cwd();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--cwd' && args[i + 1]) { cwd = path.resolve(args[++i]); }
    else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: node bin/validate-config.js [--json] [--cwd ROOT]\n');
      process.exit(0);
    }
  }
  try {
    process.exit(run({ cwd, json }));
  } catch (err) {
    process.stderr.write('orchestray: internal error in validate-config: ' + (err && err.stack || err) + '\n');
    process.exit(2);
  }
}
