#!/usr/bin/env node
'use strict';

/**
 * R-AIDER-FULL — ROLE_BUDGETS source-of-truth sync test (v2.1.17 W9-fix F-007).
 *
 * Goal: keep `bin/_lib/repo-map.js` ROLE_BUDGETS and the human-readable per-role
 * budget table in `agents/pm.md` (Section 3 "Aider-style Repo Map Token Budget")
 * byte-for-byte consistent. The PM call-site (Section 3 step 9.6) cites
 * `ROLE_BUDGETS` as the SINGLE SOURCE OF TRUTH; the table is mirror docs only.
 * If a role's budget changes in code, this test fails until pm.md catches up.
 *
 * Cross-checks:
 *   1. Every role/budget pair in ROLE_BUDGETS appears in the pm.md table with
 *      matching budget.
 *   2. Every "consuming" role row in the pm.md table (budget != 0) appears in
 *      ROLE_BUDGETS with matching budget. Roles with budget 0 in the table do
 *      NOT need to appear in ROLE_BUDGETS — the consumer treats absence as 0.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PM_MD_PATH = path.join(REPO_ROOT, 'agents', 'pm.md');

const { ROLE_BUDGETS } = require(path.join(REPO_ROOT, 'bin', '_lib', 'repo-map.js'));

/**
 * Parse the pm.md "Per-role default token budgets" table. Returns
 * {role: string -> budget: number}. Entries whose budget is non-numeric (e.g.,
 * the "(dynamic specialists)" row that says "inherits parent…") are skipped.
 */
function parsePmMdRoleTable(content) {
  // Find the table by looking for the header line.
  const headerIdx = content.indexOf('| Role        | Default budget |');
  assert.ok(headerIdx >= 0, 'pm.md must contain the per-role budget table header');
  // Slice from header to next blank line / next subsection.
  const tail = content.slice(headerIdx);
  const lines = tail.split('\n');
  const out = {};
  // Skip first 2 lines (header + separator), then read until non-pipe row.
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('|')) break;
    // | role | budget | notes |
    const cells = line.split('|').map((s) => s.trim()).filter((s, idx, arr) => {
      // Drop leading and trailing empties from leading/trailing pipes.
      if (idx === 0 && s === '') return false;
      if (idx === arr.length - 1 && s === '') return false;
      return true;
    });
    if (cells.length < 2) continue;
    const role = cells[0];
    const budgetText = cells[1];
    // Skip rows whose budget cell is non-numeric (e.g., "(dynamic specialists)").
    if (!/^\d+$/.test(budgetText)) continue;
    out[role] = parseInt(budgetText, 10);
  }
  return out;
}

describe('R-AIDER-FULL ROLE_BUDGETS source-of-truth (F-007)', () => {
  const pmContent = fs.readFileSync(PM_MD_PATH, 'utf8');
  const tableMap = parsePmMdRoleTable(pmContent);

  test('every ROLE_BUDGETS entry has a matching pm.md table row', () => {
    for (const [role, budget] of Object.entries(ROLE_BUDGETS)) {
      assert.ok(
        role in tableMap,
        `pm.md table missing row for role '${role}' (ROLE_BUDGETS has ${budget})`
      );
      assert.equal(
        tableMap[role],
        budget,
        `pm.md table budget for '${role}' (${tableMap[role]}) ` +
        `does not match ROLE_BUDGETS (${budget}). pm.md must be updated.`
      );
    }
  });

  test('every consuming role in pm.md (budget != 0) appears in ROLE_BUDGETS', () => {
    for (const [role, budget] of Object.entries(tableMap)) {
      if (budget === 0) continue; // Roles defaulting to 0 needn't appear in code.
      assert.ok(
        role in ROLE_BUDGETS,
        `pm.md table claims role '${role}' has budget ${budget}, but ` +
        `ROLE_BUDGETS in bin/_lib/repo-map.js does not include it. Add it ` +
        `to ROLE_BUDGETS (single source of truth) or remove from pm.md.`
      );
      assert.equal(
        ROLE_BUDGETS[role],
        budget,
        `pm.md table budget for '${role}' (${budget}) ` +
        `does not match ROLE_BUDGETS (${ROLE_BUDGETS[role]}).`
      );
    }
  });

  test('Section 3 step 9.6 cites ROLE_BUDGETS by name', () => {
    // Defensive: the PM's procedural step MUST cite the constant by name so a
    // reader knows where the source of truth lives. If someone rewrites step
    // 9.6 without naming `ROLE_BUDGETS`, this test catches the regression.
    const stepIdx = pmContent.indexOf('9.6.');
    assert.ok(stepIdx >= 0, 'pm.md Section 3 must contain step 9.6');
    const stepBlock = pmContent.slice(stepIdx, stepIdx + 2000);
    assert.ok(
      stepBlock.includes('ROLE_BUDGETS'),
      'pm.md step 9.6 must cite ROLE_BUDGETS by name as the source of truth'
    );
    assert.ok(
      stepBlock.includes('bin/_lib/repo-map.js'),
      'pm.md step 9.6 must reference bin/_lib/repo-map.js as the location of ROLE_BUDGETS'
    );
  });
});
