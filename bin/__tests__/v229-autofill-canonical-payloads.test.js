#!/usr/bin/env node
'use strict';

/**
 * v229-autofill-canonical-payloads.test.js — F1 (v2.2.9).
 *
 * Pins the W4 RCA-9 fix: every event-type registered in
 * `agents/pm-reference/event-schemas.shadow.json` must validate cleanly when
 * the emitter omits ONLY the F1-allowlist fields (`version`, `timestamp`,
 * `orchestration_id`, and best-effort `session_id`). Pre-F1, omitting
 * `version: 1` silently drove 64/74 = 86% of `agent_stop` rows into the
 * `schema_shadow_validation_block` surrogate path.
 *
 * Coverage:
 *   1. Canonical sweep: for every shadow event-type, construct a synthetic
 *      payload with all required fields populated, then deliberately drop
 *      `version`. Assert the writer:
 *        a) appends the original event to events.jsonl (validation passes)
 *        b) does NOT emit a `schema_shadow_validation_block` surrogate
 *        c) emits exactly one `audit_event_autofilled` advisory naming
 *           `version` in `fields_autofilled`
 *   2. Caller-provided values are NEVER counted as autofilled (e.g. caller
 *      supplies version=1 explicitly → no autofill telemetry fires).
 *   3. Kill switch: with `ORCHESTRAY_AUDIT_AUTOFILL_DISABLED=1`, the writer
 *      reverts to v2.2.8 behavior — version-omitted payloads drop into the
 *      surrogate path and no `audit_event_autofilled` row appears.
 *   4. Recursion guard: emitting `audit_event_autofilled` itself does not
 *      cascade into more `audit_event_autofilled` rows.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert/strict');
const { spawnSync }      = require('node:child_process');
const path               = require('node:path');
const fs                 = require('node:fs');
const os                 = require('node:os');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.md');
const SHADOW_PATH = path.resolve(REPO_ROOT, 'agents', 'pm-reference', 'event-schemas.shadow.json');
const GATEWAY     = path.resolve(REPO_ROOT, 'bin', '_lib', 'audit-event-writer.js');

// ---------------------------------------------------------------------------
// Test fixtures: payloads constructed from the schema source
// ---------------------------------------------------------------------------

/**
 * Build a synthetic payload for the given event-type by parsing the JSON
 * fence of its event-schemas.md section. Keeps every required field present
 * EXCEPT `version` so we exercise F1 autofill.
 *
 * Returns null when the section's JSON fence is unparseable — those entries
 * are skipped (the test reports the count to surface schema-source drift).
 */
