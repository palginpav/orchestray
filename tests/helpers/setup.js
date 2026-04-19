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
