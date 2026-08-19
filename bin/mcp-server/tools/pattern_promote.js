'use strict';

/**
 * `pattern_promote` MCP tool.
 *
 * Thin dispatcher over `bin/_lib/shared-promote.js`'s `promotePattern()` —
 * modelled byte-for-byte on `curator_tombstone.js`, whose own header states
 * its reason for existing: "the curator agent has no `Bash` tool and cannot
 * `require()` Node modules directly." This is the second dispatcher for the
 * second Node library the curator needs.
 *
 * Before this tool, `promotePattern()` had zero production callers — the
 * curator wrote the shared tier directly with `Write`, so no sanitization
 * stage ever ran. See .orchestray/kb/artifacts/v2330-w1-promote-surface-design.md.
 *
 * Return-shape discipline (load-bearing, do not "simplify"):
 *   - A blocked promote (sensitivity, secret-scan, size-cap, schema-validate,
 *     collision, sharing-flag, write) is `toolSuccess` with `result: "blocked"`,
 *     never `toolError`. The refusal — stage, reason, remediation — IS the
 *     payload the calling LLM needs to decide what to do next.
 *   - `toolError` is reserved for protocol faults: bad input, unsafe slug,
 *     pattern not found, project root unresolvable, or the internal
 *     preview-invariant assertion below.
 *
 * D2 — the sensitivity gate lives in shared-promote.js and is NOT
 * re-implemented, pre-checked, or mirrored here. `cwd` is not in this tool's
 * input schema — the project root comes only from `context.projectRoot`
 * (server-injected) or `paths.getProjectRoot()`. `additionalProperties: false`
 * makes an injected `cwd` a validation error, not a silent extra field.
 */

const os = require('node:os');
const path = require('node:path');

const { validateAgainstSchema, deepFreeze } = require('../lib/schemas');
const { toolSuccess, toolError } = require('../lib/tool-result');
const { writeAuditEvent } = require('../lib/audit');
const { emitHandlerEntry } = require('../../_lib/mcp-handler-entry');
const paths = require('../lib/paths');
const { promotePattern } = require('../../_lib/shared-promote');

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const MODE_ENUM = ['promote', 'preview', 'dry_run'];
const BY_ENUM = ['user', 'curator'];

const INPUT_SCHEMA = deepFreeze({
  type: 'object',
  required: ['slug'],
  additionalProperties: false, // load-bearing: blocks an injected `cwd`
  properties: {
    slug: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Pattern slug (filename stem, no .md) under .orchestray/patterns/.',
    },
    mode: {
      type: 'string',
      enum: MODE_ENUM,
      description:
        'promote = run all stages and WRITE the shared tier. ' +
        'preview = run all stages, write nothing, return the full before/after diff ' +
        '(sensitivity gate is reported, not enforced — a preview never shares anything). ' +
        'dry_run = run all stages, write nothing, return pass/fail only.',
    },
    overwrite: {
      type: 'boolean',
      description:
        'Allow replacing an existing shared pattern with the same slug. ' +
        'Default false: a slug collision is a blocked promote, not a silent overwrite.',
    },
    by: {
      type: 'string',
      enum: BY_ENUM,
      description: 'Attribution recorded in the audit event. Curator MUST pass "curator".',
    },
    run_id: {
      type: 'string',
      maxLength: 100,
      description: 'Curator run id, when called inside a curate run. Correlates the promote with curator_run_start.',
    },
  },
});

const definition = deepFreeze({
  name: 'pattern_promote',
  description:
    'Promote a local pattern to the cross-project shared tier through the full ' +
    'sanitization pipeline (secret scan, Evidence strip, path/identity strip, header ' +
    'downgrade, size cap, schema validate). This is the ONLY way to write the shared ' +
    'tier — direct Write/Edit to ~/.orchestray/shared/ is blocked. Fail-closed: any ' +
    'stage violation returns result:"blocked" with a stage, a reason, and remediation ' +
    'steps; nothing is written. Use mode:"preview" to see the exact before/after diff ' +
    'without writing.',
  inputSchema: INPUT_SCHEMA,
});

// ---------------------------------------------------------------------------
// Per-stage remediation table (spec §"Interface contract")
// ---------------------------------------------------------------------------

