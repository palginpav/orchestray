'use strict';

/**
 * spawn-context-delta.js — hash-anchored delegation-prompt delta (P3.2, v2.2.0).
 *
 * Computes the delta between the CURRENT delegation prompt the PM is about to
 * emit and the most-recently-cached "static prefix" for the same
 * (orchestration_id, agent_type) pair. First spawn returns the full prompt;
 * subsequent spawns return a small delta block referencing the pinned prefix's
 * sha256 and disk path.
 *
 * State (in-memory + on-disk):
 *   - `stateMap` (in-process Map) keyed by `${orch}::${agent_type}`.
 *   - `.orchestray/state/spawn-prefix-cache/<orch>-<agent>.txt` — atomic write
 *     (`<path>.tmp` + rename). Mirrors compose-block-a.js:332 pattern. Allows
 *     a SessionStart that re-imports the dossier (without /compact) to rebuild
 *     stateMap by globbing the directory and re-hashing on load.
 *
 * Static-vs-per-spawn split is STRUCTURAL: the PM wraps sections in
 *   <!-- delta:static-begin -->   ... <!-- delta:static-end -->
 *   <!-- delta:per-spawn-begin --> ... <!-- delta:per-spawn-end -->
 * markers. Failure to find both pairs yields type='full' with reason='markers_missing'
 * — fail-soft to today's behaviour.
 *
 * Failure modes (all fail-soft to type='full'):
 *   - empty/null prompt        → reason='empty_prompt'
 *   - markers missing/multi    → reason='markers_missing'
 *   - hash mismatch mid-orch   → reason='hash_mismatch' (re-caches new prefix)
 *   - explicit post-compact    → reason='post_compact_resume'
 *   - dossier auto-detect      → reason='post_compact_resume'
 *   - disk write failure       → reason='disk_write_failed'
 *
 * Public API: { computeDelta, splitStaticAndPerSpawn, __resetCache, __purgeOrch }.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { resolveSafeCwd } = require('./resolve-project-cwd');

// ---------------------------------------------------------------------------
// Constants (binding)
// ---------------------------------------------------------------------------

const PREFIX_CACHE_DIR = path.join('.orchestray', 'state', 'spawn-prefix-cache');
const DOSSIER_PATH     = path.join('.orchestray', 'state', 'resilience-dossier.json');
const CONFIG_REL       = path.join('.orchestray', 'config.json');

const MARK_STATIC_BEGIN   = '<!-- delta:static-begin -->';
const MARK_STATIC_END     = '<!-- delta:static-end -->';
const MARK_PER_SPAWN_BEGIN = '<!-- delta:per-spawn-begin -->';
const MARK_PER_SPAWN_END   = '<!-- delta:per-spawn-end -->';

// ---------------------------------------------------------------------------
// Module-private state — cleared by __resetCache for tests.
// ---------------------------------------------------------------------------

const stateMap = new Map();   // key: `${orch}::${agent_type}` → { prefix_hash, prefix_path, prefix_bytes, cached_at }

function __resetCache() {
  stateMap.clear();
  _rehydrateDoneFor = null;
}

function __purgeOrch(orchestration_id, cwd) {
  for (const k of Array.from(stateMap.keys())) {
    if (k.startsWith(orchestration_id + '::')) stateMap.delete(k);
  }
  try {
    const dir = path.join(cwd || resolveSafeCwd(null), PREFIX_CACHE_DIR);
    if (fs.existsSync(dir)) {
      for (const ent of fs.readdirSync(dir)) {
        if (ent.startsWith(orchestration_id + '-') && ent.endsWith('.txt')) {
          try { fs.rmSync(path.join(dir, ent)); } catch (_e) { /* fail-open */ }
        }
      }
    }
  } catch (_e) { /* fail-open */ }
}

