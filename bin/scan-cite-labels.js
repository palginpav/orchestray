#!/usr/bin/env node
'use strict';

/**
 * scan-cite-labels.js — Stop-hook scanner for unlabelled pattern citations.
 *
 * v2.2.9 B-7.5. Reads the assistant's final message text from the hook
 * payload and emits one `cite_unlabelled_detected` event per
 * `@orchestray:pattern://<slug>` occurrence that lacks a `[label]` token.
 *
 * Warn-tier: never blocks (always exits 0). Future release can flip to deny.
 *
 * Input fields recognised on stdin:
 *   - event.message_text  (preferred; passthrough variant)
 *   - event.transcript    (fallback)
 *   - event.tool_response (PostToolUse variant — scans `output` if present)
 *
 * Fail-open: any error → exit 0 with no event.
 */

const { resolveSafeCwd } = require('./_lib/resolve-project-cwd');
const { scan } = require('./_lib/cite-label-scanner');
const { writeEvent } = require('./_lib/audit-event-writer');
const { MAX_INPUT_BYTES } = require('./_lib/constants');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', () => { process.exit(0); });
process.stdin.on('data', (chunk) => {
  input += chunk;
  if (input.length > MAX_INPUT_BYTES) process.exit(0);
});
process.stdin.on('end', () => {
  let event;
  try {
    event = input ? JSON.parse(input) : {};
  } catch (_e) {
    process.exit(0);
  }

  const cwd = resolveSafeCwd(event && event.cwd);

  // Collect candidate text from likely fields.
  const buckets = [];
  const push = (v) => { if (typeof v === 'string' && v.length > 0) buckets.push(v); };
  push(event && event.message_text);
  push(event && event.transcript);
  push(event && event.assistant_text);
  if (event && event.tool_response) {
    push(event.tool_response.output);
    push(event.tool_response.text);
  }
  // Some Stop hook envelopes carry a `messages` array; coerce defensively.
  if (event && Array.isArray(event.messages)) {
    for (const m of event.messages) {
      if (m && typeof m.content === 'string') push(m.content);
    }
  }

  const text = buckets.join('\n');
  if (!text) process.exit(0);

  let matches;
  try {
    matches = scan(text);
  } catch (_e) {
    process.exit(0);
  }

  if (!matches || matches.length === 0) process.exit(0);

  for (const hit of matches) {
    try {
      writeEvent({
        type: 'cite_unlabelled_detected',
        version: 1,
        timestamp: new Date().toISOString(),
        pattern_url: hit.pattern_url,
        surrounding_text: hit.surrounding_text.slice(0, 200),
      }, { cwd });
    } catch (_evErr) { /* fail-open */ }
  }
  process.exit(0);
});
