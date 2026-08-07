'use strict';

/**
 * hook-stdin.js — THE shared hook entry point (v2.3.18 W0).
 *
 * Every `bin/` hook script that reads a Claude Code hook payload from stdin
 * routes through here. Consolidating the entry gives us three things that were
 * previously per-script opt-in (or absent entirely):
 *
 *   1. **Dual-install dedup (D1).** Two live hook registrations — global
 *      `~/.claude/orchestray/` and local `<project>/.claude/orchestray/` — fire
 *      the same script twice, 7-30 ms apart. Before v2.3.18 only 4 scripts
 *      carried a guard; every other hook ran its body twice (duplicate block
 *      messages, doubled `additionalContext` injections, 2x analytics). The
 *      guard now applies to EVERY hook automatically, with no per-script code.
 *   2. **A single fail-open stdin read.** Malformed, empty, oversized or
 *      unreadable stdin yields a safe empty payload instead of an exception. A
 *      crashing hook must never wedge an orchestration.
 *   3. **The BDG harvest seam.** The Behavior Diff Gate needs a fixture corpus
 *      of real hook inputs. The seam lives here but is DORMANT by default —
 *      W5 arms it. See `harvest()` below.
 *
 * ## Dedup design — one layer: the payload-hash claim
 *
 * Key: `(script-basename, session_id, sha256(raw stdin))` inside a ~2 s window.
 * Implemented as an atomic `O_CREAT|O_EXCL|O_NOFOLLOW` claim file under
 * `os.tmpdir()` (see `claimDir` for why not the project); `O_EXCL` makes the
 * claim race-free across processes without a lock file dance. Whichever
 * install arrives first wins the key and runs; the loser exits 0 having done
 * no work.
 *
 * The claim suppresses ONLY when the competing caller path differs from the
 * claim holder's. This matters: a hook legitimately firing twice on two
 * identical tool calls in rapid succession has the SAME caller path and must
 * not be swallowed. Dual-install racing always has two textually distinct
 * caller paths (that is the entire signature in the 61
 * `hook_double_fire_detected` rows), so the narrower rule loses nothing D1
 * cares about and removes the whole false-positive class.
 *
 * ## The claim's trust model (v2.3.18 W10)
 *
 * `caller_path` read out of the claim file is the ONE input in this module that
 * can silence a hook, and it lives in a world-writable directory whose path is
 * fully derivable (public uid + sha256 of a known cwd). Left untrusted it is a
 * blackout primitive: pre-create the claim with a fabricated `caller_path` and
 * a rolling `ts_ms` and every genuine hook suppresses itself forever — exactly
 * the silence class W9 deleted Layer 1 to close.
 *
 * So suppression requires POSITIVE PROOF that the claim is ours:
 *
 *   - both directory components we create (`orchestray-hook-dedup-<uid>` and
 *     the per-project leaf) must be real directories, not symlinks, owned by
 *     this uid;
 *   - the LEAF must additionally not be writable by anyone else — write access
 *     to it is precisely what planting a claim takes. Write access to the
 *     shared parent is not: it only lets an attacker remove the leaf, which
 *     costs a visible duplicate, and any leaf they put back fails the owner
 *     check. So a lax parent we own is tightened and re-verified rather than
 *     rejected; a lax leaf is rejected AND tightened.
 *   - the claim file itself must be a regular file, not a symlink, owned by
 *     this uid, and not writable by anyone else;
 *   - the claim is created with `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` at 0o600,
 *     and every re-claim unlinks before re-creating the same way, so no write
 *     can be redirected through a planted symlink.
 *
 * Anything short of that fires (`claim_dir_untrusted` / `claim_untrusted`) —
 * a duplicate is visible, a blackout is not. `os.tmpdir()` itself is out of
 * scope: it is world-writable and sticky by design, and on macOS it is a
 * symlink. On platforms with no `process.getuid` (win32) the ownership and
 * mode checks are skipped — `O_EXCL` and the symlink check still apply, and
 * the residual exposure is a same-user tamper we cannot distinguish there.
 *
 * ## What used to sit in front of it, and why it is gone (v2.3.18 W9)
 *
 * There was a cheaper first layer: an install-topology gate
 * (`shouldFireFromThisInstall`) that tried to PREDICT whether the sibling
 * install would handle this event — does a local dir exist? is it named in a
 * settings file? does it carry this script? Six distinct inference paths across
 * five fix attempts all failed the same way: each install concluded the other
 * one would fire, so neither did, silently. One process cannot observe whether
 * another process will run; every proxy for it is an approximation whose
 * failure mode is silence.
 *
 * The claim needs no prediction. Both installs run → exactly one wins. Only one
 * runs → it wins. The accepted cost is a second short-lived process on
 * dual-install machines that exits after losing the claim. The worst case is
 * now a duplicate, which is visible and self-evident, instead of a blackout,
 * which is neither.
 *
 * **Do not add a predicate about the other install here.** That is the class of
 * bug this layer replaced, not an optimization it is missing.
 *
 * The pre-existing post-fire `double-fire-guard.js` (`requireGuard`) stays
 * where it is on the 4 scripts that use it — it keys on its own guardName and
 * catches same-install re-entry, a case the claim deliberately allows through.
 * The two do not double-suppress.
 *
 * ## Telemetry (v2.3.18 W11, volume-corrected W12)
 *
 * Every decision passes through one emit site in `dedupDecision`, writing a
 * `hook_dedup_decision` row via the shared audit writer. Untrusted claims and
 * error paths are always emitted; the ordinary outcomes AND the suppression
 * (`duplicate_install` — normal on the losing install of a dual-install pair)
 * are sampled. See the "Dedup telemetry" section for the volume policy and
 * why it is not "once per process". The emit is strictly downstream of the
 * decision and wrapped so that a broken writer cannot change `fire`.
 *
 * ## Kill switches
 *   - `ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP=1` — skip the claim; every install
 *     fires.
 *   - `ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED=1` — legacy spelling of the same
 *     thing. It named the (now deleted) install-priority layer, so since W9 the
 *     two switches are behaviourally identical and differ only in the `reason`
 *     they report. Kept because operators, docs and existing scripts use it.
 *   - `ORCHESTRAY_HOOK_DEDUP_WINDOW_MS=<n>` — override the 2000 ms window.
 *   - `ORCHESTRAY_HOOK_DEDUP_SAMPLE_RATE=<0..1>` — sampled-telemetry rate;
 *     `0` silences the sampled rows (always-emit reasons are unaffected).
 *     Defaults to 0 under the test harness, to the sampled rate otherwise.
 *   - `ORCHESTRAY_FIXTURE_HARVEST=1` — ARM the BDG harvest (default: dormant).
 *
 * Fail-open is absolute: every internal error path returns "fire the hook".
 */

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { shapeHash }      = require('./fixture-shape');
const { resolveSafeCwd } = require('./resolve-project-cwd');

