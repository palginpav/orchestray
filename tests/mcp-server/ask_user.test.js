#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/mcp-server/handlers/ask_user.js
 *
 * Per v2011c-stage1-plan.md §3.4, §5, §11.
 *
 * Contract under test:
 *   async handleAskUser(
 *     input: object,
 *     context: {
 *       sendElicitation: (params, timeoutMs) => Promise<{ action, content? }>,
 *       config: object
 *     }
 *   ) -> { isError: boolean, content: Array<{type:"text",text:string}>,
 *           structuredContent?: object }
 *
 * Decision rules (§3.4):
 *   1. Validate input. On fail -> { isError: true, content: [{type:"text", ...}] }
 *   2. Translate form[] -> MCP requestedSchema.
 *   3. Resolve timeout: input.timeout_seconds
 *      ?? config.mcp_server.tools.ask_user.default_timeout_seconds
 *      ?? 120
 *   4. await context.sendElicitation({message, requestedSchema}, timeoutMs)
 *   5. TIMEOUT rejection -> structuredContent: { cancelled: false, timedOut: true }
 *   6. action=accept -> structuredContent: { cancelled: false, ...content }
 *   7. action=cancel -> { cancelled: true }   (outcome "cancelled")
 *      action=decline -> { cancelled: true }  (outcome "declined")
 *   8. unexpected error -> isError: true
 *
 * Each path emits exactly one audit event. This test file injects a fake
 * sendElicitation via the context parameter to avoid touching stdio.
 *
 * NOTE for developer: to verify the audit-event side effect in test 8,
 * handleAskUser must either (a) accept an optional audit sink in its context
 * argument, or (b) expose the audit-event object it built via its return
 * value. The plan doesn't explicitly say which. This test assumes (a) —
 * context.auditSink(event) is called once per invocation if provided. If you
 * choose (b), adjust test 8 accordingly and leave the rest alone.
 *
 * RED PHASE: source module does not exist yet; tests must fail at require().
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { handleAskUser } = require('../../bin/mcp-server/handlers/ask_user.js');

// ---------------------------------------------------------------------------
// Helpers: minimal fakes
// ---------------------------------------------------------------------------

function validInput(overrides = {}) {
  return {
    title: 'Confirm rename',
    question: 'Proceed with rename?',
    form: [
      { name: 'confirm', label: 'Proceed?', type: 'boolean', required: true },
    ],
    ...overrides,
  };
}

function makeContext({ sendElicitation, config, auditSink } = {}) {
  return {
    sendElicitation: sendElicitation || (async () => ({ action: 'accept', content: { confirm: true } })),
    config: config || { mcp_server: { tools: { ask_user: { default_timeout_seconds: 120 } } } },
    auditSink: auditSink || (() => {}),
  };
}

function timeoutErr() {
  const e = new Error('timeout');
  e.code = 'TIMEOUT';
  return e;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleAskUser', () => {

  test('returns isError: true when input validation fails (missing title)', async () => {
    const input = { question: 'What?', form: [{ name: 'x', label: 'X', type: 'text' }] };
    let elicitationCalled = false;
    const ctx = makeContext({
      sendElicitation: async () => { elicitationCalled = true; return { action: 'accept', content: {} }; },
    });

    const result = await handleAskUser(input, ctx);

    assert.equal(result.isError, true, 'must return isError: true on validation failure');
    assert.ok(Array.isArray(result.content) && result.content.length > 0,
      'content array must include the error text');
    assert.equal(result.content[0].type, 'text');
    assert.equal(elicitationCalled, false,
      'sendElicitation must NOT be called when input validation fails');
  });

  test('returns { cancelled: false, ...answers } when fake client accepts', async () => {
    const input = validInput({
      form: [
        { name: 'confirm', label: 'Proceed?', type: 'boolean', required: true },
        { name: 'strategy', label: 'Strategy', type: 'select', choices: ['a', 'b'] },
      ],
    });
    const ctx = makeContext({
      sendElicitation: async () => ({
        action: 'accept',
        content: { confirm: true, strategy: 'b' },
      }),
    });

    const result = await handleAskUser(input, ctx);

    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, {
      cancelled: false,
      confirm: true,
      strategy: 'b',
    });
  });

  test('returns { cancelled: true } when fake client cancels', async () => {
    const ctx = makeContext({
      sendElicitation: async () => ({ action: 'cancel' }),
    });

    const result = await handleAskUser(validInput(), ctx);

    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { cancelled: true });
  });

  test('returns { cancelled: true } when fake client declines', async () => {
    const ctx = makeContext({
      sendElicitation: async () => ({ action: 'decline' }),
    });

    const result = await handleAskUser(validInput(), ctx);

    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent, { cancelled: true });
  });

  test('returns { cancelled: false, timedOut: true } when sendElicitation rejects with code=TIMEOUT', async () => {
    const ctx = makeContext({
      sendElicitation: async () => { throw timeoutErr(); },
    });

    const result = await handleAskUser(validInput(), ctx);

    assert.equal(result.isError, false, 'timeout is NOT an error per §5 — simple branch');
    assert.deepEqual(result.structuredContent, { cancelled: false, timedOut: true });
  });

  test('passes input.timeout_seconds (converted to ms) to sendElicitation when provided', async () => {
    let receivedTimeoutMs = null;
    const ctx = makeContext({
      sendElicitation: async (_params, timeoutMs) => {
        receivedTimeoutMs = timeoutMs;
        return { action: 'accept', content: { confirm: true } };
      },
    });

    await handleAskUser(validInput({ timeout_seconds: 200 }), ctx);

    assert.equal(receivedTimeoutMs, 200 * 1000,
      'handler must convert timeout_seconds to ms when calling sendElicitation');
  });

  test('defaults timeout to 120 seconds when neither input nor config specifies one', async () => {
    let receivedTimeoutMs = null;
    const ctx = makeContext({
      sendElicitation: async (_params, timeoutMs) => {
        receivedTimeoutMs = timeoutMs;
        return { action: 'accept', content: { confirm: true } };
      },
      // Config with no default_timeout_seconds — handler must fall back to 120.
      config: { mcp_server: { tools: { ask_user: {} } } },
    });

    await handleAskUser(validInput(), ctx);

    assert.equal(receivedTimeoutMs, 120 * 1000,
      'handler must default timeout to 120s when unspecified in input and config');
  });

  test('emits exactly one audit event with outcome=answered on successful accept', async () => {
    // See NOTE at top of file: this test assumes the handler calls
    // context.auditSink(event) once per invocation. If the developer
    // chooses to return the audit event instead, adapt this assertion.
    const sink = [];
    const ctx = makeContext({
      sendElicitation: async () => ({ action: 'accept', content: { confirm: true } }),
      auditSink: (ev) => sink.push(ev),
    });

    await handleAskUser(validInput(), ctx);

    assert.equal(sink.length, 1, 'exactly one audit event must be emitted');
    assert.equal(sink[0].outcome, 'answered');
    assert.equal(sink[0].tool, 'mcp__orchestray__ask_user');
    assert.equal(sink[0].form_fields_count, 1);
  });

});
