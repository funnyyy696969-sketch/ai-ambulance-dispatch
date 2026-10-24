import type { RoadGraph } from "./types";
import { edgeTravelTime, isTurnAllowed } from "./network";

export interface PathResult {
  nodePath: number[];
  edgeIds: number[];
  cost: number; // estimated travel time (s)
  distance: number; // meters
}

function finish(graph: RoadGraph, edgeChain: number[], start: number): PathResult {
  const nodePath = [start];
  let distance = 0;
  let cost = 0;
  for (const id of edgeChain) {
    const e = graph.edgesById.get(id)!;
    nodePath.push(e.to);
    distance += e.length;
    cost += edgeTravelTime(e);
  }
  return { nodePath, edgeIds: edgeChain, cost, distance };
}

/**
 * Edge-based Dijkstra over estimated travel time with LIVE congestion.
 * Skips blocked edges and rejects turns banned by real OSM restrictions.
 */
export function dijkstra(graph: RoadGraph, start: number, goal: number): PathResult | null {
  if (start === goal) return { nodePath: [start], edgeIds: [], cost: 0, distance: 0 };
  const distE = new Map<number, number>();
  const prevE = new Map<number, number>();
  const done = new Set<number>();
  const pq: [number, number][] = [];
  for (const eId of graph.out.get(start) ?? []) {
    const e = graph.edgesById.get(eId)!;
    if (e.blocked) continue;
    distE.set(eId, edgeTravelTime(e));
    prevE.set(eId, -1);
    pq.push([distE.get(eId)!, eId]);
  }
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, eId] = pq.shift()!;
    if (done.has(eId)) continue;
    done.add(eId);
    const e = graph.edgesById.get(eId)!;
    if (e.to === goal) {
      const chain: number[] = [];
      let cur = eId;
      while (cur !== -1) {
        chain.push(cur);
        cur = prevE.get(cur)!;
      }
      chain.reverse();
      return finish(graph, chain, start);
    }
    for (const nId of graph.out.get(e.to) ?? []) {
      const n = graph.edgesById.get(nId)!;
      if (n.blocked || done.has(nId)) continue;
      if (!isTurnAllowed(graph, e, n)) continue;
      const nd = d + edgeTravelTime(n);
      if (nd < (distE.get(nId) ?? Infinity)) {
        distE.set(nId, nd);
        prevE.set(nId, eId);
        pq.push([nd, nId]);
      }
    }
  }
  return null;
}

/** Edge-based A* (admissible: euclid / fastest road speed). */
export function astar(graph: RoadGraph, start: number, goal: number): PathResult | null {
  if (start === goal) return { nodePath: [start], edgeIds: [], cost: 0, distance: 0 };
  const goalNode = graph.nodesById.get(goal)!;
  const maxSpeed = Math.max(...graph.edges.map((e) => e.speedLimit), 1);
  const h = (nodeId: number) => {
    const a = graph.nodesById.get(nodeId)!;
    return Math.hypot(a.x - goalNode.x, a.y - goalNode.y) / maxSpeed;
  };
  const gE = new Map<number, number>();
  const prevE = new Map<number, number>();
  const done = new Set<number>();
  const pq: [number, number][] = []; // [f, edgeId]
  for (const eId of graph.out.get(start) ?? []) {
    const e = graph.edgesById.get(eId)!;
    if (e.blocked) continue;
    gE.set(eId, edgeTravelTime(e));
    prevE.set(eId, -1);
    pq.push([gE.get(eId)! + h(e.to), eId]);
  }
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [, eId] = pq.shift()!;
    if (done.has(eId)) continue;
    done.add(eId);
    const e = graph.edgesById.get(eId)!;
    if (e.to === goal) {
      const chain: number[] = [];
      let cur = eId;
      while (cur !== -1) {
        chain.push(cur);
        cur = prevE.get(cur)!;
      }
      chain.reverse();
      return finish(graph, chain, start);
    }
    const ge = gE.get(eId)!;
    for (const nId of graph.out.get(e.to) ?? []) {
      const n = graph.edgesById.get(nId)!;
      if (n.blocked || done.has(nId)) continue;
      if (!isTurnAllowed(graph, e, n)) continue;
      const ng = ge + edgeTravelTime(n);
      if (ng < (gE.get(nId) ?? Infinity)) {
        gE.set(nId, ng);
        prevE.set(nId, eId);
        pq.push([ng + h(n.to), nId]);
      }
    }
  }
  return null;
}

export function closestNodeTo(graph: RoadGraph, x: number, y: number): number {
  let best = graph.nodes[0].id;
  let bd = Infinity;
  for (const n of graph.nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) { bd = d; best = n.id; }
  }
  return best;
}
