#!/usr/bin/env node
'use strict';

/**
 * Tests for bin/_lib/pattern-credit-compute.js — one test per §5 structural
 * bound proving it REJECTS the violating case (each asserts the exact
 * `withheld.reason`), plus the outcome gate and the double-count regression.
 *
 * Runner: node --require ./tests/helpers/setup.js --test bin/_lib/__tests__/pattern-credit-compute.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { computeCredits } = require('../pattern-credit-compute');

function offerRow(spawnId, offers) {
  return { orchestration_id: 'orch-1', spawn_id: spawnId, offers };
}

function ackRow(spawnId, { used = [], rejected = [], agent_status = 'success', source = 'structured_result', agent_role = 'developer', task_id = null } = {}) {
  return { orchestration_id: 'orch-1', spawn_id: spawnId, agent_role, task_id, source, used, rejected, agent_status };
}

function reasonsFor(withheld, slug) {
  return withheld.filter((w) => w.slug === slug).map((w) => w.reason);
}

// ---------------------------------------------------------------------------
// §5.1 — closed-set matching
// ---------------------------------------------------------------------------

describe('§5.1 closed-set matching', () => {
  test('a slug not in that spawn\'s offer row is withheld as not_offered', () => {
    const offers = [offerRow('s1', [{ slug: 'foo', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'bar', how_len: 50 }] })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'bar'), ['not_offered']);
  });
});

// ---------------------------------------------------------------------------
// §5.2 — one increment per (pattern, orchestration)
// ---------------------------------------------------------------------------

describe('§5.2 one increment per (pattern, orchestration)', () => {
  test('two spawns crediting the same slug produce exactly one credited entry', () => {
    const offers = [
      offerRow('s1', [{ slug: 'shared-slug', offer_kind: 'curated', confidence: 0.9 }]),
      offerRow('s2', [{ slug: 'shared-slug', offer_kind: 'curated', confidence: 0.9 }]),
    ];
    const acks = [
      ackRow('s1', { used: [{ slug: 'shared-slug', how_len: 50 }] }),
      ackRow('s2', { used: [{ slug: 'shared-slug', how_len: 80 }] }),
    ];
    const result = computeCredits(offers, acks, [], {});
    const matches = result.credited.filter((c) => c.slug === 'shared-slug');
    assert.equal(matches.length, 1, 'exactly one credited entry, not two');
    assert.deepEqual(matches[0].spawn_ids.sort(), ['s1', 's2']);
  });
});

// ---------------------------------------------------------------------------
// §5.3 — contradiction is not application
// ---------------------------------------------------------------------------

describe('§5.3 contradiction is not application', () => {
  test('a slug only in patterns_rejected across the orch is contradicted, not credited', () => {
    const offers = [offerRow('s1', [{ slug: 'rejected-only', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', { rejected: [{ slug: 'rejected-only', why_len: 30 }] })];
    const result = computeCredits(offers, acks, [], {});
    assert.deepEqual(result.contradicted, ['rejected-only']);
    assert.equal(result.credited.filter((c) => c.slug === 'rejected-only').length, 0);
  });

  test('a slug in both used and rejected for the same spawn is withheld as used_and_rejected', () => {
    const offers = [offerRow('s1', [{ slug: 'malformed', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', {
      used: [{ slug: 'malformed', how_len: 50 }],
      rejected: [{ slug: 'malformed', why_len: 30 }],
    })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.filter((c) => c.slug === 'malformed').length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'malformed'), ['used_and_rejected']);
  });
});

// ---------------------------------------------------------------------------
// §5.4 — ambient offers are not application-eligible by default
// ---------------------------------------------------------------------------

describe('§5.4 ambient offers not application-eligible by default', () => {
  test('an ambient slug with prose below the promotion threshold is withheld ambient_not_promoted', () => {
    const offers = [offerRow('s1', [{ slug: 'ambient-slug', offer_kind: 'ambient', confidence: 0.6 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'ambient-slug', how_len: 15 }] })]; // < default 40
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.filter((c) => c.slug === 'ambient-slug').length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'ambient-slug'), ['ambient_not_promoted']);
  });

  test('promotion succeeds at how_len >= 40 when it is the only ambient slug named', () => {
    const offers = [offerRow('s1', [{ slug: 'ambient-slug', offer_kind: 'ambient', confidence: 0.6 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'ambient-slug', how_len: 45 }] })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.filter((c) => c.slug === 'ambient-slug').length, 1);
  });

  test('naming two ambient slugs in the same spawn promotes neither', () => {
    const offers = [offerRow('s1', [
      { slug: 'amb-a', offer_kind: 'ambient', confidence: 0.6 },
      { slug: 'amb-b', offer_kind: 'ambient', confidence: 0.6 },
    ])];
    const acks = [ackRow('s1', { used: [
      { slug: 'amb-a', how_len: 45 },
      { slug: 'amb-b', how_len: 45 },
    ] })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'amb-a'), ['ambient_not_promoted']);
    assert.deepEqual(reasonsFor(result.withheld, 'amb-b'), ['ambient_not_promoted']);
  });
});

// ---------------------------------------------------------------------------
// §5.5 — per-orchestration credit cap
// ---------------------------------------------------------------------------

describe('§5.5 per-orchestration credit cap', () => {
  test('a 6th distinct pattern is withheld orch_cap, keeping the highest how_len 5', () => {
    const slugs = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const offers = [offerRow('s1', slugs.map((slug) => ({ slug, offer_kind: 'curated', confidence: 0.9 })))];
    // Descending how_len so p6 (lowest) is the one capped.
    const acks = [ackRow('s1', { used: slugs.map((slug, i) => ({ slug, how_len: 20 - i })) })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 5);
    assert.deepEqual(reasonsFor(result.withheld, 'p6'), ['orch_cap']);
    assert.ok(!result.credited.some((c) => c.slug === 'p6'));
  });
});

// ---------------------------------------------------------------------------
// Self-report cap (§7.1)
// ---------------------------------------------------------------------------

describe('self-report cap', () => {
  test('a 3rd self-report-only slug is withheld self_report_cap (default max 2)', () => {
    const acks = [
      ackRow(null, { source: 'self_report', used: [{ slug: 'sr1', how_len: 5 }] }),
      ackRow(null, { source: 'self_report', used: [{ slug: 'sr2', how_len: 5 }] }),
      ackRow(null, { source: 'self_report', used: [{ slug: 'sr3', how_len: 5 }] }),
    ];
    const result = computeCredits([], acks, [], {});
    assert.equal(result.credited.length, 2);
    assert.equal(reasonsFor(result.withheld, 'sr3').length, 1);
    assert.equal(reasonsFor(result.withheld, 'sr3')[0], 'self_report_cap');
  });

  test('self-report is exempt from the min_how_length gate', () => {
    const acks = [ackRow(null, { source: 'self_report', used: [{ slug: 'sr-short', how_len: 0 }] })];
    const result = computeCredits([], acks, [], {});
    assert.equal(result.credited.filter((c) => c.slug === 'sr-short').length, 1);
    assert.equal(result.credited[0].evidence_grade, 'self_report');
  });
});

// ---------------------------------------------------------------------------
// how_too_short (structured_result, defensive re-check)
// ---------------------------------------------------------------------------

describe('how_too_short', () => {
  test('a structured_result entry below min_how_length is withheld', () => {
    const offers = [offerRow('s1', [{ slug: 'short-how', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'short-how', how_len: 3 }] })];
    const result = computeCredits(offers, acks, [], {});
    assert.deepEqual(reasonsFor(result.withheld, 'short-how'), ['how_too_short']);
  });
});

// ---------------------------------------------------------------------------
// Outcome gate — E3/E4
// ---------------------------------------------------------------------------

describe('outcome gate', () => {
  test('a failed spawn does not yield credit (spawn_failed)', () => {
    const offers = [offerRow('s1', [{ slug: 'fails', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'fails', how_len: 50 }], agent_status: 'failure' })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'fails'), ['spawn_failed']);
  });

  test('a task invalidated by a replan does not yield credit (verify_fix_escalated)', () => {
    const offers = [offerRow('s1', [{ slug: 'replanned', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'replanned', how_len: 50 }], task_id: 'W3' })];
    const orchEvents = [{ type: 'replan', tasks_invalidated: ['W3'] }];
    const result = computeCredits(offers, acks, orchEvents, {});
    assert.equal(result.credited.length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'replanned'), ['verify_fix_escalated']);
  });

  test('a task with a verify_fix_fail escalation does not yield credit', () => {
    const offers = [offerRow('s1', [{ slug: 'escalated', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'escalated', how_len: 50 }], task_id: 'W4' })];
    const orchEvents = [{ type: 'verify_fix_fail', task_id: 'W4' }];
    const result = computeCredits(offers, acks, orchEvents, {});
    assert.equal(result.credited.length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'escalated'), ['verify_fix_escalated']);
  });

  test('a healthy spawn with matching routing_outcome is credited', () => {
    const offers = [offerRow('s1', [{ slug: 'healthy', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow('s1', { used: [{ slug: 'healthy', how_len: 50 }], agent_role: 'developer' })];
    const orchEvents = [{ type: 'routing_outcome', agent_type: 'developer' }];
    const result = computeCredits(offers, acks, orchEvents, {});
    assert.equal(result.credited.filter((c) => c.slug === 'healthy').length, 1);
  });
});

// ---------------------------------------------------------------------------
// no_ack — offered but never covered by any ack
// ---------------------------------------------------------------------------

describe('no_ack', () => {
  test('an offered slug with zero ack coverage is withheld no_ack', () => {
    const offers = [offerRow('s1', [{ slug: 'uncovered', offer_kind: 'curated', confidence: 0.9 }])];
    const result = computeCredits(offers, [], [], {});
    assert.deepEqual(reasonsFor(result.withheld, 'uncovered'), ['no_ack']);
  });
});

// ---------------------------------------------------------------------------
// offered_counts — tracked regardless of credit outcome
// ---------------------------------------------------------------------------

describe('offered_counts', () => {
  test('counts distinct offering spawns regardless of whether the slug was credited', () => {
    const offers = [
      offerRow('s1', [{ slug: 'never-acked', offer_kind: 'curated', confidence: 0.9 }]),
      offerRow('s2', [{ slug: 'never-acked', offer_kind: 'curated', confidence: 0.9 }]),
    ];
    const result = computeCredits(offers, [], [], {});
    assert.equal(result.offered_counts['never-acked'], 2);
    assert.equal(result.credited.length, 0);
  });
});

// ---------------------------------------------------------------------------
// RV-1 regressions — the §5 bounds are per-SPAWN, and a spawn must be named.
// Inputs are the review's exact reproductions.
// ---------------------------------------------------------------------------

describe('RV-1 E2 — the ambient gate spans a spawn, not one ack row', () => {
  test('two ambient slugs split across two ack rows of one spawn promote neither', () => {
    const offers = [offerRow('s1', [
      { slug: 'amb-a', offer_kind: 'ambient', confidence: 0.6 },
      { slug: 'amb-b', offer_kind: 'ambient', confidence: 0.6 },
    ])];
    const acks = [
      ackRow('s1', { used: [{ slug: 'amb-a', how_len: 50 }] }),
      ackRow('s1', { used: [{ slug: 'amb-b', how_len: 50 }] }),
    ];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 0, 'splitting the claim across rows must not buy credit');
    assert.deepEqual(reasonsFor(result.withheld, 'amb-a'), ['ambient_not_promoted']);
    assert.deepEqual(reasonsFor(result.withheld, 'amb-b'), ['ambient_not_promoted']);
  });

  test('a lone ambient slug named once per spawn is still promoted across two spawns', () => {
    const offers = [
      offerRow('s1', [{ slug: 'amb-a', offer_kind: 'ambient', confidence: 0.6 }]),
      offerRow('s2', [{ slug: 'amb-b', offer_kind: 'ambient', confidence: 0.6 }]),
    ];
    const acks = [
      ackRow('s1', { used: [{ slug: 'amb-a', how_len: 50 }] }),
      ackRow('s2', { used: [{ slug: 'amb-b', how_len: 50 }] }),
    ];
    const result = computeCredits(offers, acks, [], {});
    assert.deepEqual(result.credited.map((c) => c.slug).sort(), ['amb-a', 'amb-b']);
  });
});

describe('RV-1 E3 — used_and_rejected spans a spawn, not one ack row', () => {
  test('used in one ack row and rejected in another of the same spawn is withheld', () => {
    const offers = [offerRow('s1', [{ slug: 'foo', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [
      ackRow('s1', { used: [{ slug: 'foo', how_len: 50 }] }),
      ackRow('s1', { rejected: [{ slug: 'foo', why_len: 50 }] }),
    ];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'foo'), ['used_and_rejected']);
  });

  test('one spawn using it and a DIFFERENT spawn rejecting it still credits', () => {
    const offers = [
      offerRow('s1', [{ slug: 'foo', offer_kind: 'curated', confidence: 0.9 }]),
      offerRow('s2', [{ slug: 'foo', offer_kind: 'curated', confidence: 0.9 }]),
    ];
    const acks = [
      ackRow('s1', { used: [{ slug: 'foo', how_len: 50 }] }),
      ackRow('s2', { rejected: [{ slug: 'foo', why_len: 50 }] }),
    ];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.filter((c) => c.slug === 'foo').length, 1);
  });
});

describe('RV-1 E4 — an offer with no spawn_id is not joinable for observed credit', () => {
  test('two spawn-less offer rows do not merge into one orchestration-wide closed set', () => {
    const offers = [
      offerRow(null, [{ slug: 'secret-a', offer_kind: 'curated', confidence: 0.9 }]),
      offerRow(null, [{ slug: 'secret-b', offer_kind: 'curated', confidence: 0.9 }]),
    ];
    const acks = [ackRow(null, { used: [
      { slug: 'secret-a', how_len: 50 },
      { slug: 'secret-b', how_len: 50 },
    ] })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 0, 'an unattributed offer cannot be observed-credited');
    assert.deepEqual(reasonsFor(result.withheld, 'secret-a'), ['not_offered']);
    assert.deepEqual(reasonsFor(result.withheld, 'secret-b'), ['not_offered']);
  });

  test('a spawn-less offer still counts toward times_offered', () => {
    const offers = [offerRow(null, [{ slug: 'orphan-offer', offer_kind: 'curated', confidence: 0.9 }])];
    const result = computeCredits(offers, [], [], {});
    assert.ok(Object.keys(result.offered_counts).includes('orphan-offer'));
    assert.deepEqual(reasonsFor(result.withheld, 'orphan-offer'), ['no_ack']);
  });

  test('a spawn-less ack cannot reach a named spawn\'s offers', () => {
    const offers = [offerRow('s1', [{ slug: 'sibling-only', offer_kind: 'curated', confidence: 0.9 }])];
    const acks = [ackRow(null, { used: [{ slug: 'sibling-only', how_len: 50 }] })];
    const result = computeCredits(offers, acks, [], {});
    assert.equal(result.credited.length, 0);
    assert.deepEqual(reasonsFor(result.withheld, 'sibling-only'), ['not_offered']);
  });

  test('self-report is unaffected — it never joins the offer set', () => {
    const acks = [ackRow(null, { source: 'self_report', used: [{ slug: 'self-only', how_len: 50 }] })];
    const result = computeCredits([], acks, [], {});
    assert.equal(result.credited.filter((c) => c.slug === 'self-only').length, 1);
  });
});