const DEFAULT_WINDOW_MS = 2000;
const DEDUP_DIRNAME     = 'hook-dedup';
const GC_PROBABILITY    = 0.05;   // ~1 in 20 reads sweeps expired claim files
const CLAIM_DIR_MODE    = 0o700;
const CLAIM_FILE_MODE   = 0o600;
// Only "someone other than the owner can modify this" makes a claim untrustworthy.
// Readable-by-others (0o755 dirs from pre-W10 releases) plants nothing.
const FOREIGN_WRITE_BITS = 0o022;
// Undefined on win32 — `O_EXCL` alone still refuses an existing symlink there.
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const MAX_HARVEST_BYTES = 256 * 1024;
const MAX_FIXTURES_PER_SCRIPT = 40;
const MAX_STATE_SNAPSHOT_BYTES = 8 * 1024;

const ENV_DISABLE_DEDUP  = 'ORCHESTRAY_DISABLE_HOOK_ENTRY_DEDUP';
const ENV_LEGACY_BYPASS  = 'ORCHESTRAY_DUAL_INSTALL_BYPASS_DISABLED';
const ENV_DEDUP_WINDOW   = 'ORCHESTRAY_HOOK_DEDUP_WINDOW_MS';
const ENV_HARVEST        = 'ORCHESTRAY_FIXTURE_HARVEST';

// fd 0 can only be drained once per process — memoize the read.
let _cached = null;

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/**
 * Drain fd 0 synchronously. Returns '' on ANY failure (TTY with no input,
 * closed fd, EAGAIN on a non-blocking pipe, permission error).
 *
 * @returns {string}
 */
function readRawStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

/**
 * Parse a hook payload, never throwing. Non-object JSON (a bare number, a
 * string, an array) is rejected too — every hook consumer expects an object.
 *
 * @param {string} raw
 * @returns {object}
 */
function parsePayload(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch (_e) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The payload-hash claim
// ---------------------------------------------------------------------------

function dedupWindowMs() {
  const raw = process.env[ENV_DEDUP_WINDOW];
  if (!raw) return DEFAULT_WINDOW_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WINDOW_MS;
}

/**
 * Build the dedup key: script basename + session + payload digest.
 * The digest is over the RAW stdin bytes, so two installs handed the same
 * frame agree byte-for-byte.
 *
 * @param {string} callerPath
 * @param {string} raw
 * @param {object} payload
 * @returns {string} filesystem-safe key
 */
function dedupKey(callerPath, raw, payload) {
  const script  = path.basename(callerPath || 'unknown-hook');
  const session = (payload && typeof payload.session_id === 'string' && payload.session_id)
    ? payload.session_id
    : 'no-session';
  const digest  = crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 16);
  const composite = script + '|' + session + '|' + digest;
  return crypto.createHash('sha256').update(composite).digest('hex').slice(0, 24);
}

