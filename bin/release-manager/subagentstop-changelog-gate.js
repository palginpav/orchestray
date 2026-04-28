#!/usr/bin/env node
'use strict';

/**
 * subagentstop-changelog-gate.js — SubagentStop hook wrapper that runs the
 * CHANGELOG↔shadow naming firewall ONLY when the stopping agent is
 * `release-manager`.
 *
 * Pattern parallels `bin/validate-no-deferral.js`: read the SubagentStop
 * payload, decide whether the gate applies, and if so invoke the underlying
 * firewall script. The firewall's `--release` flag is force-set so the kill
 * switch is ignored (release commits cannot opt out per F3 spec).
 *
 * Failure semantics:
 *   exit 2 → drift detected; SubagentStop is blocked (Claude Code surfaces
 *            the stderr content to the agent so the next turn can fix the
 *            CHANGELOG).
 *   exit 0 → no drift, or non-release-manager agent (gate not applicable).
 *
 * Fail-open: any error reading stdin or invoking the firewall → exit 0.
 */

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveSafeCwd } = require('../_lib/resolve-project-cwd');

function readStdinSync() {
  try {
    if (process.stdin.isTTY) return null;
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || raw.trim().length === 0) return null;
    return JSON.parse(raw);
  } catch (_e) {
    return null;
  }
}

function isReleaseManager(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const candidates = [
    payload.agent_type,
    payload.subagent_type,
    payload.agent_role,
    payload.role,
    payload.agent && payload.agent.type,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.toLowerCase() === 'release-manager') return true;
  }
  return false;
}

function main() {
  const payload = readStdinSync();
  const cwd     = resolveSafeCwd(payload && payload.cwd);

  if (!isReleaseManager(payload)) {
    return 0; // gate does not apply
  }

  const script = path.join(cwd, 'bin', 'release-manager', 'changelog-event-name-check.js');
  if (!fs.existsSync(script)) {
    process.stderr.write(`subagentstop-changelog-gate: missing ${script}\n`);
    return 0; // fail-open
  }

  const res = spawnSync('node', [script, '--release', '--cwd', cwd], {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 10000,
  });
  if (res.error) {
    process.stderr.write(`subagentstop-changelog-gate: spawn failed: ${res.error.message}\n`);
    return 0;
  }
  return typeof res.status === 'number' ? res.status : 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`subagentstop-changelog-gate: top-level error: ${e && e.message ? e.message : e}\n`);
    process.exit(0);
  }
}

module.exports = { main };