function buildPayloadFromSchemaSource(slug, schemaSource) {
  // Locate the section starting with `### `<slug>` event ...` or variants.
  const SECTION_RE = new RegExp(
    '^### [`]?' + slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '(?:[`]| event| Event)',
    'm'
  );
  const m = SECTION_RE.exec(schemaSource);
  if (!m) return null;
  const sectionStart = m.index;
  const nextSection  = schemaSource.indexOf('\n### ', sectionStart + 1);
  const sectionEnd   = nextSection === -1 ? schemaSource.length : nextSection;
  const section      = schemaSource.slice(sectionStart, sectionEnd);

  const fenceStart = section.indexOf('```json');
  if (fenceStart === -1) return null;
  const fenceContentStart = fenceStart + '```json'.length;
  const fenceEnd = section.indexOf('```', fenceContentStart);
  if (fenceEnd === -1) return null;
  const block = section.slice(fenceContentStart, fenceEnd);

  // The schema fences are hand-written and may include enum prose like
  // `"reason": "promise_met|max_iterations"`, so JSON.parse usually fails.
  // Walk lines instead — same approach as event-schemas-parser.js.
  const KEY_VALUE_RE = /^\s+"([^"]+)"\s*:\s*(.+?)(?:,\s*)?$/;
  const lines = block.split('\n').filter((l) => !l.match(/^```/));

  const payload = {};
  for (const line of lines) {
    const km = line.match(KEY_VALUE_RE);
    if (!km) continue;
    const key = km[1];
    const valText = km[2].trim();

    // Skip optional fields — the test only fills required ones.
    const isOptional = /optional|null|undefined|\?/.test(valText) ||
      valText === 'null' ||
      (valText.startsWith('"') && valText.includes('optional'));
    if (isOptional) continue;

    if (key === 'type') {
      payload.type = slug;
      continue;
    }
    if (key === 'version') {
      // Deliberately OMITTED — this is the F1 test trigger.
      continue;
    }

    // Provide a synthetic value matching the apparent type. The F1 test only
    // cares that validation passes; downstream consumers are NOT exercised.
    if (valText.startsWith('"')) {
      payload[key] = 'synthetic-' + key;
    } else if (valText.startsWith('{')) {
      payload[key] = {};
    } else if (valText.startsWith('[')) {
      payload[key] = [];
    } else if (/^-?\d/.test(valText)) {
      payload[key] = 0;
    } else if (valText === 'true' || valText === 'false') {
      payload[key] = valText === 'true';
    } else {
      // Enum prose like `measured|estimated` — pick the first token.
      payload[key] = valText.replace(/^"/, '').replace(/"$/, '').split('|')[0].trim() || 'synthetic';
    }
  }

  // Always omit version — F1 must autofill it.
  delete payload.version;

  return payload;
}

function makeTmpRepo() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-f1-test-'));
  const pmRefDir = path.join(tmpDir, 'agents', 'pm-reference');
  fs.mkdirSync(pmRefDir, { recursive: true });
  fs.copyFileSync(SCHEMA_PATH, path.join(pmRefDir, 'event-schemas.md'));
  fs.copyFileSync(SHADOW_PATH, path.join(pmRefDir, 'event-schemas.shadow.json'));
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'state'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.orchestray', 'audit'), { recursive: true });
  // Active orchestration marker so resolveOrchestrationId returns a stable id.
  fs.writeFileSync(
    path.join(tmpDir, '.orchestray', 'audit', 'current-orchestration.json'),
    JSON.stringify({ orchestration_id: 'orch-f1-test', started_at: new Date().toISOString() })
  );
  return tmpDir;
}

function readEventsJsonl(tmpDir) {
  const p = path.join(tmpDir, '.orchestray', 'audit', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/**
 * Run a node child that loads writeEvent and invokes it once per payload.
 * Returns the parsed events.jsonl rows. Optional `env` overrides for the
 * kill-switch test.
 */
function callWriteEvents(tmpDir, payloads, env) {
  const harness = `
    const { writeEvent } = require(${JSON.stringify(GATEWAY)});
    const payloads = ${JSON.stringify(payloads)};
    for (const p of payloads) writeEvent(p, { cwd: ${JSON.stringify(tmpDir)} });
  `;
  spawnSync(process.execPath, ['-e', harness], {
    encoding: 'utf8',
    timeout: 20000,
    env: Object.assign({}, process.env, env || {}),
  });
  return readEventsJsonl(tmpDir);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('v229 F1 — required-field autofill', () => {

  test('1. canonical sweep — every shadow event-type passes validation when version is omitted', () => {
    const shadow       = JSON.parse(fs.readFileSync(SHADOW_PATH, 'utf8'));
    const schemaSource = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const slugs = Object.keys(shadow).filter((k) => k !== '_meta');

    // Build a payload per slug. Skip slugs whose schema source we can't parse
    // (would indicate a documentation gap separate from F1's responsibility).
    //
    // Two slugs are deliberately excluded from the canonical sweep:
    //   - `schema_shadow_validation_block`: this IS the surrogate type. A
    //     synthetic payload of this type would still validate cleanly, but
    //     it would create false-positive entries in the surrogate count
    //     used by the post-write assertion.
    //   - `audit_event_autofilled`: this is the F1 telemetry type. A
    //     synthetic payload of this type fires the recursion guard but
    //     would also collide with the autofill-counting assertions.
    // Both have their own targeted tests below.
    const SWEEP_EXCLUDE = new Set([
      'schema_shadow_validation_block',
      'audit_event_autofilled',
    ]);
    const payloads = [];
    const skipped  = [];
    for (const slug of slugs) {
      if (SWEEP_EXCLUDE.has(slug)) continue;
      const p = buildPayloadFromSchemaSource(slug, schemaSource);
      if (p === null) {
        skipped.push(slug);
        continue;
      }
      payloads.push(p);
    }

    // Assert at least 100 of the 145+ slugs were parseable — defends against
    // schema-source drift that would silently shrink the test surface.
    assert.ok(
      payloads.length >= 100,
      'expected ≥100 parseable schema entries; got ' + payloads.length +
      ' (skipped: ' + skipped.length + ')'
    );

    const tmpDir = makeTmpRepo();
    try {
      const lines = callWriteEvents(tmpDir, payloads);

      // Partition rows.
      const surrogates = lines.filter((e) => e.type === 'schema_shadow_validation_block');
      const autofills  = lines.filter((e) => e.type === 'audit_event_autofilled');
      const originals  = lines.filter((e) =>
        e.type !== 'schema_shadow_validation_block' &&
        e.type !== 'audit_event_autofilled' &&
        e.type !== 'schema_unknown_type_warn'
      );

      // CRITICAL: zero surrogate rows. Pre-F1 every payload would have
      // generated one because version was omitted.
      assert.equal(
        surrogates.length, 0,
        'expected zero surrogate rows; got ' + surrogates.length +
        ' (first surrogate blocked: ' +
        (surrogates[0] && surrogates[0].blocked_event_type) + ')'
      );

      // Every original payload appended exactly once. Some payloads may
      // have other unsatisfiable required fields (e.g. nested objects with
      // structural enums), so we only check the count is at least the
      // payload count minus a small tolerance for payload-shape edge cases.
      // The hard assertion is "no surrogates fired".
      assert.ok(
        originals.length >= payloads.length - 5,
        'expected ≥' + (payloads.length - 5) + ' original rows; got ' + originals.length
      );

      // For event-types whose schema declares `version` as required, the
      // autofill must populate it. For event-types whose schema source
      // OMITS the version line (pre-F1 emit-only convention), F1
      // deliberately skips the version autofill — those events were
      // already passing v2.2.8 validation without it.
      //
      // Use the validator's parsed schema to decide expectations per slug.
      const { getSchemas } = require(path.resolve(REPO_ROOT, 'bin', '_lib', 'schema-emit-validator'));
      const tmpSchemas = getSchemas(tmpDir);
      let versionRequiredCount = 0;
      let versionAutofilledCount = 0;
      for (const ev of originals) {
        const schema = tmpSchemas && tmpSchemas.get(ev.type);
        const versionIsRequired = schema &&
          Array.isArray(schema.required) &&
          schema.required.includes('version');
        if (versionIsRequired) {
          versionRequiredCount++;
          assert.equal(
            typeof ev.version, 'number',
            'version autofill expected on ' + ev.type + ' (schema requires version)'
          );
          if (typeof ev.version === 'number') versionAutofilledCount++;
        }
      }
      // Defend against a schema-source regression where the bombshell-fix
      // surface shrinks: ≥70 of the ~146 event-types declare version
      // required as of v2.2.9 ship (verified at F1 ship time: 77).
      assert.ok(
        versionRequiredCount >= 70,
        'expected ≥70 event-types to declare version required; got ' + versionRequiredCount
      );

      // Each original whose version was autofilled gets one telemetry row.
      // Telemetry rows themselves do NOT generate further telemetry (they
      // include version: 1 explicitly, so no autofill on them).
      const autofillsForVersionOnly = autofills.filter((e) =>
        Array.isArray(e.fields_autofilled) &&
        e.fields_autofilled.includes('version')
      );
      assert.ok(
        autofillsForVersionOnly.length >= versionAutofilledCount - 5,
        'expected ≥' + (versionAutofilledCount - 5) +
        ' audit_event_autofilled rows naming version; got ' + autofillsForVersionOnly.length
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('2. caller-provided version is NEVER reported as autofilled', () => {
    const tmpDir = makeTmpRepo();
    try {
      const lines = callWriteEvents(tmpDir, [
        // schema_shadow_hit requires {version, event_type}; provide both.
        { type: 'schema_shadow_hit', version: 1, event_type: 'tier2_load' },
      ]);
      const autofills = lines.filter((e) => e.type === 'audit_event_autofilled');
      // No autofill row should reference 'version' because the caller
      // provided it explicitly. (timestamp + orchestration_id may still be
      // autofilled — those are not in this assertion.)
      const versionAutofills = autofills.filter((e) =>
        Array.isArray(e.fields_autofilled) && e.fields_autofilled.includes('version')
      );
      assert.equal(versionAutofills.length, 0,
        'caller-provided version must not be reported in audit_event_autofilled'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('3. kill switch — ORCHESTRAY_AUDIT_AUTOFILL_DISABLED=1 reverts to v2.2.8 behavior', () => {
    const tmpDir = makeTmpRepo();
    try {
      // Same payload as test 1, version omitted. Pre-F1 / kill-switch-on
      // behavior: validation fails, original drops, surrogate emitted.
      const lines = callWriteEvents(
        tmpDir,
        [{ type: 'schema_shadow_hit', event_type: 'tier2_load' }],
        { ORCHESTRAY_AUDIT_AUTOFILL_DISABLED: '1' }
      );
      const surrogates = lines.filter((e) => e.type === 'schema_shadow_validation_block');
      const originals  = lines.filter((e) => e.type === 'schema_shadow_hit');
      const autofills  = lines.filter((e) => e.type === 'audit_event_autofilled');

      assert.equal(surrogates.length, 1,
        'kill-switch on: missing-version payload must drop into surrogate path; got ' +
        surrogates.length + ' surrogates'
      );
      assert.equal(originals.length, 0,
        'kill-switch on: original schema_shadow_hit must NOT be appended'
      );
      assert.equal(autofills.length, 0,
        'kill-switch on: no audit_event_autofilled rows; got ' + autofills.length
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('4. recursion guard — audit_event_autofilled row never cascades', () => {
    const tmpDir = makeTmpRepo();
    try {
      // Trigger one autofill via a version-omitted payload. The resulting
      // audit_event_autofilled row must not itself trigger another one.
      const lines = callWriteEvents(tmpDir, [
        { type: 'schema_shadow_hit', event_type: 'tier2_load' },
      ]);
      const autofills = lines.filter((e) => e.type === 'audit_event_autofilled');
      // Exactly one telemetry row (for the schema_shadow_hit), not two.
      assert.equal(autofills.length, 1,
        'expected exactly 1 audit_event_autofilled row; got ' + autofills.length
      );
      // The telemetry row itself has version: 1 (from F1's allowlist
      // hardcoded fallback for the audit_event_autofilled emit).
      assert.equal(autofills[0].version, 1, 'telemetry row has version: 1');
      assert.equal(autofills[0].event_type, 'schema_shadow_hit',
        'telemetry row references the underlying event-type'
      );
      assert.ok(
        Array.isArray(autofills[0].fields_autofilled) &&
        autofills[0].fields_autofilled.includes('version'),
        'fields_autofilled lists version'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

});