/**
 * Directory holding claim files for one project root.
 *
 * Deliberately under `os.tmpdir()`, NOT under `<project>/.orchestray/state/`.
 * Hooks fire on every tool call; dropping a file into the user's project each
 * time dirties git worktrees (v2.2.18's auto-commit hook happily committed
 * them) and materialises `.orchestray/` in directories that have no Orchestray
 * state at all. The two racing installs share a cwd, so hashing the project
 * root is enough for them to meet. The uid segment keeps a shared `/tmp` from
 * crossing users.
 *
 * Neither segment is a security boundary: the uid is public and the hash is
 * over a cwd anyone who can see the process knows, so this whole path is
 * derivable by an attacker. `verifyClaimDir` and `claimFileTrusted` are what
 * make a claim believable — not the obscurity of where it sits.
 *
 * Under `isTestContext()` only, an extra `ORCHESTRAY_TEST_WORKER_ID` segment
 * (set once per worker process by tests/helpers/setup.js) is folded into the
 * parent dir name. `node --test` isolates each test file into its own
 * process, and several run concurrently — this keeps any two workers that
 * happen to resolve the same cwd from sharing one claim namespace. The
 * segment is inherited by any child process a test spawns, so a hook and the
 * sibling hook it deliberately races against still land in the SAME
 * namespace as each other. The production path (non-test) is unchanged.
 *
 * @param {string} cwd
 * @returns {string}
 */
function claimDir(cwd) {
  const uid = currentUid();
  const seg = uid === null ? 'u' : String(uid);
  const projectHash = crypto.createHash('sha256').update(String(cwd)).digest('hex').slice(0, 16);
  const workerSeg = isTestContext() && process.env.ORCHESTRAY_TEST_WORKER_ID
    ? '-w' + process.env.ORCHESTRAY_TEST_WORKER_ID
    : '';
  return path.join(os.tmpdir(), 'orchestray-' + DEDUP_DIRNAME + '-' + seg + workerSeg, projectHash);
}

// ---------------------------------------------------------------------------
// Claim integrity — see "The claim's trust model" in the header.
//
// Every predicate below answers ONE question: may the content of this claim be
// allowed to silence a hook? The answer is no unless it is provably ours, and
// "no" always means fire.
// ---------------------------------------------------------------------------

/**
 * This process's uid, or `null` on a platform that has none (win32).
 *
 * @returns {number|null}
 */
function currentUid() {
  try {
    return typeof process.getuid === 'function' ? process.getuid() : null;
  } catch (_e) {
    return null;
  }
}

/**
 * Verify the two directory components we create. Recursive `mkdir` applies its
 * mode only to directories it actually creates, so a pre-planted world-writable
 * directory survives `{ mode: 0o700 }` untouched and has to be caught here.
 *
 * The two levels are judged differently, because only one of them is a planting
 * surface. Planting a claim requires write access to the LEAF — a lax leaf is
 * therefore rejected outright. Write access to the shared parent only lets an
 * attacker unlink or rename the leaf, which costs a duplicate fire (visible),
 * and any leaf they put back is owned by them and rejected here. So a lax
 * parent we own is repaired and verified rather than rejected: rejecting it
 * would fire once for every project on any machine upgrading from a release
 * that created the parent with the default mode, for no security gain.
 *
 * Symlinks, foreign owners and non-directories are rejected at both levels.
 *
 * `at`/`why` on a failure name the level and the predicate that rejected, for
 * W11 telemetry. They are diagnostics only — `reason` remains the contract, and
 * nothing here branches on them.
 *
 * @param {string} dir — the per-project leaf.
 * @returns {{ok: boolean, reason?: string, at?: string, why?: string}}
 */
function verifyClaimDir(dir) {
  const uid = currentUid();
  const parent = path.dirname(dir);
  for (const p of [parent, dir]) {
    const at = p === dir ? 'leaf' : 'parent';
    const no = (reason, why) => ({ ok: false, reason, at, why });
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (_e) {
      return no('claim_dir_unavailable', 'unstattable');
    }
    if (st.isSymbolicLink()) return no('claim_dir_untrusted', 'symlink');
    if (!st.isDirectory()) return no('claim_dir_untrusted', 'not_directory');
    if (uid === null) continue;                         // win32 — no uid, no mode bits
    if (st.uid !== uid) return no('claim_dir_untrusted', 'foreign_uid');
    if ((st.mode & FOREIGN_WRITE_BITS) === 0) continue;

    // Lax mode on a directory we own: tighten it, then confirm the tightening
    // landed. Never assume chmod worked — a filesystem that ignores it must
    // not read as verified.
    let repaired;
    try {
      fs.chmodSync(p, CLAIM_DIR_MODE);
      repaired = fs.lstatSync(p);
    } catch (_e) {
      return no('claim_dir_untrusted', 'chmod_failed');
    }
    if ((repaired.mode & FOREIGN_WRITE_BITS) !== 0) return no('claim_dir_untrusted', 'lax_mode_unrepaired');
    if (p === dir) return no('claim_dir_untrusted', 'lax_mode');
  }
  return { ok: true };
}

/**
 * Whether the existing claim file may be believed — a regular file, not a
 * symlink, owned by us, and not writable by anyone else — and, when it may not,
 * which predicate rejected it.
 *
 * `lstatSync`, never `statSync`: through a symlink the stat describes the
 * TARGET, whose ownership the attacker picks, not the path we are about to
 * trust. For the same reason `why` never names the symlink's target: that
 * string is attacker-chosen and could point anywhere on the host.
 *
 * @param {string} file
 * @returns {{ok: boolean, why?: string}}
 */
