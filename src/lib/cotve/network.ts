import { settings, makeRng, trafficSettings } from "./config";
import { makeProjection, toLocal, dist, type Projection } from "./geo";
import type { LatLng, RoadEdge, RoadGraph, RoadNode } from "./types";

/** Raw network handed over from the Convex Overpass action (or the demo
 * generator). Coordinates are lat/lng; projection happens here. */
export interface RawOsmNetwork {
  nodes: { id: number; lat: number; lng: number; signal?: boolean }[];
  edges: { from: number; to: number; oneway: boolean; type: string; maxspeed: number | null }[];
  source: "osm" | "demo-grid";
}

export interface OsmFetchResult {
  ok: boolean;
  error?: string;
  network?: RawOsmNetwork;
}

export interface BuiltGraph {
  graph: RoadGraph;
  projection: Projection;
}

/** Build a RoadGraph from raw nodes/edges. Deduplicates coordinates into
 * intersections, projects to local meters, keeps the largest strongly
 * reachable component, and marks signalized intersections (high-degree
 * junctions, checkerboard-limited to keep rendering light). */
export function buildGraph(raw: RawOsmNetwork, center: LatLng): BuiltGraph {
  const proj = makeProjection(center);
  const nodes: RoadNode[] = [];
  const coordKey = new Map<string, number>();

  // dedupe raw osm node ids AND coordinates (shared intersections)
  const idMap = new Map<number, number>();
  for (const rn of raw.nodes) {
    const { x, y } = toLocal(proj, { lat: rn.lat, lng: rn.lng });
    const key = `${Math.round(x / 3)},${Math.round(y / 3)}`;
    let nid = coordKey.get(key);
    if (nid === undefined) {
      nid = nodes.length;
      nodes.push({
        id: nid,
        x,
        y,
        lat: rn.lat,
        lng: rn.lng,
        degree: 0,
        signalized: false,
        // carry the REAL OSM traffic-signal tag through dedupe
        ...(rn.signal ? { signalSource: "osm" as const } : {}),
      });
      coordKey.set(key, nid);
    } else if (rn.signal) {
      nodes[nid].signalSource = "osm";
    }
    idMap.set(rn.id, nid);
  }

  const edgeSeen = new Set<string>();
  const edges: RoadEdge[] = [];
  for (const re of raw.edges) {
    const from = idMap.get(re.from);
    const to = idMap.get(re.to);
    if (from === undefined || to === undefined || from === to) continue;
    const a = nodes[from];
    const b = nodes[to];
    const length = Math.max(4, dist(a.x, a.y, b.x, b.y));
    if (length > 800) continue; // drop unrealistic links
    const speed = re.maxspeed ?? settings.defaultSpeeds[re.type] ?? 10;
    const fwd = `${from}->${to}`;
    if (!edgeSeen.has(fwd)) {
      edgeSeen.add(fwd);
      edges.push({
        id: edges.length,
        from,
        to,
        length,
        highwayType: re.type,
        speedLimit: speed,
        baseTravelTime: length / speed,
        oneway: re.oneway,
        density: 0,
      });
      a.degree++;
      b.degree++;
    }
    if (!re.oneway) {
      const bwd = `${to}->${from}`;
      if (!edgeSeen.has(bwd)) {
        edgeSeen.add(bwd);
        edges.push({
          id: edges.length,
          from: to,
          to: from,
          length,
          highwayType: re.type,
          speedLimit: speed,
          baseTravelTime: length / speed,
          oneway: false,
          density: 0,
        });
        a.degree++;
        b.degree++;
      }
    }
  }

  // largest reachable component (undirected view)
  const visited = new Array(nodes.length).fill(false);
  let bestComp: number[] = [];
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  }
  for (let i = 0; i < nodes.length; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    visited[i] = true;
    while (stack.length) {
      const n = stack.pop()!;
      comp.push(n);
      for (const m of adj[n]) {
        if (!visited[m]) {
          visited[m] = true;
          stack.push(m);
        }
      }
    }
    if (comp.length > bestComp.length) bestComp = comp;
  }
  const keep = new Set(bestComp);
  const remap = new Map<number, number>();
  const fNodes: RoadNode[] = [];
  for (const n of nodes) {
    if (!keep.has(n.id)) continue;
    const nid = fNodes.length;
    remap.set(n.id, nid);
    fNodes.push({ ...n, id: nid });
  }
  const fEdges: RoadEdge[] = [];
  for (const e of edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from === undefined || to === undefined) continue;
    fEdges.push({ ...e, id: fEdges.length, from, to });
  }

  const out = new Map<number, number[]>();
  for (const n of fNodes) out.set(n.id, []);
  for (const e of fEdges) out.get(e.from)!.push(e.id);

  markSignalized(fNodes, fEdges, raw.source);

  const graph: RoadGraph = {
    source: raw.source,
    center,
    nodes: fNodes,
    nodesById: new Map(fNodes.map((n) => [n.id, n])),
    out,
    edges: fEdges,
    edgesById: new Map(fEdges.map((e) => [e.id, e])),
    bounds: boundsOf(fNodes),
  };
  return { graph, projection: proj };
}

