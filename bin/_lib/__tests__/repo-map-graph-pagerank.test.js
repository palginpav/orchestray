#!/usr/bin/env node
'use strict';

/**
 * repo-map-graph-pagerank.test.js
 *
 * Parity test for the inline PageRank implementation introduced in v2.3.8,
 * which replaced graphology + graphology-metrics/centrality/pagerank.
 *
 * The expected values below were captured from the OLD graphology-metrics
 * implementation before removal. To reproduce them (while graphology is still
 * installed), run from repo root:
 *
 *   node -e "
 *     const Graph = require('graphology');
 *     const pr = require('graphology-metrics/centrality/pagerank');
 *     const g = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });
 *     ['A','B','C','D','E'].forEach(n => g.addNode(n));
 *     // B->A w=2, C->A w=1, D->A w=1, D->B w=1, E->nothing (dangling)
 *     g.addEdge('B','A',{weight:2}); g.addEdge('C','A',{weight:1});
 *     g.addEdge('D','A',{weight:1}); g.addEdge('D','B',{weight:1});
 *     const s = pr(g, {alpha:0.85, maxIterations:100, tolerance:1e-6, getEdgeWeight:'weight'});
 *     console.log(JSON.stringify(s));
 *   "
 *
 * Captured output:
 *   {"A":0.44067044132831257,"B":0.1801232171554451,
 *    "C":0.12640211383874747,"D":0.12640211383874747,"E":0.12640211383874747}
 *
 * Note: E (dangling) gets the SAME rank as C and D. Dangling-node mass is
 * redistributed uniformly to ALL nodes including E itself, but E contributes
 * nothing back, so its equilibrium rank equals that of the other low-rank nodes.
 * Ordering: A > B > {C, D, E} (C=D=E by symmetry in this topology).
 *
 * NOTE: this test is self-contained — no graphology import required.
 * The expected values are captured literals from the old implementation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const graphMod = require('../repo-map-graph.js');

// ---------------------------------------------------------------------------
// Helper: build graph from explicit edge list.
// ---------------------------------------------------------------------------
function makeGraph(nodes, edges) {
  const tagsByFile = new Map();
  for (const n of nodes) tagsByFile.set(n, []);

  // edges: [from, to, weight?] — to define a symbol in `to` referenced from `from`
  // We fabricate unique symbol names per edge to get precise weight control.
  let sym = 0;
  for (const [from, to, w] of edges) {
    const repeat = w || 1;
    for (let i = 0; i < repeat; i++) {
      const name = 's' + (sym++);
      tagsByFile.get(to).push({ name, kind: 'def', file: to, line: 1 });
      tagsByFile.get(from).push({ name, kind: 'ref', file: from, line: 1 });
    }
  }
  return graphMod.buildGraph(tagsByFile).graph;
}

// ---------------------------------------------------------------------------
// Test 1: ordering on 5-node synthetic graph (hub + dangling node + cycle).
//
// Topology:
//   B->A (weight 2), C->A (weight 1), D->A (weight 1), D->B (weight 1),
//   E has no outbound edges (dangling).
//
// Expected ordering (from old graphology-metrics run):
//   A > B > E > C ≈ D
//
// A is heavily cited (3 in-edges), B is cited by D too, E is dangling so
// receives teleportation + dangling redistribution from all nodes.
// ---------------------------------------------------------------------------
describe('repo-map-graph-pagerank: synthetic 5-node parity', () => {
  test('ordering matches captured graphology-metrics output', () => {
    const graph = makeGraph(
      ['A', 'B', 'C', 'D', 'E'],
      [
        ['B', 'A', 2], // B references A twice
        ['C', 'A', 1],
        ['D', 'A', 1],
        ['D', 'B', 1],
        // E: no outbound edges → dangling node
      ]
    );

    assert.equal(graph.order, 5, 'five nodes');
    // edge count: A has in-edges from B,C,D (but those are 3 distinct edges from
    // unique symbols); D->B is 1 more. Total = 4 distinct (from,to) pairs.
    // B->A weight=2 (merged from 2 ref occurrences), C->A=1, D->A=1, D->B=1.
    assert.equal(graph.size, 4, 'four distinct directed edges');
    assert.equal(graph.getEdgeAttribute('B', 'A', 'weight'), 2, 'B->A weight=2');

    const scores = graphMod.runPageRank(graph);
    const keys = Array.from(scores.keys());

    // A must rank first (most cited hub).
    assert.equal(keys[0], 'A', 'A should rank first; got: ' + keys.join(','));
    // B must rank second (cited by D, and receives weight from B->A path).
    assert.equal(keys[1], 'B', 'B should rank second; got: ' + keys.join(','));
    // C, D, E all rank equally — E (dangling) does not get a boost above C/D.
    // Dangling mass is redistributed to ALL nodes uniformly, so E settles at the
    // same equilibrium as the other low-rank nodes.
    const eIdx = keys.indexOf('E');
    const cIdx = keys.indexOf('C');
    const dIdx = keys.indexOf('D');
    assert.ok(eIdx >= 2, 'E should be in rank positions 2-4; got idx=' + eIdx);
    assert.ok(cIdx >= 2, 'C should be in rank positions 2-4; got idx=' + cIdx);
    assert.ok(dIdx >= 2, 'D should be in rank positions 2-4; got idx=' + dIdx);

    // Sanity: scores sum to approximately 1.
    const total = Array.from(scores.values()).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(total - 1.0) < 1e-4, 'scores must sum to ~1; got ' + total);
  });

  test('dangling-only graph: all nodes get uniform rank', () => {
    // All nodes are dangling (no edges), so runPageRank returns uniform 1/N.
    const tagsByFile = new Map([
      ['a.py', [{ name: 'x', kind: 'def', file: 'a.py', line: 1 }]],
      ['b.py', [{ name: 'y', kind: 'def', file: 'b.py', line: 1 }]],
      ['c.py', [{ name: 'z', kind: 'def', file: 'c.py', line: 1 }]],
    ]);
    const { graph } = graphMod.buildGraph(tagsByFile);
    assert.equal(graph.size, 0, 'no edges');
    const scores = graphMod.runPageRank(graph);
    for (const v of scores.values()) {
      assert.ok(Math.abs(v - 1 / 3) < 1e-9, 'uniform rank 1/3 expected; got ' + v);
    }
  });

  test('cycle: A->B->C->A, all share approximately equal rank', () => {
    const graph = makeGraph(
      ['A', 'B', 'C'],
      [['A', 'B', 1], ['B', 'C', 1], ['C', 'A', 1]]
    );
    assert.equal(graph.size, 3);
    const scores = graphMod.runPageRank(graph);
    const vals = Array.from(scores.values());
    // A perfect 3-cycle yields exactly equal ranks by symmetry.
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    for (const v of vals) {
      assert.ok(Math.abs(v - mean) < 1e-6, 'cycle nodes should have equal rank; diff=' + Math.abs(v - mean));
    }
  });

  test('captured literal scores match within tolerance', () => {
    // Scores captured from graphology-metrics run (see file header comment).
    // Keys: A, B, C, D, E
    // Values (exact from graphology-metrics, alpha=0.85, maxIter=100, tol=1e-6):
    //   A=0.44067044132831257, B=0.1801232171554451,
    //   C=D=E=0.12640211383874747
    // We allow ±0.005 tolerance to handle minor floating-point differences.
    const EXPECTED = {
      A: 0.44067044132831257,
      B: 0.18012321715544510,
      C: 0.12640211383874747,
      D: 0.12640211383874747,
      E: 0.12640211383874747,
    };
    const TOL = 0.005;

    const graph = makeGraph(
      ['A', 'B', 'C', 'D', 'E'],
      [['B', 'A', 2], ['C', 'A', 1], ['D', 'A', 1], ['D', 'B', 1]]
    );
    const scores = graphMod.runPageRank(graph);
    for (const [node, expected] of Object.entries(EXPECTED)) {
      const actual = scores.get(node);
      assert.ok(actual != null, 'score missing for node ' + node);
      assert.ok(
        Math.abs(actual - expected) < TOL,
        node + ': expected ~' + expected + ', got ' + actual.toFixed(6)
      );
    }
  });
});