function claimFileTrust(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (_e) { return { ok: false, why: 'unstattable' }; }
  if (st.isSymbolicLink()) return { ok: false, why: 'symlink' };
  if (!st.isFile()) return { ok: false, why: 'not_file' };
  const uid = currentUid();
  if (uid === null) return { ok: true };              // win32 — no uid, no mode bits
  if (st.uid !== uid) return { ok: false, why: 'foreign_uid' };
  if ((st.mode & FOREIGN_WRITE_BITS) !== 0) return { ok: false, why: 'lax_mode' };
  return { ok: true };
}

/**
 * Boolean face of `claimFileTrust`. The trust rule has exactly one
 * implementation; this is the shape most callers want.
 *
 * @param {string} file
 * @returns {boolean}
 */
function claimFileTrusted(file) {
  return claimFileTrust(file).ok;
}

/**
 * Create the claim, failing rather than following a symlink or truncating an
 * existing file. `O_EXCL` is what makes the claim race-free; `O_NOFOLLOW` is
 * what keeps the write inside the directory we verified.
 *
 * @param {string} file
 * @param {string} record
 * @returns {{ok: boolean, code?: string}}
 */
function createClaimExclusive(file, record) {
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(file, flags, CLAIM_FILE_MODE);
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'EUNKNOWN' };
  }
  try {
    fs.writeSync(fd, record);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: (e && e.code) || 'EUNKNOWN' };
  } finally {
    try { fs.closeSync(fd); } catch (_e) { /* fd already gone */ }
  }
}

/**
 * Replace a claim we are not going to honour (corrupt, expired, or untrusted).
 * Unlink first — `unlink` removes the link itself, never its target, so a
 * planted symlink is destroyed rather than written through.
 *
 * @param {string} file
 * @param {string} record
 */
function takeoverClaim(file, record) {
  try { fs.unlinkSync(file); } catch (_e) { /* another racer took it over */ }
  createClaimExclusive(file, record);
}

/**
 * Sweep expired claim files. Best-effort, probabilistic — a stale claim is
 * harmless (it only ever widens the window for one key), so an occasional
 * missed sweep costs nothing.
 *
 * @param {string} dir
 * @param {number} nowMs
 * @param {number} windowMs
 */
function gcClaims(dir, nowMs, windowMs) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        // lstat, not stat: a planted symlink must be judged and unlinked as
        // itself, not as whatever long-lived file it points at.
        if (nowMs - fs.lstatSync(file).mtimeMs > windowMs * 10) fs.unlinkSync(file);
      } catch (_e) { /* concurrent sweep won the race */ }
    }
  } catch (_e) { /* fail-open */ }
}

/**
 * Claim the dedup key for this caller.
 *
 * @param {string} cwd
 * @param {string} key
 * `untrustedAt`/`untrustedWhy`/`errCode` are diagnostics for the W11 telemetry
 * emit; no caller branches on them.
 *
 * @param {string} callerPath
 * @returns {{fire: boolean, reason: string, firstCaller?: string, deltaMs?: number,
 *            untrustedAt?: string, untrustedWhy?: string, errCode?: string}}
 */
function claim(cwd, key, callerPath) {
  const windowMs = dedupWindowMs();
  if (windowMs === 0) return { fire: true, reason: 'window_disabled' };

  let dir;
  try {
    dir = claimDir(cwd);
    fs.mkdirSync(dir, { recursive: true, mode: CLAIM_DIR_MODE });
  } catch (_e) {
    return { fire: true, reason: 'claim_dir_unavailable' };
  }

  const dirTrust = verifyClaimDir(dir);
  if (!dirTrust.ok) {
    return {
      fire: true, reason: dirTrust.reason,
      untrustedAt: dirTrust.at, untrustedWhy: dirTrust.why,
    };
  }

  const nowMs = Date.now();
  if (Math.random() < GC_PROBABILITY) gcClaims(dir, nowMs, windowMs);

  const file   = path.join(dir, key + '.json');
  const record = JSON.stringify({ ts_ms: nowMs, caller_path: callerPath, pid: process.pid });

  // O_EXCL create: exactly one process wins, no lock protocol needed.
  const created = createClaimExclusive(file, record);
  if (created.ok) return { fire: true, reason: 'claimed' };
  if (created.code !== 'EEXIST') return { fire: true, reason: 'claim_error', errCode: created.code };

  // A claim exists, and from here on its CONTENT is the only thing that can
  // return `fire: false`. Prove it is ours before reading a byte of it.
  const fileTrust = claimFileTrust(file);
  if (!fileTrust.ok) {
    takeoverClaim(file, record);
    return {
      fire: true, reason: 'claim_untrusted',
      untrustedAt: 'claim_file', untrustedWhy: fileTrust.why,
    };
  }

  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    // Corrupt or mid-write claim — re-claim and fire.
    takeoverClaim(file, record);
    return { fire: true, reason: 'claim_unreadable' };
  }

  const deltaMs = nowMs - (Number(existing && existing.ts_ms) || 0);
  if (!(deltaMs >= 0 && deltaMs <= windowMs)) {
    // Window expired — take over the claim.
    takeoverClaim(file, record);
    return { fire: true, reason: 'window_expired' };
  }

  // Inside the window, on a claim proven to be ours. Suppress only a DIFFERENT
  // caller path (see header). This is the module's sole `fire: false`.
  if (existing.caller_path && existing.caller_path !== callerPath) {
    return { fire: false, reason: 'duplicate_install', firstCaller: existing.caller_path, deltaMs };
  }
  return { fire: true, reason: 'same_caller_repeat' };
}

