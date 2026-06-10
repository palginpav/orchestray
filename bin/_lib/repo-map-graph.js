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
 * `weight = sum`, so a plain directed graph (single edges) suffices for
 * pagerank.
 *
 * Self-loops are dropped per W4 §3.2.3.
 *
 * v2.3.8: replaced graphology + graphology-metrics/centrality/pagerank with
 * an inline directed graph class + power-iteration PageRank. Semantics are
 * identical to graphology-metrics v2 (alpha=0.85, maxIterations=100,
 * tolerance=1e-6, weighted outbound, dangling-node redistribution).
 */

// ---------------------------------------------------------------------------
// Minimal directed graph (single edges, no self-loops).
// Exposes only the API surface used by buildGraph, runPageRank, serialize,
// deserialize, and the repo-map.test.js unit tests.
// ---------------------------------------------------------------------------

class DirectedGraph {
  constructor() {
    // node set — preserves insertion order
    this._nodes = new Map(); // node -> true
    // adjacency: src -> Map<target, { weight: number }>
    this._adj = new Map();
    // reverse index for fast target lookup
    this._edges = new Map(); // `${src}\0${tgt}` -> { weight }
  }

  get order() { return this._nodes.size; }
  get size()  { return this._edges.size; }

  hasNode(node)  { return this._nodes.has(node); }

  addNode(node) {
    if (!this._nodes.has(node)) {
      this._nodes.set(node, true);
      this._adj.set(node, new Map());
    }
  }

  _edgeKey(src, tgt) { return src + '\0' + tgt; }

  hasEdge(src, tgt)  { return this._edges.has(this._edgeKey(src, tgt)); }

  addEdge(src, tgt, attrs) {
    // ensure nodes
    if (!this._nodes.has(src)) this.addNode(src);
    if (!this._nodes.has(tgt)) this.addNode(tgt);
    const key = this._edgeKey(src, tgt);
    const a = Object.assign({}, attrs);
    this._edges.set(key, a);
    this._adj.get(src).set(tgt, a);
  }

  getEdgeAttribute(src, tgt, attr) {
    const a = this._edges.get(this._edgeKey(src, tgt));
    return a ? a[attr] : undefined;
  }

  setEdgeAttribute(src, tgt, attr, value) {
    const a = this._edges.get(this._edgeKey(src, tgt));
    if (a) {
      a[attr] = value;
    }
  }

  forEachNode(cb) {
    for (const node of this._nodes.keys()) cb(node);
  }

  // cb(edgeKey, attrs, source, target)
  forEachEdge(cb) {
    for (const [src, tgtMap] of this._adj) {
      for (const [tgt, attrs] of tgtMap) {
        cb(this._edgeKey(src, tgt), attrs, src, tgt);
      }
    }
  }

  // Returns array of node names in insertion order.
  nodes() {
    return Array.from(this._nodes.keys());
  }

  // outNeighbors(node) -> [target, ...] with edge weights
  // Used internally by pagerank.
  _outEdges(node) {
    const m = this._adj.get(node);
    if (!m) return [];
    return Array.from(m.entries()); // [[tgt, attrs], ...]
  }
}

// ---------------------------------------------------------------------------
// Power-iteration PageRank — exact semantic match to graphology-metrics v2.
//
// Reference implementation: graphology-metrics/centrality/pagerank.js
//   https://github.com/graphology/graphology-metrics
//
// Key invariants preserved:
//   - Initial vector: x[i] = 1/N for all i.
//   - Dangling nodes (out-degree 0 by edge-weight sum) contribute their
//     mass as alpha * dangleSum * (1/N) to every node.
//   - Weighted out-degree: sum of edge weights leaving node i (same as
//     graphology's outDegrees[i] in WeightedNeighborhoodIndex).
//   - Normalised transition: w(i,j) / outDegree(i).
//   - Convergence: sum(|x[i] - xLast[i]|) < N * tolerance  (L1 norm).
//   - Throws on non-convergence (matching graphology-metrics behaviour).
// ---------------------------------------------------------------------------

function pagerank(graph, opts) {
  const alpha         = (opts && opts.alpha         != null) ? opts.alpha         : 0.85;
  const maxIterations = (opts && opts.maxIterations  != null) ? opts.maxIterations : 100;
  const tolerance     = (opts && opts.tolerance      != null) ? opts.tolerance     : 1e-6;

  const nodeList = graph.nodes(); // stable insertion-order array
  const N = nodeList.length;

  if (N === 0) return {};

  const p = 1 / N;

  // Build adjacency arrays (out-edges with normalised weights) and mark
  // dangling nodes.
  // outEdges[i] = [[targetIdx, normWeight], ...]
  const outEdges = new Array(N);
  const danglingNodes = [];

  // Build node -> index map for O(1) lookup during edge traversal.
  const nodeIdx = new Map();
  for (let i = 0; i < N; i++) nodeIdx.set(nodeList[i], i);

  for (let i = 0; i < N; i++) {
    const raw = graph._outEdges(nodeList[i]);
    let totalW = 0;
    for (const [, attrs] of raw) totalW += (attrs.weight || 1);

    if (totalW === 0) {
      outEdges[i] = [];
      danglingNodes.push(i);
    } else {
      outEdges[i] = raw.map(([tgt, attrs]) => {
        return [nodeIdx.get(tgt), (attrs.weight || 1) / totalW];
      });
    }
  }

  // Power iterations.
  let x = new Float64Array(N).fill(p);
  let converged = false;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const xLast = x;
    x = new Float64Array(N);

    // Dangling-node contribution.
    let dangleSum = 0;
    for (const di of danglingNodes) dangleSum += xLast[di];
    dangleSum *= alpha;

    for (let i = 0; i < N; i++) {
      // Propagate along out-edges.
      for (const [tgtIdx, normW] of outEdges[i]) {
        x[tgtIdx] += alpha * xLast[i] * normW;
      }
      // Dangling redistribution + teleportation (same formula as graphology-metrics).
      x[i] += dangleSum * p + (1 - alpha) * p;
    }

    // L1 convergence check.
    let error = 0;
    for (let i = 0; i < N; i++) error += Math.abs(x[i] - xLast[i]);
    if (error < N * tolerance) { converged = true; break; }
  }

  if (!converged) throw new Error('pagerank: failed to converge.');

  const result = {};
  for (let i = 0; i < N; i++) result[nodeList[i]] = x[i];
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the co-occurrence graph.
 *
 * @param {Map<string, Tag[]>} tagsByFile  - per-file tag arrays
 * @returns {{ graph: DirectedGraph, defByName: Map<string, Set<string>> }}
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
  const graph = new DirectedGraph();
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
 * Serialize for cache persistence. Avoids external dependencies so we keep
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
  const graph = new DirectedGraph();
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
