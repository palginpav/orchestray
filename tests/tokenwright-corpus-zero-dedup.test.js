'use strict';

/**
 * tokenwright-corpus-zero-dedup.test.js
 *
 * Fixture-based regression test: runs the classifier pipeline over a set of
 * representative production prompts and asserts that NO section is classified
 * as `dedup-eligible` or `score-eligible`.
 *
 * These fixtures are representative of the 477-prompt corpus audited in v2.2.20.
 * The audit found 0/477 prompts containing any heading in DEDUP_ELIGIBLE_HEADINGS
 * or SCORE_ELIGIBLE_HEADINGS (all `prompt_compression` events showed dedup_eligible: 0).
 *
 * If this test fails, the corpus has drifted — re-audit per
 * .orchestray/kb/artifacts/v2220-l1-revival-design.md before flipping the kill switch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { parseSections } = require(path.join(__dirname, '../bin/_lib/tokenwright/parse-sections.js'));
const { classifySection } = require(path.join(__dirname, '../bin/_lib/tokenwright/classify-section.js'));

// ---------------------------------------------------------------------------
// Representative fixture prompts (extracted from production corpus).
// These capture the typical heading set seen across developer, reviewer,
// architect, and researcher agent types. All use H2 headings (## ).
// ---------------------------------------------------------------------------

const FIXTURE_PROMPTS = [
  // Fixture 1: developer agent prompt (typical structure)
  `You are a senior software developer. Implement the following changes.

## Task Description — W4 §B1 verify-load-bearing

Add post-compression invariant check to inject-tokenwright.js.

## Acceptance Rubric

All load-bearing sections must survive compression byte-identical.

## Structured Result

Return JSON: { status, summary, files_changed, files_read, issues, assumptions }.

## Output Style

Terse. No trailing summaries.

## Context from Previous Agent

Architect designed the invariant check in v2.2.6-design.md.
`,

  // Fixture 2: reviewer agent prompt (multi-section structure)
  `You are a code reviewer. Review the changes below.

## Goal

Identify correctness, security, and operability issues in the tokenwright L1 pipeline.

## Constraints

- Read-only. Do not edit files.
- Report findings with severity (critical/warning/info).

## Repository Map

bin/_lib/tokenwright/classify-section.js
bin/_lib/tokenwright/dedup-minhash.js
bin/inject-tokenwright.js

## Acceptance Rubric

At least one finding per file reviewed.

## Structured Result

Return JSON per handoff-contract.md.
`,

  // Fixture 3: architect agent prompt (design task)
  `You are an architect. Design the L1 compression revival approach.

## Mission

Determine whether to revive tokenwright.l1_compression_enabled after the v2.2.19 kill.

## Output

Produce a design document at .orchestray/kb/artifacts/v2220-l1-revival-design.md.

## Handoff Contract

Hand off to developer T5 with explicit heading additions list and config posture plan.

## Project Intent

Orchestray is a Claude Code plugin. Maximize token efficiency across agent spawns.

## Acceptance Rubric

Design document must include: corpus audit results, heading additions list, default-flip verdict.

## Structured Result

{ status: "complete", summary: "...", files_changed: [...], ... }
`,

  // Fixture 4: researcher agent prompt (survey task)
  `You are a researcher surveying prior art.

## Goal

Survey MinHash dedup approaches for short prompt blocks (1–10 KB).

## Constraints

- Time-box to 30 minutes.
- Prefer approaches with pure-Node implementations.

## Output

Decision-ready shortlist of 2–3 candidate approaches.

## Acceptance Rubric

Each candidate must include: name, dependencies, per-block cost, Jaccard threshold range.

## Structured Result

{ status, summary, files_read, issues, assumptions }
`,

  // Fixture 5: debugger agent prompt (investigation task)
  `You are a debugger. Investigate why prompt_compression events show dedup_eligible: 0.

## Mission

Root-cause the zero-dedup observation across 141 prompt_compression events.

## Constraints

- Read-only. Do not modify production files.
- Reproduce from events.jsonl and source code alone.

## Output

Root cause analysis with supporting evidence.

## Acceptance Rubric

Must identify the heading mismatch or confirm the list is intentionally empty.

## Structured Result

Return JSON with status, root_cause, evidence, recommendations.
`,
];

// ---------------------------------------------------------------------------
// Helper: run the classifier pipeline over a prompt string.
// Returns { dedupEligibleCount, scoreEligibleCount, headingsSeen }.
// ---------------------------------------------------------------------------
function classifyPrompt(promptText) {
  const sections = parseSections(promptText);
  let dedupEligibleCount = 0;
  let scoreEligibleCount = 0;
  const headingsSeen = [];

  for (const section of sections) {
    const result = classifySection(section);
    if (section.heading !== null) {
      headingsSeen.push({ heading: section.heading, kind: result.kind });
    }
    if (result.kind === 'dedup-eligible') dedupEligibleCount++;
    if (result.kind === 'score-eligible') scoreEligibleCount++;
  }

  return { dedupEligibleCount, scoreEligibleCount, headingsSeen };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('corpus zero-dedup: fixture 1 (developer) has 0 dedup-eligible sections', () => {
  const { dedupEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[0]);
  assert.equal(dedupEligibleCount, 0,
    'dedup-eligible count must be 0 — if this fails, re-audit per v2220-l1-revival-design.md');
});

test('corpus zero-dedup: fixture 1 (developer) has 0 score-eligible sections', () => {
  const { scoreEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[0]);
  assert.equal(scoreEligibleCount, 0,
    'score-eligible count must be 0 — if this fails, re-audit per v2220-l1-revival-design.md');
});

test('corpus zero-dedup: fixture 2 (reviewer) has 0 dedup-eligible sections', () => {
  const { dedupEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[1]);
  assert.equal(dedupEligibleCount, 0);
});

test('corpus zero-dedup: fixture 2 (reviewer) has 0 score-eligible sections', () => {
  const { scoreEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[1]);
  assert.equal(scoreEligibleCount, 0);
});

test('corpus zero-dedup: fixture 3 (architect) has 0 dedup-eligible sections', () => {
  const { dedupEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[2]);
  assert.equal(dedupEligibleCount, 0);
});

test('corpus zero-dedup: fixture 3 (architect) has 0 score-eligible sections', () => {
  const { scoreEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[2]);
  assert.equal(scoreEligibleCount, 0);
});

test('corpus zero-dedup: fixture 4 (researcher) has 0 dedup-eligible sections', () => {
  const { dedupEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[3]);
  assert.equal(dedupEligibleCount, 0);
});

test('corpus zero-dedup: fixture 4 (researcher) has 0 score-eligible sections', () => {
  const { scoreEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[3]);
  assert.equal(scoreEligibleCount, 0);
});

test('corpus zero-dedup: fixture 5 (debugger) has 0 dedup-eligible sections', () => {
  const { dedupEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[4]);
  assert.equal(dedupEligibleCount, 0);
});

test('corpus zero-dedup: fixture 5 (debugger) has 0 score-eligible sections', () => {
  const { scoreEligibleCount } = classifyPrompt(FIXTURE_PROMPTS[4]);
  assert.equal(scoreEligibleCount, 0);
});

test('corpus zero-dedup: ALL fixtures combined have 0 dedup-eligible sections', () => {
  let total = 0;
  for (const prompt of FIXTURE_PROMPTS) {
    const { dedupEligibleCount } = classifyPrompt(prompt);
    total += dedupEligibleCount;
  }
  assert.equal(total, 0,
    `Expected 0 total dedup-eligible across all fixtures; got ${total}. ` +
    'If this fails, the corpus has drifted — re-audit per ' +
    '.orchestray/kb/artifacts/v2220-l1-revival-design.md before flipping the kill switch.');
});

test('corpus zero-dedup: ALL fixtures combined have 0 score-eligible sections', () => {
  let total = 0;
  for (const prompt of FIXTURE_PROMPTS) {
    const { scoreEligibleCount } = classifyPrompt(prompt);
    total += scoreEligibleCount;
  }
  assert.equal(total, 0,
    `Expected 0 total score-eligible across all fixtures; got ${total}. ` +
    'If this fails, the corpus has drifted — re-audit per ' +
    '.orchestray/kb/artifacts/v2220-l1-revival-design.md before flipping the kill switch.');
});