// ---------------------------------------------------------------------------
// The dedup decision — the SOLE dual-install decision point for every hook
//
// Adding a second one reintroduces a five-times-repeated failure. W6c had two
// copies of an install-topology rule; they disagreed and nothing fired. W7b
// gave them one implementation but two `cwd` inputs; they disagreed again and
// nothing fired. W9 removed the rule outright, so there is no longer anything
// to keep in sync — but the shape of the bug survives any gate that decides the
// dual-install question outside this function. Consume this decision instead.
// ---------------------------------------------------------------------------

/**
 * The decision itself. Kept separate from `dedupDecision` purely so the emit
 * below has exactly one place to sit; every `return` in this function is a
 * `fire` outcome and nothing may be added between here and the caller that
 * changes one.
 *
 * @param {object} args
 * @returns {{fire: boolean, reason: string, firstCaller?: string, deltaMs?: number}}
 */
function decide(args) {
  if (process.env[ENV_DISABLE_DEDUP] === '1') return { fire: true, reason: 'kill_switch' };
  // Legacy spelling of the switch above — see the header. Reported under its
  // own reason so operator-set bypasses stay distinguishable in telemetry.
  if (process.env[ENV_LEGACY_BYPASS] === '1') return { fire: true, reason: 'legacy_kill_switch' };
  try {
    return claim(args.cwd, dedupKey(args.callerPath, args.raw, args.payload), args.callerPath);
  } catch (_e) {
    return { fire: true, reason: 'dedup_error' };
  }
}

/**
 * Dedup decision for this invocation: claim the payload key, fire iff we got it.
 *
 * Admits exactly one caller per (script, session, payload) within the window —
 * never two, and (because a lone caller always wins an uncontested claim, and
 * every error path returns `fire: true`) never zero.
 *
 * @param {object} args
 * @returns {{fire: boolean, reason: string, firstCaller?: string, deltaMs?: number}}
 */
function dedupDecision(args) {
  const decision = decide(args);
  emitDedupDecision(args, decision);   // observability only — cannot alter `decision`
  return decision;
}

// ---------------------------------------------------------------------------
// Dedup telemetry (v2.3.18 W11, volume-corrected W12)
//
// Until W11 this module emitted nothing. Every suppression was a hook that did
// not run, with no row anywhere saying so — "did dedup swallow that?" was
// unanswerable from telemetry. That mattered more after W9: with the
// install-topology layer deleted, the claim is the SOLE thing preventing
// duplicate hook execution, and W10 hardened it against a proven blackout
// attack. `claim_untrusted` / `claim_dir_untrusted` fire exactly when someone
// is planting claim files or a machine is misconfigured, and both were silent.
//
// W11 shipped `duplicate_install` as always-emit, reasoning it was the
// suppression itself and therefore rare. It is not rare: on a dual-install
// machine it is the NORMAL, HEALTHY outcome on the losing side of every tool
// call, 1:1 with hook traffic — measured at ~10,000 rows/session against a
// 27,220-row historical log. W12 moved it into the sampled set; see that
// constant's comment for the rate reasoning.
//
// Three rules govern this section:
//   1. It is downstream of the decision. `emitDedupDecision` is called with an
//      already-final decision and returns nothing.
//   2. It cannot fail loudly. Everything is inside one try/catch; a broken
//      audit writer changes no `fire`, throws nothing, and is not retried.
//   3. It cannot flood. See the volume policy below.
// ---------------------------------------------------------------------------

const DEDUP_EVENT_TYPE = 'hook_dedup_decision';

/**
 * Reasons that earn a row every time. All are rare: the tamper/misconfiguration
 * signals and the internal error paths. `window_expired` is bounded by the rate
 * of REPEATED identical payloads, not by hook traffic, so it is affordable here
 * too.
 *
 * `duplicate_install` — this module's only `fire: false` — is deliberately NOT
 * here despite being the reason this telemetry exists. See the W12 note above
 * and the sampled-set comment below for why an always-emit suppression reason
 * is exactly the flood this module must not become.
 */
const ALWAYS_EMIT_REASONS = new Set([
  'claim_untrusted',
  'claim_dir_untrusted',
  'claim_dir_unavailable',
  'claim_unreadable',
  'claim_error',
  'window_expired',
  'dedup_error',
]);

