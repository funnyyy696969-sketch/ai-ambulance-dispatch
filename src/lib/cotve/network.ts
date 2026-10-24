import { settings, makeRng, trafficSettings } from "./config";
import { makeProjection, toLocal, toLatLng, dist, type Projection } from "./geo";
import type {
  LatLng,
  LocalPt,
  NetworkValidation,
  RoadEdge,
  RoadGraph,
  RoadNode,
  RoadSnap,
  TurnRestriction,
} from "./types";

/** Raw OSM ways as delivered by the Convex Overpass action (or the smoke
 * script). `nodes` is the FULL way geometry in order, junction or not. */
export interface RawWay {
  id: number;
  nodes: { id: number; lat: number; lng: number }[];
  oneway: boolean;
  type: string;
  maxspeed: number | null;
  lanes: number | null;
}

export interface RawRestriction {
  viaLat: number;
  viaLng: number;
  fromWay: number;
  toWay: number;
  restriction: string;
}

export interface RawOsmNetwork {
  ways: RawWay[];
  /** coords of real highway=traffic_signals nodes */
  signals: { lat: number; lng: number }[];
  restrictions: RawRestriction[];
  source: "osm" | "demo-grid";
}

export interface BuiltGraph {
  graph: RoadGraph;
  projection: Projection;
}

const SPEED_DEFAULTS: Record<string, number> = {
  motorway: 27, trunk: 22, primary: 16, secondary: 13, tertiary: 11,
  residential: 8, unclassified: 8, living_street: 6, service: 5, demo: 12,
};

function cumulative(pts: LocalPt[]): number[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y));
  }
  return cum;
}

function makeEdge(
  id: number, from: number, to: number, geom: LocalPt[],
  w: RawWay, density = 0,
): RoadEdge | null {
  const cum = cumulative(geom);
  const length = cum[cum.length - 1];
  if (!Number.isFinite(length) || length <= 0.5) return null;
  const speed = w.maxspeed ?? SPEED_DEFAULTS[w.type] ?? 10;
  return {
    id, from, to, length, highwayType: w.type, speedLimit: speed,
    baseTravelTime: length / speed, oneway: w.oneway, density,
    geom, cum, wayId: w.id, lanes: w.lanes, blocked: false,
  };
}

/** A coordinate is a junction when: shared by >=2 ways, an endpoint of a way,
 * or carries a real traffic-signal tag. Everything else stays a shape point
 * inside an edge's polyline — preserving the real road curvature. */