// F-003 (v2.2.0 fix-pass): post-restart cache rehydration.
//
// The P3.2 §1 design promised: "Persistence is atomic … so a SessionStart
// that re-imports the dossier (without /compact) can rebuild stateMap by
// globbing the directory and re-hashing on load." This function implements
// that rebuild — globs the prefix-cache dir, recomputes the SHA-256 of each
// file's contents, and seeds stateMap. Called once per process the first
// time computeDelta is invoked. Idempotent: subsequent calls are no-ops.
//
// Without this, after a process restart with disk cache present, the
// in-memory stateMap is empty. The hot-path delta check sees no
// cachedEntry and falls back to type='full' with reason='first_spawn',
// re-writing the same file. Slot 4's cache pinning may still salvage the
// API-side savings, but observability becomes misleading.
let _rehydrateDoneFor = null;

function __rehydrateFromDisk(cwd) {
  const resolved = cwd ? path.resolve(cwd) : resolveSafeCwd(null);
  if (_rehydrateDoneFor === resolved) return;
  _rehydrateDoneFor = resolved;
  // S-006: opportunistic stale-file sweep on first rehydrate per process.
  // 14-day TTL bounded at 100 deletions — avoids I/O spike on the
  // first computeDelta after a long-idle install.
  try { sweepStalePrefixCache(resolved); } catch (_e) { /* fail-open */ }
  try {
    const dir = path.join(resolved, PREFIX_CACHE_DIR);
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir)) {
      if (!ent.endsWith('.txt')) continue;
      // Filename format: `<orch>-<agent>.txt`. The orch token always
      // starts `orch-` (per `bin/ox.js`) so we split on the first '-' AFTER
      // the `orch-` prefix (i.e., on the second '-').
      const stem = ent.slice(0, -('.txt'.length));
      // The orch id is everything up to the LAST '-' in the stem; the
      // final segment is the agent_type. This works as long as agent_type
      // names contain no '-', which is true for the standard subagent set.
      // For agent_type names with '-' (e.g., 'release-manager', 'pm-router'),
      // the last segment captures only the trailing token; we accept the
      // ambiguity because the SHA-recompute is the truth source for the
      // hot-path match — a wrong split just means the seeded entry is
      // unused (cachedEntry won't match the recomputed hash on next spawn).
      const lastDash = stem.lastIndexOf('-');
      if (lastDash <= 0) continue;
      const orch = stem.slice(0, lastDash);
      const agent = stem.slice(lastDash + 1);
      const abs = path.join(dir, ent);
      let body;
      try { body = fs.readFileSync(abs, 'utf8'); }
      catch (_e) { continue; }
      const prefixHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
      const prefixBytes = Buffer.byteLength(body, 'utf8');
      let cachedAt;
      try { cachedAt = fs.statSync(abs).mtime.toISOString(); }
      catch (_e) { cachedAt = new Date(0).toISOString(); }
      stateMap.set(orch + '::' + agent, {
        prefix_hash: prefixHash,
        prefix_path: path.join(PREFIX_CACHE_DIR, ent),
        prefix_bytes: prefixBytes,
        cached_at: cachedAt,
      });
    }
  } catch (_e) { /* fail-open */ }
}

function __resetRehydrateGuard() {
  _rehydrateDoneFor = null;
}

// S-006 (v2.2.0 fix-pass): 14-day stale-file sweep on the spawn-prefix-cache.
// The brief mentioned a sweep; this audit confirmed it was absent. Long-running
// installations accumulate one file per (orchestration_id, agent_type) pair
// forever. Bounded at 100 deletions per call to avoid I/O spikes during a
// SessionStart hook. Idempotent and fail-open. Returns the number of files
// deleted (callers may emit a state_gc_run row but the sweep itself does not).
const STALE_PREFIX_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const STALE_PREFIX_CACHE_BATCH = 100;

