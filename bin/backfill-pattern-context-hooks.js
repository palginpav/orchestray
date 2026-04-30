#!/usr/bin/env node
// NOT_A_HOOK (v2.2.15 FN-59): CLI-only utility, not wired as a hook handler.
'use strict';

/**
 * bin/backfill-pattern-context-hooks.js (R-CAT-DEFAULT v2.1.16)
 *
 * One-time Haiku-driven backfill of the `context_hook` frontmatter field on
 * pattern files. Companion to v2.1.14's `bin/backfill-pattern-hooks.js` —
 * that script extracts the hook from the first sentence of `## Context`;
 * this one calls Claude Haiku 4.5 to generate a focused trigger sentence
 * ("WHEN does this pattern apply?") for patterns whose extracted hooks are
 * weak or whose `## Context` section is missing.
 *
 * Idempotent: skips patterns that already have a non-empty `context_hook`.
 *
 * Cap: stops after MAX_API_CALLS (200) Haiku calls. Logs progress every 25.
 *
 * On the first real run the user must approve a diff/preview (per the
 * v2.1.14 R-SHDW shadow-regen pattern) — invoke `--dry-run` first to see
 * what WOULD change, then run without the flag to write.
 *
 * Usage:
 *   node bin/backfill-pattern-context-hooks.js [--dry-run] [--dir <d>]
 *
 * Options:
 *   --dry-run         Print what would be written; do NOT call the API
 *                     and do NOT modify files.
 *   --dir <d>         Pattern directory (default: .orchestray/patterns/).
 *                     May be repeated to walk multiple stores; if omitted,
 *                     scans .orchestray/patterns/ and any directory named
 *                     "patterns" under cwd (depth-bounded glob).
 *   --model <id>      Haiku model id (default: claude-haiku-4-5-20251001).
 *   --max-calls <N>   Override the 200-call cap.
 *
 * Environment:
 *   ANTHROPIC_API_KEY — required for live runs (not required for --dry-run).
 *
 * Exit codes:
 *   0  success (or dry-run completed cleanly)
 *   1  hard error (missing API key on a live run; pattern dir unreadable;
 *      Anthropic API error; cap exceeded with --strict)
 */

const fs   = require('node:fs');
const path = require('node:path');
const https = require('node:https');

// ---------------------------------------------------------------------------
// Frontmatter library — same loader as v2.1.14 backfill-pattern-hooks.js.
// ---------------------------------------------------------------------------

