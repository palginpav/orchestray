#!/usr/bin/env node
'use strict';

/**
 * sentinel-probe.js — P1.4 thin CLI shim around `bin/_lib/sentinel-probes.js`.
 *
 * Usage: node bin/sentinel-probe.js <op> '<json-args>'
 *
 * Exit codes:
 *   0 — probe returned {ok:true}
 *   1 — probe returned {ok:false} (fail-soft)
 *   2 — caller-side error (argv parse, unknown op pre-dispatch, JSON parse error)
 *
 * The PM-prompt §3.S referral teaches the PM to prefer this one-shot CLI shape
 * over hand-rolled `Bash([ -f X ])` constructions. Every call funnels through
 * `runProbe` which emits a `sentinel_probe` audit event.
 */

const { runProbe, _ALLOWED_OPS } = require('./_lib/sentinel-probes');
const { MAX_INPUT_BYTES }        = require('./_lib/constants');

function _printAndExit(result, exitCode) {
  try {
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (_e) {
    process.stdout.write('{"ok":false,"reason":"stringify_failed"}\n');
  }
  process.exit(exitCode);
}

function main() {
  const op = process.argv[2];
  const argsRaw = process.argv[3];

  if (typeof op !== 'string' || op.length === 0) {
    _printAndExit({ ok: false, reason: 'missing_op' }, 2);
  }
  if (!_ALLOWED_OPS.includes(op)) {
    _printAndExit({ ok: false, reason: 'unknown_op' }, 2);
  }
  if (typeof argsRaw !== 'string') {
    _printAndExit({ ok: false, reason: 'missing_args' }, 2);
  }
  if (Buffer.byteLength(argsRaw, 'utf8') > MAX_INPUT_BYTES) {
    _printAndExit({ ok: false, reason: 'args_too_large' }, 2);
  }

  let args;
  try {
    args = JSON.parse(argsRaw);
  } catch (_e) {
    _printAndExit({ ok: false, reason: 'invalid_json' }, 2);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    _printAndExit({ ok: false, reason: 'invalid_input' }, 2);
  }

  let result;
  try {
    result = runProbe(op, args, { source: 'cli' });
  } catch (_e) {
    // runProbe is documented as never-throws; this is the defence-in-depth catch.
    _printAndExit({ ok: false, reason: 'probe_internal_error' }, 1);
  }

  _printAndExit(result, result && result.ok === true ? 0 : 1);
}

main();
