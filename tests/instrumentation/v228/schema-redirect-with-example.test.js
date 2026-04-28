'use strict';

/**
 * v2.2.8 Item 9 — schema redirect worked example + conversion tracking.
 *
 * Verifies:
 *   1. context-shield.js deny message contains the worked example with a slug.
 *   2. schema_redirect_emitted event is written to events.jsonl on redirect.
 *   3. sentinel file schema-redirect-pending.jsonl is written on redirect.
 *   4. emit-schema-redirect-followed.js pairs a schema_get call against sentinel.
 *   5. opt-out (full_load_disabled: false) suppresses the redirect.
 *   6. shadow.json contains schema_redirect_emitted and schema_redirect_followed.
 *   7. hooks.json contains mcp__orchestray__schema_get PostToolUse entry.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');
const fs     = require('node:fs');
const os     = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT      = path.resolve(__dirname, '..', '..', '..');
const SHIELD_SCRIPT  = path.join(REPO_ROOT, 'bin', 'context-shield.js');
const FOLLOWED_SCRIPT = path.join(REPO_ROOT, 'bin', 'emit-schema-redirect-followed.js');
const HOOKS_JSON     = path.join(REPO_ROOT, 'hooks', 'hooks.json');

const { loadShadow } = require('../../../bin/_lib/load-schema-shadow');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanup = [];

function makeTmpDir({ config = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-v228-test-'));
  cleanup.push(dir);

  // Create the minimum directory structure.
  const stateDir = path.join(dir, '.orchestray', 'state');
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });

  // Seed config.json.
  if (config !== null) {
    fs.writeFileSync(
      path.join(dir, '.orchestray', 'config.json'),
      JSON.stringify(config),
      'utf8'
    );
  }

  // Seed a stub event-schemas.md so the target file path resolves.
  const pmRefDir = path.join(dir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.writeFileSync(
    path.join(pmRefDir, 'event-schemas.md'),
    '# stub\n',
    'utf8'
  );

  // Seed shadow.json pointing to the real repo shadow (for validator).
  const realShadow = path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
  if (fs.existsSync(realShadow)) {
    fs.copyFileSync(realShadow, path.join(pmRefDir, 'event-schemas.shadow.json'));
  }

  // Seed a current-orchestration.json.
  fs.writeFileSync(
    path.join(auditDir, 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-test-v228', phase: 'wave-1' }),
    'utf8'
  );

  // Seed an events.jsonl target.
  fs.writeFileSync(path.join(auditDir, 'events.jsonl'), '', 'utf8');

  return dir;
}

function runScript(scriptPath, payload, cwd) {
  const result = spawnSync(process.execPath, [scriptPath], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 10000,
    env: Object.assign({}, process.env, {
      // Disable the shield's own session cache so we don't collide with other tests.
      ORCHESTRAY_SHIELD_DISABLED: '0',
    }),
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

function parseDecision(stdout) {
  try { return JSON.parse(stdout).hookSpecificOutput || {}; } catch (_e) { return {}; }
}

function readEventsJsonl(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, '.orchestray', 'audit', 'events.jsonl'), 'utf8');
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

function readSentinel(dir) {
  try {
    const raw = fs.readFileSync(
      path.join(dir, '.orchestray', 'state', 'schema-redirect-pending.jsonl'),
      'utf8'
    );
    return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  } catch (_e) { return []; }
}

// Clean up after all tests.
process.on('exit', () => {
  for (const d of cleanup) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) {}
  }
});

// ---------------------------------------------------------------------------
// Test 1: deny message contains worked example with slug
// ---------------------------------------------------------------------------

test('deny message contains worked example with mcp__orchestray__schema_get slug', () => {
  const dir = makeTmpDir();
  const targetFile = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');

  const payload = {
    tool_name: 'Read',
    cwd: dir,
    session_id: 'v228-test-1',
    turn_number: 1,
    tool_input: { file_path: targetFile },
  };

  const { status, stdout } = runScript(SHIELD_SCRIPT, payload, dir);
  assert.equal(status, 0, 'shield must exit 0');

  const decision = parseDecision(stdout);
  assert.equal(decision.permissionDecision, 'deny', 'must deny event-schemas.md read');

  const reason = decision.permissionDecisionReason || '';
  assert.ok(
    reason.includes('mcp__orchestray__schema_get'),
    'deny reason must mention mcp__orchestray__schema_get'
  );
  assert.ok(
    reason.includes("slug='"),
    "deny reason must contain a worked example with slug='...'"
  );
  assert.ok(
    reason.includes('_index'),
    "deny reason must mention the _index slug as a discovery mechanism"
  );
});

// ---------------------------------------------------------------------------
// Test 2: schema_redirect_emitted event is written to events.jsonl
// ---------------------------------------------------------------------------

test('schema_redirect_emitted event is written to events.jsonl on redirect', () => {
  const dir = makeTmpDir();
  const targetFile = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');

  const payload = {
    tool_name: 'Read',
    cwd: dir,
    session_id: 'v228-test-2',
    turn_number: 1,
    agent_type: 'developer',
    tool_input: { file_path: targetFile },
  };

  runScript(SHIELD_SCRIPT, payload, dir);

  const events = readEventsJsonl(dir);
  const emitted = events.find(e => e.type === 'schema_redirect_emitted');
  assert.ok(emitted, 'must emit schema_redirect_emitted event');
  assert.equal(emitted.suggested_tool, 'mcp__orchestray__schema_get');
  assert.ok(typeof emitted.suggested_slug === 'string', 'suggested_slug must be a string');
  assert.ok(typeof emitted.blocking_path === 'string', 'blocking_path must be a string');
  assert.equal(emitted.orchestration_id, 'orch-test-v228');
});

// ---------------------------------------------------------------------------
// Test 3: sentinel file is written on redirect
// ---------------------------------------------------------------------------

test('schema-redirect-pending.jsonl sentinel is written on redirect', () => {
  const dir = makeTmpDir();
  const targetFile = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');

  const payload = {
    tool_name: 'Read',
    cwd: dir,
    session_id: 'v228-test-3',
    turn_number: 1,
    agent_type: 'researcher',
    tool_input: { file_path: targetFile },
  };

  runScript(SHIELD_SCRIPT, payload, dir);

  const entries = readSentinel(dir);
  assert.ok(entries.length >= 1, 'sentinel must have at least one entry');
  const entry = entries[0];
  assert.equal(entry.orchestration_id, 'orch-test-v228');
  assert.ok(typeof entry.suggested_slug === 'string');
  assert.ok(typeof entry.ts === 'string');
});

// ---------------------------------------------------------------------------
// Test 4: emit-schema-redirect-followed.js pairs call against sentinel
// ---------------------------------------------------------------------------

test('schema_redirect_followed event is emitted when schema_get is called after redirect', () => {
  const dir = makeTmpDir();
  const targetFile = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');

  // Step 1: trigger the redirect (writes sentinel).
  const shieldPayload = {
    tool_name: 'Read',
    cwd: dir,
    session_id: 'v228-test-4',
    turn_number: 1,
    agent_type: 'developer',
    tool_input: { file_path: targetFile },
  };
  runScript(SHIELD_SCRIPT, shieldPayload, dir);

  // Verify sentinel was written.
  const sentinelBefore = readSentinel(dir);
  assert.ok(sentinelBefore.length >= 1, 'sentinel must exist before follow-up');

  // Step 2: simulate the agent calling mcp__orchestray__schema_get.
  const followPayload = {
    tool_name: 'mcp__orchestray__schema_get',
    cwd: dir,
    agent_type: 'developer',
    tool_input: { slug: 'agent_start' },
  };
  const { status } = runScript(FOLLOWED_SCRIPT, followPayload, dir);
  assert.equal(status, 0, 'followed script must exit 0');

  // Verify schema_redirect_followed event.
  const events = readEventsJsonl(dir);
  const followed = events.find(e => e.type === 'schema_redirect_followed');
  assert.ok(followed, 'must emit schema_redirect_followed event');
  assert.equal(followed.called_slug, 'agent_start');
  assert.ok(typeof followed.slug_match === 'boolean');
  assert.ok(typeof followed.suggested_slug === 'string');
  assert.equal(followed.orchestration_id, 'orch-test-v228');
});

// ---------------------------------------------------------------------------
// Test 5: opt-out (full_load_disabled: false) suppresses redirect
// ---------------------------------------------------------------------------

test('opt-out (event_schemas.full_load_disabled: false) allows event-schemas.md read', () => {
  const dir = makeTmpDir({
    config: { event_schemas: { full_load_disabled: false } },
  });
  const targetFile = path.join(dir, 'agents', 'pm-reference', 'event-schemas.md');

  const payload = {
    tool_name: 'Read',
    cwd: dir,
    session_id: 'v228-test-5',
    turn_number: 1,
    tool_input: { file_path: targetFile },
  };

  const { stdout } = runScript(SHIELD_SCRIPT, payload, dir);
  const decision = parseDecision(stdout);

  // May be 'allow' from R14 (first read) or the redirect is bypassed.
  // Key invariant: must NOT be a redirect deny.
  const reason = decision.permissionDecisionReason || '';
  assert.ok(
    !reason.includes('event-schemas.md is disabled'),
    'opt-out must suppress the redirect deny message'
  );
});

// ---------------------------------------------------------------------------
// Test 6: shadow.json contains both new event types
// ---------------------------------------------------------------------------

test('shadow.json contains schema_redirect_emitted and schema_redirect_followed', () => {
  const shadow = loadShadow(REPO_ROOT);
  assert.ok(shadow !== null, 'shadow JSON must be loadable');
  assert.ok(
    'schema_redirect_emitted' in shadow,
    'shadow must contain schema_redirect_emitted'
  );
  assert.ok(
    'schema_redirect_followed' in shadow,
    'shadow must contain schema_redirect_followed'
  );
});

// ---------------------------------------------------------------------------
// Test 7: hooks.json contains mcp__orchestray__schema_get PostToolUse entry
// ---------------------------------------------------------------------------

test('hooks.json PostToolUse contains mcp__orchestray__schema_get matcher', () => {
  const raw = fs.readFileSync(HOOKS_JSON, 'utf8');
  assert.ok(
    raw.includes('mcp__orchestray__schema_get'),
    'hooks.json must reference mcp__orchestray__schema_get'
  );
  const parsed = JSON.parse(raw);
  const postToolUse = parsed.hooks && parsed.hooks.PostToolUse;
  assert.ok(Array.isArray(postToolUse), 'PostToolUse must be an array');
  const hasEntry = postToolUse.some(entry => {
    const matcher = entry.matcher || '';
    const hooks = entry.hooks || [];
    return (
      matcher.includes('mcp__orchestray__schema_get') &&
      hooks.some(h => String(h.command || '').includes('emit-schema-redirect-followed'))
    );
  });
  assert.ok(hasEntry, 'hooks.json must have PostToolUse entry for schema_get → emit-schema-redirect-followed.js');
});
