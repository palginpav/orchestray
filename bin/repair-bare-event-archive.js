#!/usr/bin/env node
// NOT_A_HOOK (v2.3.24): CLI-only, one-shot maintenance utility. NOT wired
// into hooks/hooks.json and NOT invoked automatically anywhere — unlike the
// live-log repair (dark-event-banner.js's SessionStart path), archive repair
// rewrites 223 historical audit logs and is opt-in by design. See
// bin/_lib/normalize-bare-event-rows.js header note 4 and
// .orchestray/kb/decisions/v2324-curate-followups.md §Item 1.
'use strict';

// Usage:
//   node bin/repair-bare-event-archive.js [--dry-run] [--project-root=<path>]
//
// Kill switch: ORCHESTRAY_BARE_EVENT_ARCHIVE_REPAIR_DISABLED=1 (env) or
// `.orchestray/config.json` -> { "bare_event_key_archive_repair": { "enabled": false } }.
//
// Prints a per-file summary to stdout and exits 0 on success (including a
// disabled-by-kill-switch no-op), non-zero on a real error or a halted run
// (verification failure — see the module docstring for why the repair stops
// rather than continuing past a classifier disagreement).

const path = require('path');
const { repairArchiveBareEventRows } = require('./_lib/normalize-bare-event-rows');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const projectRootArg = argv.find((a) => a.startsWith('--project-root='));
const cwd = projectRootArg ? path.resolve(projectRootArg.split('=')[1]) : process.cwd();

const result = repairArchiveBareEventRows(cwd, { dryRun });

if (result.disabled) {
  process.stdout.write('[repair-bare-event-archive] disabled by kill switch — no-op\n');
  process.exit(0);
}

if (result.error && !result.ran) {
  process.stderr.write('[repair-bare-event-archive] error: ' + result.error + '\n');
  process.exit(1);
}

process.stdout.write(
  '[repair-bare-event-archive] ' + (dryRun ? 'DRY RUN — ' : '') +
  'filesScanned=' + result.filesScanned +
  ' filesChanged=' + result.filesChanged +
  ' rowsRepaired=' + result.rowsRepaired +
  ' rowsMalformed=' + result.rowsMalformed +
  ' rowsBothKeys=' + result.rowsBothKeys +
  ' verificationFailures=' + result.verificationFailures +
  (result.reportPath ? ' report=' + result.reportPath : '') + '\n'
);

for (const f of result.perFile) {
  if (f.changed) {
    process.stdout.write(
      '  ' + f.relPath + ': backfilled=' + f.backfilled +
      ' bothKeys=' + f.bothKeysCount + ' malformed=' + f.malformedCount +
      ' totalLines=' + f.totalLines +
      (f.verified === null ? '' : ' verified=' + f.verified) + '\n'
    );
  }
}

if (result.halted) {
  process.stderr.write('[repair-bare-event-archive] HALTED: ' + result.error + '\n');
  process.stderr.write(
    '[repair-bare-event-archive] files already processed keep their backups; ' +
    're-run after investigating to resume with the remaining files.\n'
  );
  process.exit(1);
}

process.exit(0);