export function buildGraph(raw: RawOsmNetwork, center: LatLng): BuiltGraph {
  const proj = makeProjection(center);
  const keyOf = (lat: number, lng: number) => {
    const p = toLocal(proj, { lat, lng });
    return `${Math.round(p.x / 2)},${Math.round(p.y / 2)}`;
  };
  const signalKeys = new Set(raw.signals.map((s) => keyOf(s.lat, s.lng)));

  const wayCount = new Map<string, number>();
  for (const w of raw.ways) {
    for (const n of w.nodes) {
      const k = keyOf(n.lat, n.lng);
      wayCount.set(k, (wayCount.get(k) ?? 0) + 1);
    }
  }
  const isJunction = (k: string, i: number, len: number) =>
    i === 0 || i === len - 1 || (wayCount.get(k) ?? 0) >= 2 || signalKeys.has(k);

  // materialize junction nodes
  const nodes: RoadNode[] = [];
  const nodeByKey = new Map<string, number>();
  const ensureNode = (lat: number, lng: number, signal: boolean): number => {
    const k = keyOf(lat, lng);
    let id = nodeByKey.get(k);
    if (id === undefined) {
      const p = toLocal(proj, { lat, lng });
      id = nodes.length;
      nodes.push({
        id, x: p.x, y: p.y, lat, lng, degree: 0, signalized: false,
        ...(signal ? { signalSource: "osm" as const } : {}),
      });
      nodeByKey.set(k, id);
    } else if (signal && nodes[id].signalSource !== "osm") {
      nodes[id].signalSource = "osm";
    }
    return id;
  };

  // split ways at junctions -> edges with full polylines
  const edges: RoadEdge[] = [];
  for (const w of raw.ways) {
    if (!w.nodes || w.nodes.length < 2) continue;
    let runStart = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      const last = i === w.nodes.length - 1;
      const k = keyOf(w.nodes[i].lat, w.nodes[i].lng);
      if (!last && !isJunction(k, i, w.nodes.length)) continue;
      // geometry of run [runStart..i]
      const pts: LocalPt[] = [];
      for (let j = runStart; j <= i; j++) {
        const p = toLocal(proj, { lat: w.nodes[j].lat, lng: w.nodes[j].lng });
        pts.push({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });
      }
      const aKey = keyOf(w.nodes[runStart].lat, w.nodes[runStart].lng);
      const a = ensureNode(w.nodes[runStart].lat, w.nodes[runStart].lng, signalKeys.has(aKey));
      const b = ensureNode(w.nodes[i].lat, w.nodes[i].lng, signalKeys.has(k));
      if (a !== b) {
        const e = makeEdge(edges.length, a, b, pts, w);
        if (e) {
          edges.push(e);
          nodes[a].degree++;
          nodes[b].degree++;
          // two-way ways get a real reverse edge with reversed geometry
          if (!w.oneway) {
            const rev = makeEdge(edges.length, b, a, [...pts].reverse(), w);
            if (rev) edges.push(rev);
          }
        }
      }
      runStart = i;
    }
  }

  // largest connected component (undirected view), honest drop counts
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  }
  const visited = new Array(nodes.length).fill(false);
  let best: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    visited[i] = true;
    while (stack.length) {
      const n = stack.pop()!;
      comp.push(n);
      for (const m of adj[n]) if (!visited[m]) { visited[m] = true; stack.push(m); }
    }
    if (comp.length > best.length) best = comp;
  }
  const keep = new Set(best);
  const remap = new Map<number, number>();
  const fNodes: RoadNode[] = [];
  for (const n of nodes) {
    if (!keep.has(n.id)) continue;
    remap.set(n.id, fNodes.length);
    fNodes.push({ ...n, id: fNodes.length });
  }
  const fEdges: RoadEdge[] = [];
  for (const e of edges) {
    const from = remap.get(e.from);
    const to = remap.get(e.to);
    if (from === undefined || to === undefined) continue;
    fEdges.push({ ...e, id: fEdges.length, from, to });
  }

  // real turn restrictions at surviving junctions
  const turnRestrictions = new Map<number, TurnRestriction[]>();
  let restrictionsApplied = 0;
  for (const r of raw.restrictions ?? []) {
    const k = keyOf(r.viaLat, r.viaLng);
    const via = nodeByKey.get(k);
    const viaNew = via !== undefined ? remap.get(via) : undefined;
    if (viaNew === undefined) continue;
    const list = turnRestrictions.get(viaNew) ?? [];
    list.push({ fromWay: r.fromWay, toWay: r.toWay, restriction: r.restriction });
    turnRestrictions.set(viaNew, list);
    restrictionsApplied++;
  }

  const graph: RoadGraph = {
    source: raw.source,
    center,
    nodes: fNodes,
    nodesById: new Map(fNodes.map((n) => [n.id, n])),
    out: new Map(fNodes.map((n) => [n.id, []])),
    edges: fEdges,
    edgesById: new Map(fEdges.map((e) => [e.id, e])),
    bounds: boundsOf(fNodes),
    turnRestrictions,
    signalNodeCount: fNodes.filter((n) => n.signalSource === "osm").length,
    droppedNodes: nodes.length - fNodes.length,
    droppedEdges: edges.length - fEdges.length,
  };
  void restrictionsApplied;
  for (const e of fEdges) graph.out.get(e.from)!.push(e.id);
  markSignalized(graph);
  return { graph, projection: proj };
}

/** Signal policy: real OSM signal tags always win. On demo grids, major
 * junctions get labeled "inferred" signals; on OSM networks only real
 * tagged signal nodes are signalized. */
function markSignalized(graph: RoadGraph) {
  for (const n of graph.nodes) {
    if (n.signalSource === "osm") n.signalized = true;
  }
  if (graph.source === "demo-grid") {
    const budget = Math.floor(graph.nodes.length / 3);
    let count = graph.nodes.filter((n) => n.signalized).length;
    for (const n of graph.nodes) {
      if (n.signalized || n.degree < 4 || count >= budget) continue;
      n.signalized = true;
      n.signalSource = "inferred";
      count++;
    }
  }
  for (const n of graph.nodes) {
    if (!n.signalized) continue;
    const axes: [number[], number[]] = [[], []];
    for (const eId of graph.out.get(n.id) ?? []) {
      const e = graph.edgesById.get(eId)!;
      const b = graph.nodesById.get(e.to)!;
      const ang = (Math.atan2(b.y - n.y, b.x - n.x) * 180) / Math.PI;
      axes[Math.abs(Math.abs(ang) - 90) < 35 ? 0 : 1].push(eId);
    }
    n.signalAxes = axes;
  }
}

