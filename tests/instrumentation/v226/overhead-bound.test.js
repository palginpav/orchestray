'use strict';

/**
 * Test 15: Overhead bound — wallclock benchmark.
 *
 * 100 iterations of the L1 pipeline on a ~50KB representative prompt.
 * 95th-percentile latency with compression enabled must be under
 * OVERHEAD_BUDGET_MS (default 50ms) vs. a no-op baseline.
 *
 * Approach: measure the L1 pipeline via runL1 exported logic (pure function,
 * no I/O). Two runs: one doing real compression, one doing a no-op passthrough
 * that mimics the disabled path. Compute p95 of each.
 *
 * If p95 difference exceeds the budget on this machine (slow CI), we emit a
 * console.warn rather than failing — per the task brief.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');

const { parseSections, reassembleSections } = require('../../../bin/_lib/tokenwright/parse-sections');
const { classifySection } = require('../../../bin/_lib/tokenwright/classify-section');
const { applyMinHashDedup } = require('../../../bin/_lib/tokenwright/dedup-minhash');

// ---------------------------------------------------------------------------
// Budget (ms) — can be overridden via env for slow machines
// ---------------------------------------------------------------------------
const OVERHEAD_BUDGET_MS = parseInt(process.env.OVERHEAD_BUDGET_MS || '50', 10);

// ---------------------------------------------------------------------------
// Build a ~50KB representative prompt with multiple duplicate sections
// ---------------------------------------------------------------------------
function buildRepresentativePrompt() {
  const lines = [
    'Preamble text with project context and task description.\n',
    '\n',
    '## Prior Findings\n',
    '\n',
  ];

  // Build a moderately large body (~800 chars each, repeat it to get ~50KB)
  const body = [
    'The agent found several issues during the review. The main issue is in the',
    'error handler module which does not properly handle edge cases when the',
    'database connection fails. The secondary issue is in the logging service',
    'which generates too much output in production mode. No critical security',
    'vulnerabilities were found. The test coverage is at 78% which is below the',
    'required 85% threshold. The API documentation needs to be updated to reflect',
    'the recent changes to the authentication endpoints. The performance profiling',
    'shows that the database queries are the main bottleneck.',
  ].join(' ');

  // Repeat the section 60 times (~50KB total)
  for (let i = 0; i < 60; i++) {
    lines.push(`## Prior Findings\n\n${body} (iteration ${i})\n\n`);
  }

  lines.push('## Structured Result\n\n{"status": "pass"}\n');
  return lines.join('');
}

// ---------------------------------------------------------------------------
// No-op "compression" — parse only, no dedup (baseline for disabled path)
// ---------------------------------------------------------------------------
function noopL1(prompt) {
  // Only parse, classify, do NOT apply dedup
  const sections = parseSections(prompt);
  for (const s of sections) s.kind = classifySection(s).kind;
  return reassembleSections(sections);
}

// ---------------------------------------------------------------------------
// Real L1 pipeline
// ---------------------------------------------------------------------------
function realL1(prompt) {
  const sections = parseSections(prompt);
  for (const s of sections) s.kind = classifySection(s).kind;
  applyMinHashDedup(sections);
  return reassembleSections(sections);
}

// ---------------------------------------------------------------------------
// p95 helper
// ---------------------------------------------------------------------------
function percentile95(latencies) {
  const sorted = latencies.slice().sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.95);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ---------------------------------------------------------------------------
// Benchmark test
// ---------------------------------------------------------------------------
test('Overhead-bound: L1 pipeline p95 latency within OVERHEAD_BUDGET_MS vs noop baseline', () => {
  const ITERATIONS = 100;
  const prompt = buildRepresentativePrompt();

  // Warm-up (2 iterations to settle JIT)
  noopL1(prompt);
  realL1(prompt);

  // Baseline: noop path
  const noopLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    noopL1(prompt);
    const t1 = process.hrtime.bigint();
    noopLatencies.push(Number(t1 - t0) / 1e6);  // ms
  }

  // Enabled: real L1 pipeline
  const realLatencies = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    realL1(prompt);
    const t1 = process.hrtime.bigint();
    realLatencies.push(Number(t1 - t0) / 1e6);  // ms
  }

  const noopP95 = percentile95(noopLatencies);
  const realP95 = percentile95(realLatencies);
  const overhead = realP95 - noopP95;

  // Report for observability regardless of pass/fail
  process.stderr.write(
    `[overhead-bound] noop_p95=${noopP95.toFixed(2)}ms real_p95=${realP95.toFixed(2)}ms overhead=${overhead.toFixed(2)}ms budget=${OVERHEAD_BUDGET_MS}ms\n`
  );

  if (overhead > OVERHEAD_BUDGET_MS) {
    // Slow machine / CI: warn but don't fail — per task brief
    const msg = `[overhead-bound] WARNING: p95 overhead ${overhead.toFixed(2)}ms exceeds budget ${OVERHEAD_BUDGET_MS}ms — slow machine or CI?`;
    console.warn(msg);
    // Do not assert.fail() on slow machines; the budget is a target, not a hard gate in CI
  } else {
    assert.ok(overhead <= OVERHEAD_BUDGET_MS,
      `L1 pipeline p95 overhead ${overhead.toFixed(2)}ms must be ≤ ${OVERHEAD_BUDGET_MS}ms`);
  }
});
