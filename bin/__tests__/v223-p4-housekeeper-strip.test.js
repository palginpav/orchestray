#!/usr/bin/env node
'use strict';

/**
 * v223-p4-housekeeper-strip.test.js — v2.2.3 P4 W2 Strip regression tests.
 *
 * Verifies the orchestray-housekeeper agent has been fully stripped from
 * the codebase: agent file gone, hooks unwired, schema events removed,
 * PM tools allowlist clean.
 *
 * Per W6 decision (.orchestray/kb/artifacts/v223-p3-housekeeper-decision.md):
 * the housekeeper marker protocol shipped in v2.2.0 but never fired (0
 * invocations across 7 post-v2.2.0 orchestrations); structural review found
 * the marker→spawn router was never wired. Re-introduction (if any) will
 * use an explicit MCP tool with verifiable cost telemetry.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

describe('v2.2.3 P4 W2 — housekeeper Strip removal', () => {
  test('agents/orchestray-housekeeper.md does NOT exist', () => {
    const filePath = path.join(REPO_ROOT, 'agents', 'orchestray-housekeeper.md');
    assert.ok(!fs.existsSync(filePath),
      'orchestray-housekeeper agent file must be removed');
  });

  test('bin/audit-housekeeper-action.js does NOT exist', () => {
    const filePath = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-action.js');
    assert.ok(!fs.existsSync(filePath),
      'audit-housekeeper-action.js hook must be removed');
  });

  test('bin/audit-housekeeper-drift.js does NOT exist', () => {
    const filePath = path.join(REPO_ROOT, 'bin', 'audit-housekeeper-drift.js');
    assert.ok(!fs.existsSync(filePath),
      'audit-housekeeper-drift.js hook must be removed');
  });

  test('bin/_lib/_housekeeper-baseline.js does NOT exist', () => {
    const filePath = path.join(REPO_ROOT, 'bin', '_lib', '_housekeeper-baseline.js');
    assert.ok(!fs.existsSync(filePath),
      '_housekeeper-baseline.js must be removed');
  });

  test('agents/pm.md tools allowlist does NOT contain orchestray-housekeeper', () => {
    const pmContent = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'pm.md'), 'utf8');
    const toolsLine = pmContent.split('\n').find((l) => l.startsWith('tools:'));
    assert.ok(toolsLine, 'pm.md must have a tools: line');
    assert.doesNotMatch(toolsLine, /\borchestray-housekeeper\b/,
      'orchestray-housekeeper must be removed from PM tools allowlist');
  });

  test('agents/pm.md does NOT contain §23f Housekeeper section', () => {
    const pmContent = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'pm.md'), 'utf8');
    assert.doesNotMatch(pmContent, /23f\.\s*Housekeeper invocation/i,
      '§23f housekeeper section must be removed from pm.md');
  });

  test('gate-agent-spawn.js CANONICAL_AGENTS_ALLOWLIST does NOT contain orchestray-housekeeper', () => {
    const gateContent = fs.readFileSync(
      path.join(REPO_ROOT, 'bin', 'gate-agent-spawn.js'), 'utf8'
    );
    // Find the allowlist literal block
    const allowlistMatch = gateContent.match(/CANONICAL_AGENTS_ALLOWLIST\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(allowlistMatch, 'CANONICAL_AGENTS_ALLOWLIST literal must exist');
    assert.doesNotMatch(allowlistMatch[1], /orchestray-housekeeper/,
      'orchestray-housekeeper must be removed from CANONICAL_AGENTS_ALLOWLIST');
  });

  test('event-schemas.md does NOT contain housekeeper_* event sections', () => {
    const schemaContent = fs.readFileSync(
      path.join(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md'), 'utf8'
    );
    assert.doesNotMatch(schemaContent, /^### `housekeeper_action`/m,
      'housekeeper_action event schema must be removed');
    assert.doesNotMatch(schemaContent, /^### `housekeeper_drift_detected`/m,
      'housekeeper_drift_detected event schema must be removed');
    assert.doesNotMatch(schemaContent, /^### `housekeeper_forbidden_tool_blocked`/m,
      'housekeeper_forbidden_tool_blocked event schema must be removed');
    assert.doesNotMatch(schemaContent, /^### `housekeeper_baseline_missing`/m,
      'housekeeper_baseline_missing event schema must be removed');
  });

  test('hooks.json does NOT register audit-housekeeper-*.js', () => {
    const hooksContent = fs.readFileSync(
      path.join(REPO_ROOT, 'hooks', 'hooks.json'), 'utf8'
    );
    assert.doesNotMatch(hooksContent, /audit-housekeeper-action/,
      'audit-housekeeper-action.js must not be registered');
    assert.doesNotMatch(hooksContent, /audit-housekeeper-drift/,
      'audit-housekeeper-drift.js must not be registered');
  });

  test('validate-task-completion.js KNOWN_EVENT_TYPES does NOT contain housekeeper_*', () => {
    const validateContent = fs.readFileSync(
      path.join(REPO_ROOT, 'bin', 'validate-task-completion.js'), 'utf8'
    );
    // Find KNOWN_EVENT_TYPES block
    const setMatch = validateContent.match(/const KNOWN_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(setMatch, 'KNOWN_EVENT_TYPES must exist');
    assert.doesNotMatch(setMatch[1], /'housekeeper_action'/,
      'housekeeper_action must be removed from KNOWN_EVENT_TYPES');
    assert.doesNotMatch(setMatch[1], /'housekeeper_drift_detected'/);
    assert.doesNotMatch(setMatch[1], /'housekeeper_forbidden_tool_blocked'/);
    assert.doesNotMatch(setMatch[1], /'housekeeper_baseline_missing'/);
  });

  test('validate-task-completion.js does NOT define HOUSEKEEPER_FORBIDDEN_TOOLS', () => {
    const validateContent = fs.readFileSync(
      path.join(REPO_ROOT, 'bin', 'validate-task-completion.js'), 'utf8'
    );
    assert.doesNotMatch(validateContent, /const\s+HOUSEKEEPER_FORBIDDEN_TOOLS/,
      'HOUSEKEEPER_FORBIDDEN_TOOLS constant must be removed');
  });

  test('READ_ONLY_AGENTS contains only haiku-scout (post-strip)', () => {
    const validateModule = require(path.join(REPO_ROOT, 'bin', 'validate-task-completion.js'));
    assert.ok(validateModule.READ_ONLY_AGENTS instanceof Set);
    assert.ok(validateModule.READ_ONLY_AGENTS.has('haiku-scout'));
    assert.ok(!validateModule.READ_ONLY_AGENTS.has('orchestray-housekeeper'),
      'orchestray-housekeeper must be removed from READ_ONLY_AGENTS');
  });

  test('haiku-routing.md does NOT contain §23f Background-housekeeper section body', () => {
    const haikuContent = fs.readFileSync(
      path.join(REPO_ROOT, 'agents', 'pm-reference', 'haiku-routing.md'), 'utf8'
    );
    // Section heading must be removed (only a strip-rationale comment may remain).
    assert.doesNotMatch(haikuContent,
      /^## Section 23f — Background-housekeeper Haiku/m,
      '§23f section heading must be removed from haiku-routing.md');
  });

  test('cost-prediction.md does NOT contain §32 Background-housekeeper cost model heading', () => {
    const costContent = fs.readFileSync(
      path.join(REPO_ROOT, 'agents', 'pm-reference', 'cost-prediction.md'), 'utf8'
    );
    assert.doesNotMatch(costContent,
      /^## Section 32 — Background-housekeeper Haiku/m,
      '§32 housekeeper cost model heading must be removed from cost-prediction.md');
  });

  test('emit-compression-telemetry.js REPO_MAP_OPT_OUT_AGENTS does NOT contain orchestray-housekeeper', () => {
    const emitContent = fs.readFileSync(
      path.join(REPO_ROOT, 'bin', 'emit-compression-telemetry.js'), 'utf8'
    );
    const setMatch = emitContent.match(/REPO_MAP_OPT_OUT_AGENTS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(setMatch);
    assert.doesNotMatch(setMatch[1], /orchestray-housekeeper/,
      'orchestray-housekeeper must be removed from REPO_MAP_OPT_OUT_AGENTS');
  });

  test('output-shape.js EXCLUDED_ROLES does NOT contain orchestray-housekeeper', () => {
    const outputShapeContent = fs.readFileSync(
      path.join(REPO_ROOT, 'bin', '_lib', 'output-shape.js'), 'utf8'
    );
    const setMatch = outputShapeContent.match(/EXCLUDED_ROLES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    assert.ok(setMatch);
    assert.doesNotMatch(setMatch[1], /orchestray-housekeeper/,
      'orchestray-housekeeper must be removed from EXCLUDED_ROLES');
  });

  test('team-config-resolve.js FORWARD_LOOK_HAIKU does NOT contain orchestray-housekeeper', () => {
    const trContent = fs.readFileSync(
      path.join(REPO_ROOT, 'bin', '_lib', 'team-config-resolve.js'), 'utf8'
    );
    const arrMatch = trContent.match(/FORWARD_LOOK_HAIKU\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(arrMatch);
    assert.doesNotMatch(arrMatch[1], /orchestray-housekeeper/,
      'orchestray-housekeeper must be removed from FORWARD_LOOK_HAIKU');
  });
});
