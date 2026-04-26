'use strict';

/**
 * repo-map-graph.js — co-occurrence graph + PageRank wrapper. Implements
 * steps 2 and 3 of W4 §3.
 *
 *   buildGraph(tagsByFile)  -> { graph, defByName }
 *   runPageRank(graph)      -> Map<filePath, score>   (sorted desc)
 *   serialize(graph, scores) -> { nodes: string[], edges: [from,to,weight][], scores }
 *   deserialize(serialized) -> { graph, scores }
 *
 * Per W4 §3.2 we collapse parallel ref edges into a single edge with
 * `weight = sum`, so a plain `DirectedGraph` (single edges) suffices for
 * pagerank — graphology-metrics/centrality/pagerank does not accept
 * MultiGraphs (same constraint as the deprecated graphology-pagerank).
 *
 * Self-loops are dropped per W4 §3.2.3.
 */

const Graph = require('graphology');
// v2.1.17 W9-fix F-003: migrated graphology-pagerank (deprecated) →
// graphology-metrics/centrality/pagerank. The new API replaces the
// `attributes: { weight: 'weight' }` option with `getEdgeWeight: 'weight'`
// and drops the `weighted` flag (always weighted when getEdgeWeight set).
const pagerank = require('graphology-metrics/centrality/pagerank');

/**
 * Build the co-occurrence graph.
 *
 * @param {Map<string, Tag[]>} tagsByFile  - per-file tag arrays
 * @returns {{ graph: Graph, defByName: Map<string, Set<string>> }}
 */
function buildGraph(tagsByFile) {
  // Step 1: invert def-tags into name -> Set<file> map.
  const defByName = new Map();
  for (const [file, tags] of tagsByFile) {
    for (const t of tags) {
      if (t.kind !== 'def') continue;
      let s = defByName.get(t.name);
      if (!s) { s = new Set(); defByName.set(t.name, s); }
      s.add(file);
    }
  }

  // Step 2: graph.
  const graph = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });
  for (const file of tagsByFile.keys()) {
    if (!graph.hasNode(file)) graph.addNode(file);
  }

  // Step 3: walk ref-tags; for each ref of N in F, add F -> F' edges where F'
  // defines N. Aggregate into existing edge weight.
  for (const [file, tags] of tagsByFile) {
    for (const t of tags) {
      if (t.kind !== 'ref') continue;
      const definers = defByName.get(t.name);
      if (!definers) continue;
      for (const target of definers) {
        if (target === file) continue; // self-loops dropped
        if (graph.hasEdge(file, target)) {
          const w = graph.getEdgeAttribute(file, target, 'weight') || 1;
          graph.setEdgeAttribute(file, target, 'weight', w + 1);
        } else {
          graph.addEdge(file, target, { weight: 1 });
        }
      }
    }
  }

  return { graph, defByName };
}

/**
 * Run PageRank and return a Map<filePath, score> sorted descending.
 *
 * Special-case: if the graph has zero edges, every node gets uniform rank
 * `1/N` (avoids pagerank's divide-by-zero on a fully disconnected graph).
 */
function runPageRank(graph) {
  const N = graph.order;
  if (N === 0) return new Map();

  let scores;
  if (graph.size === 0) {
    // No edges — uniform rank.
    const p = 1 / N;
    scores = {};
    graph.forEachNode((node) => { scores[node] = p; });
  } else {
    try {
      scores = pagerank(graph, {
        alpha: 0.85,
        maxIterations: 100,
        tolerance: 1e-6,
        getEdgeWeight: 'weight',
      });
    } catch (_e) {
      // Defensive fallback — uniform rank.
      const p = 1 / N;
      scores = {};
      graph.forEachNode((node) => { scores[node] = p; });
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return new Map(sorted);
}

/**
 * Serialize for cache persistence. Avoids graphology's exporter so we keep
 * the on-disk format small + stable.
 */
function serialize(graph, scoresMap) {
  const nodes = [];
  graph.forEachNode((node) => nodes.push(node));
  const edges = [];
  graph.forEachEdge((edge, attrs, source, target) => {
    edges.push([source, target, attrs.weight || 1]);
  });
  const scores = {};
  for (const [k, v] of scoresMap) scores[k] = v;
  return { nodes, edges, scores };
}

function deserialize(serialized) {
  const graph = new Graph({ type: 'directed', multi: false, allowSelfLoops: false });
  for (const node of serialized.nodes || []) {
    if (!graph.hasNode(node)) graph.addNode(node);
  }
  for (const [from, to, w] of serialized.edges || []) {
    if (!graph.hasNode(from)) graph.addNode(from);
    if (!graph.hasNode(to))   graph.addNode(to);
    graph.addEdge(from, to, { weight: w });
  }
  const sortedScores = new Map(
    Object.entries(serialized.scores || {}).sort((a, b) => b[1] - a[1])
  );
  return { graph, scores: sortedScores };
}

module.exports = {
  buildGraph,
  runPageRank,
  serialize,
  deserialize,
};
