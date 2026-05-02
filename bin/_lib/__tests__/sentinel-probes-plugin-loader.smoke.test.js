'use strict';

/**
 * sentinel-probes-plugin-loader.smoke.test.js
 *
 * Smoke tests for the 7 Wave 3 static-analysis probes:
 *   W-SEC-13  assertNoShellInBrokerForwardPath
 *   W-SEC-19  assertPluginStdoutNeverReachesAuditWriter
 *   W-SEC-DEF-1.1  assertNoModelOutputInDispatch
 *   W-SEC-DEF-1.2  assertEnvStripIsApplied
 *   W-SEC-DEF-1.3  assertConsentRequiredBeforeSpawn
 *   W-SEC-DEF-1.4  assertNoEvalInPluginLoader
 *   W-SEC-DEF-1.5  assertPluginToolsNeverInTopLevelMcpServers
 *
 * Each probe has:
 *   1. Happy path against real Orchestray sources (asserts ok === true)
 *   2. Violation-detected path with a synthetic source file (asserts ok === false
 *      and violations contains a meaningful entry)
 *
 * Pattern: probes accept an optional path argument; for violations tests we
 * write synthetic source to a temp file and pass that path.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const pathMod = require('node:path');

const {
  assertNoShellInBrokerForwardPath,
  assertPluginStdoutNeverReachesAuditWriter,
  assertNoModelOutputInDispatch,
  assertEnvStripIsApplied,
  assertConsentRequiredBeforeSpawn,
  assertNoEvalInPluginLoader,
  assertPluginToolsNeverInTopLevelMcpServers,
} = require('../sentinel-probes');

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'sentinel-probes-smoke-'));
});

after(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_e) { /* best-effort cleanup */ }
});

/**
 * Write synthetic source to a temp file and return its absolute path.
 *
 * @param {string} name     Filename (no path)
 * @param {string} content  Source content
 * @returns {string}
 */