let frontmatter;
try {
  frontmatter = require('./mcp-server/lib/frontmatter');
} catch (_e1) {
  try {
    frontmatter = require(path.join(__dirname, 'mcp-server', 'lib', 'frontmatter'));
  } catch (e2) {
    process.stderr.write(
      'backfill-pattern-context-hooks: cannot load frontmatter lib: ' + e2.message + '\n'
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

// Update DEFAULT_MODEL when Haiku ships a new minor; Anthropic-pinned model
// IDs become deprecation-targeted on a ~6-month cycle. The `--model <id>` flag
// overrides this constant for one-shot reruns. See v2.1.16 R-CAT-DEFAULT.
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_CALLS = 200;
const PROGRESS_EVERY = 25;
const HOOK_MAX_CHARS = 120;

function parseArgs(argv) {
  const out = { dryRun: false, dirs: [], model: DEFAULT_MODEL, maxCalls: DEFAULT_MAX_CALLS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--dir' && argv[i + 1]) { out.dirs.push(argv[++i]); }
    else if (a === '--model' && argv[i + 1]) { out.model = argv[++i]; }
    else if (a === '--max-calls' && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) out.maxCalls = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pattern directory discovery
// ---------------------------------------------------------------------------

function discoverDirs(explicitDirs) {
  if (explicitDirs.length > 0) return explicitDirs.map((d) => path.resolve(d));

  const found = new Set();

  // Default canonical store.
  const canonical = path.join(process.cwd(), '.orchestray', 'patterns');
  if (fs.existsSync(canonical) && fs.statSync(canonical).isDirectory()) {
    found.add(canonical);
  }

  // Shallow walk for any other **/patterns directory under cwd. We bound depth
  // to keep this script safe to run from a large repo root.
  const MAX_DEPTH = 4;
  function walk(dir, depth) {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_e) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') && e.name !== '.orchestray') continue;
      if (e.name === 'node_modules') continue;
      const child = path.join(dir, e.name);
      if (e.name === 'patterns') found.add(child);
      walk(child, depth + 1);
    }
  }
  walk(process.cwd(), 0);

  return Array.from(found);
}

// ---------------------------------------------------------------------------
// Pattern file enumeration (.md and .json)
// ---------------------------------------------------------------------------

function listPatternFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (err) {
    process.stderr.write(
      'backfill-pattern-context-hooks: cannot read dir "' + dir + '": ' + err.message + '\n'
    );
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.md') || n.endsWith('.json'))
    .map((n) => path.join(dir, n))
    .sort();
}

// ---------------------------------------------------------------------------
// Pattern parse + skip detection
// ---------------------------------------------------------------------------

/**
 * Read a pattern file and return either:
 *   { kind: "md", parsed, hasHook, body, slug }
 *   { kind: "json", obj, hasHook, body, slug }
 *   { kind: "skip", reason } when the file is malformed or unsupported.
 */
function loadPattern(filepath) {
  let raw;
  try { raw = fs.readFileSync(filepath, 'utf8'); }
  catch (err) { return { kind: 'skip', reason: 'read-error: ' + err.message }; }

  if (filepath.endsWith('.md')) {
    const parsed = frontmatter.parse(raw);
    if (!parsed.hasFrontmatter) {
      return { kind: 'skip', reason: 'no-frontmatter' };
    }
    const fm = parsed.frontmatter;
    const slug = typeof fm.name === 'string' ? fm.name : path.basename(filepath, '.md');
    const hasHook =
      typeof fm.context_hook === 'string' && fm.context_hook.trim().length >= 5;
    return {
      kind: 'md',
      parsed,
      hasHook,
      body: parsed.body,
      slug,
    };
  }

  if (filepath.endsWith('.json')) {
    let obj;
    try { obj = JSON.parse(raw); }
    catch (err) { return { kind: 'skip', reason: 'json-parse-error: ' + err.message }; }
    if (!obj || typeof obj !== 'object') {
      return { kind: 'skip', reason: 'json-not-object' };
    }
    const slug = typeof obj.name === 'string' ? obj.name :
                 typeof obj.slug === 'string' ? obj.slug :
                 path.basename(filepath, '.json');
    const hasHook =
      typeof obj.context_hook === 'string' && obj.context_hook.trim().length >= 5;
    // Use any descriptive field as the body for the prompt.
    const body = [obj.description, obj.context, obj.approach, obj.body]
      .filter((x) => typeof x === 'string' && x.trim().length > 0)
      .join('\n\n');
    return { kind: 'json', obj, hasHook, body, slug, raw };
  }

  return { kind: 'skip', reason: 'unsupported-extension' };
}

// ---------------------------------------------------------------------------
// Haiku prompt + Anthropic API call
// ---------------------------------------------------------------------------

function buildPrompt(slug, body) {
  const trimmedBody = (body || '').slice(0, 4000); // Cap body to keep input small.
  return (
    'Given the following Orchestray pattern, write a single sentence ' +
    '(<=' + HOOK_MAX_CHARS + ' chars) named "context_hook" that names the ' +
    'trigger condition: WHEN does this pattern apply?\n' +
    'Output ONLY the sentence. No quotes, no JSON, no preamble.\n\n' +
    'Pattern slug: ' + slug + '\n\n' +
    'Pattern:\n' + trimmedBody + '\n'
  );
}

function callHaiku({ apiKey, model, prompt, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => { chunks += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(
              'Anthropic API ' + res.statusCode + ': ' + chunks.slice(0, 500)
            ));
          }
          let parsed;
          try { parsed = JSON.parse(chunks); }
          catch (err) { return reject(new Error('JSON parse: ' + err.message)); }
          const text = (parsed.content || [])
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
            .trim();
          if (!text) return reject(new Error('empty response from Haiku'));
          resolve(text);
        });
      }
    );

    req.on('timeout', () => { req.destroy(new Error('request timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sanitizeHook(text) {
  if (typeof text !== 'string') return null;
  // Take the first line; trim quotes/markdown; cap to HOOK_MAX_CHARS.
  let line = text.split('\n').map((s) => s.trim()).find((s) => s.length > 0) || '';
  // Strip surrounding quotes/backticks if Haiku included them despite the prompt.
  line = line.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  if (line.length < 5) return null;
  if (line.length > HOOK_MAX_CHARS) line = line.slice(0, HOOK_MAX_CHARS - 1) + '…';
  return line;
}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

function writeMdHook(filepath, hook) {
  const result = frontmatter.rewriteField(filepath, 'context_hook', hook);
  if (!result.ok) throw new Error('rewriteField: ' + result.error);
}

function writeJsonHook(filepath, obj, hook) {
  obj.context_hook = hook;
  const next = JSON.stringify(obj, null, 2) + '\n';
  fs.writeFileSync(filepath, next, 'utf8');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dirs = discoverDirs(args.dirs);

  if (dirs.length === 0) {
    process.stderr.write(
      'backfill-pattern-context-hooks: no pattern directories found ' +
      '(searched .orchestray/patterns and **/patterns under cwd).\n'
    );
    process.exit(1);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!args.dryRun && (!apiKey || apiKey.trim().length === 0)) {
    process.stderr.write(
      'backfill-pattern-context-hooks: ANTHROPIC_API_KEY is not set.\n' +
      '  This script calls Claude Haiku once per pattern. Set the env var ' +
      'or pass --dry-run to preview without calling the API.\n'
    );
    process.exit(1);
  }

  process.stdout.write(
    'backfill-pattern-context-hooks: ' + (args.dryRun ? 'DRY-RUN — ' : '') +
    'scanning ' + dirs.length + ' director' + (dirs.length === 1 ? 'y' : 'ies') + ':\n'
  );
  for (const d of dirs) process.stdout.write('  - ' + d + '\n');

  let scanned = 0;
  let alreadyHooked = 0;
  let skipped = 0;
  let calls = 0;
  let written = 0;
  let errors = 0;
  const writes = []; // [{ filepath, slug, hook, kind, obj? }]

  outer: for (const dir of dirs) {
    const files = listPatternFiles(dir);
    for (const filepath of files) {
      scanned++;
      const loaded = loadPattern(filepath);
      if (loaded.kind === 'skip') {
        skipped++;
        process.stdout.write('  SKIP (' + loaded.reason + '): ' + path.relative(process.cwd(), filepath) + '\n');
        continue;
      }
      if (loaded.hasHook) {
        alreadyHooked++;
        continue; // idempotent: already populated.
      }
      if (!loaded.body || loaded.body.trim().length < 5) {
        skipped++;
        process.stdout.write('  SKIP (empty body): ' + path.relative(process.cwd(), filepath) + '\n');
        continue;
      }

      if (calls >= args.maxCalls) {
        process.stdout.write(
          '  STOP: reached cap of ' + args.maxCalls + ' Haiku calls. ' +
          'Re-run after this batch lands.\n'
        );
        break outer;
      }

      // Build the prompt regardless of dry-run, so we can preview the input.
      const prompt = buildPrompt(loaded.slug, loaded.body);

      if (args.dryRun) {
        calls++; // count the would-be call
        process.stdout.write(
          '  DRY-RUN would call Haiku for: ' + loaded.slug +
          '  (file=' + path.relative(process.cwd(), filepath) +
          ', body_chars=' + loaded.body.length + ')\n'
        );
      } else {
        let raw;
        try {
          raw = await callHaiku({ apiKey, model: args.model, prompt });
          calls++;
        } catch (err) {
          errors++;
          process.stderr.write('  ERROR ' + loaded.slug + ': ' + err.message + '\n');
          continue;
        }

        const hook = sanitizeHook(raw);
        if (!hook) {
          errors++;
          process.stderr.write('  ERROR ' + loaded.slug + ': empty/invalid hook from Haiku\n');
          continue;
        }

        writes.push({ filepath, slug: loaded.slug, hook, kind: loaded.kind, obj: loaded.obj });

        try {
          if (loaded.kind === 'md') writeMdHook(filepath, hook);
          else writeJsonHook(filepath, loaded.obj, hook);
          written++;
          process.stdout.write('  WROTE ' + loaded.slug + ': ' + hook + '\n');
        } catch (err) {
          errors++;
          process.stderr.write('  WRITE-ERROR ' + loaded.slug + ': ' + err.message + '\n');
        }
      }

      if (calls > 0 && calls % PROGRESS_EVERY === 0) {
        process.stdout.write(
          '  progress: ' + calls + ' calls, ' + written + ' written, ' +
          errors + ' errors\n'
        );
      }
    }
  }

  process.stdout.write(
    '\nbackfill-pattern-context-hooks: done.\n' +
    '  scanned=' + scanned + '\n' +
    '  already_hooked=' + alreadyHooked + '\n' +
    '  skipped=' + skipped + '\n' +
    '  calls=' + calls + (args.dryRun ? ' (dry-run)' : '') + '\n' +
    '  written=' + written + '\n' +
    '  errors=' + errors + '\n'
  );

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write('backfill-pattern-context-hooks: fatal: ' + (err && err.stack || err) + '\n');
  process.exit(1);
});
