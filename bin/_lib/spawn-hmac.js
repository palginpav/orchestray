'use strict';

/**
 * spawn-hmac.js — HMAC sign/verify for system-housekeeper spawn rows
 * (v2.2.21 W1-T2 closure of T4 F1, CWE-862 Missing Authorization).
 *
 * Threat model: any agent with the Write tool can append a JSONL row to
 * `.orchestray/state/spawn-requests.jsonl` claiming
 * `requester_agent: "system:housekeeper-trigger"` + `auto_approve: true`,
 * bypassing the cost-vs-budget gate at process-spawn-requests.js:286.
 *
 * Mitigation: legitimate writers (`bin/spawn-housekeeper-on-trigger.js`)
 * compute `signature = HMAC-SHA256(key, canonicalBody(row))` and append it
 * to the row. The drainer recomputes and constant-time compares. The HMAC
 * key lives at `~/.claude/orchestray/.spawn-hmac-key` (mode 0600), generated
 * at install time. An agent that cannot read that key cannot mint a forged
 * row.
 *
 * Allowlist short-circuit: this module is paired with a SYSTEM_REQUESTER_ALLOWLIST
 * in process-spawn-requests.js. A row whose requester_agent is in the allowlist
 * AND carries a valid HMAC signature passes. A row missing either fails.
 *
 * Kill switch: ORCHESTRAY_AUTO_APPROVE_ALLOWLIST_DISABLED=1 reverts to v2.2.20
 * behavior (handled by the caller; this module exposes verifyRow() unconditionally).
 *
 * Fail-open posture: this module never throws. Missing key → verify returns
 * false; signing returns null. Caller decides policy.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY_BYTES = 32;

/**
 * Resolve absolute path of the spawn-HMAC key file.
 * Lives under ~/.claude/orchestray/ so both global and local installs share it.
 */
function getKeyPath() {
  return path.join(os.homedir(), '.claude', 'orchestray', '.spawn-hmac-key');
}

/**
 * Read the HMAC key from disk. Returns null if absent or unreadable.
 */
function loadKey() {
  try {
    const buf = fs.readFileSync(getKeyPath(), 'utf8').trim();
    if (!buf) return null;
    return Buffer.from(buf, 'base64');
  } catch (_e) {
    return null;
  }
}

/**
 * Build a stable canonical body for HMAC. Field order is fixed; the signature
 * field is excluded. New fields added later MUST NOT change the canonical
 * body shape — they are unauthenticated metadata.
 */
function canonicalBody(row) {
  if (!row || typeof row !== 'object') return '';
  const parts = [
    String(row.request_id || ''),
    String(row.orchestration_id || ''),
    String(row.requester_agent || ''),
    String(row.requested_agent || ''),
    String(row.ts || ''),
  ];
  return parts.join('|');
}

/**
 * Compute HMAC-SHA256 hex over canonicalBody(row) with the given key buffer.
 */
function hmac(keyBuf, body) {
  return crypto.createHmac('sha256', keyBuf).update(body, 'utf8').digest('hex');
}

/**
 * Sign a spawn-request row in place. Returns the row with `signature` set,
 * or returns the original row unchanged when the key is missing (best-effort —
 * the drainer will then deny on signature verification, which is the safe
 * direction).
 */
function signRow(row) {
  if (!row || typeof row !== 'object') return row;
  const key = loadKey();
  if (!key) return row;
  const sig = hmac(key, canonicalBody(row));
  return Object.assign({}, row, { signature: sig });
}

/**
 * Verify a spawn-request row's signature. Returns true only when:
 *   - HMAC key file is readable
 *   - row.signature is a non-empty string
 *   - constant-time compare matches
 */
function verifyRow(row) {
  if (!row || typeof row !== 'object') return false;
  if (typeof row.signature !== 'string' || row.signature.length === 0) return false;
  const key = loadKey();
  if (!key) return false;
  const expected = hmac(key, canonicalBody(row));
  // Length-mismatch sidesteps timingSafeEqual's hard-throw on unequal buffers.
  if (expected.length !== row.signature.length) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'utf8'),
      Buffer.from(row.signature, 'utf8')
    );
  } catch (_e) {
    return false;
  }
}

/**
 * Install-time hook: generate the HMAC key if absent.
 *   - 32 random bytes, base64-encoded
 *   - mode 0600
 *   - parent directory created with mode 0700
 *
 * Returns:
 *   { created: boolean, path: string, error?: string }
 *
 * Idempotent: a second call with the file already present is a no-op
 * (created=false). NEVER overwrites — rotation is a separate operation.
 */
function ensureKey() {
  const keyPath = getKeyPath();
  try {
    if (fs.existsSync(keyPath)) {
      return { created: false, path: keyPath };
    }
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(KEY_BYTES).toString('base64');
    // Atomic write with mode 0600 from creation (do not rely on chmodSync alone).
    const tmp = keyPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, key + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (_e) { /* tolerate on non-POSIX */ }
    fs.renameSync(tmp, keyPath);
    try { fs.chmodSync(keyPath, 0o600); } catch (_e) { /* tolerate on non-POSIX */ }
    return { created: true, path: keyPath };
  } catch (err) {
    return { created: false, path: keyPath, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Mirror an existing key into a target path with mode 0600. Used for
 * dual-install setups where global+local installs both want the key
 * available without diverging. Never regenerates — only copies. No-op if
 * source missing or target already present.
 */
function mirrorKeyTo(targetKeyPath) {
  try {
    const srcPath = getKeyPath();
    if (!fs.existsSync(srcPath)) return { copied: false, reason: 'source_absent' };
    if (fs.existsSync(targetKeyPath)) return { copied: false, reason: 'target_exists' };
    fs.mkdirSync(path.dirname(targetKeyPath), { recursive: true, mode: 0o700 });
    const buf = fs.readFileSync(srcPath, 'utf8');
    const tmp = targetKeyPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, buf, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (_e) {}
    fs.renameSync(tmp, targetKeyPath);
    try { fs.chmodSync(targetKeyPath, 0o600); } catch (_e) {}
    return { copied: true };
  } catch (err) {
    return { copied: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  getKeyPath,
  loadKey,
  signRow,
  verifyRow,
  canonicalBody,
  ensureKey,
  mirrorKeyTo,
};
