/**
 * Dispatch-origin correctness suite (incident regression).
 *
 * Two real bugs fixed and pinned here:
 *  1. STALE SPLIT: when the dispatch hospital differs from the treatment
 *     hospital, the dispatch access node was inserted with an edge id
 *     captured BEFORE the treatment insert renumbered all edges — the node
 *     was attached to an UNRELATED road, producing phantom geometry through
 *     buildings and a corrupted ambulance start.
 *  2. FLAT MEASURE: hospital travel time used the snapped edge's `from`
 *     junction, ignoring the along-edge offset and one-way direction, so a
 *     physically near hospital could be scored unreachable and never be
 *     chosen as the ambulance's dispatch origin.
 */
import { describe, it, expect } from "vitest";
import { generateDemoGrid, buildGraph } from "../network";
import { approachTimeToSnap, astar, exitTimeFromSnap } from "../baselines";
import { runDispatchFlow } from "../dispatchFlow";
import { getController } from "../simulation";
import { toLocal, makeProjection } from "../geo";
import type { LatLng, LocalPt, RoadGraph } from "../types";

const center: LatLng = { lat: 13.0827, lng: 80.2707 };

const dLat = (m: number) => m / 111320;
const dLng = (m: number) => m / (111320 * Math.cos((center.lat * Math.PI) / 180));

