'use strict';

/**
 * t15-cross-field.js — cross-field invariant checker for T15 Structured Results.
 *
 * Introduced in v2.2.11 W2-4 to enforce semantic constraints between fields
 * that cannot be expressed as single-field presence/type checks.
 *
 * Rules enforced:
 *   R1 success_with_error_severity  — status=success AND any issues[].severity=error
 *   R2 wrote_without_reading        — files_changed.length > 0 AND files_read.length = 0
 *   R3 failure_without_issues       — status=failure AND issues.length = 0
 *
 * Contract: NEVER throws. Malformed or missing input → fail-open: {valid:true, violations:[]}.
 */

/**
 * @typedef {{ field: string, rule: string, expected: string, actual: string }} Violation
 * @typedef {{ valid: boolean, violations: Violation[] }} CrossFieldResult
 */

/**
 * Validate cross-field invariants in a Structured Result.
 *
 * @param {unknown} structuredResult
 * @returns {CrossFieldResult}
 */
function validateCrossField(structuredResult) {
  try {
    // Fail-open on non-object or null input.
    if (!structuredResult || typeof structuredResult !== 'object' || Array.isArray(structuredResult)) {
      return { valid: true, violations: [] };
    }

    const violations = [];
    const status = structuredResult.status;
    const issues = structuredResult.issues;
    const filesChanged = structuredResult.files_changed;
    const filesRead = structuredResult.files_read;

    // R1: success_with_error_severity
    // status === "success" AND any issues[].severity === "error"
    if (
      typeof status === 'string' &&
      status === 'success' &&
      Array.isArray(issues)
    ) {
      const hasErrorSeverity = issues.some(
        issue => issue && typeof issue === 'object' && issue.severity === 'error'
      );
      if (hasErrorSeverity) {
        violations.push({
          field: 'issues[].severity',
          rule: 'success_with_error_severity',
          expected: 'no severity:"error" entries when status is "success"',
          actual: 'found at least one issues entry with severity:"error"',
        });
      }
    }

    // R2: wrote_without_reading
    // files_changed.length > 0 AND files_read.length === 0
    if (Array.isArray(filesChanged) && Array.isArray(filesRead)) {
      if (filesChanged.length > 0 && filesRead.length === 0) {
        violations.push({
          field: 'files_read',
          rule: 'wrote_without_reading',
          expected: 'non-empty files_read when files_changed is non-empty (CRITIC evidence)',
          actual: 'files_read is empty while files_changed has ' + filesChanged.length + ' entr' +
            (filesChanged.length === 1 ? 'y' : 'ies'),
        });
      }
    }

    // R3: failure_without_issues
    // status === "failure" AND issues.length === 0
    if (
      typeof status === 'string' &&
      status === 'failure' &&
      Array.isArray(issues) &&
      issues.length === 0
    ) {
      violations.push({
        field: 'issues',
        rule: 'failure_without_issues',
        expected: 'at least one issue entry when status is "failure"',
        actual: 'issues array is empty',
      });
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  } catch (_err) {
    // Fail-open: any unexpected error returns valid so the hook is never broken
    // by a malformed input shape we did not anticipate.
    return { valid: true, violations: [] };
  }
}

module.exports = { validateCrossField };
