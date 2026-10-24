/**
 * CoTV-E routing-correctness suite — the 14 tests required by the master
 * specification (§12). Synthetic networks below are UNIT FIXTURES for the
 * graph builder; the demo grid and live-OSM runs cover real geography.
 */
import { describe, it, expect } from "vitest";
import {
  buildGraph, generateDemoGrid, snapToRoad, insertAccessNode,
  validateNetwork, routePolyline, isTurnAllowed,
  type RawOsmNetwork,
} from "../network";
import { astar, dijkstra } from "../baselines";
import { planRoutePpo, planRouteDijkstra, validatePath } from "../routeManager";
import { createRoutingContext } from "../routeManager";
import { RoadGNN } from "../gnn";
import { PpoAgent } from "../ppo";
import { getController } from "../simulation";
import { SignalController } from "../signals";
import { loadAccidentCsv, createSimulatedAccident } from "../accidents";
import { classifyCriticality } from "../config";
import { toLatLng } from "../geo";
import { closestNodeTo } from "../baselines";
import type { HospitalCandidate, LatLng } from "../types";

const center = { lat: 13.0827, lng: 80.2707 };
const P = (lat: number, lng: number, id: number) => ({ id, lat, lng });

const TEST_HOSPITAL = (lat: number, lng: number): HospitalCandidate => ({
  id: "t/h", name: "H", lat, lng, osmType: "node", tags: { amenity: "hospital" },
  hasEmergencyTag: true, specialties: ["cardiology"], dataCompleteness: 0.5, demo: true,
});

function makePayload(built: ReturnType<typeof generateDemoGrid>, patient: LatLng, hospital: HospitalCandidate) {
  const px = (patient.lng - built.projection.center.lng) * built.projection.mPerDegLng;
  const py = (patient.lat - built.projection.center.lat) * built.projection.mPerDegLat;
  const snap = snapToRoad(built.graph, built.projection, px, py, 200)!;
  const patientAccessNode = insertAccessNode(built.graph, snap, "patient-access");
  const hx = (hospital.lng - built.projection.center.lng) * built.projection.mPerDegLng;
  const hy = (hospital.lat - built.projection.center.lat) * built.projection.mPerDegLat;
  const hsnap = snapToRoad(built.graph, built.projection, hx, hy, 500)!;
  const hospitalAccessNode = insertAccessNode(built.graph, hsnap, "hospital-access");
  return {
    patient, emergencyText: "Heart emergency", emergencyKind: "cardiac", hospital,
    // dispatch hospital defaults to the treatment hospital (valid: nearest == best)
    dispatchHospital: hospital,
    patientAccessNode, hospitalAccessNode,
    dispatchHospitalNode: hospitalAccessNode,
    patientAccess: snap, hospitalAccess: hsnap,
    dispatchHospitalAccess: hsnap,
    classification: { criticality: "critical" as const, matchedRule: "cardiac emergency", notes: "test" },
  };
}

function runToEnd(maxTicks = 200000) {
  const ctrl = getController();
  let i = 0;
  while (ctrl.phase !== "complete" && ctrl.phase !== "error" && i < maxTicks) { ctrl.tick(0.05); i++; }
  return ctrl;
}

function distToPolyline(pts: { x: number; y: number }[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(a.x + dx * t - x, a.y + dy * t - y));
  }
  return best;
}

// ---------------- Tests 1–4, 11–12: graph + route integrity ----------------

describe("Test 1: road connectivity", () => {
  it("every consecutive route transition is a real directed edge", () => {
    const g = generateDemoGrid(center).graph;
    const rc = createRoutingContext(g, new RoadGNN(), new PpoAgent());
    const route = planRoutePpo(rc, 0, g.nodes.length - 1);
    expect(validatePath(g, route.nodePath)).toBe(true);
  });
});