/** distance from p to segment ab */
function pointSegDist(p: LocalPt, a: LocalPt, b: LocalPt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** all segments of the pristine (pre-insert) road set */
function pristineSegments(g: RoadGraph): { a: LocalPt; b: LocalPt }[] {
  const segs: { a: LocalPt; b: LocalPt }[] = [];
  for (const e of g.edges) for (let i = 0; i < e.geom.length - 1; i++) segs.push({ a: e.geom[i], b: e.geom[i + 1] });
  return segs;
}

/** Every out-edge of node must leave ALONG a real road: its first segment's
 * midpoint must lie on the pristine network (max 0.75 m off). */
function assertOutEdgesOnRoad(graph: RoadGraph, node: number, segs: { a: LocalPt; b: LocalPt }[], label: string) {
  const outs = (graph.out.get(node) ?? []).map((id) => graph.edgesById.get(id)!);
  expect(outs.length, `${label}: access node must connect to the road network`).toBeGreaterThan(0);
  const n = graph.nodesById.get(node)!;
  for (const e of outs) {
    const p1 = e.geom[1] ?? e.geom[0];
    const mid: LocalPt = { x: (n.x + p1.x) / 2, y: (n.y + p1.y) / 2 };
    const minD = Math.min(...segs.map((s) => pointSegDist(mid, s.a, s.b)));
    expect(minD, `${label}: out-edge leaves the road network (phantom segment — likely stale split)`).toBeLessThan(0.75);
  }
}

function hospitalElement(id: number, lat: number, lng: number, tags: Record<string, string>) {
  return { type: "node" as const, id, lat, lng, tags };
}

describe("dispatch origin (stale edge-split regression)", () => {
  it("attaches every access node to its OWN road when dispatch hospital != treatment hospital", async () => {
    const patient: LatLng = { lat: center.lat + dLat(120), lng: center.lng + dLng(120) };
    // pristine reference: the SAME deterministic demo grid the flow builds
    // (flow passes `patient` as center — same seed, same frame)
    const pristine = generateDemoGrid(patient);
    const segs = pristineSegments(pristine.graph);

    // near hospital (will be dispatch origin — closest by road)
    const nearH = hospitalElement(1, center.lat + dLat(150), center.lng + dLng(150), {
      amenity: "hospital", name: "Near General Hospital",
    });
    // far hospital (will be treatment — cardiology specialty match)
    const farH = hospitalElement(2, center.lat - dLat(380), center.lng - dLng(380), {
      amenity: "hospital", name: "Far Cardiac Centre", emergency: "yes",
      "healthcare:specialty": "cardiology", phone: "x", website: "x", "addr:street": "x",
    });

    const res = await runDispatchFlow(patient, "Heart emergency", {
      fetchRoads: async () => ({ ok: false as const, error: "offline (unit test)" }), // -> deterministic demo grid
      fetchHospitals: async () => ({ ok: true as const, elements: [nearH, farH] }),
      saveManifest: async () => undefined,
    });

    expect(res.ok, res.ok ? "" : res.error).toBe(true);
    if (!res.ok) return;
    // treatment: cardiac specialty match; dispatch: nearest by road time
    expect(res.hospital!.name).toContain("Cardiac");
    expect(res.dispatchHospital!.name).toContain("Near");
    expect(res.dispatchHospital!.id).not.toBe(res.hospital!.id); // exercise the two-insert path

    const ctrl = getController();
    assertOutEdgesOnRoad(ctrl.graph, ctrl.patientNode, segs, "patient access");
    assertOutEdgesOnRoad(ctrl.graph, ctrl.hospitalNode, segs, "treatment-hospital access");
    assertOutEdgesOnRoad(ctrl.graph, ctrl.depotNode, segs, "dispatch-hospital access");

    // ambulance physically departs from the dispatch hospital's access point
    const depot = ctrl.graph.nodesById.get(ctrl.depotNode)!;
    const proj = makeProjection(center);
    const hpt = toLocal(proj, { lat: nearH.lat, lng: nearH.lng });
    expect(Math.hypot(depot.x - hpt.x, depot.y - hpt.y)).toBeLessThan(150);
  });
});

describe("hospital travel metrics (offset + one-way aware)", () => {
  it("counts the along-edge offset instead of measuring from the edge's from-junction", () => {
    // U --w1--> V --w2--> P ; hospital sits near V on the two-way w1
    const U: LatLng = { lat: center.lat + dLat(320), lng: center.lng };
    const V: LatLng = { lat: center.lat + dLat(4), lng: center.lng };
    const P: LatLng = { lat: V.lat, lng: center.lng + dLng(320) };
    const raw = {
      ways: [
        { id: 1, nodes: [{ id: 0, ...U }, { id: 1, ...V }], oneway: false, type: "residential", maxspeed: null, lanes: null },
        { id: 2, nodes: [{ id: 1, ...V }, { id: 2, ...P }], oneway: false, type: "residential", maxspeed: null, lanes: null },
      ],
      signals: [], restrictions: [], source: "osm" as const,
    };
    const g = buildGraph(raw, center).graph;
    const nodeId = (ll: LatLng) => g.nodes.find((n) => Math.abs(n.lat - ll.lat) < 1e-9 && Math.abs(n.lng - ll.lng) < 1e-9)!.id;
    const u = nodeId(U), v = nodeId(V), p = nodeId(P);
    // hospital 5 m south of V, on w1 (U->V)
    const hosp: LatLng = { lat: V.lat - dLat(5), lng: V.lng };
    const hx = (hosp.lng - center.lng) * (111320 * Math.cos((center.lat * Math.PI) / 180));
    const hy = (hosp.lat - center.lat) * 111320;
    const w1 = g.edges.find((e) => e.from === u && e.to === v)!;
    const snap = { edgeId: w1.id, arcPos: w1.length - 5, x: hx, y: hy, lat: hosp.lat, lng: hosp.lng, distanceM: 5 };

    const oldCost = astar(g, u, p)!.cost;                 // previous flat metric (from-junction)
    const fixed = approachTimeToSnap(g, p, snap)!;        // patient -> hospital access point
    expect(fixed.cost).toBeLessThan(oldCost - 1);         // offset actually counted
    expect(fixed.cost).toBeLessThanOrEqual(astar(g, v, p)!.cost + 1); // <= via V junction

    const exitOld = astar(g, u, p)!.cost;                 // previous dispatch metric
    const exitFixed = exitTimeFromSnap(g, snap, p)!;      // hospital access -> patient
    expect(exitFixed.cost).toBeLessThan(exitOld - 1);
  });

  it("one-way access: exit forward only; never through the closed direction", () => {
    // A ->(oneway) B ->(oneway) C ; hospital just inside A->B, patient at C
    const A: LatLng = { lat: center.lat + dLat(300), lng: center.lng };
    const B: LatLng = { lat: center.lat + dLat(4), lng: center.lng };
    const C: LatLng = { lat: center.lat, lng: center.lng + dLng(300) };
    const raw = {
      ways: [
        { id: 1, nodes: [{ id: 0, ...A }, { id: 1, ...B }], oneway: true, type: "residential", maxspeed: null, lanes: null },
        { id: 2, nodes: [{ id: 1, ...B }, { id: 2, ...C }], oneway: true, type: "residential", maxspeed: null, lanes: null },
      ],
      signals: [], restrictions: [], source: "osm" as const,
    };
    const g = buildGraph(raw, center).graph;
    const nodeId = (ll: LatLng) => g.nodes.find((n) => Math.abs(n.lat - ll.lat) < 1e-9 && Math.abs(n.lng - ll.lng) < 1e-9)!.id;
    const a = nodeId(A), c = nodeId(C);
    const hosp: LatLng = { lat: A.lat - dLat(3), lng: A.lng };
    const w1 = g.edges.find((e) => e.from === a && e.to === nodeId(B))!;
    const snap = { edgeId: w1.id, arcPos: 3, x: 0, y: 0, lat: hosp.lat, lng: hosp.lng, distanceM: 3 };

    // forward exit (to B, then to C) is legal and strictly cheaper than the
    // old from-junction measure (which included the full first edge)
    const exit = exitTimeFromSnap(g, snap, c)!;
    expect(exit.cost).toBeGreaterThan(0);
    expect(exit.cost).toBeLessThan(astar(g, a, c)!.cost);
    // destination in the CLOSED direction (back behind A) is unreachable
    expect(exitTimeFromSnap(g, snap, a)).toBeNull();
  });
});
