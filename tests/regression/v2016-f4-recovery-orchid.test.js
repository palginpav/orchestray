#!/usr/bin/env node
'use strict';

/**
 * W8 — T2 F4 regression: `pattern_record_skip_reason` audit uses correct
 * `orchestration_id` in recovery path.
 *
 * Fix shipped in v2.0.15: `bin/mcp-server/server.js:372-383` extracts
 * `orchIdOverride` from `args.orchestration_id`; `lib/audit.js:buildAuditEvent`
 * prefers the override over the filesystem marker.
 *
 * This test verifies that the override takes precedence for all non-ask_user
 * tools, and that the fallback still works when no override is supplied.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildAuditEvent } = require('../../bin/mcp-server/lib/audit.js');

function makeTmpProject(orchId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-f4-test-'));
  const auditDir = path.join(dir, '.orchestray', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  if (orchId) {
    fs.writeFileSync(
      path.join(auditDir, 'current-orchestration.json'),
      JSON.stringify({ orchestration_id: orchId })
    );
  }
  return dir;
}

function withCwd(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(prev);
  }
}

describe('W8 T2 F4 regression — orchestration_id_override in buildAuditEvent', () => {

  test('override takes precedence over filesystem marker', () => {
    const tmp = makeTmpProject('orch-filesystem-id');
    try {
      const event = withCwd(tmp, () => buildAuditEvent({
        tool: 'pattern_record_skip_reason',
        outcome: 'answered',
        duration_ms: 10,
        form_fields_count: 0,
        orchestration_id_override: 'orch-recovery-id',
      }));
      assert.equal(event.orchestration_id, 'orch-recovery-id',
        'override must win over filesystem marker when both are present');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('filesystem marker is used when no override is supplied', () => {
    const tmp = makeTmpProject('orch-filesystem-id');
    try {
      const event = withCwd(tmp, () => buildAuditEvent({
        tool: 'pattern_record_skip_reason',
        outcome: 'answered',
        duration_ms: 10,
        form_fields_count: 0,
        // no orchestration_id_override
      }));
      assert.equal(event.orchestration_id, 'orch-filesystem-id',
        'filesystem marker used when override is absent');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('empty-string override falls back to filesystem marker', () => {
    const tmp = makeTmpProject('orch-filesystem-id');
    try {
      const event = withCwd(tmp, () => buildAuditEvent({
        tool: 'pattern_find',
        outcome: 'answered',
        duration_ms: 5,
        form_fields_count: 0,
        orchestration_id_override: '', // empty → not a valid override
      }));
      assert.equal(event.orchestration_id, 'orch-filesystem-id',
        'empty-string override must be treated as absent and fall back to filesystem');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('override works for all non-ask_user tool names (coverage for F4 7-tool scope)', () => {
    // The v2015 reviewer confirmed F4 fix applies to all non-ask_user tools.
    // Verify buildAuditEvent accepts override regardless of tool name.
    const tools = [
      'pattern_record_skip_reason',
      'pattern_find',
      'kb_search',
      'history_query_events',
      'history_find_similar_tasks',
      'pattern_record_application',
      'kb_write',
    ];
    const tmp = makeTmpProject('orch-filesystem-id');
    try {
      for (const tool of tools) {
        const event = withCwd(tmp, () => buildAuditEvent({
          tool,
          outcome: 'answered',
          duration_ms: 1,
          form_fields_count: 0,
          orchestration_id_override: 'orch-override-' + tool,
        }));
        assert.equal(event.orchestration_id, 'orch-override-' + tool,
          `override must be used for tool "${tool}"`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('override with non-string value falls back to filesystem marker', () => {
    const tmp = makeTmpProject('orch-filesystem-id');
    try {
      const event = withCwd(tmp, () => buildAuditEvent({
        tool: 'kb_search',
        outcome: 'answered',
        duration_ms: 5,
        form_fields_count: 0,
        orchestration_id_override: 42, // non-string → not a valid override
      }));
      assert.equal(event.orchestration_id, 'orch-filesystem-id',
        'non-string override must fall back to filesystem marker');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