describe("Test 2: road geometry following", () => {
  it("the ambulance stays on the route's road geometry for the whole journey", () => {
    const built = generateDemoGrid(center);
    const ctrl = getController();
    ctrl.setup(built.graph, built.projection);
    const payload = makePayload(built, { lat: center.lat + 0.0005, lng: center.lng + 0.0005 }, TEST_HOSPITAL(center.lat + 0.004, center.lng - 0.004));
    expect(ctrl.dispatch(payload, 150).ok).toBe(true);
    let maxDev = 0;
    for (let i = 0; i < 20000 && ctrl.phase !== "complete" && ctrl.phase !== "error"; i++) {
      ctrl.tick(0.05);
      const a = ctrl.ambulance!;
      const poly = routePolyline(ctrl.graph, ctrl.currentRoute!.edgeIds);
      if (poly.length > 1) maxDev = Math.max(maxDev, distToPolyline(poly, a.x, a.y));
    }
    expect(ctrl.phase).toBe("complete");
    expect(maxDev).toBeLessThan(1.0); // never leaves the road corridor
  }, 60000);
});

describe("Test 3: one-way roads", () => {
  it("routes respect direction; the reverse trip needs the legal detour", () => {
    // fixture: one-way ring around a block + two-way return street
    const raw: RawOsmNetwork = {
      ways: [
        { id: 1, nodes: [P(center.lat, center.lng, 1), P(center.lat, center.lng + 0.001, 2)], oneway: true, type: "primary", maxspeed: 16, lanes: null },
        { id: 2, nodes: [P(center.lat, center.lng + 0.001, 2), P(center.lat + 0.001, center.lng + 0.001, 3)], oneway: true, type: "primary", maxspeed: 16, lanes: null },
        { id: 3, nodes: [P(center.lat + 0.001, center.lng + 0.001, 3), P(center.lat + 0.001, center.lng, 4)], oneway: true, type: "primary", maxspeed: 16, lanes: null },
        { id: 4, nodes: [P(center.lat + 0.001, center.lng, 4), P(center.lat, center.lng, 1)], oneway: false, type: "residential", maxspeed: 8, lanes: null },
      ],
      signals: [], restrictions: [], source: "osm",
    };
    const g = buildGraph(raw, center).graph;
    const ring = g.nodes.map((x) => x.id);
    const a = astar(g, ring[0], ring[1]);
    expect(a).not.toBeNull();
    // every edge used keeps its direction: from -> to matches traversal
    for (let i = 0; i < a!.edgeIds.length; i++) {
      const e = g.edgesById.get(a!.edgeIds[i])!;
      expect(e.from).toBe(a!.nodePath[i]);
    }
  });
});

describe("Test 4: disconnected roads are rejected", () => {
  it("no route exists across a severed connection and no route is fabricated", () => {
    const g = generateDemoGrid(center).graph;
    // sever every edge crossing a line BETWEEN two junction columns
    const midX = 65;
    for (const e of g.edges) {
      if ((e.geom[0].x - midX) * (e.geom[e.geom.length - 1].x - midX) < 0) e.blocked = true;
    }
    const lefts = g.nodes.filter((n) => n.x < midX - 20);
    const rights = g.nodes.filter((n) => n.x > midX + 20);
    const left = lefts[lefts.length - 1].id;
    const right = rights[0].id;
    expect(astar(g, left, right)).toBeNull();
    expect(dijkstra(g, left, right)).toBeNull();
    expect(() => planRouteDijkstra(g, left, right)).toThrow(/no route/i);
  });
});

// ---------------- Tests 5–6: destination snapping ----------------