/**
 * Sample rate for every other reason — `claimed`, `duplicate_install`,
 * `same_caller_repeat`, and the three operator-switch reasons (`kill_switch`,
 * `legacy_kill_switch`, `window_disabled`).
 *
 * All six recur on EVERY hook invocation: `claimed` is the ordinary outcome on
 * the winning install, `duplicate_install` is the ordinary outcome on the
 * LOSING install of a dual-install pair (W12 — through W11 it emitted
 * unconditionally, a third flooder in one release after the ~300-rows/day
 * nightly job and the 1:1 autofill amplifier already fixed this release), and
 * the switch reasons are constant for the life of a machine's configuration.
 * Emitting any of them unconditionally would put one row on events.jsonl per
 * tool call. Note that "once per process" is NOT a control for these: each
 * hook is its own short-lived process, so it would emit every time anyway.
 * Stateless probabilistic sampling is, and it costs one `Math.random()` with
 * no I/O (the same mechanism `gcClaims` already uses in this file).
 *
 * 1% keeps every one of them visible as a denominator for rate math while
 * staying two orders of magnitude under the flood line. `duplicate_install`
 * is deliberately sampled at the SAME rate as `claimed` rather than given its
 * own higher rate or an aggregate counter: the two are paired 1:1 (one
 * install's fire is the other's suppression for the same tool call), so
 * sampling both at one rate keeps their sampled counts a valid estimator of
 * the true suppression ratio. "Did dedup swallow that hook?" becomes
 * statistical instead of exact — the same trade this file already made for
 * "is dedup running as expected?" on the `claimed` path, and nothing new for
 * an operator who already reads this telemetry as a rate, not a transcript.
 * For an EXACT answer on one invocation, `ORCHESTRAY_HOOK_DEDUP_SAMPLE_RATE=1`
 * forces every sampled reason to emit — the escape hatch this file already
 * provides and the tests below already exercise. The tamper/misconfiguration
 * and error paths above are unaffected either way: those stay exact always.
 */
const DEDUP_SAMPLE_RATE = 0.01;
const ENV_DEDUP_SAMPLE  = 'ORCHESTRAY_HOOK_DEDUP_SAMPLE_RATE';

// Re-entrancy guard: the audit writer requires this module (for
// `readHookInputRaw`), so an emit that re-entered dedup could recurse.
let _inDedupEmit = false;

/**
 * Effective sample rate. `0` disables sampled rows entirely (always-emit
 * reasons are unaffected); `1` emits every decision. Out-of-range or
 * unparseable values fall back to the default rather than disabling telemetry.
 *
 * Defaults to 0 under the test harness, for the same reason `harvestEnabled`
 * is off there: a sampled row is a statistical denominator, and a synthetic
 * run produces no meaningful statistics. It also removes a flake class — a
 * spawned-hook test that counts rows in its own events.jsonl would otherwise
 * fail one run in a hundred, silently, on a row it never asked for. An
 * explicit env override still wins, so tests that assert on the sampled path
 * can ask for it. Always-emit reasons are unaffected in every context.
 *
 * @returns {number} 0..1
 */
function dedupSampleRate() {
  const raw = process.env[ENV_DEDUP_SAMPLE];
  if (raw === undefined || raw === '') return isTestContext() ? 0 : DEDUP_SAMPLE_RATE;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEDUP_SAMPLE_RATE;
}

/**
 * Apply the volume policy.
 *
 * @param {string} reason
 * @returns {boolean}
 */
function shouldEmitDedup(reason) {
  if (ALWAYS_EMIT_REASONS.has(reason)) return true;
  const rate = dedupSampleRate();
  return rate > 0 && Math.random() < rate;
}

/**
 * Project a caller path to something safe to persist.
 *
 * The absolute path of an install directory embeds a username and a home
 * layout, and events.jsonl is read by agents and pasted into bug reports. The
 * basename alone would carry no signal at all — the dedup key is built from the
 * basename, so a claim collision ALWAYS has the same basename on both sides.
 * What distinguishes the two racing installs is the directory, so that is what
 * gets hashed: stable enough to tell global from local across rows, opaque
 * enough to leak nothing. The `#` prefix marks it as not-a-path.
 *
 * @param {string} p
 * @returns {string|null}
 */
function redactCaller(p) {
  const s = String(p || '');
  if (!s) return null;
  const dir = crypto.createHash('sha256').update(path.dirname(s)).digest('hex').slice(0, 12);
  return '#' + dir + '/' + path.basename(s);
}

/**
 * Write one `hook_dedup_decision` row for a decision that has already been
 * made. Never throws, never returns anything the caller could act on.
 *
 * The audit writer is required LAZILY and only once the volume policy has said
 * yes — it pulls in the schema validator and orchestration-state readers, and
 * loading that on all ~99% of invocations we do not emit would be the whole
 * cost of this feature. It also cannot be required at module scope: the writer
 * requires this file, so a top-level require would close a cycle.
 *
 * @param {object} args     — the `dedupDecision` args (callerPath, cwd, payload).
 * @param {object} decision — the final decision. Read-only here.
 */