const REMEDIATION = deepFreeze({
  'sharing-flag': {
    summary: "This pattern is pinned to this machine ('sharing: local-only').",
    actions: [
      "Edit the local pattern's frontmatter and remove the 'sharing: local-only' key " +
      "(or change it to 'federated'), then re-run this tool.",
    ],
    retryable_after_edit: true,
  },
  sensitivity: {
    summary:
      'This project has not opted in to sharing. This is an operator decision — ' +
      'the agent must not make it itself.',
    actions: [
      "Ask the operator to run: /orchestray:config set federation.sensitivity shareable",
    ],
    retryable_after_edit: false,
  },
  'secret-scan': {
    summary: 'A potential credential was found in the pattern file.',
    actions: [
      'Remove the credential from the local pattern file, then re-run this tool.',
      "If this is a false positive (e.g. a commit SHA), append '<!-- secret-scan: allow -->' to that line.",
    ],
    retryable_after_edit: true,
  },
  'size-cap': {
    summary: 'The sanitized pattern body exceeds the shared-tier size limit.',
    actions: [
      'Trim the pattern body (remove project-specific examples), or split it into multiple patterns.',
    ],
    retryable_after_edit: true,
  },
  'schema-validate': {
    summary: 'The pattern frontmatter is missing a required field or has an invalid value.',
    actions: [
      'Add the missing field, or fix the invalid confidence/category value named in the reason, then re-run.',
    ],
    retryable_after_edit: true,
  },
  collision: {
    summary: 'A different pattern already exists in the shared tier under this slug.',
    actions: [
      'Rename the local slug to avoid the collision, or re-call this tool with overwrite: true.',
    ],
    retryable_after_edit: true,
  },
  write: {
    summary: 'The shared tier is not configured or the filesystem write failed.',
    actions: [
      'Enable federation.shared_dir_enabled in .orchestray/config.json, or report the filesystem error to the operator.',
    ],
    retryable_after_edit: false,
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace the home directory prefix with `<home>` so absolute paths never leak into a transcript. */
function _homeRelativize(p) {
  if (typeof p !== 'string') return p;
  const home = os.homedir();
  if (home && p.startsWith(home)) {
    return '<home>' + p.slice(home.length);
  }
  return p;
}

/**
 * Best-effort extraction of secret-scan detail (kind, line, section) from the
 * formatted error string produced by shared-promote.js's `_secretScan`.
 * Both the pattern-based and hex-entropy branches share the same
 * "found potential X on line N of Y section" shape.
 */
function _parseSecretScanDetail(errorMessage) {
  const m = /found potential (.+?) on line (\d+) of (.+?) section/.exec(errorMessage || '');
  if (!m) return { detected_kind: null, location: null };
  return {
    detected_kind: m[1],
    location: { line: Number(m[2]), section: m[3] },
  };
}

/** Emit a federation_pattern_promoted / federation_promote_blocked audit event. Fail-open. */
function _emitPromoteEvent(type, fields) {
  try {
    writeAuditEvent(Object.assign({ timestamp: new Date().toISOString(), type, schema_version: 1, version: 1 }, fields));
  } catch (_e) {
    // Audit failures must never block the tool response.
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function handle(input, context) {
  emitHandlerEntry('pattern_promote', context);

  const validation = validateAgainstSchema(input, INPUT_SCHEMA);
  if (!validation.ok) {
    return toolError('pattern_promote: ' + validation.errors.join('; '));
  }

  const slug = input.slug;
  const mode = input.mode || 'promote';
  const overwrite = input.overwrite === true;
  const by = (input.by && BY_ENUM.includes(input.by)) ? input.by : 'user';
  const runId = (typeof input.run_id === 'string' && input.run_id.length > 0) ? input.run_id : null;

  try {
    paths.assertSafeSegment(slug);
  } catch (err) {
    return toolError('pattern_promote: unsafe slug: ' + (err && err.message));
  }

  // Project root: context.projectRoot (server-injected) > paths.getProjectRoot().
  // Never accepted from the caller — see D2 bypass analysis vector 1.
  let projectRoot = (context && context.projectRoot) || null;
  if (!projectRoot) {
    try {
      projectRoot = paths.getProjectRoot();
    } catch (_e) {
      return toolError('pattern_promote: could not resolve project root (no context.projectRoot and no ancestor .orchestray/)');
    }
  }

  const promoteOptions = {
    cwd: projectRoot,
    preview: mode === 'preview',
    dryRun: mode === 'dry_run',
    overwrite,
  };

  let result;
  try {
    result = await promotePattern(slug, promoteOptions);
  } catch (err) {
    return toolError('pattern_promote: promotePattern threw: ' + (err && err.message));
  }

  // -------------------------------------------------------------------------
  // Preview path
  // -------------------------------------------------------------------------
  if (result.ok && result.preview) {
    // D2 bypass vector 2: preview must never write. Assert the invariant
    // rather than trusting it — a future refactor bug becomes a visible
    // failure instead of a silent shared-tier write.
    if (result.destPath !== '<not-written>') {
      _emitPromoteEvent('federation_promote_blocked', {
        orchestration_id: null,
        slug,
        by,
        stage: 'preview_invariant',
        detected_kind: null,
        retryable_after_edit: false,
      });
      return toolError(
        'pattern_promote: internal invariant violated — preview mode returned a written destPath. Aborting.'
      );
    }
    return toolSuccess(Object.assign(
      { result: 'preview', slug },
      result.preview,
      { sensitivity_blocks_actual_share: result.preview.sensitivity_blocks_actual_share === true },
    ));
  }

  // -------------------------------------------------------------------------
  // Blocked path (policy refusal — toolSuccess, never toolError)
  // -------------------------------------------------------------------------
  if (!result.ok) {
    // Protocol faults (not policy) — these stay toolError per the interface contract.
    if (result.stage === 'read') {
      return toolError('pattern_promote: ' + result.error);
    }

    const stage = result.stage || 'unknown';
    const remediation = REMEDIATION[stage] || {
      summary: 'Promotion was blocked.',
      actions: ['Review the reason and consult the operator.'],
      retryable_after_edit: false,
    };

    let detected_kind = null;
    let location = null;
    if (stage === 'secret-scan') {
      const parsed = _parseSecretScanDetail(result.error);
      detected_kind = parsed.detected_kind;
      location = parsed.location;
    }

    _emitPromoteEvent('federation_promote_blocked', {
      orchestration_id: null,
      slug,
      by,
      stage,
      detected_kind,
      retryable_after_edit: remediation.retryable_after_edit,
    });

    const payload = {
      result: 'blocked',
      slug,
      written: false,
      stage,
      reason: result.error,
      remediation: {
        summary: remediation.summary,
        actions: remediation.actions,
        retryable_after_edit: remediation.retryable_after_edit,
      },
    };
    if (location) payload.location = location;
    if (detected_kind) payload.detected_kind = detected_kind;
    if (result.existing) payload.existing = result.existing;

    return toolSuccess(payload);
  }

  // -------------------------------------------------------------------------
  // Success path — "promoted", "no_op", or "dry_run"
  // -------------------------------------------------------------------------
  const promotedFm = result.promotedFm || {};
  const finalSizeBytes = typeof result.sanitizedBody === 'string'
    ? Buffer.byteLength(result.sanitizedBody, 'utf8')
    : null;

  if (result.result === 'promoted') {
    _emitPromoteEvent('federation_pattern_promoted', {
      orchestration_id: null,
      slug,
      by,
      run_id: runId,
      promoted_from: promotedFm.promoted_from || null,
      stages_run: result.stagesRun || [],
      evidence_stripped_bytes: result.evidenceStrippedBytes || 0,
      final_size_bytes: finalSizeBytes,
      overwrote_existing: Boolean(result.overwroteExisting),
    });
  }

  return toolSuccess({
    result: result.result || (result.dryRun ? 'dry_run' : 'promoted'),
    slug,
    written: Boolean(result.written),
    dest_path: _homeRelativize(result.destPath),
    promoted_at: promotedFm.promoted_at || null,
    promoted_from: promotedFm.promoted_from || null,
    stages_run: result.stagesRun || [],
    sanitization: {
      evidence_stripped_bytes: result.evidenceStrippedBytes || 0,
      frontmatter_removed: result.frontmatterRemoved || [],
      frontmatter_added: result.frontmatterAdded || [],
      final_size_bytes: finalSizeBytes,
    },
    overwrote_existing: Boolean(result.overwroteExisting),
    reason: result.reason || null,
  });
}

module.exports = { definition, handle };