/**
 * Signalization policy:
 *  - Nodes carrying a REAL `highway=traffic_signals` OSM tag are always
 *    signalized with signalSource "osm".
 *  - On top of those, on DEMO grids high-degree junctions without a tag are
 *    marked "inferred" (labeled, never claimed to be real OSM signals).
 *    On real OSM networks only actual signal tags are used, per spec §7.
 */
function markSignalized(nodes: RoadNode[], edges: RoadEdge[], source: "osm" | "demo-grid") {
  // 1. REAL OSM signal tags always win
  let realSignals = 0;
  for (const n of nodes) {
    if (n.signalSource === "osm") {
      n.signalized = true;
      realSignals++;
    }
  }
  // 2. demo grids: infer signals at high-degree junctions (labeled "inferred")
  const chosenSet = new Set<number>();
  if (source === "demo-grid") {
    const high = nodes.filter((n) => n.signalSource !== "osm" && n.degree >= 4);
    const budget = Math.max(0, Math.floor(nodes.length / 3) - realSignals);
    let count = 0;
    for (const n of high) {
      if (count >= budget) break;
      chosenSet.add(n.id);
      count++;
    }
  }
  // 3. apply + compute signal axes for every signalized node
  for (const n of nodes) {
    if (chosenSet.has(n.id)) {
      n.signalized = true;
      n.signalSource = "inferred";
    }
    if (!n.signalized) continue;
    const axes: [number[], number[]] = [[], []];
    for (const e of edges) {
      if (e.from !== n.id) continue;
      const b = nodes[e.to];
      const ang = (Math.atan2(b.y - n.y, b.x - n.x) * 180) / Math.PI;
      const isNS = Math.abs(Math.abs(ang) - 90) < 35;
      axes[isNS ? 0 : 1].push(e.id);
    }
    n.signalAxes = axes;
  }
}

function boundsOf(nodes: RoadNode[]) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x);
    maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Synthetic demonstration road network: a GxG grid with two arterial
 * diagonals and seeded ambient congestion. Clearly labeled demo-grid. */
export function generateDemoGrid(center: LatLng, seed = settings.seed): BuiltGraph {
  const rng = makeRng(seed);
  const g = settings.demoGridSize;
  const sp = settings.demoGridSpacingM;
  const half = ((g - 1) * sp) / 2;
  const nodes: RoadNode[] = [];
  const edgesRaw: RawOsmNetwork["edges"] = [];
  const rawNodes: RawOsmNetwork["nodes"] = [];
  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      const x = c * sp - half;
      const y = r * sp - half;
      const id = r * g + c;
      rawNodes.push({ id, lat: center.lat + y / 111320, lng: center.lng + x / (111320 * Math.cos((center.lat * Math.PI) / 180)) });
      nodes.push({ id, x, y, lat: 0, lng: 0, degree: 0, signalized: false });
    }
  }
  const id = (r: number, c: number) => r * g + c;
  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      if (c < g - 1) edgesRaw.push({ from: id(r, c), to: id(r, c + 1), oneway: false, type: r % 3 === 0 ? "secondary" : "residential", maxspeed: null });
      if (r < g - 1) edgesRaw.push({ from: id(r, c), to: id(r + 1, c), oneway: false, type: c % 3 === 0 ? "secondary" : "residential", maxspeed: null });
    }
  }
  // arterial ring one cell inside the border
  for (let i = 1; i < g - 1; i++) {
    edgesRaw.push({ from: id(1, i), to: id(1, i + 1), oneway: false, type: "primary", maxspeed: 16 });
    edgesRaw.push({ from: id(g - 2, i), to: id(g - 2, i + 1), oneway: false, type: "primary", maxspeed: 16 });
    edgesRaw.push({ from: id(i, 1), to: id(i + 1, 1), oneway: false, type: "primary", maxspeed: 16 });
    edgesRaw.push({ from: id(i, g - 2), to: id(i + 1, g - 2), oneway: false, type: "primary", maxspeed: 16 });
  }
  void rng;
  const built = buildGraph({ nodes: rawNodes, edges: edgesRaw, source: "demo-grid" }, center);
  seedCongestion(built.graph, makeRng(seed));
  return built;
}

