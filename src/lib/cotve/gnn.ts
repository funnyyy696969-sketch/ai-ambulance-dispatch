import { makeRng, settings } from "./config";
import type { RoadGraph } from "./types";
import { edgeTravelTime } from "./network";
import { dist } from "./geo";

/**
 * Lightweight Graph Neural Network over the road graph.
 *
 * Architecture: 2 message-passing layers (mean aggregation + tanh), hidden
 * dim 16 — deliberately tiny so it runs on any CPU in a browser.
 *
 * HONEST STATUS: the weights are deterministically initialized (seeded) and
 * are NOT trained in this web port — there is no real training data for road
 * embeddings, and training a GNN inside a browser request budget is not
 * feasible. The embeddings therefore carry raw feature information (degree,
 * congestion, distances) passed through a fixed random projection. This is
 * clearly labeled "demonstration embeddings (untrained)" everywhere in the
 * UI. The PPO agent's *decision* features (distance deltas, congestion,
 * travel-time) are hand-crafted and are what actually drive route quality;
 * the PPO weights themselves ARE trained in-browser (quick-train).
 */

export const GNN_HIDDEN = 16;

function mat(rng: () => number, rows: number, cols: number, scale: number): Float32Array {
  const m = new Float32Array(rows * cols);
  for (let i = 0; i < m.length; i++) m[i] = (rng() * 2 - 1) * scale;
  return m;
}

export class RoadGNN {
  readonly inDim = 7;
  readonly hidden = GNN_HIDDEN;
  /** layer 1: node transform + edge-message transform (inDim->hidden) */
  private wNode1: Float32Array;
  private wEdge1: Float32Array;
  /** layer 2 */
  private wNode2: Float32Array;
  private wEdge2: Float32Array;

  constructor(seed = settings.seed) {
    const rng = makeRng(seed * 13 + 5);
    this.wNode1 = mat(rng, this.inDim, this.hidden, 0.6);
    this.wEdge1 = mat(rng, 4, this.hidden, 0.5);
    this.wNode2 = mat(rng, this.hidden, this.hidden, 0.6);
    this.wEdge2 = mat(rng, 4, this.hidden, 0.5);
  }

  private mv(v: Float32Array, m: Float32Array, dim: number, out: Float32Array, outOff: number) {
    for (let h = 0; h < this.hidden; h++) {
      let s = 0;
      for (let i = 0; i < dim; i++) s += v[i] * m[i * this.hidden + h];
      out[outOff + h] = s;
    }
  }

  /** Compute node embeddings for the whole graph.
   * @param destA patient node id (normalized distance feature)
   * @param destB hospital node id */
  embed(graph: RoadGraph, destA: number, destB: number): Float32Array {
    const N = graph.nodes.length;
    const maxDeg = 6;
    const maxTime = Math.max(...graph.edges.map((e) => edgeTravelTime(e)), 1);
    const spanX = Math.max(graph.bounds.maxX - graph.bounds.minX, 1);
    const spanY = Math.max(graph.bounds.maxY - graph.bounds.minY, 1);
    const nodeA = graph.nodesById.get(destA);
    const nodeB = graph.nodesById.get(destB);
    const maxDist = Math.max(spanX + spanY, 1);

    const x = new Float32Array(N * this.inDim);
    for (const n of graph.nodes) {
      const o = n.id * this.inDim;
      x[o] = Math.min(1, n.degree / maxDeg);
      x[o + 1] = n.signalized ? 1 : 0;
      x[o + 2] = n.x / spanX;
      x[o + 3] = n.y / spanY;
      x[o + 4] = nodeA ? Math.min(1, dist(n.x, n.y, nodeA.x, nodeA.y) / maxDist) : 1;
      x[o + 5] = nodeB ? Math.min(1, dist(n.x, n.y, nodeB.x, nodeB.y) / maxDist) : 1;
      x[o + 6] = 1; // bias
    }

    const h1 = new Float32Array(N * this.hidden);
    const h2 = new Float32Array(N * this.hidden);
    const tmp = new Float32Array(this.hidden);
    const agg = new Float32Array(this.hidden);
    const efeat = new Float32Array(4);

    // layer 1
    for (const n of graph.nodes) {
      agg.fill(0);
      let cnt = 0;
      for (const eId of graph.out.get(n.id) ?? []) {
        const e = graph.edgesById.get(eId)!;
        efeat[0] = e.length / 400;
        efeat[1] = edgeTravelTime(e) / maxTime;
        efeat[2] = e.density;
        efeat[3] = e.speedLimit / 20;
        this.mv(efeat, this.wEdge1, 4, tmp, 0);
        for (let h = 0; h < this.hidden; h++) agg[h] += tmp[h];
        cnt++;
      }
      this.mv(x.subarray(n.id * this.inDim, (n.id + 1) * this.inDim), this.wNode1, this.inDim, h1, n.id * this.hidden);
      if (cnt > 0) {
        for (let h = 0; h < this.hidden; h++) agg[h] /= cnt;
      }
      for (let h = 0; h < this.hidden; h++) {
        h1[n.id * this.hidden + h] = Math.tanh(h1[n.id * this.hidden + h] + agg[h]);
      }
    }

    // layer 2 (neighbor mean aggregation + self transform)
    for (const n of graph.nodes) {
      agg.fill(0);
      let cnt = 0;
      for (const eId of graph.out.get(n.id) ?? []) {
        const e = graph.edgesById.get(eId)!;
        efeat[0] = e.length / 400;
        efeat[1] = edgeTravelTime(e) / maxTime;
        efeat[2] = e.density;
        efeat[3] = e.speedLimit / 20;
        this.mv(efeat, this.wEdge2, 4, tmp, 0);
        // neighbor hidden state contributes via edge-transformed message
        for (let h = 0; h < this.hidden; h++) {
          agg[h] += tmp[h] + 0.5 * h1[e.to * this.hidden + h];
        }
        cnt++;
      }
      this.mv(h1.subarray(n.id * this.hidden, (n.id + 1) * this.hidden), this.wNode2, this.hidden, h2, n.id * this.hidden);
      if (cnt > 0) for (let h = 0; h < this.hidden; h++) agg[h] /= cnt;
      for (let h = 0; h < this.hidden; h++) {
        h2[n.id * this.hidden + h] = Math.tanh(h2[n.id * this.hidden + h] + agg[h]);
      }
    }
    return h2;
  }
}
