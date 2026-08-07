'use strict';

/**
 * `pattern_record_application` MCP tool.
 *
 * pattern-application-evidence-design.md §7.1 (v2.3.19 Phase 2): demoted from
 * the primary counter path to the out-of-band self-report channel. Per
 * times-applied-undercount-diagnosis.md, letting this tool mutate
 * `times_applied` directly made it the same cheap self-report shape as the
 * skip-reason path it was meant to counterbalance — 26 calls against 6,945
 * skips. `times_applied` is now committed from evidence (offer + ack ledger
 * join at orchestration close); this tool no longer mutates pattern
 * frontmatter at all.
 *
 * What it does instead: validates the call, appends a `source: "self_report"`
 * row to `.orchestray/state/pattern-acks.jsonl` (the same ledger
 * `bin/validate-pattern-ack.js` writes to, joined at orch-close by
 * whichever script implements §4.3 Phase 3), and emits a typed
 * `pattern_application_recorded` event with `evidence_grade: "self_report"`.
 * That event type was previously never emitted anywhere in `bin/` (§0.3),
 * so `bin/pattern-roi-aggregate.js`'s `app_rate` was structurally 0
 * regardless of the 26-call under-count — this fixes that read as a side
 * effect. `times_applied_before`/`times_applied_after` are read informational
 * — this call does NOT mutate them; both equal the pattern's current value
 * until whatever process implements §4.3 Phase 3 joins this ack row through
 * the §5 bounds and performs the real, capped, frontmatter increment.
 *
 * Legitimate use of this out-of-band channel: a pattern that shaped work
 * which never went through an `Agent()` spawn (PM applying it in-line, or a
 * curator run) — real, narrow, and worth keeping a channel for.
 */

const fs = require('node:fs');
const path = require('node:path');

const paths = require('../lib/paths');
const frontmatter = require('../lib/frontmatter');
const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { checkLimit, recordSuccess } = require('../lib/tool-counts');
const { writeAuditEvent } = require('../lib/audit');
const { atomicAppendJsonl } = require('../../_lib/atomic-append');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');

const OUTCOMES = ['applied', 'applied-success', 'applied-failure'];

const INPUT_SCHEMA = {
  type: 'object',
  required: ['slug', 'orchestration_id', 'outcome'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string', minLength: 1, maxLength: 200 },
    orchestration_id: { type: 'string', minLength: 1, maxLength: 64 },
    // task_id is optional but enables W6 per-task rate-limit enforcement
    // when both orchestration_id and task_id are present.
    task_id: { type: 'string', minLength: 1, maxLength: 64 },
    outcome: { type: 'string', enum: OUTCOMES },
    note: { type: 'string', maxLength: 500 },
  },
};

const definition = deepFreeze({
  name: 'pattern_record_application',
  description:
    'Out-of-band self-report: a pattern shaped work that never went through ' +
    'an Agent() spawn (in-line PM application, or a curator run). Does NOT ' +
    'increment times_applied directly — appends a self-report ack row that ' +
    'is joined through the same evidence bounds as spawn-observed ' +
    'applications at orchestration close. For spawned work, prefer citing ' +
    'the pattern in patterns_used on the spawned agent\'s Structured Result; ' +
    'no PM call is required for that path.',
  inputSchema: INPUT_SCHEMA,
});