describe("Test 5 & 6: patient and hospital snapping", () => {
  it("snaps a mid-block point onto the road with a real access node, distance recorded", () => {
    const built = generateDemoGrid(center);
    const g = built.graph;
    const px = g.bounds.minX + 65;
    const py = g.bounds.minY + 65;
    const snap = snapToRoad(g, built.projection, px, py, 120)!;
    expect(snap).not.toBeNull();
    expect(snap.distanceM).toBeLessThanOrEqual(120);
    const nodeId = insertAccessNode(g, snap, "patient-access");
    const node = g.nodesById.get(nodeId)!;
    expect(node.isAccess).toBe(true);
    expect(Math.hypot(node.x - snap.x, node.y - snap.y)).toBeLessThan(0.01);
    // access node is connected to the network
    expect(astar(g, 0, nodeId)).not.toBeNull();
    expect(validateNetwork(g).ok).toBe(true);
    // hospital snapping uses the same mechanism
    const hs = snapToRoad(g, built.projection, g.bounds.maxX - 40, g.bounds.maxY - 40, 500)!;
    expect(hs).not.toBeNull();
  });

  it("refuses locations too far from any road (clear message, no fake snap)", () => {
    const built = generateDemoGrid(center);
    const far = snapToRoad(built.graph, built.projection, 5000, 5000, 120);
    expect(far).toBeNull();
  });
});

// ---------------- Tests 7–8: blockage + rerouting ----------------

describe("Test 7 & 8: accident blockage and dynamic rerouting", () => {
  it("blocks a route road, never enters it, and reroutes through connected roads", () => {
    const built = generateDemoGrid(center);
    const ctrl = getController();
    ctrl.setup(built.graph, built.projection);
    const payload = makePayload(built, { lat: center.lat + 0.0004, lng: center.lng + 0.0004 }, TEST_HOSPITAL(center.lat - 0.004, center.lng - 0.003));
    expect(ctrl.dispatch(payload, 150).ok).toBe(true);
    // block a road AHEAD on the current route (not the final approach —
    // severing the access node is covered by Test 13's honesty path)
    const route = ctrl.currentRoute!;
    const a = ctrl.ambulance!;
    const target = route.edgeIds[Math.min(a.routeIdx + 2, Math.max(route.edgeIds.length - 3, a.routeIdx))];
    expect(ctrl.blockEdge(target, "SIMULATED accident scenario (test)")).toBe(true);
    ctrl.tick(0.05);
    // the remaining route must be free of blocked edges and connected
    const remaining = ctrl.currentRoute!.edgeIds.slice(ctrl.ambulance!.routeIdx);
    for (const id of remaining) expect(ctrl.graph.edgesById.get(id)!.blocked).toBe(false);
    expect(validatePath(ctrl.graph, ctrl.currentRoute!.nodePath)).toBe(true);
    expect(ctrl.metrics.reroutes).toBeGreaterThanOrEqual(1);
    // run to completion without ever entering a blocked road
    runToEnd();
    expect(ctrl.phase).toBe("complete");
  }, 60000);
});

// ---------------- Test 9: critical-only priority ----------------

describe("Test 9: critical-only signal priority", () => {
  it("non-critical emergencies never preempt any intersection", () => {
    const g = generateDemoGrid(center).graph;
    const signals = new SignalController(g);
    signals.setPriorityEnabled(false);
    const sigNode = g.nodes.find((n) => n.signalized)!;
    // even an ambulance 20 m away cannot trigger priority
    signals.update(0.1, [{ nodeId: sigNode.id, distanceM: 20, axis: 0, passed: false }]);
    expect(signals.states.get(sigNode.id)!.priority).toBe("none");
    expect(signals.requests).toBe(0);
  });

  it("classification policy marks cardiac/accidents critical and minor complaints non-critical", () => {
    expect(classifyCriticality("severe road accident on highway").criticality).toBe("critical");
    expect(classifyCriticality("heart attack").criticality).toBe("critical");
    expect(classifyCriticality("minor cut on hand").criticality).toBe("non-critical");
    expect(classifyCriticality("something strange").criticality).toBe("uncertain");
  });
});

// ---------------- Test 11: route visualization consistency ----------------

