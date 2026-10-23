import { describe, it, expect } from "vitest";
import { generateDemoGrid } from "../network";
import { getController } from "../simulation";
import { astar, closestNodeTo } from "../baselines";
import { scoreHospital, parseOverpassHospitals, classifyEmergency } from "../hospitalDiscovery";
import { TrafficSimulator } from "../traffic";
import type { HospitalCandidate } from "../types";

const center = { lat: 28.6139, lng: 77.209 };

describe("hospital scoring honesty", () => {
  it("never treats unknown emergency capability as confirmed", () => {
    const cand: HospitalCandidate = {
      id: "t/1", name: "Test", lat: 0, lng: 0, osmType: "node",
      tags: { amenity: "hospital", name: "Test" },
      hasEmergencyTag: "unknown", specialties: [], dataCompleteness: 0.1, demo: false,
    };
    const s = scoreHospital(cand, "cardiac", 300, 2000);
    expect(s.emergencyBonus).toBe(0.4); // neutral, not 1
    expect(s.specialtyMatch).toBe(0);
    expect(s.notes.some((n) => n.toLowerCase().includes("unknown"))).toBe(true);
  });

  it("parses overpass hospitals and extracts verified specialties only", () => {
    const els: { type: string; id: number; lat?: number; lng?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }[] = [
      { type: "node", id: 1, lat: 28.61, lng: 77.21, tags: { amenity: "hospital", name: "H", emergency: "yes", "healthcare:specialty": "cardiology;trauma" } },
      { type: "way", id: 2, center: { lat: 28.62, lon: 77.22 }, tags: { amenity: "clinic" } },
    ];
    const parsed = parseOverpassHospitals(els);
    expect(parsed.length).toBe(2);
    expect(parsed[0].hasEmergencyTag).toBe(true);
    expect(parsed[0].specialties).toContain("cardiology");
    expect(parsed[1].hasEmergencyTag).toBe("unknown");
  });

  it("classifies free-text emergencies into rule kinds", () => {
    expect(classifyEmergency("Heart emergency")).toBe("cardiac");
    expect(classifyEmergency("major accident on road")).toBe("trauma");
    expect(classifyEmergency("cannot breathe")).toBe("respiratory");
    expect(classifyEmergency("feeling unwell")).toBe("general");
  });
});

describe("traffic simulator", () => {
  it("keeps vehicles on connected edges and produces congestion", () => {
    const g = generateDemoGrid(center).graph;
    const sim = new TrafficSimulator(g, 3, 20);
    for (let i = 0; i < 200; i++) sim.tick(0.1);
    for (const v of sim.vehicles) {
      const e = g.edgesById.get(v.edgeId)!;
      expect(v.pos).toBeGreaterThanOrEqual(0);
      expect(v.pos).toBeLessThanOrEqual(e.length + 0.001);
    }
    expect(g.edges.some((e) => e.density > 0)).toBe(true);
  });
});

describe("full journey simulation (phases 2-6)", () => {
  it("dispatches, reaches the patient, picks up, and delivers to the hospital", () => {
    const built = generateDemoGrid(center);
    const ctrl = getController();
    ctrl.setup(built.graph, built.projection);

    const patient = { lat: center.lat + 0.0005, lng: center.lng + 0.0005 };
    const hospital: HospitalCandidate = {
      id: "t/2", name: "Test Hospital", lat: center.lat + 0.004, lng: center.lng - 0.004,
      osmType: "node", tags: { amenity: "hospital" }, hasEmergencyTag: true,
      specialties: ["cardiology"], dataCompleteness: 0.5, demo: true,
    };
    const res = ctrl.dispatch({ patient, emergencyText: "Heart emergency", emergencyKind: "cardiac", hospital }, 250);
    expect(res.ok).toBe(true);
    expect(ctrl.phase).toBe("to-patient");
    expect(ctrl.currentRoute).not.toBeNull();
    expect(ctrl.currentRoute!.nodePath[0]).toBe(ctrl.depotNode);

    // run the sim to completion (bounded)
    let steps = 0;
    while (ctrl.phase !== "complete" && ctrl.phase !== "error" && steps < 200000) {
      ctrl.tick(0.05);
      steps++;
    }
    expect(ctrl.phase).toBe("complete");
    expect(ctrl.metrics.responseTime).toBeGreaterThan(0);
    expect(ctrl.metrics.totalTime).toBeGreaterThan(ctrl.metrics.responseTime);
    expect(ctrl.metrics.legs.toPatient!.distance).toBeGreaterThan(0);
    expect(ctrl.metrics.legs.toHospital!.distance).toBeGreaterThan(0);

    // ambulance must have stayed on connected roads: final node == hospital node
    const hxy = { x: (hospital.lng - built.projection.center.lng) * built.projection.mPerDegLng, y: (hospital.lat - built.projection.center.lat) * built.projection.mPerDegLat };
    expect(ctrl.hospitalNode).toBe(closestNodeTo(built.graph, hxy.x, hxy.y));
    expect(ctrl.metrics.baseline).not.toBeNull();
    expect(ctrl.metrics.baseline!.astarTime).toBeGreaterThan(0);

    // both "screens" read the same live frame
    expect(ctrl.live.phase).toBe("complete");
    expect(ctrl.live.signals).toBe(ctrl.signals.states);
  }, 60000);

  it("patient snap is reachable on the road graph (astar finds a route)", () => {
    const built = generateDemoGrid(center);
    const g = built.graph;
    const px = g.bounds.minX + 50;
    const py = g.bounds.minY + 50;
    const node = closestNodeTo(g, px, py);
    expect(astar(g, 0, node)).not.toBeNull();
  });
});