function emitDedupDecision(args, decision) {
  if (_inDedupEmit) return;
  try {
    if (!decision || !shouldEmitDedup(decision.reason)) return;
    _inDedupEmit = true;

    const payload = (args && args.payload) || {};
    const event = {
      type:    DEDUP_EVENT_TYPE,
      version: 1,
      reason:  decision.reason,
      fire:    decision.fire === true,
      script:  path.basename((args && args.callerPath) || '') || 'unknown-hook',
      sampled: !ALWAYS_EMIT_REASONS.has(decision.reason),
    };

    if (typeof payload.session_id === 'string' && payload.session_id) {
      event.session_id = payload.session_id;
    }
    if (decision.firstCaller) event.first_caller = redactCaller(decision.firstCaller);
    if (typeof decision.deltaMs === 'number') event.delta_ms = decision.deltaMs;
    if (decision.untrustedAt)  event.untrusted_at  = decision.untrustedAt;
    if (decision.untrustedWhy) event.untrusted_why = decision.untrustedWhy;
    if (decision.errCode)      event.err_code      = decision.errCode;

    require('./audit-event-writer').writeEvent(event, { cwd: args && args.cwd });
  } catch (_e) {
    // Telemetry never affects the decision — see rule 2 in the section header.
  } finally {
    _inDedupEmit = false;
  }
}

// ---------------------------------------------------------------------------
// BDG harvest seam — DORMANT until W5 arms it
// ---------------------------------------------------------------------------

/**
 * Structure-preserving redaction. Paths keep their depth and extension; prose
 * collapses to a length marker. The result is shape-equivalent to the input
 * but carries no user content — fixtures are committed, payloads are not.
 *
 * @param {*} v
 * @param {string} [key]
 * @returns {*}
 */
function redact(v, key) {
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => redact(x));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = redact(v[k], k);
    return o;
  }
  if (typeof v !== 'string') return v;
  if (/^\/|^[A-Za-z]:\\/.test(v)) {
    const parts = v.split(/[\\/]/).filter(Boolean);
    if (parts.length === 0) return '/';
    return '/' + parts
      .map((_, i) => (i === parts.length - 1 ? 'f' + path.extname(v) : 'd' + i))
      .join('/');
  }
  return v.length > 64 ? '<str:' + v.length + '>' : v;
}

/**
 * True iff the BDG harvest is armed. **ARMED by default since v2.3.18 W5b** —
 * W0 shipped the seam dormant, W5b flipped it. An empty corpus makes the
 * Behavior Diff Gate a no-op, so collection has to run ahead of gating; design
 * §2.8 keeps `harvest` and `block` separable for exactly this reason.
 *
 * Off when `ORCHESTRAY_FIXTURE_HARVEST=0`, when
 * `behavior_diff_gate.harvest` is `false`, or under test — synthetic shapes
 * would pollute the corpus with inputs production never produces.
 *
 * @param {string} [cwd]
 * @returns {boolean}
 */
function harvestEnabled(cwd) {
  const env = process.env[ENV_HARVEST];
  if (env === '0') return false;
  if (isTestContext()) return false;
  if (env === '1') return true;
  return harvestConfigured(cwd);
}

/**
 * `behavior_diff_gate.harvest` — defaults to true, fail-open to true. Cached
 * per process: this runs on every hook and must stay sub-millisecond.
 *
 * @param {string} [cwd]
 * @returns {boolean}
 */
let _harvestCfg = null;
function harvestConfigured(cwd) {
  if (_harvestCfg !== null) return _harvestCfg;
  _harvestCfg = true;
  try {
    const file = path.join(cwd || process.cwd(), '.orchestray', 'config.json');
    const section = JSON.parse(fs.readFileSync(file, 'utf8')).behavior_diff_gate;
    if (section && typeof section === 'object') {
      if (section.enabled === false) _harvestCfg = false;
      else if (typeof section.harvest === 'boolean') _harvestCfg = section.harvest;
    }
  } catch (_e) { /* no config → harvest on */ }
  return _harvestCfg;
}

/**
 * Snapshot the small `.orchestray/state/*` files present at hook time.
 *
 * A fixture is `{stdin, state}`, not `stdin` — the §2.4 prototype run proved
 * that a stdin-only fixture exercises almost none of a hook's real decision
 * surface, because our hooks are state-dependent and fail-open by design.
 *
 * @param {string} cwd
 * @returns {object} filename -> redacted content
 */
function snapshotState(cwd) {
  const out = {};
  try {
    const stateDir = path.join(cwd, '.orchestray', 'state');
    for (const name of fs.readdirSync(stateDir)) {
      try {
        const file = path.join(stateDir, name);
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > MAX_STATE_SNAPSHOT_BYTES) continue;
        out[name] = redact(fs.readFileSync(file, 'utf8'));
      } catch (_e) { /* skip unreadable entry */ }
    }
  } catch (_e) { /* no state dir yet */ }
  return out;
}

/**
 * Write one fixture per previously-unseen payload shape, capped per script.
 * Harvesting must NEVER affect the hook: every failure is swallowed.
 *
 * @param {string} scriptName
 * @param {object} payload
 * @param {string} cwd
 */