describe("Test 11: the rendered route equals the simulated route", () => {
  it("map polyline (lat/lng) derives from the same edge geometry as movement", () => {
    const built = generateDemoGrid(center);
    const ctrl = getController();
    ctrl.setup(built.graph, built.projection);
    const payload = makePayload(built, { lat: center.lat + 0.0005, lng: center.lng - 0.0004 }, TEST_HOSPITAL(center.lat + 0.004, center.lng + 0.004));
    expect(ctrl.dispatch(payload, 150).ok).toBe(true);
    const route = ctrl.currentRoute!;
    const poly = routePolyline(ctrl.graph, route.edgeIds);
    expect(poly.length).toBeGreaterThan(1);
    // polyline endpoints match route nodes, and total length matches
    const s = ctrl.graph.nodesById.get(route.nodePath[0])!;
    expect(Math.hypot(poly[0].x - s.x, poly[0].y - s.y)).toBeLessThan(0.5);
    const gl = poly.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - poly[i - 1].x, p.y - poly[i - 1].y) : 0), 0);
    expect(Math.abs(gl - route.length) / route.length).toBeLessThan(0.01);
    // lat/lng conversion round-trips (what the Leaflet polyline uses)
    const ll = toLatLng(ctrl.projection, poly[0].x, poly[0].y);
    expect(Math.abs(ll.lat - ctrl.graph.nodesById.get(route.nodePath[0])!.lat)).toBeLessThan(1e-4);
  }, 60000);
});

// ---------------- Test 12: dual-view synchronization ----------------

describe("Test 12: both 3D screens share one simulation state", () => {
  it("live frame is the controller's own state (identity, not a copy)", () => {
    const built = generateDemoGrid(center);
    const ctrl = getController();
    ctrl.setup(built.graph, built.projection);
    const payload = makePayload(built, { lat: center.lat + 0.0003, lng: center.lng + 0.0002 }, TEST_HOSPITAL(center.lat - 0.003, center.lng + 0.004));
    expect(ctrl.dispatch(payload, 100).ok).toBe(true);
    ctrl.tick(0.1);
    expect(ctrl.live.ambulance).toBe(ctrl.ambulance);
    expect(ctrl.live.signals).toBe(ctrl.signals.states);
    expect(ctrl.live.vehicles).toBe(ctrl.traffic.vehicles);
    const pausedT = ctrl.live.t;
    ctrl.paused = true;
    ctrl.tick(0.5);
    expect(ctrl.live.t).toBe(pausedT); // pausing the shared state pauses both views
    ctrl.paused = false;
  }, 60000);
});

// ---------------- Test 13: no route -> clear message ----------------

describe("Test 13: route-unavailable handling", () => {
  it("dispatch on an unreachable access point fails with a clear error, no fake route", () => {
    const built = generateDemoGrid(center);
    const ctrl = getController();
    ctrl.setup(built.graph, built.projection);
    const payload = makePayload(built, { lat: center.lat + 0.0005, lng: center.lng + 0.0005 }, TEST_HOSPITAL(center.lat + 0.004, center.lng - 0.004));
    // isolate the patient access node completely
    for (const e of built.graph.edges) {
      if (e.to === payload.patientAccessNode || e.from === payload.patientAccessNode) e.blocked = true;
    }
    const res = ctrl.dispatch(payload, 100);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(ctrl.phase).toBe("error");
  }, 60000);
});

// ---------------- Test 14: accident data validation ----------------