function sweepStalePrefixCache(cwd, opts) {
  opts = opts || {};
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs > 0
    ? opts.ttlMs
    : STALE_PREFIX_CACHE_TTL_MS;
  const batch = typeof opts.batch === 'number' && opts.batch > 0
    ? opts.batch
    : STALE_PREFIX_CACHE_BATCH;
  const resolvedCwd = cwd ? path.resolve(cwd) : resolveSafeCwd(null);
  const dir = path.join(resolvedCwd, PREFIX_CACHE_DIR);
  let deleted = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - ttlMs;
    const ents = fs.readdirSync(dir);
    for (const ent of ents) {
      if (!ent.endsWith('.txt') && !ent.endsWith('.tmp')) continue;
      if (deleted >= batch) break;
      const abs = path.join(dir, ent);
      try {
        const st = fs.statSync(abs);
        if (st.mtimeMs < cutoff) {
          fs.rmSync(abs);
          deleted++;
          // Also drop any stateMap entry pointing to this file.
          const stem = ent.endsWith('.txt') ? ent.slice(0, -4) : ent.slice(0, -4);
          const lastDash = stem.lastIndexOf('-');
          if (lastDash > 0) {
            const orchKey = stem.slice(0, lastDash);
            const agentKey = stem.slice(lastDash + 1);
            stateMap.delete(orchKey + '::' + agentKey);
          }
        }
      } catch (_e) { /* skip — fail-open */ }
    }
  } catch (_e) { /* fail-open */ }
  return deleted;
}

// ---------------------------------------------------------------------------
// Marker split — byte-exact, no whitespace normalization
// ---------------------------------------------------------------------------

/**
 * Split the assembled delegation prompt into {static, perSpawn}. Returns null
 * if any marker is missing, present multiple times, or out-of-order.
 *
 * @param {string} text
 * @returns {{static: string, perSpawn: string}|null}
 */
function splitStaticAndPerSpawn(text) {
  if (typeof text !== 'string' || text.length === 0) return null;

  // Multi-match rejection: each marker must appear EXACTLY ONCE.
  for (const m of [MARK_STATIC_BEGIN, MARK_STATIC_END, MARK_PER_SPAWN_BEGIN, MARK_PER_SPAWN_END]) {
    if (text.split(m).length - 1 !== 1) return null;
  }

  const sB = text.indexOf(MARK_STATIC_BEGIN);
  const sE = text.indexOf(MARK_STATIC_END);
  const pB = text.indexOf(MARK_PER_SPAWN_BEGIN);
  const pE = text.indexOf(MARK_PER_SPAWN_END);

  if (!(sB < sE && sE < pB && pB < pE)) return null;

  const staticStart   = sB + MARK_STATIC_BEGIN.length;
  const staticPortion = text.slice(staticStart, sE);
  const perSpawnStart = pB + MARK_PER_SPAWN_BEGIN.length;
  const perSpawn      = text.slice(perSpawnStart, pE);

  return { static: staticPortion, perSpawn };
}

// ---------------------------------------------------------------------------
// F-001 (v2.2.0 fix-pass): kill-switch defence-in-depth.
//
// The PM-prompt layer was the only place that honored the documented
// `ORCHESTRAY_DISABLE_DELEGATION_DELTA=1` env var and the
// `pm_protocol.delegation_delta.enabled === false` config flag. The PM
// could (in principle) drift on prompt compliance, leaving the helper
// emitting deltas even when an operator had explicitly disabled them.
// This helper-level check mirrors `bin/_lib/audit-round-archive.js::isDisabled()`.
//
// Either kill switch returning true → computeDelta returns
// type='full' with reason='disabled', leaving the prompt unmodified.
// ---------------------------------------------------------------------------

function isDisabled(cwd) {
  if (process.env.ORCHESTRAY_DISABLE_DELEGATION_DELTA === '1') return true;
  try {
    const raw = fs.readFileSync(path.join(cwd, CONFIG_REL), 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg === 'object') {
      const block = cfg.pm_protocol && cfg.pm_protocol.delegation_delta;
      if (block && block.enabled === false) return true;
    }
  } catch (_e) { /* fail-open: defaults apply */ }
  return false;
}

