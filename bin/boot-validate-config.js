#!/usr/bin/env node
'use strict';

/**
 * bin/boot-validate-config.js — SessionStart hook wrapper around
 * `bin/validate-config.js`.
 *
 * v2.1.13 R-ZOD. Runs the zod-schema validation as a Claude Code
 * SessionStart hook. Writes a loud summary to stderr on any failure and
 * exits non-zero so the user sees the issue at session start.
 *
 * This is a thin shim so the `SessionStart` hook entry in `hooks.json` can
 * have a stable path (`bin/boot-validate-config.js`) even if the underlying
 * validator CLI's behavior (arg parsing, exit codes) evolves.
 *
 * Exit codes mirror validate-config.js:
 *   0 — all checks passed
 *   1 — at least one artifact failed validation
 *   2 — internal error (zod not installed, I/O, etc.)
 */

const path = require('path');

try {
  const { run } = require('./validate-config.js');
  // Human-readable output in SessionStart context; use --json if the user
  // explicitly sets ORCHESTRAY_BOOT_VALIDATE_JSON=1.
  const json = process.env.ORCHESTRAY_BOOT_VALIDATE_JSON === '1';
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const code = run({ cwd, json });
  if (code !== 0) {
    process.stderr.write(
      '\n[orchestray] boot-validate-config: one or more files failed zod validation.\n' +
      '  Re-run with: node bin/validate-config.js --cwd ' + cwd + '\n' +
      '  See `.orchestray/config.json`, `.orchestray/patterns/*.md`,\n' +
      '  and `specialists/*.md` for details.\n'
    );
  }
  process.exit(code);
} catch (err) {
  // Most likely cause: zod missing (postinstall skipped, partial install).
  // Emit a targeted stderr message and exit 2 so the boot signals clearly.
  const msg = err && err.stack ? err.stack : String(err);
  process.stderr.write(
    '[orchestray] boot-validate-config internal error:\n' + msg + '\n' +
    '  Most likely cause: `zod` is not installed. Run `npm install` in the plugin directory.\n'
  );
  process.exit(2);
}