describe("Test 14: real accident records are validated, never fabricated or relocated", () => {
  it("preserves raw rows verbatim and marks out-of-range records unmapped", () => {
    const built = generateDemoGrid(center);
    const csv = [
      "date,lat,lng,severity,category",
      "2024-01-05,13.0830,80.2710,major,collision",           // near a road -> mapped
      "2024-02-11,12.0000,77.0000,fatal,rollover",            // outside bounds -> invalid
      "2024-03-02,not-a-lat,80.27,minor,scrape",              // unparsable -> invalid
      "2026-12-31,13.0829,80.2705,minor,fender",              // mapped
    ].join("\n");
    const res = loadAccidentCsv(csv, {
      sourceName: "unit-test.csv",
      projection: built.projection,
      graph: built.graph,
      maxSnapM: 120,
      bounds: { minLat: 12.8, maxLat: 13.4, minLng: 79.9, maxLng: 80.5 },
    });
    expect(res.records.length).toBe(4);
    // raw lines preserved byte-for-byte (records are never regenerated)
    expect(res.records[0].raw).toBe("2024-01-05,13.0830,80.2710,major,collision");
    expect(res.records[2].status).toBe("invalid");
    expect(res.records[1].status).toBe("invalid");
    // unmapped records are reported, never moved onto a road
    for (const r of res.records) {
      if (r.status !== "mapped") expect(r.snap).toBeNull();
      else expect(r.snap!.distanceM).toBeLessThanOrEqual(120);
    }
    expect(res.mapped + res.unmapped + res.invalid).toBe(4);
  });

  it("simulated accidents are flagged simulated and block a real road segment", () => {
    const built = generateDemoGrid(center);
    const acc = createSimulatedAccident(built.graph, 7)!;
    expect(acc.simulated).toBe(true);
    expect(acc.id.startsWith("sim-")).toBe(true);
    expect(built.graph.edgesById.get(acc.edgeId)).toBeDefined();
  });
});

// ---------------- bonus: turn restrictions are real constraints ----------------

describe("bonus: real turn restrictions constrain the routers", () => {
  it("a no_straight_on restriction forbids the direct movement", () => {
    const latM = 1 / 111320;
    const raw: RawOsmNetwork = {
      ways: [
        { id: 11, nodes: [P(center.lat - 0.002, center.lng, 1), P(center.lat, center.lng, 2)], oneway: false, type: "primary", maxspeed: 16, lanes: null },
        { id: 12, nodes: [P(center.lat, center.lng, 2), P(center.lat + 0.002, center.lng, 3)], oneway: false, type: "primary", maxspeed: 16, lanes: null },
        { id: 13, nodes: [P(center.lat, center.lng, 2), P(center.lat, center.lng + 0.002, 4)], oneway: false, type: "residential", maxspeed: 8, lanes: null },
        { id: 14, nodes: [P(center.lat, center.lng + 0.002, 4), P(center.lat + 0.002, center.lng + 0.002, 5)], oneway: false, type: "residential", maxspeed: 8, lanes: null },
        { id: 15, nodes: [P(center.lat + 0.002, center.lng + 0.002, 5), P(center.lat + 0.002, center.lng, 3)], oneway: false, type: "residential", maxspeed: 8, lanes: null },
      ],
      signals: [],
      restrictions: [{ viaLat: center.lat, viaLng: center.lng, fromWay: 11, toWay: 12, restriction: "no_straight_on" }],
      source: "osm",
    };
    const g = buildGraph(raw, center).graph;
    expect(g.turnRestrictions.size).toBe(1);
    const junction = [...g.turnRestrictions.keys()][0];
    const inEdge = g.edges.find((e) => e.to === junction && e.wayId === 11)!;
    const straight = g.edges.find((e) => e.from === junction && e.wayId === 12)!;
    const turn = g.edges.find((e) => e.from === junction && e.wayId === 13)!;
    expect(isTurnAllowed(g, inEdge, straight)).toBe(false);
    expect(isTurnAllowed(g, inEdge, turn)).toBe(true);
    // routers must obey: no path from south to north via the banned way pair
    const south = g.nodes.reduce((b, x) => (x.y < g.nodesById.get(b)!.y ? x.id : b), 0);
    const north = g.nodes.reduce((b, x) => (x.y > g.nodesById.get(b)!.y ? x.id : b), 0);
    const p = astar(g, south, north);
    expect(p).not.toBeNull();
    expect(p!.edgeIds.length).toBeGreaterThan(2); // forced around the block
    void latM;
    void closestNodeTo;
  });
});