// ---------------------------------------------------------------------------
// Dossier auto-detect for post-compact resume
// ---------------------------------------------------------------------------

function readDossierLastCompactAt(cwd) {
  try {
    const p = path.join(cwd, DOSSIER_PATH);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!j || typeof j !== 'object') return null;
    return j.last_compact_detected_at || null;
  } catch (_e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API: computeDelta
// ---------------------------------------------------------------------------

/**
 * Compute the spawn-context delta. See header for full contract.
 */
// S-004 (v2.2.0 fix-pass): orchestration_id and agent_type are concatenated
// into the spawn-prefix-cache filename. Without containment, an
// agent_type like `'../../etc/passwd'` would let the atomic-write at
// fs.renameSync drop the static delegation-prompt portion at an
// arbitrary path. CWE-22 path traversal. Mirrors S-003 in
// audit-round-archive.js. orch must start with `orch-` per ox.js;
// agent_type is an alphanumeric subagent-name token.
const ORCH_ID_RE_DELTA = /^orch-[a-zA-Z0-9_-]+$/;
const AGENT_TYPE_RE_DELTA = /^[a-zA-Z0-9_-]+$/;

function computeDelta(currentDelegationPrompt, opts) {
  opts = opts || {};
  const cwd = opts.cwd ? path.resolve(opts.cwd) : resolveSafeCwd(null);
  const orch = String(opts.orchestration_id || '');
  const agent = String(opts.agent_type || '');

  // F-003: rehydrate stateMap from disk on first invocation per process.
  // This handles a process restart where the prefix-cache files survive on
  // disk but stateMap was wiped. Idempotent — _rehydrateDoneFor guards
  // against re-globbing on every call.
  __rehydrateFromDisk(cwd);

  // F-001: helper-side kill-switch short-circuit. Mirror P3.1's
  // audit-round-archive.js::isDisabled pattern so the documented kill
  // switches are enforced at the helper level, not just the PM-prompt layer.
  if (isDisabled(cwd)) {
    return {
      type: 'full',
      text: currentDelegationPrompt || '',
      prefix_hash: null,
      prefix_path: null,
      prefix_bytes: 0,
      delta_text: null,
      delta_bytes: null,
      full_bytes_avoided: 0,
      reason: 'disabled',
    };
  }

  // S-004: regex validation on orch + agent_type before they are
  // interpolated into the prefix-cache filename. Empty values are
  // permitted (legacy path — they produce a `-` filename which is
  // still inside the cache dir); we only reject values that contain
  // path-significant characters.
  if ((orch && !ORCH_ID_RE_DELTA.test(orch)) ||
      (agent && !AGENT_TYPE_RE_DELTA.test(agent))) {
    return {
      type: 'full',
      text: currentDelegationPrompt || '',
      prefix_hash: null,
      prefix_path: null,
      prefix_bytes: 0,
      delta_text: null,
      delta_bytes: null,
      full_bytes_avoided: 0,
      reason: 'invalid_input',
    };
  }

  // Empty prompt — observable but fail-soft.
  if (!currentDelegationPrompt) {
    return {
      type: 'full',
      text: '',
      prefix_hash: null,
      prefix_path: null,
      prefix_bytes: 0,
      delta_text: null,
      delta_bytes: null,
      full_bytes_avoided: 0,
      reason: 'empty_prompt',
    };
  }

  const split = splitStaticAndPerSpawn(currentDelegationPrompt);
  if (split === null) {
    return {
      type: 'full',
      text: currentDelegationPrompt,
      prefix_hash: null,
      prefix_path: null,
      prefix_bytes: 0,
      delta_text: null,
      delta_bytes: null,
      full_bytes_avoided: 0,
      reason: 'markers_missing',
    };
  }

  const staticPortion = split.static;
  const perSpawn      = split.perSpawn;
  const staticBytes   = Buffer.byteLength(staticPortion, 'utf8');
  const newHash       = crypto.createHash('sha256').update(staticPortion, 'utf8').digest('hex');

  const key = `${orch}::${agent}`;
  const cacheRel = path.join(PREFIX_CACHE_DIR, `${orch}-${agent}.txt`);
  const cacheAbs = path.join(cwd, cacheRel);

  // Layer 1: explicit post-compact flag from PM Section 7.C.
  let forcePostCompact = !!opts.postCompactResume;

  // Layer 2: helper-side dossier auto-detect — defence in depth.
  if (!forcePostCompact && stateMap.has(key)) {
    const entry = stateMap.get(key);
    const lastCompactAt = readDossierLastCompactAt(cwd);
    if (lastCompactAt && entry.cached_at && lastCompactAt > entry.cached_at) {
      forcePostCompact = true;
    }
  }

  const cachedEntry = stateMap.get(key);
  const onDiskExists = !forcePostCompact && safeExists(cacheAbs);

  // Hot path: matching cached prefix → emit delta.
  if (
    !forcePostCompact &&
    cachedEntry &&
    cachedEntry.prefix_hash === newHash &&
    onDiskExists
  ) {
    const deltaText =
      `<!-- delta:reference prefix_hash="${newHash}" prefix_path="${cacheRel}" prefix_bytes=${staticBytes} -->\n` +
      '<!-- The static portion of this delegation prompt is identical to spawn-1 of this -->\n' +
      '<!-- (orchestration_id, agent_type) pair. To reconstruct the full prompt, prepend  -->\n' +
      '<!-- the contents of the prefix_path file before this block.                       -->\n' +
      `${MARK_PER_SPAWN_BEGIN}\n${perSpawn}\n${MARK_PER_SPAWN_END}`;
    return {
      type: 'delta',
      text: null,
      prefix_hash: newHash,
      prefix_path: cacheRel,
      prefix_bytes: staticBytes,
      delta_text: deltaText,
      delta_bytes: Buffer.byteLength(deltaText, 'utf8'),
      full_bytes_avoided: staticBytes,
      reason: null,
    };
  }

  // Determine the failure-mode reason for the type='full' return.
  let reason;
  if (forcePostCompact) {
    reason = 'post_compact_resume';
  } else if (cachedEntry && cachedEntry.prefix_hash !== newHash) {
    reason = 'hash_mismatch';
  } else {
    reason = 'first_spawn';
  }

  // Persist the new prefix to disk + memory. Disk failure is fail-soft.
  let diskOk = true;
  try {
    fs.mkdirSync(path.join(cwd, PREFIX_CACHE_DIR), { recursive: true });
    const tmp = cacheAbs + '.tmp';
    fs.writeFileSync(tmp, staticPortion, 'utf8');
    fs.renameSync(tmp, cacheAbs);
  } catch (_e) {
    diskOk = false;
  }

  if (!diskOk) {
    return {
      type: 'full',
      text: currentDelegationPrompt,
      prefix_hash: newHash,
      prefix_path: cacheRel,
      prefix_bytes: staticBytes,
      delta_text: null,
      delta_bytes: null,
      full_bytes_avoided: 0,
      reason: 'disk_write_failed',
    };
  }

  stateMap.set(key, {
    prefix_hash:  newHash,
    prefix_path:  cacheRel,
    prefix_bytes: staticBytes,
    cached_at:    new Date().toISOString(),
  });

  return {
    type: 'full',
    text: currentDelegationPrompt,
    prefix_hash: newHash,
    prefix_path: cacheRel,
    prefix_bytes: staticBytes,
    delta_text: null,
    delta_bytes: null,
    full_bytes_avoided: 0,
    reason,
  };
}

function safeExists(p) {
  try { return fs.existsSync(p); } catch (_e) { return false; }
}

module.exports = {
  computeDelta,
  splitStaticAndPerSpawn,
  isDisabled,
  sweepStalePrefixCache,
  __resetCache,
  __purgeOrch,
  __rehydrateFromDisk,
  __resetRehydrateGuard,
  STALE_PREFIX_CACHE_TTL_MS,
};
