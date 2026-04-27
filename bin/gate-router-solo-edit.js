#!/usr/bin/env node
'use strict';

/**
 * gate-router-solo-edit.js — PreToolUse hook for pm-router solo path.
 *
 * Blocks pm-router from Edit/Write/MultiEdit to protected Orchestray paths
 * and enforces the solo_max_files file-count cap.
 *
 * Exit 0 = allow. Exit 2 = block. Fail-open on unexpected errors.
 *
 * Scoped to pm-router agent only. All other agents: exit 0 immediately.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

// Per-invocation nonce: unique per Node process import (each hook invocation
// is a fresh process). Ensures fallback session IDs are unique even if two
// concurrent pm-router hooks share a PID (impossible in practice but safe).
const SESSION_NONCE = crypto.randomBytes(8).toString('hex');

const PROTECTED_PATH_PREFIXES = [
  'agents/',
  'agents/pm-reference/',
  'bin/',
  'hooks/',
  'skills/',
  '.claude/',
];

function loadConfig(cwd) {
  const cfgPath = path.join(cwd, '.orchestray', 'config.json');
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (_e) { return {}; }
}

function getMaxFiles(cfg) {
  return (cfg.pm_router &&
    Number.isInteger(cfg.pm_router.solo_max_files) &&
    cfg.pm_router.solo_max_files > 0)
    ? cfg.pm_router.solo_max_files : 1;
}

function isProtectedPath(filePath, cwd) {
  // Normalize: if absolute, make repo-relative; if relative, use as-is.
  let rel = filePath;
  if (path.isAbsolute(filePath)) {
    rel = path.relative(cwd, filePath);
  }
  // Normalize path separators and remove leading ./
  rel = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function getLedgerPath(cwd) {
  return path.join(cwd, '.orchestray', 'state', 'router-solo-edits.jsonl');
}

function readLedger(ledgerPath) {
  try {
    const lines = fs.readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
    return lines.map(l => { try { return JSON.parse(l); } catch (_e) { return null; } }).filter(Boolean);
  } catch (_e) { return []; }
}

function appendLedger(ledgerPath, entry) {
  try {
    const dir = path.dirname(ledgerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
  } catch (_e) { /* fail-open */ }
}

function getSessionId() {
  if (process.env.CLAUDE_AGENT_SESSION_ID) return process.env.CLAUDE_AGENT_SESSION_ID;
  const agentType = process.env.ORCHESTRAY_AGENT_TYPE || 'pm-router';
  // Include SESSION_NONCE to guarantee uniqueness per hook invocation even
  // when CLAUDE_AGENT_SESSION_ID is absent (e.g., in tests or older runtimes).
  return agentType + '-' + process.pid + '-' + SESSION_NONCE;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) process.exit(0);
});
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input || '{}');

    // Scope to pm-router only.
    const agentType = event.agent_type || event.subagent_type || process.env.ORCHESTRAY_AGENT_TYPE || '';
    if (agentType !== 'pm-router') {
      process.exit(0);
    }

    const toolName = event.tool_name || '';
    if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) {
      process.exit(0);
    }

    const toolInput = event.tool_input || {};
    // MultiEdit uses 'path', others use 'file_path'.
    const filePath = toolInput.file_path || toolInput.path || '';

    const cwd = resolveSafeCwd(event.cwd);
    const cfg = loadConfig(cwd);

    // Protected path check.
    if (filePath && isProtectedPath(filePath, cwd)) {
      process.stderr.write('BLOCK pm-router solo edit: protected path ' + filePath + '. Escalate task.\n');
      process.exit(2);
    }

    // solo_max_files cap.
    const maxFiles = getMaxFiles(cfg);
    const ledgerPath = getLedgerPath(cwd);
    const sessionId = getSessionId();
    const rows = readLedger(ledgerPath);
    const sessionEdits = rows.filter(r => r.agent_session_id === sessionId);

    if (sessionEdits.length >= maxFiles) {
      process.stderr.write('BLOCK pm-router solo: file cap reached (solo_max_files=' + maxFiles + '). Escalate task.\n');
      process.exit(2);
    }

    // Allowed — append to ledger.
    appendLedger(ledgerPath, {
      timestamp: new Date().toISOString(),
      agent_session_id: sessionId,
      file_path: filePath,
    });

    process.exit(0);
  } catch (_e) {
    // Fail-open.
    process.exit(0);
  }
});
