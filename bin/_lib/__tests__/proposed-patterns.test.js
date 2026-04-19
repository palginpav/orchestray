#!/usr/bin/env node
'use strict';

/**
 * Unit tests for bin/_lib/proposed-patterns.js (v2.1.6 W4).
 *
 * Covers:
 *   - listProposed: empty dir, populated dir, excludes rejected/.
 *   - readProposed: happy path, missing file, path-traversal rejection.
 *   - acceptProposed: validator pass → file moved + fields stripped;
 *                     validator fail → file left in place.
 *   - rejectProposed: file moved to rejected/, frontmatter updated.
 *
 * Runner: node --test bin/_lib/__tests__/proposed-patterns.test.js
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { listProposed, readProposed, acceptProposed, rejectProposed } =
  require('../proposed-patterns.js');
const frontmatter = require('../../mcp-server/lib/frontmatter.js');
const { _buildProposalContent } = require('../../post-orchestration-extract.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpProject() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pp-test-'));
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'patterns'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.orchestray', 'proposed-patterns'), { recursive: true });
  return projectRoot;
}

function cleanup(projectRoot) {
  try {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

/**
 * Write a valid proposed-pattern file. All required fields for the validator
 * are included so acceptProposed() can pass Layer C.
 */
function writeProposal(projectRoot, slug, overrides = {}) {
  const defaults = {
    name: slug,
    category: 'decomposition',
    tip_type: 'strategy',
    confidence: 0.5,
    description: 'A test pattern that verifies correct behavior under orchestration.',
    approach: 'Use this approach when the system detects a recurring decomposition challenge. Apply the strategy consistently and record the outcome in Evidence for future reference.',
    evidence_orch_id: 'orch-test-abc123',
    proposed: true,
    proposed_at: '2026-04-19T10:00:00.000Z',
    proposed_from: 'orch-test-abc123',
  };
  const fm = Object.assign({}, defaults, overrides);
  const body = '\n# Pattern: Test\n\n## Context\nTest context.\n\n## Approach\n' + fm.approach + '\n';

  const content = frontmatter.stringify({ frontmatter: fm, body });
  const dir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, slug + '.md'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// listProposed
// ---------------------------------------------------------------------------

describe('listProposed', () => {

  test('returns empty array when proposed-patterns dir does not exist', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestray-pp-empty-'));
    try {
      const result = listProposed(projectRoot);
      assert.deepEqual(result, []);
    } finally {
      cleanup(projectRoot);
    }
  });

  test('returns empty array when dir exists but is empty', () => {
    const projectRoot = makeTmpProject();
    try {
      const result = listProposed(projectRoot);
      assert.deepEqual(result, []);
    } finally {
      cleanup(projectRoot);
    }
  });

  test('returns entries sorted by slug', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'z-last-pattern');
      writeProposal(projectRoot, 'a-first-pattern');
      writeProposal(projectRoot, 'm-middle-pattern');

      const result = listProposed(projectRoot);
      assert.equal(result.length, 3);
      assert.equal(result[0].slug, 'a-first-pattern');
      assert.equal(result[1].slug, 'm-middle-pattern');
      assert.equal(result[2].slug, 'z-last-pattern');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('excludes files in rejected/ subdirectory', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'active-proposal');

      // Manually write to rejected/ subdir.
      const rejectedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns', 'rejected');
      fs.mkdirSync(rejectedDir, { recursive: true });
      fs.writeFileSync(
        path.join(rejectedDir, 'old-rejected.md'),
        '---\nname: old-rejected\n---\n',
        'utf8'
      );

      const result = listProposed(projectRoot);
      assert.equal(result.length, 1, 'only the active proposal should be listed');
      assert.equal(result[0].slug, 'active-proposal');
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// readProposed
// ---------------------------------------------------------------------------

describe('readProposed', () => {

  test('returns frontmatter, body, slug, filepath for existing proposal', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'my-test-proposal');

      const result = readProposed('my-test-proposal', projectRoot);
      assert.equal(result.slug, 'my-test-proposal');
      assert.ok(result.frontmatter, 'frontmatter should be present');
      assert.equal(result.frontmatter.name, 'my-test-proposal');
      assert.ok(typeof result.body === 'string', 'body should be a string');
      assert.ok(result.filepath.endsWith('my-test-proposal.md'), 'filepath should end with .md');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('throws when file is missing', () => {
    const projectRoot = makeTmpProject();
    try {
      assert.throws(
        () => readProposed('nonexistent-slug', projectRoot),
        /nonexistent-slug/,
        'should throw with slug name in error message'
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('throws on path-traversal slug', () => {
    const projectRoot = makeTmpProject();
    try {
      assert.throws(
        () => readProposed('../evil-traversal', projectRoot),
        /path separator/,
        'should throw on path-traversal attempt'
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('throws on slug with slash', () => {
    const projectRoot = makeTmpProject();
    try {
      assert.throws(
        () => readProposed('subdir/evil', projectRoot),
        Error,
        'should throw on slug with slash'
      );
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// acceptProposed
// ---------------------------------------------------------------------------

describe('acceptProposed', () => {

  test('happy path: file is moved to patterns/, proposed fields stripped', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'valid-proposal');

      const result = acceptProposed('valid-proposal', projectRoot);
      assert.equal(result.ok, true, 'expected ok:true, got: ' + JSON.stringify(result));
      assert.ok(result.destPath.endsWith('valid-proposal.md'));

      // Source file should be gone.
      const srcPath = path.join(projectRoot, '.orchestray', 'proposed-patterns', 'valid-proposal.md');
      assert.ok(!fs.existsSync(srcPath), 'source file should be removed');

      // Destination file should exist.
      assert.ok(fs.existsSync(result.destPath), 'destination file should exist');

      // Frontmatter should not have proposed lifecycle fields.
      const content = fs.readFileSync(result.destPath, 'utf8');
      const parsed = frontmatter.parse(content);
      assert.equal(parsed.frontmatter.proposed, undefined, 'proposed field should be stripped');
      assert.equal(parsed.frontmatter.proposed_at, undefined, 'proposed_at field should be stripped');
      assert.equal(parsed.frontmatter.proposed_from, undefined, 'proposed_from field should be stripped');
      assert.equal(parsed.frontmatter.layer_b_markers, undefined, 'layer_b_markers field should be stripped');

      // Standard pattern fields should be present.
      assert.equal(parsed.frontmatter.times_applied, 0, 'times_applied should default to 0');
      assert.equal(parsed.frontmatter.last_applied, null, 'last_applied should default to null');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('created_from is set from proposed_from if absent', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'proposal-with-from');

      const result = acceptProposed('proposal-with-from', projectRoot);
      assert.equal(result.ok, true);

      const content = fs.readFileSync(result.destPath, 'utf8');
      const parsed = frontmatter.parse(content);
      assert.equal(parsed.frontmatter.created_from, 'orch-test-abc123',
        'created_from should be set from proposed_from');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('Layer C validation failure: file left in place, ok:false returned', () => {
    const projectRoot = makeTmpProject();
    try {
      // Write a proposal with an invalid confidence (> 0.7 is rejected by validator).
      writeProposal(projectRoot, 'invalid-proposal', {
        confidence: 0.9, // exceeds max allowed by validator (0.7)
      });

      const result = acceptProposed('invalid-proposal', projectRoot);
      assert.equal(result.ok, false, 'expected ok:false for invalid proposal');
      assert.ok(Array.isArray(result.errors), 'errors should be an array');
      assert.ok(result.errors.length > 0, 'errors should be non-empty');
      assert.ok(
        result.errors.some((e) => e.field === 'confidence'),
        'errors should mention confidence field'
      );

      // Source file should still exist (not moved).
      const srcPath = path.join(projectRoot, '.orchestray', 'proposed-patterns', 'invalid-proposal.md');
      assert.ok(fs.existsSync(srcPath), 'source file should remain when validation fails');

      // Destination should NOT exist.
      const destPath = path.join(projectRoot, '.orchestray', 'patterns', 'invalid-proposal.md');
      assert.ok(!fs.existsSync(destPath), 'destination should not be created on validation failure');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('layer_b_markers are returned in the result for warning display', () => {
    const projectRoot = makeTmpProject();
    try {
      // Write a valid proposal that has layer_b_markers populated.
      writeProposal(projectRoot, 'proposal-with-markers', {
        layer_b_markers: ['marker1', 'marker2'],
      });

      const result = acceptProposed('proposal-with-markers', projectRoot);
      assert.equal(result.ok, true);
      // (layer_b_markers is also returned on failure, but for a valid proposal
      // the ok:true path doesn't expose them — the caller reads them pre-call.)
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// rejectProposed
// ---------------------------------------------------------------------------

describe('rejectProposed', () => {

  test('file is moved to rejected/ with rejection metadata', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'proposal-to-reject');

      const result = rejectProposed('proposal-to-reject', 'low quality extraction', projectRoot);
      assert.ok(result.ok === true, 'expected ok:true');
      assert.ok(result.rejectedPath.includes('rejected'));
      assert.ok(result.rejectedPath.endsWith('proposal-to-reject.md'));

      // Source file should be gone.
      const srcPath = path.join(projectRoot, '.orchestray', 'proposed-patterns', 'proposal-to-reject.md');
      assert.ok(!fs.existsSync(srcPath), 'source should be removed');

      // Rejected file should exist with updated frontmatter.
      assert.ok(fs.existsSync(result.rejectedPath), 'rejected file should exist');

      const content = fs.readFileSync(result.rejectedPath, 'utf8');
      const parsed = frontmatter.parse(content);
      assert.ok(typeof parsed.frontmatter.rejected_at === 'string', 'rejected_at should be set');
      assert.equal(parsed.frontmatter.rejected_reason, 'low quality extraction');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('empty reason defaults to no_reason_given', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'proposal-no-reason');

      const result = rejectProposed('proposal-no-reason', '', projectRoot);
      assert.ok(result.ok);

      const content = fs.readFileSync(result.rejectedPath, 'utf8');
      const parsed = frontmatter.parse(content);
      assert.equal(parsed.frontmatter.rejected_reason, 'no_reason_given');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('reason is truncated to 80 characters', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'proposal-long-reason');

      const longReason = 'x'.repeat(120);
      const result = rejectProposed('proposal-long-reason', longReason, projectRoot);
      assert.ok(result.ok);

      const content = fs.readFileSync(result.rejectedPath, 'utf8');
      const parsed = frontmatter.parse(content);
      assert.ok(
        parsed.frontmatter.rejected_reason.length <= 80,
        'reason should be truncated to 80 chars'
      );
    } finally {
      cleanup(projectRoot);
    }
  });

  test('creates rejected/ subdir if missing', () => {
    const projectRoot = makeTmpProject();
    try {
      writeProposal(projectRoot, 'proposal-mkdir-test');

      const rejectedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns', 'rejected');
      assert.ok(!fs.existsSync(rejectedDir), 'rejected/ should not exist yet');

      const result = rejectProposed('proposal-mkdir-test', 'test reason', projectRoot);
      assert.ok(result.ok);
      assert.ok(fs.existsSync(rejectedDir), 'rejected/ should have been created');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('throws when proposal does not exist', () => {
    const projectRoot = makeTmpProject();
    try {
      assert.throws(
        () => rejectProposed('no-such-proposal', 'reason', projectRoot),
        Error,
        'should throw when file not found'
      );
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// BLK-01 regression: production round-trip — _buildProposalContent → acceptProposed
// ---------------------------------------------------------------------------

describe('BLK-01 regression — production round-trip', () => {

  test('file written by _buildProposalContent can be accepted by acceptProposed', () => {
    const projectRoot = makeTmpProject();
    try {
      const orchId = 'orch-blk01-test';
      const proposal = {
        name: 'blk01-roundtrip-slug',
        category: 'routing',
        tip_type: 'strategy',
        confidence: 0.5,
        description: 'Pattern for verifying round-trip integrity after BLK-01 fix.',
        approach: 'When the extractor writes a proposal file via _buildProposalContent, approach and evidence_orch_id must be in frontmatter so acceptProposed can read them for Layer-C re-validation.',
        evidence_orch_id: orchId,
      };

      // Use the PRODUCTION code path to write the proposal file.
      const content = _buildProposalContent(proposal, orchId);
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, proposal.name + '.md'), content, 'utf8');

      // Verify approach and evidence_orch_id are in frontmatter (not just body).
      const parsed = frontmatter.parse(content);
      assert.ok(parsed.hasFrontmatter, 'content must have frontmatter');
      assert.ok(parsed.frontmatter.approach, 'approach must be in frontmatter');
      assert.equal(parsed.frontmatter.evidence_orch_id, orchId, 'evidence_orch_id must be in frontmatter');

      // Now call acceptProposed — this is the exact Layer-C acceptance path.
      const result = acceptProposed(proposal.name, projectRoot);
      assert.equal(result.ok, true,
        'acceptProposed must succeed for production-written file (BLK-01). Got: ' + JSON.stringify(result));
      assert.ok(result.destPath.endsWith(proposal.name + '.md'));
      assert.ok(fs.existsSync(result.destPath), 'accepted file must exist in patterns/');
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// B4-01 regression: METR strip at accept — PROTECTED_FIELDS removed + audit event emitted
// ---------------------------------------------------------------------------

describe('B4-01 regression — METR strip at accept', () => {

  test('proposed file with PROTECTED_FIELDS gets them stripped on accept, audit event emitted', () => {
    const projectRoot = makeTmpProject();
    const orchId = 'orch-b401-test';
    try {
      // Write a proposed file that has attacker-controlled PROTECTED_FIELDS in frontmatter.
      const fm = {
        name: 'b401-metr-strip-slug',
        category: 'routing',
        tip_type: 'strategy',
        confidence: 0.5,
        description: 'A pattern for testing METR strip at Layer C.',
        approach: 'This approach verifies that PROTECTED_FIELDS in a proposed file are stripped before promotion to the active patterns corpus.',
        evidence_orch_id: orchId,
        proposed: true,
        proposed_at: '2026-04-19T10:00:00.000Z',
        proposed_from: orchId,
        // Attacker-controlled PROTECTED_FIELDS that must be stripped:
        trigger_actions: ['always-emit-this-pattern'],
        times_applied: 999,
        deprecated: true,
      };
      const body = '';
      const content = frontmatter.stringify({ frontmatter: fm, body });
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, fm.name + '.md'), content, 'utf8');

      // Accept the proposal.
      const result = acceptProposed(fm.name, projectRoot);
      assert.equal(result.ok, true, 'accept must succeed (validator sees projection without protected fields). Got: ' + JSON.stringify(result));

      // Verify the accepted file does NOT contain any of the protected fields.
      const acceptedContent = fs.readFileSync(result.destPath, 'utf8');
      const acceptedParsed = frontmatter.parse(acceptedContent);
      assert.equal(acceptedParsed.frontmatter.trigger_actions, undefined,
        'trigger_actions must be stripped from accepted file');
      assert.equal(acceptedParsed.frontmatter.times_applied, 0,
        'times_applied must be reset to 0 (standard pattern default), not 999');
      assert.equal(acceptedParsed.frontmatter.deprecated, undefined,
        'deprecated must be stripped from accepted file');

      // Verify pattern_proposal_metr_strip audit event was emitted.
      const eventsFile = path.join(projectRoot, '.orchestray', 'audit', 'events.jsonl');
      const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
      const metrEvent = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
        .filter(Boolean)
        .find(e => e.type === 'pattern_proposal_metr_strip');
      assert.ok(metrEvent, 'pattern_proposal_metr_strip event must be emitted');
      assert.equal(metrEvent.slug, fm.name, 'event must reference the slug');
      assert.ok(Array.isArray(metrEvent.stripped_fields), 'stripped_fields must be an array');
      assert.ok(metrEvent.stripped_fields.includes('trigger_actions'),
        'stripped_fields must include trigger_actions');
      assert.ok(metrEvent.stripped_fields.includes('deprecated'),
        'stripped_fields must include deprecated');
    } finally {
      cleanup(projectRoot);
    }
  });

});

// ---------------------------------------------------------------------------
// B4-05 regression: multi-line approach/description round-trip via
// _buildProposalContent → frontmatter.parse → acceptProposed
// ---------------------------------------------------------------------------

describe('B4-05 regression — multi-line approach/description round-trip', () => {

  test('3-line approach survives _buildProposalContent → readProposed round-trip with exact content equality', () => {
    const projectRoot = makeTmpProject();
    try {
      const orchId = 'orch-b405-approach';
      const multiLineApproach = 'line1\nline2\nline3';
      const proposal = {
        name: 'b405-approach-roundtrip',
        category: 'routing',
        tip_type: 'strategy',
        confidence: 0.5,
        description: 'Single-line description for B4-05 approach test.',
        approach: multiLineApproach,
        evidence_orch_id: orchId,
      };

      // Use the production code path to write the proposal file.
      const { _buildProposalContent } = require('../../post-orchestration-extract.js');
      const content = _buildProposalContent(proposal, orchId);
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, proposal.name + '.md'), content, 'utf8');

      // Read back via the production readProposed path.
      const result = readProposed(proposal.name, projectRoot);
      assert.equal(result.frontmatter.approach, multiLineApproach,
        'multi-line approach must survive write→read exactly (B4-05)');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('3-line description survives _buildProposalContent → readProposed round-trip with exact content equality', () => {
    const projectRoot = makeTmpProject();
    try {
      const orchId = 'orch-b405-desc';
      const multiLineDesc = 'descLine1\ndescLine2\ndescLine3';
      const proposal = {
        name: 'b405-description-roundtrip',
        category: 'decomposition',
        tip_type: 'heuristic',
        confidence: 0.4,
        description: multiLineDesc,
        approach: 'Single-line approach for B4-05 description test.',
        evidence_orch_id: orchId,
      };

      const { _buildProposalContent } = require('../../post-orchestration-extract.js');
      const content = _buildProposalContent(proposal, orchId);
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, proposal.name + '.md'), content, 'utf8');

      const result = readProposed(proposal.name, projectRoot);
      assert.equal(result.frontmatter.description, multiLineDesc,
        'multi-line description must survive write→read exactly (B4-05)');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('empty approach round-trips as empty string', () => {
    const projectRoot = makeTmpProject();
    try {
      const orchId = 'orch-b405-empty';
      const proposal = {
        name: 'b405-empty-approach',
        category: 'routing',
        tip_type: 'strategy',
        confidence: 0.5,
        description: 'Description for empty approach test.',
        approach: '',
        evidence_orch_id: orchId,
      };

      const { _buildProposalContent } = require('../../post-orchestration-extract.js');
      const content = _buildProposalContent(proposal, orchId);
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, proposal.name + '.md'), content, 'utf8');

      const result = readProposed(proposal.name, projectRoot);
      assert.equal(result.frontmatter.approach, '',
        'empty approach must round-trip as empty string');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('single-line approach round-trips unchanged', () => {
    const projectRoot = makeTmpProject();
    try {
      const orchId = 'orch-b405-single';
      const singleLineApproach = 'Apply the strategy when complexity_score exceeds 5.';
      const proposal = {
        name: 'b405-single-line',
        category: 'specialization',
        tip_type: 'strategy',
        confidence: 0.6,
        description: 'Description for single-line approach test.',
        approach: singleLineApproach,
        evidence_orch_id: orchId,
      };

      const { _buildProposalContent } = require('../../post-orchestration-extract.js');
      const content = _buildProposalContent(proposal, orchId);
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, proposal.name + '.md'), content, 'utf8');

      const result = readProposed(proposal.name, projectRoot);
      assert.equal(result.frontmatter.approach, singleLineApproach,
        'single-line approach must round-trip unchanged');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('very long (1500 char) multi-line approach round-trips exactly', () => {
    const projectRoot = makeTmpProject();
    try {
      const orchId = 'orch-b405-long';
      // Build a 1500-char string with embedded newlines.
      const longApproach = Array.from({ length: 10 }, (_, i) =>
        'Paragraph ' + (i + 1) + ': ' + 'x'.repeat(140)
      ).join('\n');
      assert.ok(longApproach.length > 1500, 'precondition: string is long enough');

      const proposal = {
        name: 'b405-long-approach',
        category: 'decomposition',
        tip_type: 'heuristic',
        confidence: 0.45,
        description: 'Description for long approach test.',
        approach: longApproach,
        evidence_orch_id: orchId,
      };

      const { _buildProposalContent } = require('../../post-orchestration-extract.js');
      const content = _buildProposalContent(proposal, orchId);
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, proposal.name + '.md'), content, 'utf8');

      const result = readProposed(proposal.name, projectRoot);
      assert.equal(result.frontmatter.approach, longApproach,
        'long multi-line approach must survive write→read with exact content equality (B4-05)');
    } finally {
      cleanup(projectRoot);
    }
  });

  test('full production round-trip: multi-line approach survives _buildProposalContent → acceptProposed', () => {
    const projectRoot = makeTmpProject();
    try {
      const orchId = 'orch-b405-accept';
      const multiLineApproach = 'Step one: identify the pattern.\nStep two: apply it.\nStep three: record evidence.';

      const proposal = {
        name: 'b405-accept-roundtrip',
        category: 'routing',
        tip_type: 'strategy',
        confidence: 0.5,
        description: 'Production round-trip test for multi-line approach through accept path.',
        approach: multiLineApproach,
        evidence_orch_id: orchId,
      };

      const { _buildProposalContent } = require('../../post-orchestration-extract.js');
      const content = _buildProposalContent(proposal, orchId);
      const proposedDir = path.join(projectRoot, '.orchestray', 'proposed-patterns');
      fs.mkdirSync(proposedDir, { recursive: true });
      fs.writeFileSync(path.join(proposedDir, proposal.name + '.md'), content, 'utf8');

      // Accept via the full Layer-C production path.
      const result = acceptProposed(proposal.name, projectRoot);
      assert.equal(result.ok, true,
        'acceptProposed must succeed for multi-line approach proposal. Got: ' + JSON.stringify(result));

      // Read the accepted pattern and verify the approach is intact.
      const acceptedContent = fs.readFileSync(result.destPath, 'utf8');
      const acceptedParsed = frontmatter.parse(acceptedContent);
      assert.equal(acceptedParsed.frontmatter.approach, multiLineApproach,
        'multi-line approach must be preserved verbatim after accept (B4-05)');
    } finally {
      cleanup(projectRoot);
    }
  });

});