/** Seeded initial congestion so scenarios are reproducible. */
export function seedCongestion(graph: RoadGraph, rng: () => number) {
  for (const e of graph.edges) {
    const base = e.highwayType === "primary" || e.highwayType === "secondary" ? 0.25 : 0.15;
    e.density = Math.min(0.95, Math.max(0, base + (rng() - 0.4) * 0.5));
  }
}

/** True when every node is reachable (directed) from node 0. */
export function validateGraphConnectivity(graph: RoadGraph): boolean {
  if (graph.nodes.length === 0) return false;
  const seen = new Set<number>([graph.nodes[0].id]);
  const stack = [graph.nodes[0].id];
  while (stack.length) {
    const n = stack.pop()!;
    for (const eId of graph.out.get(n) ?? []) {
      const to = graph.edgesById.get(eId)!.to;
      if (!seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen.size === graph.nodes.length;
}

export function edgeTravelTime(e: RoadEdge): number {
  return e.baseTravelTime * (1 + 2 * e.density);
}

export function nearestNode(graph: RoadGraph, x: number, y: number): number {
  let best = graph.nodes[0].id;
  let bestD = Infinity;
  for (const n of graph.nodes) {
    const d = dist(n.x, n.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = n.id;
    }
  }
  return best;
}

export function routeEdges(graph: RoadGraph, nodePath: number[]): number[] {
  const ids: number[] = [];
  for (let i = 0; i < nodePath.length - 1; i++) {
    const a = nodePath[i];
    const b = nodePath[i + 1];
    const e = graph.out.get(a)!.map((id) => graph.edgesById.get(id)!).find((e) => e.to === b);
    if (!e) return ids; // invalid transition guard
    ids.push(e.id);
  }
  return ids;
}

export function routeLength(graph: RoadGraph, edgeIds: number[]): number {
  let len = 0;
  for (const id of edgeIds) len += graph.edgesById.get(id)!.length;
  return len;
}

export function routeEstimatedTime(graph: RoadGraph, edgeIds: number[]): number {
  let t = 0;
  for (const id of edgeIds) t += edgeTravelTime(graph.edgesById.get(id)!);
  return t;
}

/** Depots: simulated ambulance bases at the 4 most "central" border nodes. */
export function pickDepots(graph: RoadGraph, count = 4): number[] {
  const { minX, minY, maxX, maxY } = graph.bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sorted = [...graph.nodes].sort(
    (a, b) => dist(a.x, a.y, cx, cy) - dist(b.x, b.y, cx, cy),
  );
  // prefer nodes at least 250m from center for realism
  const far = sorted.filter((n) => dist(n.x, n.y, cx, cy) > 250);
  const pool = far.length >= count ? far : sorted;
  const picked: number[] = [];
  for (const n of pool) {
    if (picked.every((p) => dist(graph.nodesById.get(p)!.x, graph.nodesById.get(p)!.y, n.x, n.y) > 300)) {
      picked.push(n.id);
      if (picked.length === count) break;
    }
  }
  if (picked.length === 0) picked.push(sorted[0].id);
  return picked;
}

export function buildingsForGraph(graph: RoadGraph, seed = settings.seed): { x: number; y: number; w: number; d: number; h: number; rot: number }[] {
  const rng = makeRng(seed * 7 + 1);
  const out: { x: number; y: number; w: number; d: number; h: number; rot: number }[] = [];
  const { minX, minY, maxX, maxY } = graph.bounds;
  const step = 26;
  for (let x = minX + step; x < maxX; x += step) {
    for (let y = minY + step; y < maxY; y += step) {
      if (rng() < 0.45) continue;
      // reject positions too close to any node (roads radiate from nodes)
      let nearRoad = false;
      for (const n of graph.nodes) {
        if (dist(n.x, n.y, x, y) < 16) {
          nearRoad = true;
          break;
        }
      }
      if (nearRoad) continue;
      out.push({
        x: x + (rng() - 0.5) * 8,
        y: y + (rng() - 0.5) * 8,
        w: 8 + rng() * 10,
        d: 8 + rng() * 10,
        h: 4 + rng() * 14,
        rot: rng() * Math.PI,
      });
      if (out.length >= 900) return out;
    }
  }
  void trafficSettings;
  return out;
}