function boundsOf(nodes: RoadNode[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Synthetic DEMONSTRATION grid (never claimed as real geography): a GxG
 * lattice expressed as ways so it flows through the same builder. */
export function generateDemoGrid(center: LatLng, seed = settings.seed): BuiltGraph {
  const rng = makeRng(seed);
  const g = settings.demoGridSize;
  const sp = settings.demoGridSpacingM;
  const half = ((g - 1) * sp) / 2;
  const latPerM = 1 / 111320;
  const lngPerM = 1 / (111320 * Math.cos((center.lat * Math.PI) / 180));
  const idOf = (r: number, c: number) => r * g + c;
  const pt = (r: number, c: number) => ({
    id: idOf(r, c),
    lat: center.lat + (c * sp - half) * latPerM * 0 + (r * sp - half) * latPerM,
    lng: center.lng + (c * sp - half) * lngPerM,
  });
  const ways: RawWay[] = [];
  let wid = 1;
  const seg = (r1: number, c1: number, r2: number, c2: number, type: string) => {
    // gentle curve at midpoints so even demo geometry is non-linear
    const a = pt(r1, c1);
    const b = pt(r2, c2);
    const off = (rng() - 0.5) * sp * 0.08;
    const mid = {
      id: -1,
      lat: (a.lat + b.lat) / 2 + off * latPerM,
      lng: (a.lng + b.lng) / 2 - off * lngPerM,
    };
    ways.push({ id: wid++, nodes: [a, mid, b], oneway: false, type, maxspeed: null, lanes: null });
  };
  for (let r = 0; r < g; r++) {
    for (let c = 0; c < g; c++) {
      if (c < g - 1) seg(r, c, r, c + 1, r % 3 === 0 ? "secondary" : "residential");
      if (r < g - 1) seg(r, c, r + 1, c, c % 3 === 0 ? "secondary" : "residential");
    }
  }
  const graph = buildGraph({ ways, signals: [], restrictions: [], source: "demo-grid" }, center);
  seedCongestion(graph.graph, makeRng(seed));
  return graph;
}

export function seedCongestion(graph: RoadGraph, rng: () => number) {
  for (const e of graph.edges) {
    const base = e.highwayType === "primary" || e.highwayType === "secondary" ? 0.25 : 0.15;
    e.density = Math.min(0.95, Math.max(0, base + (rng() - 0.4) * 0.5));
  }
}

export function edgeTravelTime(e: RoadEdge): number {
  return e.baseTravelTime * (1 + 2 * e.density);
}

/** Position + heading at arc position s along an edge's real geometry. */
export function edgePoseAt(e: RoadEdge, s: number): { x: number; y: number; heading: number } {
  const s2 = Math.max(0, Math.min(s, e.length));
  let i = 1;
  while (i < e.cum.length - 1 && e.cum[i] < s2) i++;
  const a = e.geom[i - 1];
  const b = e.geom[i];
  const segLen = e.cum[i] - e.cum[i - 1] || 1;
  const t = (s2 - e.cum[i - 1]) / segLen;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    heading: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

/** Snap a geographical point to the nearest point on any road segment.
 * Returns null when farther than maxSnapM from every road. */
export function snapToRoad(graph: RoadGraph, proj: Projection, x: number, y: number, maxSnapM: number): RoadSnap | null {
  let best: RoadSnap | null = null;
  for (const e of graph.edges) {
    for (let i = 1; i < e.geom.length; i++) {
      const a = e.geom[i - 1];
      const b = e.geom[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const d = Math.hypot(px - x, py - y);
      if (!best || d < best.distanceM) {
        const ll = toLatLng(proj, px, py);
        best = { edgeId: e.id, arcPos: e.cum[i - 1] + t * (e.cum[i] - e.cum[i - 1]), x: px, y: py, lat: ll.lat, lng: ll.lng, distanceM: d };
      }
    }
  }
  if (!best || best.distanceM > maxSnapM) return null;
  return best;
}

/** Rebuild adjacency + edge ids after structural mutation. */
export function rebuildAdjacency(graph: RoadGraph) {
  graph.edges.forEach((e, i) => (e.id = i));
  graph.edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  graph.nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  graph.out = new Map(graph.nodes.map((n) => [n.id, []]));
  for (const e of graph.edges) graph.out.get(e.from)!.push(e.id);
  graph.bounds = boundsOf(graph.nodes);
}

/** Split the road at the snap point and insert a real road-access node.
 * Respects direction: oneway edges split once, two-way pairs both. */
export function insertAccessNode(graph: RoadGraph, snap: RoadSnap, label: string): number {
  const e = graph.edgesById.get(snap.edgeId)!;
  const proj = makeProjection(graph.center);
  const ll = toLatLng(proj, snap.x, snap.y);
  const nid = graph.nodes.length;
  graph.nodes.push({ id: nid, x: snap.x, y: snap.y, lat: ll.lat, lng: ll.lng, degree: 2, signalized: false, isAccess: true, accessLabel: label });

  const splitEdge = (edge: RoadEdge, s: number) => {
    const cut = edge.geom.findIndex((_, i) => edge.cum[i] >= s);
    const i = Math.max(1, Math.min(cut === -1 ? edge.geom.length - 1 : cut, edge.geom.length - 1));
    const head = edge.geom.slice(0, i);
    head.push({ x: snap.x, y: snap.y });
    const tail = [{ x: snap.x, y: snap.y }, ...edge.geom.slice(i)];
    return { head, tail };
  };

  const doSplit = (edge: RoadEdge, s: number) => {
    const { head, tail } = splitEdge(edge, s);
    const w: RawWay = { id: edge.wayId, nodes: [], oneway: edge.oneway, type: edge.highwayType, maxspeed: edge.speedLimit, lanes: edge.lanes };
    const e1 = makeEdge(-1, edge.from, nid, head, w, edge.density);
    const e2 = makeEdge(-1, nid, edge.to, tail, w, edge.density);
    graph.edges = graph.edges.filter((x) => x.id !== edge.id);
    if (e1) graph.edges.push(e1);
    if (e2) graph.edges.push(e2);
  };

  doSplit(e, snap.arcPos);
  // two-way counterpart: split at mirrored arc position
  if (!e.oneway) {
    const rev = graph.edges.find((x) => x.from === e.to && x.to === e.from && x.wayId === e.wayId && x.id !== snap.edgeId);
    if (rev) doSplit(rev, rev.length - snap.arcPos);
  }
  rebuildAdjacency(graph);
  graph.nodesById.get(e.from)!.degree++;
  graph.nodesById.get(e.to)!.degree++;
  return nid;
}

/** True when the turn fromEdge -> toEdge is permitted at their shared
 * junction, honoring real OSM `no_*` restrictions. */
export function isTurnAllowed(graph: RoadGraph, fromEdge: RoadEdge, toEdge: RoadEdge): boolean {
  if (toEdge.from !== fromEdge.to) return false;
  if (fromEdge.to === fromEdge.from) return false;
  const rs = graph.turnRestrictions.get(toEdge.from);
  if (!rs || rs.length === 0) return true;
  for (const r of rs) {
    if (r.fromWay !== fromEdge.wayId || r.toWay !== toEdge.wayId) continue;
    if (r.restriction.startsWith("no_")) return false;
  }
  return true;
}

export function validateNetwork(graph: RoadGraph): NetworkValidation {
  const issues: NetworkValidation["issues"] = [];
  let invalidLengths = 0;
  let missingGeometry = 0;
  for (const e of graph.edges) {
    if (!e.geom || e.geom.length < 2) missingGeometry++;
    else if (!Number.isFinite(e.length) || e.length <= 0.5) invalidLengths++;
  }
  if (missingGeometry) issues.push({ severity: "error", kind: "missing-geometry", detail: `${missingGeometry} edges without valid polyline geometry` });
  if (invalidLengths) issues.push({ severity: "error", kind: "invalid-length", detail: `${invalidLengths} edges with invalid length` });

  const seen = new Set<number>([graph.nodes[0]?.id ?? 0]);
  const stack = [graph.nodes[0]?.id ?? 0];
  while (stack.length) {
    const n = stack.pop()!;
    for (const id of graph.out.get(n) ?? []) {
      const to = graph.edgesById.get(id)!.to;
      if (!seen.has(to)) { seen.add(to); stack.push(to); }
    }
  }
  const components = seen.size === graph.nodes.length ? 1 : 2;
  if (components > 1) issues.push({ severity: "warning", kind: "disconnected", detail: "graph has disconnected components (largest kept, rest reported)" });

  let isolated = 0;
  for (const n of graph.nodes) if ((graph.out.get(n.id) ?? []).length === 0) isolated++;
  if (isolated) issues.push({ severity: "warning", kind: "isolated", detail: `${isolated} nodes with no outgoing edge` });
  if (graph.droppedNodes) issues.push({ severity: "warning", kind: "dropped", detail: `${graph.droppedNodes} nodes / ${graph.droppedEdges} edges dropped during construction` });

  return {
    ok: !issues.some((i) => i.severity === "error"),
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    components,
    isolatedNodes: isolated,
    invalidLengths,
    missingGeometry,
    droppedNodes: graph.droppedNodes,
    droppedEdges: graph.droppedEdges,
    turnRestrictions: [...graph.turnRestrictions.values()].reduce((a, b) => a + b.length, 0),
    issues,
  };
}

export function nearestNode(graph: RoadGraph, x: number, y: number): number {
  let best = graph.nodes[0].id;
  let bestD = Infinity;
  for (const n of graph.nodes) {
    const d = dist(n.x, n.y, x, y);
    if (d < bestD) { bestD = d; best = n.id; }
  }
  return best;
}

/** Geometry-true polyline of a route (local meters). */
export function routePolyline(graph: RoadGraph, edgeIds: number[]): LocalPt[] {
  const pts: LocalPt[] = [];
  for (const id of edgeIds) {
    const e = graph.edgesById.get(id);
    if (!e) continue;
    for (let i = pts.length === 0 ? 0 : 1; i < e.geom.length; i++) pts.push(e.geom[i]);
  }
  return pts;
}

export function routeLength(graph: RoadGraph, edgeIds: number[]): number {
  let len = 0;
  for (const id of edgeIds) len += graph.edgesById.get(id)?.length ?? 0;
  return len;
}

export function routeEstimatedTime(graph: RoadGraph, edgeIds: number[]): number {
  let t = 0;
  for (const id of edgeIds) t += graph.edgesById.get(id) ? edgeTravelTime(graph.edgesById.get(id)!) : 0;
  return t;
}

/** Simulated ambulance depots (labeled simulated): central-ish nodes away
 * from each other, snapped on real graph nodes. */
export function pickDepots(graph: RoadGraph, count = 4): number[] {
  const { minX, minY, maxX, maxY } = graph.bounds;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const sorted = [...graph.nodes].sort((a, b) => dist(a.x, a.y, cx, cy) - dist(b.x, b.y, cx, cy));
  const far = sorted.filter((n) => dist(n.x, n.y, cx, cy) > 250);
  const pool = far.length >= count ? far : sorted;
  const picked: number[] = [];
  for (const n of pool) {
    if (picked.every((p) => dist(graph.nodesById.get(p)!.x, graph.nodesById.get(p)!.y, n.x, n.y) > 300)) {
      picked.push(n.id);
      if (picked.length === count) break;
    }
  }
  return picked.length ? picked : [sorted[0].id];
}

export function buildingsForGraph(graph: RoadGraph, seed = settings.seed) {
  const rng = makeRng(seed * 7 + 1);
  const out: { x: number; y: number; w: number; d: number; h: number; rot: number }[] = [];
  const { minX, minY, maxX, maxY } = graph.bounds;
  const step = 30;
  for (let x = minX + step; x < maxX; x += step) {
    for (let y = minY + step; y < maxY; y += step) {
      if (rng() < 0.5) continue;
      let nearRoad = false;
      for (const n of graph.nodes) {
        if (dist(n.x, n.y, x, y) < 18) { nearRoad = true; break; }
      }
      if (nearRoad) continue;
      out.push({ x: x + (rng() - 0.5) * 8, y: y + (rng() - 0.5) * 8, w: 8 + rng() * 10, d: 8 + rng() * 10, h: 4 + rng() * 14, rot: rng() * Math.PI });
      if (out.length >= 900) return out;
    }
  }
  void trafficSettings;
  return out;
}

export { makeProjection };