function writeSynthetic(name, content) {
  const p = pathMod.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Resolve real project paths for happy-path tests
// The sentinel-probes.js lives in bin/_lib/; the project root is three levels up.
// ---------------------------------------------------------------------------
const PROJECT_ROOT = pathMod.resolve(__dirname, '..', '..', '..');
const REAL_SERVER_PATH = pathMod.join(PROJECT_ROOT, 'bin', 'mcp-server', 'server.js');
// plugin-loader.js does not exist yet (Wave 3 deliverable); probes handle absence gracefully.
const REAL_LOADER_PATH = pathMod.join(PROJECT_ROOT, 'bin', '_lib', 'plugin-loader.js');
const REAL_AUDIT_PATH  = pathMod.join(PROJECT_ROOT, 'bin', '_lib', 'audit-event-writer.js');

// ---------------------------------------------------------------------------
// W-SEC-13 — assertNoShellInBrokerForwardPath
// ---------------------------------------------------------------------------

describe('assertNoShellInBrokerForwardPath (W-SEC-13)', () => {
  test('happy path: real plugin-loader.js (absent or clean) passes', () => {
    const result = assertNoShellInBrokerForwardPath(REAL_LOADER_PATH);
    assert.equal(result.ok, true,
      `Expected ok=true but got: ${JSON.stringify(result.violations || result)}`);
    assert.ok(typeof result.evidence === 'string', 'evidence should be a string');
  });

  test('violation detected: forwardToPlugin with exec() is flagged', () => {
    const synthetic = writeSynthetic('plugin-loader-exec.js', `
'use strict';
async function forwardToPlugin(plugin, frame) {
  const cmd = frame.method;
  exec(cmd); // forbidden: shell execution in broker forward path
  plugin.stdin.write(JSON.stringify(frame));
}
module.exports = { forwardToPlugin };
`);
    const result = assertNoShellInBrokerForwardPath(synthetic);
    assert.equal(result.ok, false, 'Expected ok=false for exec() in forwardToPlugin');
    assert.ok(Array.isArray(result.violations) && result.violations.length > 0,
      'Expected at least one violation');
    assert.ok(
      result.violations.some(v => /exec/i.test(v.reason) || /exec/i.test(v.snippet)),
      `Violation should mention exec; got: ${JSON.stringify(result.violations)}`
    );
  });
});

// ---------------------------------------------------------------------------
// W-SEC-19 — assertPluginStdoutNeverReachesAuditWriter
// ---------------------------------------------------------------------------

describe('assertPluginStdoutNeverReachesAuditWriter (W-SEC-19)', () => {
  test('happy path: real plugin-loader.js (absent or clean) passes', () => {
    const result = assertPluginStdoutNeverReachesAuditWriter(REAL_LOADER_PATH, REAL_AUDIT_PATH);
    assert.equal(result.ok, true,
      `Expected ok=true but got: ${JSON.stringify(result.violations || result)}`);
  });

  test('violation detected: raw plugin.stdout in audit({ call is flagged', () => {
    const synthetic = writeSynthetic('plugin-loader-stdout.js', `
'use strict';
function emitPluginEvent(plugin, frame) {
  writeEvent({
    type: 'plugin_output',
    version: 1,
    output: plugin.stdout, // forbidden: raw stdout
  });
}
module.exports = { emitPluginEvent };
`);
    const result = assertPluginStdoutNeverReachesAuditWriter(synthetic, REAL_AUDIT_PATH);
    assert.equal(result.ok, false, 'Expected ok=false for raw plugin.stdout in audit call');
    assert.ok(Array.isArray(result.violations) && result.violations.length > 0,
      'Expected at least one violation');
    assert.ok(
      result.violations.some(v => /plugin\.stdout|stdout/i.test(v.reason) || /plugin\.stdout/i.test(v.snippet)),
      `Violation should mention plugin.stdout; got: ${JSON.stringify(result.violations)}`
    );
  });
});

// ---------------------------------------------------------------------------
// W-SEC-DEF-1.1 — assertNoModelOutputInDispatch
// ---------------------------------------------------------------------------

describe('assertNoModelOutputInDispatch (W-SEC-DEF-1.1)', () => {
  test('happy path: real server.js has TOOL_TABLE[name] static dispatch', () => {
    const result = assertNoModelOutputInDispatch(REAL_SERVER_PATH);
    assert.equal(result.ok, true,
      `Expected ok=true but got: ${JSON.stringify(result.violations || result)}`);
    assert.ok(typeof result.evidence === 'string', 'evidence should be a string');
  });

  test('violation detected: dispatch[modelOutput] pattern is flagged', () => {
    const synthetic = writeSynthetic('server-dynamic.js', `
'use strict';
// Dangerous: resolving tool handler from model-supplied key
async function handleToolsCall(params) {
  const name = params.name;
  const modelOutput = params.modelSuggested;
  const handler = dispatch[modelOutput]; // forbidden: model-output as dispatch key
  return handler(params.arguments);
}
`);
    const result = assertNoModelOutputInDispatch(synthetic);
    assert.equal(result.ok, false, 'Expected ok=false for dispatch[modelOutput]');
    assert.ok(Array.isArray(result.violations) && result.violations.length > 0,
      'Expected at least one violation');
    assert.ok(
      result.violations.some(v => /modelOutput|dynamic/i.test(v.reason)),
      `Violation should mention modelOutput; got: ${JSON.stringify(result.violations)}`
    );
  });
});

// ---------------------------------------------------------------------------
// W-SEC-DEF-1.2 — assertEnvStripIsApplied
// ---------------------------------------------------------------------------

describe('assertEnvStripIsApplied (W-SEC-DEF-1.2)', () => {
  test('happy path: real plugin-loader.js (absent or clean) passes', () => {
    const result = assertEnvStripIsApplied(REAL_LOADER_PATH);
    assert.equal(result.ok, true,
      `Expected ok=true but got: ${JSON.stringify(result.violations || result)}`);
  });

  test('violation detected: spawn() with env: process.env is flagged', () => {
    const synthetic = writeSynthetic('plugin-loader-env.js', `
'use strict';
const { spawn } = require('child_process');
function spawnPlugin(pluginPath, args) {
  const proc = spawn(pluginPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env, // forbidden: raw process.env leaks secrets
  });
  return proc;
}
module.exports = { spawnPlugin };
`);
    const result = assertEnvStripIsApplied(synthetic);
    assert.equal(result.ok, false, 'Expected ok=false for env: process.env');
    assert.ok(Array.isArray(result.violations) && result.violations.length > 0,
      'Expected at least one violation');
    assert.ok(
      result.violations.some(v => /process\.env/i.test(v.reason) || /process\.env/i.test(v.snippet)),
      `Violation should mention process.env; got: ${JSON.stringify(result.violations)}`
    );
  });
});

// ---------------------------------------------------------------------------
// W-SEC-DEF-1.3 — assertConsentRequiredBeforeSpawn
// ---------------------------------------------------------------------------

describe('assertConsentRequiredBeforeSpawn (W-SEC-DEF-1.3)', () => {
  test('happy path: real plugin-loader.js (absent or clean) passes', () => {
    const result = assertConsentRequiredBeforeSpawn(REAL_LOADER_PATH);
    assert.equal(result.ok, true,
      `Expected ok=true but got: ${JSON.stringify(result.violations || result)}`);
  });

  test('violation detected: spawn before consent is flagged', () => {
    const synthetic = writeSynthetic('plugin-loader-consent.js', `
'use strict';
async function load(pluginDef) {
  // BUG: spawn happens before consent check
  const proc = await spawnAndHandshake(pluginDef.path);
  const consent = await _loadConsent(pluginDef); // too late
  return { proc, consent };
}
module.exports = { load };
`);
    const result = assertConsentRequiredBeforeSpawn(synthetic);
    assert.equal(result.ok, false, 'Expected ok=false when spawn precedes _loadConsent');
    assert.ok(Array.isArray(result.violations) && result.violations.length > 0,
      'Expected at least one violation');
    assert.ok(
      result.violations.some(v => /consent|spawn/i.test(v.reason)),
      `Violation should mention consent/spawn order; got: ${JSON.stringify(result.violations)}`
    );
  });
});

// ---------------------------------------------------------------------------
// W-SEC-DEF-1.4 — assertNoEvalInPluginLoader
// ---------------------------------------------------------------------------

describe('assertNoEvalInPluginLoader (W-SEC-DEF-1.4)', () => {
  test('happy path: real plugin-loader.js (absent or clean) passes', () => {
    const result = assertNoEvalInPluginLoader(REAL_LOADER_PATH);
    assert.equal(result.ok, true,
      `Expected ok=true but got: ${JSON.stringify(result.violations || result)}`);
  });

  test('violation detected: eval() in plugin-loader is flagged', () => {
    const synthetic = writeSynthetic('plugin-loader-eval.js', `
'use strict';
function parsePluginResponse(raw) {
  // Dangerous: eval() of plugin-supplied content
  const result = eval('(' + raw + ')');
  return result;
}
module.exports = { parsePluginResponse };
`);
    const result = assertNoEvalInPluginLoader(synthetic);
    assert.equal(result.ok, false, 'Expected ok=false for eval() in plugin-loader');
    assert.ok(Array.isArray(result.violations) && result.violations.length > 0,
      'Expected at least one violation');
    assert.ok(
      result.violations.some(v => /eval/i.test(v.reason) || /eval/i.test(v.snippet)),
      `Violation should mention eval; got: ${JSON.stringify(result.violations)}`
    );
  });
});

// ---------------------------------------------------------------------------
// W-SEC-DEF-1.5 — assertPluginToolsNeverInTopLevelMcpServers
// ---------------------------------------------------------------------------

describe('assertPluginToolsNeverInTopLevelMcpServers (W-SEC-DEF-1.5)', () => {
  test('happy path: real server.js has no top-level mcpServers write', () => {
    const result = assertPluginToolsNeverInTopLevelMcpServers(REAL_SERVER_PATH);
    assert.equal(result.ok, true,
      `Expected ok=true but got: ${JSON.stringify(result.violations || result)}`);
    assert.ok(typeof result.evidence === 'string', 'evidence should be a string');
  });

  test('violation detected: mcpServers[pluginName] = ... assignment is flagged', () => {
    const synthetic = writeSynthetic('server-mcpservers.js', `
'use strict';
const mcpServers = {};
function registerPluginTools(plugin) {
  // Forbidden: registering plugin tools as top-level mcpServers
  mcpServers[plugin.name] = plugin.toolDefinitions;
}
module.exports = { registerPluginTools };
`);
    const result = assertPluginToolsNeverInTopLevelMcpServers(synthetic);
    assert.equal(result.ok, false, 'Expected ok=false for mcpServers[...] = assignment');
    assert.ok(Array.isArray(result.violations) && result.violations.length > 0,
      'Expected at least one violation');
    assert.ok(
      result.violations.some(v => /mcpServers/i.test(v.reason) || /mcpServers/i.test(v.snippet)),
      `Violation should mention mcpServers; got: ${JSON.stringify(result.violations)}`
    );
  });
});