async function handle(input, context) {
  emitHandlerEntry('pattern_record_application', context);
  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_record_application: ' + validation.errors.join('; '));
  }

  // W6 (v2.0.16): per-(orchestration_id, task_id) rate-limit pre-check.
  // checkLimit is read-only — does NOT increment the counter.
  // recordSuccess is called only after the pattern file is successfully written.
  // Only enforced when task_id is present alongside orchestration_id.
  const orchId = input.orchestration_id;
  const taskId = (input && typeof input.task_id === 'string') ? input.task_id : null;
  const _projectRoot = (context && context.projectRoot) || null;
  const _config = (context && context.config) || null;
  if (orchId && taskId && _projectRoot) {
    const limitResult = checkLimit(
      { orchestration_id: orchId, task_id: taskId, tool_name: 'pattern_record_application' },
      _projectRoot,
      _config
    );
    if (limitResult.exceeded) {
      return toolError(
        'pattern_record_application: max_per_task rate limit exceeded for task "' + taskId +
        '" (' + limitResult.count + '/' + limitResult.maxAllowed + ' calls used)'
      );
    }
  }

  const slug = input.slug;

  // Resolve patterns directory. Prefer context-injected projectRoot
  // (fixture strategy) so tests don't need to chdir into a tmpdir.
  let patternsDir;
  try {
    if (context && context.projectRoot) {
      patternsDir = path.join(context.projectRoot, '.orchestray', 'patterns');
    } else {
      patternsDir = paths.getPatternsDir();
    }
  } catch (err) {
    return toolError('pattern_record_application: no project root');
  }

  // Validate slug for safe segment (covers "..", "/", null byte, etc.).
  try {
    paths.assertSafeSegment(slug);
  } catch (err) {
    return toolError('pattern_record_application: unsafe slug: ' + (err && err.message));
  }

  const patternFile = path.join(patternsDir, slug + '.md');
  // Belt-and-braces containment check against the patterns root.
  const resolved = path.resolve(patternFile);
  const rootAbs = path.resolve(patternsDir);
  if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
    return toolError('pattern_record_application: slug escapes patterns root');
  }
  if (!fs.existsSync(resolved)) {
    return toolError('pattern not found: ' + slug);
  }

  // Read the CURRENT frontmatter for the informational before/after fields on
  // the emitted event. §7.1: this tool no longer mutates times_applied —
  // before and after are deliberately identical here.
  let content;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    return toolError('pattern_record_application: read failed: ' + (err && err.message));
  }
  const parsed = frontmatter.parse(content);
  if (!parsed.hasFrontmatter) {
    return toolError('pattern_record_application: malformed frontmatter in ' + slug);
  }
  const currentCount = _toInt(parsed.frontmatter.times_applied, 0);
  const nowIso = new Date().toISOString();
  // 'applied-failure' means the APPLICATION did not go well, distinct from a
  // tool-call failure (which returns toolError above, never reaches here).
  const agentStatus = input.outcome === 'applied-failure' ? 'failure' : 'success';

  // Append the self-report ack row. Same ledger bin/validate-pattern-ack.js
  // writes to (.orchestray/state/pattern-acks.jsonl) — joined through the §5
  // bounds by whichever process implements §4.3 Phase 3 orch-close commit.
  // `how_len` mirrors the optional free-text `note` field; self-report is not
  // held to the 10-300 char bar the Structured Result contract enforces
  // (§7.1: "out-of-band channel", a weaker signal by design).
  const ackRow = {
    timestamp: nowIso,
    orchestration_id: orchId,
    spawn_id: null,
    agent_role: null,
    task_id: taskId,
    source: 'self_report',
    used: [{ slug, how_len: typeof input.note === 'string' ? input.note.trim().length : 0 }],
    rejected: [],
    agent_status: agentStatus,
  };
  try {
    const ackPath = (_projectRoot || paths.getProjectRoot());
    const ackFile = path.join(ackPath, '.orchestray', 'state', 'pattern-acks.jsonl');
    fs.mkdirSync(path.dirname(ackFile), { recursive: true });
    atomicAppendJsonl(ackFile, ackRow);
  } catch (_e) { /* fail-open — ledger write must never block the tool response */ }

  // Fixes §0.3: pattern_application_recorded was never emitted anywhere in
  // bin/, so bin/pattern-roi-aggregate.js's app_rate read zero structurally.
  const recordedEvent = {
    version: 1,
    type: 'pattern_application_recorded',
    orchestration_id: orchId,
    timestamp: nowIso,
    slug,
    pattern_name: slug,
    evidence_grade: 'self_report',
    offer_kind: null,
    spawn_ids: [],
    agent_roles: [],
    times_applied_before: currentCount,
    times_applied_after: currentCount,
    schema_version: 1,
  };
  try {
    if (context && typeof context.auditSink === 'function') {
      context.auditSink(recordedEvent);
    } else if (_projectRoot) {
      const auditPath = path.join(_projectRoot, '.orchestray', 'audit', 'events.jsonl');
      fs.mkdirSync(path.dirname(auditPath), { recursive: true });
      fs.appendFileSync(auditPath, JSON.stringify(recordedEvent) + '\n', 'utf8');
    } else {
      writeAuditEvent(recordedEvent);
    }
  } catch (_e) { /* fail-open */ }

  // W6 (F06): record successful call after the ack/event writes are attempted.
  if (orchId && taskId && _projectRoot) {
    recordSuccess(
      { orchestration_id: orchId, task_id: taskId, tool_name: 'pattern_record_application' },
      _projectRoot,
      _config
    );
  }

  return toolSuccess({
    slug,
    recorded: 'self_report',
    evidence_grade: 'self_report',
    times_applied: currentCount,
  });
}

function _toInt(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return fallback;
}

module.exports = {
  definition,
  handle,
};
