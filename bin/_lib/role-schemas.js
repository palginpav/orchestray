'use strict';

/**
 * role-schemas.js — per-role Structured Result field requirements (v2.2.9 B-2.1).
 *
 * Imported by bin/validate-task-completion.js.
 *
 * Each role entry may have:
 *   required_extra   — field names that MUST be present (in addition to the
 *                      5 base fields enforced by HANDOFF_REQUIRED_SECTIONS).
 *   enums            — {fieldName: [...allowed values]}  checked when present.
 *   min_count        — {fieldName: N}  field must be array with length >= N.
 *   output_regex     — RegExp the full agent output must match (project-intent).
 *   cross_check      — human-readable description of a semantic constraint
 *                      that cannot be expressed as a simple field check; used
 *                      only in error messages.
 *
 * Kill switches: ORCHESTRAY_T15_<ROLE_UPPER>_HARD_DISABLED=1 disables hard-reject
 * for a specific role.  ROLE_UPPER = role name upper-cased, hyphens → underscores.
 *   e.g. ORCHESTRAY_T15_SECURITY_ENGINEER_HARD_DISABLED=1
 */

const ROLE_SCHEMAS = {
  architect: {
    required_extra: ['design_doc_path', 'acceptance_rubric'],
  },
  developer: {
    required_extra: ['files_read', 'self_check_passed', 'tests_added_or_existing'],
    enums: { self_check_passed: ['true', 'false', true, false] },
    // CRITIC evidence: if files_changed is non-empty, files_read must also be non-empty.
    // Checked inline in the validator (not expressible as a simple field rule).
    files_changed_implies: { files_read_non_empty: true },
  },
  reviewer: {
    required_extra: ['verdict', 'rubric_scores', 'always_on_dimensions'],
    enums: { verdict: ['approve', 'request-changes', 'block'] },
    // If files_changed is present and non-empty, issues must have at least one entry.
    files_changed_implies: { issues_must_have_one: true },
  },
  debugger: {
    required_extra: ['root_cause', 'repro_confirmed', 'fix_location_hint'],
  },
  tester: {
    required_extra: ['test_suite_result', 'test_plan_block_present'],
  },
  documenter: {
    required_extra: ['canonical_source_checked'],
  },
  refactorer: {
    required_extra: ['behavior_preserved', 'plan_block', 'test_baseline_post_diff'],
  },
  inventor: {
    required_extra: ['verdict', 'prototype_executed'],
    enums: { verdict: ['novel', 'incremental', 'rejected'] },
    sections_required: ['## Phase 1', '## Phase 2', '## Phase 3', '## Phase 4', '## Phase 5', '## Phase 6'],
  },
  'security-engineer': {
    required_extra: ['threats_found', 'severity_breakdown', 'security_mode'],
    enums: { security_mode: ['design', 'implementation'] },
  },
  'release-manager': {
    required_extra: ['version_parity_checked', 'changelog_user_readable'],
  },
  'ux-critic': {
    required_extra: ['surfaces_reviewed', 'personas_used', 'findings_count'],
  },
  'platform-oracle': {
    required_extra: ['claims', 'webfetch_urls'],
    cross_check: 'claims[].source_url must be subset of observed WebFetch URLs',
  },
  researcher: {
    required_extra: ['sources_cited'],
    min_count: { sources_cited: 3 },
  },
  'project-intent': {
    // B-2.1.b: locked output format regex.
    // The agent output must begin with the canonical Project Intent heading structure.
    output_regex: /# Project Intent[\s\S]*## Domain[\s\S]*## Constraints[\s\S]*## Tech Stack/,
  },
};

/**
 * Return the kill-switch env var name for a given role.
 *
 * @param {string} role - e.g. 'security-engineer'
 * @returns {string} - e.g. 'ORCHESTRAY_T15_SECURITY_ENGINEER_HARD_DISABLED'
 */
function killSwitchEnvVar(role) {
  return 'ORCHESTRAY_T15_' + role.toUpperCase().replace(/-/g, '_') + '_HARD_DISABLED';
}

/**
 * Is the per-role hard-reject disabled for this role?
 *
 * @param {string} role
 * @returns {boolean}
 */
function isRoleHardDisabled(role) {
  return process.env[killSwitchEnvVar(role)] === '1';
}

/**
 * Validate a Structured Result against the per-role schema for `role`.
 *
 * Returns an array of violation strings (empty = valid).
 * Also checks the raw output string when schema.output_regex is set.
 *
 * @param {string} role
 * @param {object|null} result - Parsed Structured Result JSON.
 * @param {string} [rawOutput] - Full raw agent output (for output_regex check).
 * @returns {string[]} violations
 */
function validateRoleSchema(role, result, rawOutput) {
  const schema = ROLE_SCHEMAS[role];
  if (!schema) return []; // Unknown role — no per-role requirements.

  const violations = [];

  // --- output_regex check (project-intent) ---
  if (schema.output_regex && typeof rawOutput === 'string') {
    if (!schema.output_regex.test(rawOutput)) {
      violations.push(
        'output_regex: agent output must match ' + schema.output_regex.toString().slice(0, 80)
      );
    }
  }

  // No structured result to check further.
  if (!result || typeof result !== 'object') {
    if (schema.required_extra && schema.required_extra.length > 0) {
      for (const f of schema.required_extra) violations.push('missing_field:' + f);
    }
    return violations;
  }

  // --- required_extra fields ---
  if (schema.required_extra) {
    for (const field of schema.required_extra) {
      if (!(field in result)) {
        violations.push('missing_field:' + field);
      }
    }
  }

  // --- enum checks ---
  if (schema.enums) {
    for (const [field, allowed] of Object.entries(schema.enums)) {
      if (field in result) {
        const val = result[field];
        if (!allowed.includes(val)) {
          violations.push(
            'enum_violation:' + field + '="' + String(val) + '" not in [' + allowed.join('|') + ']'
          );
        }
      }
    }
  }

  // --- min_count checks ---
  if (schema.min_count) {
    for (const [field, minN] of Object.entries(schema.min_count)) {
      if (field in result) {
        const val = result[field];
        const len = Array.isArray(val) ? val.length : 0;
        if (len < minN) {
          violations.push(
            'min_count:' + field + ' requires >=' + minN + ' items, got ' + len
          );
        }
      }
    }
  }

  // --- files_changed_implies: developer CRITIC evidence ---
  if (schema.files_changed_implies) {
    const fc = result.files_changed;
    const fr = result.files_read;
    const fcNonEmpty = Array.isArray(fc) && fc.length > 0;

    if (schema.files_changed_implies.files_read_non_empty && fcNonEmpty) {
      if (!Array.isArray(fr) || fr.length === 0) {
        violations.push(
          'critic_evidence: files_changed is non-empty but files_read is empty — CRITIC evidence required'
        );
      }
    }

    if (schema.files_changed_implies.issues_must_have_one && fcNonEmpty) {
      const issues = result.issues;
      if (!Array.isArray(issues) || issues.length === 0) {
        violations.push(
          'issues_required: reviewer files_changed is non-empty but issues array is empty'
        );
      }
    }
  }

  return violations;
}

module.exports = {
  ROLE_SCHEMAS,
  killSwitchEnvVar,
  isRoleHardDisabled,
  validateRoleSchema,
};
