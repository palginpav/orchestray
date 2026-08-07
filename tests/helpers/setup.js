'use strict';

/**
 * Global test setup — loaded via `node --require` before every test file.
 *
 * Sets ORCHESTRAY_TEST_SHARED_DIR to a path that is guaranteed to be
 * non-existent so that no test can accidentally read real federation
 * shared-tier patterns from ~/.orchestray/shared/.
 *
 * The path uses os.tmpdir() + a unique suffix so it survives parallel test
 * runs on the same machine without collisions.
 *
 * Callers of getSharedPatternsDir() in pattern_find.js and related modules
 * will receive a path that yields ENOENT on readdirSync, causing the shared
 * tier to be silently skipped — exactly the same behaviour as when no
 * shared directory exists at all.
 *
 * Tests that explicitly exercise the shared tier (e.g., the federation
 * describe-block in tests/mcp-server/tools/pattern_find.test.js) must
 * temporarily override ORCHESTRAY_TEST_SHARED_DIR for their own scope
 * and restore it afterwards. This global value acts as the safe fallback.
 */

const os = require('node:os');
const path = require('node:path');

// Only set if not already forced by the calling environment, so CI or a
// developer can still override it explicitly if needed.
if (!process.env.ORCHESTRAY_TEST_SHARED_DIR) {
  process.env.ORCHESTRAY_TEST_SHARED_DIR = path.join(
    os.tmpdir(),
    'orchestray-test-no-shared-' + process.pid
  );
}

// ---------------------------------------------------------------------------
// D7 (v2.3.18 W0) — keep the test suite out of the live project audit log.
//
// Tests that call writeEvent without an explicit cwd fell back to
// process.cwd() and appended straight into `.orchestray/audit/events.jsonl`,
// contaminating production telemetry with fixtures (`/nonexistent/path.jsonl`,
// `session_id: v2217-ramp-test`, `orch-smoke-*`). ORCHESTRAY_TEST is the gate
// that bin/_lib/audit-event-writer.js checks; ORCHESTRAY_TEST_EVENTS_PATH is
// where those writes go instead — per-worker so parallel runs cannot collide.
// ---------------------------------------------------------------------------
process.env.ORCHESTRAY_TEST = '1';
if (!process.env.ORCHESTRAY_TEST_EVENTS_PATH) {
  process.env.ORCHESTRAY_TEST_EVENTS_PATH = path.join(
    os.tmpdir(),
    'orchestray-test-events-' + process.pid + '.jsonl'
  );
}

// ---------------------------------------------------------------------------
// Per-worker claim namespace for bin/_lib/hook-stdin.js's dedup claim dir.
//
// claimDir(cwd) keys solely on (uid, sha256(cwd)) under os.tmpdir() — by
// design, so the two real installs racing on the same project meet in the
// same place. But `node --test` isolates each test file into its own
// process, and multiple files run concurrently under ORCHESTRAY_PARALLEL_TESTS=1.
// Any two of those worker processes that end up resolving the same cwd for a
// claim (e.g. a fixed sandbox path, or a fallback to process.cwd()) would
// share one claim namespace and could suppress each other's hooks.
//
// process.pid, set once here per worker, is inherited by any child process a
// test spawns (spawnSync/execFileSync default to copying process.env) — so a
// hook launched by this worker and a sibling hook it deliberately races
// against still land in the SAME namespace as each other, just one distinct
// from every other worker's. hook-stdin.js only reads this under
// isTestContext(); the production claim path is untouched.
if (!process.env.ORCHESTRAY_TEST_WORKER_ID) {
  process.env.ORCHESTRAY_TEST_WORKER_ID = String(process.pid);
}
