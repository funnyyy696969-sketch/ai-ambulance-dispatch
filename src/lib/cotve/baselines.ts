import type { RoadGraph } from "./types";
import { edgeTravelTime } from "./network";

export interface PathResult {
  nodePath: number[];
  edgeIds: number[];
  cost: number; // estimated travel time (s)
  distance: number; // meters
}

function reconstruct(prevEdge: Map<number, number>, prevNode: Map<number, number>, start: number, goal: number): PathResult | null {
  if (!prevNode.has(goal) && goal !== start) return null;
  const nodePath = [goal];
  const edgeIds: number[] = [];
  let cur = goal;
  while (cur !== start) {
    const e = prevEdge.get(cur);
    const p = prevNode.get(cur);
    if (e === undefined || p === undefined) return null;
    edgeIds.push(e);
    nodePath.push(p);
    cur = p;
  }
  nodePath.reverse();
  edgeIds.reverse();
  return { nodePath, edgeIds, cost: 0, distance: 0 };
}

function finalize(graph: RoadGraph, res: Omit<PathResult, "cost" | "distance"> & { cost: number }): PathResult {
  let distance = 0;
  for (const id of res.edgeIds) distance += graph.edgesById.get(id)!.length;
  return { ...res, distance };
}

/** Dijkstra baseline over estimated travel time with live congestion. */
export function dijkstra(graph: RoadGraph, start: number, goal: number): PathResult | null {
  if (start === goal) return { nodePath: [start], edgeIds: [], cost: 0, distance: 0 };
  const distV = new Map<number, number>([[start, 0]]);
  const prevNode = new Map<number, number>();
  const prevEdge = new Map<number, number>();
  // binary-heap-lite: array-based priority queue is fine at this scale (<1k)
  const pq: [number, number][] = [[0, start]];
  const done = new Set<number>();
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, u] = pq.shift()!;
    if (done.has(u)) continue;
    done.add(u);
    if (u === goal) break;
    for (const eId of graph.out.get(u) ?? []) {
      const e = graph.edgesById.get(eId)!;
      if (done.has(e.to)) continue;
      const nd = d + edgeTravelTime(e);
      if (nd < (distV.get(e.to) ?? Infinity)) {
        distV.set(e.to, nd);
        prevNode.set(e.to, u);
        prevEdge.set(e.to, eId);
        pq.push([nd, e.to]);
      }
    }
  }
  const res = reconstruct(prevEdge, prevNode, start, goal);
  if (!res) return null;
  res.cost = distV.get(goal) ?? 0;
  return finalize(graph, res);
}

/** A* baseline with haversine-ish euclidean heuristic (admissible: time <=
 * dist / maxSpeed <= euclid / minSpeed). */
export function astar(graph: RoadGraph, start: number, goal: number): PathResult | null {
  if (start === goal) return { nodePath: [start], edgeIds: [], cost: 0, distance: 0 };
  const gScore = new Map<number, number>([[start, 0]]);
  const prevNode = new Map<number, number>();
  const prevEdge = new Map<number, number>();
  const goalNode = graph.nodesById.get(goal)!;
  // admissible heuristic: fastest possible time >= euclid / fastest road speed
  const maxSpeed = Math.max(...graph.edges.map((e) => e.speedLimit), 1);
  const h = (n: number) => {
    const a = graph.nodesById.get(n)!;
    return Math.hypot(a.x - goalNode.x, a.y - goalNode.y) / maxSpeed;
  };
  const open: [number, number][] = [[h(start), start]];
  const closed = new Set<number>();
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [, u] = open.shift()!;
    if (closed.has(u)) continue;
    closed.add(u);
    if (u === goal) break;
    const gu = gScore.get(u) ?? Infinity;
    for (const eId of graph.out.get(u) ?? []) {
      const e = graph.edgesById.get(eId)!;
      if (closed.has(e.to)) continue;
      const ng = gu + edgeTravelTime(e);
      if (ng < (gScore.get(e.to) ?? Infinity)) {
        gScore.set(e.to, ng);
        prevNode.set(e.to, u);
        prevEdge.set(e.to, eId);
        open.push([ng + h(e.to), e.to]);
      }
    }
  }
  const res = reconstruct(prevEdge, prevNode, start, goal);
  if (!res) return null;
  res.cost = gScore.get(goal) ?? 0;
  return finalize(graph, res);
}

/** Nearest reachable node to a lat/lng-free point: used to snap patient and
 * hospital markers onto the road graph. */
export function closestNodeTo(graph: RoadGraph, x: number, y: number): number {
  let best = graph.nodes[0].id;
  let bd = Infinity;
  for (const n of graph.nodes) {
    const d = Math.hypot(n.x - x, n.y - y);
    if (d < bd) {
      bd = d;
      best = n.id;
    }
  }
  return best;
}