function harvest(scriptName, payload, cwd) {
  try {
    const dir  = path.join(cwd, '.orchestray', 'fixtures', scriptName);
    const file = path.join(dir, shapeHash(payload) + '.json');
    if (fs.existsSync(file)) return;                          // shape already covered
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).length >= MAX_FIXTURES_PER_SCRIPT) return;
    const fixture = { stdin: redact(payload), state: snapshotState(cwd) };
    const body = JSON.stringify(fixture, null, 2);
    if (body.length > MAX_HARVEST_BYTES) return;
    fs.writeFileSync(file, body, 'utf8');
  } catch (_e) { /* harvesting never affects the hook */ }
}

// ---------------------------------------------------------------------------
// Test-context detection (shared with audit-event-writer for D7)
// ---------------------------------------------------------------------------

/**
 * True when running under the test harness. `tests/helpers/setup.js` sets
 * ORCHESTRAY_TEST=1 for every worker; NODE_ENV is the conventional fallback.
 *
 * @returns {boolean}
 */
function isTestContext() {
  return process.env.ORCHESTRAY_TEST === '1' || process.env.NODE_ENV === 'test';
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Read the hook payload from stdin, applying dedup and (when armed) harvest.
 *
 * On a suppressed duplicate this calls `opts.onDuplicate` if supplied, else
 * `process.exit(0)` — an exit code of 0 with empty stdout is "no opinion" for
 * every Claude Code hook event, which is exactly right: the sibling install is
 * doing the work and producing the real response.
 *
 * @param {object} [opts]
 * @param {string} [opts.callerPath] — defaults to `process.argv[1]`.
 * @param {string} [opts.cwd]        — defaults to payload `cwd`, then `process.cwd()`.
 * @param {boolean} [opts.dedup]     — set false to skip dedup entirely.
 * @param {Function} [opts.onDuplicate] — called with the decision instead of exiting.
 * @returns {{raw: string, payload: object, decision: object}}
 */
function readHookEnvelope(opts) {
  const options = opts || {};

  if (!_cached) {
    const raw = readRawStdin();
    _cached = { raw, payload: parsePayload(raw) };
  }
  const { raw, payload } = _cached;

  const callerPath = options.callerPath || process.argv[1] || '';
  const cwd = options.cwd || resolveSafeCwd(payload && payload.cwd);

  let decision = { fire: true, reason: 'dedup_disabled' };
  if (options.dedup !== false) {
    decision = dedupDecision({ callerPath, cwd, raw, payload });
  }

  if (!decision.fire) {
    if (typeof options.onDuplicate === 'function') {
      options.onDuplicate(decision);
      return { raw: '', payload: {}, decision };
    }
    process.exit(0);
  }

  if (harvestEnabled(cwd)) {
    harvest(path.basename(callerPath, '.js') || 'unknown-hook', payload, cwd);
  }

  return { raw, payload, decision };
}

/**
 * Parsed hook payload. `{}` on empty/malformed/unreadable stdin.
 *
 * @param {object} [opts] — see readHookEnvelope.
 * @returns {object}
 */
function readHookInput(opts) {
  return readHookEnvelope(opts).payload;
}

/**
 * Raw hook payload string. `''` on empty/unreadable stdin. Drop-in for scripts
 * that do their own `JSON.parse` (or inspect the text before parsing).
 *
 * @param {object} [opts] — see readHookEnvelope.
 * @returns {string}
 */
function readHookInputRaw(opts) {
  return readHookEnvelope(opts).raw;
}

/** Reset the memoized stdin read. Unit tests only. */
function _resetCache() {
  _cached = null;
}

/** Seed the memoized stdin read. Unit tests only. */
function _seedCache(raw) {
  _cached = { raw: String(raw), payload: parsePayload(String(raw)) };
}

module.exports = {
  readHookInput,
  readHookInputRaw,
  readHookEnvelope,
  isTestContext,
  // Internals exported for unit tests and for W5 (BDG) — not a stable contract.
  _internal: {
    parsePayload,
    readRawStdin,
    dedupKey,
    dedupWindowMs,
    claim,
    claimDir,
    verifyClaimDir,
    claimFileTrust,
    claimFileTrusted,
    createClaimExclusive,
    currentUid,
    decide,
    dedupDecision,
    emitDedupDecision,
    shouldEmitDedup,
    dedupSampleRate,
    redactCaller,
    DEDUP_EVENT_TYPE,
    ALWAYS_EMIT_REASONS,
    DEDUP_SAMPLE_RATE,
    ENV_DEDUP_SAMPLE,
    redact,
    harvest,
    harvestEnabled,
    harvestConfigured,
    _resetHarvestCfg: () => { _harvestCfg = null; },
    snapshotState,
    gcClaims,
    _resetCache,
    _seedCache,
    DEFAULT_WINDOW_MS,
    DEDUP_DIRNAME,
    ENV_DISABLE_DEDUP,
    ENV_LEGACY_BYPASS,
    ENV_DEDUP_WINDOW,
    ENV_HARVEST,
    MAX_INPUT_BYTES: require('./constants').MAX_INPUT_BYTES,
  },
};
