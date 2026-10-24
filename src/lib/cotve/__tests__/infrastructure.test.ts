/**
 * CoTV-E realistic-infrastructure suite.
 *
 * Covers the two core upgrades:
 *  1. Hospital-based dispatch — the ambulance departs from the NEAREST
 *     SUITABLE hospital by road travel time (not an arbitrary depot), then
 *     transports to the best-matching treatment hospital.
 *  2. Real building footprints — OSM rings project into the SAME shared
 *     coordinate transform as roads, keep their true geographic position,
 *     and distinguish measured OSM heights from documented estimates.
 */
import { describe, it, expect } from "vitest";
import { generateDemoGrid, snapToRoad, insertAccessNode } from "../network";
import { buildFootprints, ringArea, pointInRing, type RawBuilding } from "../buildings";
import { getController, type DispatchPayload } from "../simulation";
import { makeProjection, toLocal } from "../geo";
import { astar } from "../baselines";
import type { HospitalCandidate, LatLng } from "../types";

const center: LatLng = { lat: 13.0827, lng: 80.2707 };

function TEST_HOSPITAL(id: string, name: string, lat: number, lng: number): HospitalCandidate {
  return {
    id, name, lat, lng, osmType: "node", tags: { amenity: "hospital" },
    hasEmergencyTag: true, specialties: ["cardiology"], dataCompleteness: 0.5, demo: false,
  };
}

function snapNode(built: ReturnType<typeof generateDemoGrid>, lat: number, lng: number, label: string) {
  const x = (lng - built.projection.center.lng) * built.projection.mPerDegLng;
  const y = (lat - built.projection.center.lat) * built.projection.mPerDegLat;
  const s = snapToRoad(built.graph, built.projection, x, y, 400)!;
  const node = insertAccessNode(built.graph, s, label);
  return { node, snap: s };
}

describe("hospital-based dispatch (ambulance departs from nearest suitable hospital)", () => {
  it("ambulance starts at the dispatch hospital access node, not an arbitrary depot", () => {
    const built = generateDemoGrid(center);
    const patient: LatLng = { lat: center.lat + 0.001, lng: center.lng + 0.001 };
    const p = snapNode(built, patient.lat, patient.lng, "patient-access");

    // two hospitals: one near the patient (dispatch), one elsewhere (treatment)
    const nearHosp = TEST_HOSPITAL("h/near", "Near Hospital", center.lat + 0.0015, center.lng + 0.0015);
    const farHosp = TEST_HOSPITAL("h/far", "Far Specialty", center.lat - 0.004, center.lng - 0.004);
    const nearS = snapNode(built, nearHosp.lat, nearHosp.lng, "h-near");
    const farS = snapNode(built, farHosp.lat, farHosp.lng, "h-far");

    const ctrl = getController();
    ctrl.setup(built.graph, built.projection);
    const payload: DispatchPayload = {
      patient, emergencyText: "Heart emergency", emergencyKind: "cardiac",
      hospital: farHosp,                       // treatment (best match)
      dispatchHospital: nearHosp,              // nearest suitable (ambulance start)
      patientAccessNode: p.node,
      hospitalAccessNode: farS.node,
      dispatchHospitalNode: nearS.node,
      patientAccess: p.snap, hospitalAccess: farS.snap, dispatchHospitalAccess: nearS.snap,
      classification: { criticality: "critical", matchedRule: "cardiac emergency", notes: "test" },
    };
    expect(ctrl.dispatch(payload, 120).ok).toBe(true);
    // the ambulance's start node IS the dispatch hospital access node
    expect(ctrl.depotNode).toBe(nearS.node);
    expect(ctrl.ambulance?.nodeId).toBe(nearS.node);
    // journey 1 targets the patient, journey 2 the treatment hospital
    expect(ctrl.patientNode).toBe(p.node);
    expect(ctrl.hospitalNode).toBe(farS.node);
    expect(ctrl.dispatchHospitalCand?.id).toBe("h/near");
    expect(ctrl.hospitalCand?.id).toBe("h/far");
  });

  it("nearest-hospital selection uses road travel time (dispatch flow)", async () => {
    // runDispatchFlow picks the dispatch hospital by road time; here we verify
    // the underlying invariant directly: A* road time to the near hospital is
    // smaller than to the far one, so it is the correct dispatch choice.
    const built = generateDemoGrid(center);
    const patient: LatLng = { lat: center.lat + 0.001, lng: center.lng + 0.001 };
    const p = snapNode(built, patient.lat, patient.lng, "patient-access");
    const nearS = snapNode(built, center.lat + 0.0015, center.lng + 0.0015, "h-near");
    const farS = snapNode(built, center.lat - 0.004, center.lng - 0.004, "h-far");
    const tNear = astar(built.graph, nearS.node, p.node);
    const tFar = astar(built.graph, farS.node, p.node);
    expect(tNear).not.toBeNull();
    expect(tFar).not.toBeNull();
    expect(tNear!.cost).toBeLessThan(tFar!.cost);
  });
});

describe("real building footprints (shared projection, honest heights)", () => {
  it("projects an OSM ring into the SAME local transform as roads and keeps its position", () => {
    const built = generateDemoGrid(center);
    const proj = makeProjection(center);
    // a small square ~ near the center, expressed in lat/lng
    const d = 0.0005;
    const ring = [
      { lat: center.lat, lng: center.lng },
      { lat: center.lat + d, lng: center.lng },
      { lat: center.lat + d, lng: center.lng + d },
      { lat: center.lat, lng: center.lng + d },
    ];
    const raw: RawBuilding[] = [{ id: 1, ring, building: "residential", heightM: 12, levels: null, name: null }];
    const footprints = buildFootprints(raw, proj, built.graph);
    expect(footprints.length).toBe(1);
    const fp = footprints[0];
    // each projected vertex matches toLocal of the same lat/lng (shared transform)
    for (let i = 0; i < ring.length; i++) {
      const expectPt = toLocal(proj, ring[i]);
      expect(fp.ring[i].x).toBeCloseTo(expectPt.x, 1);
      expect(fp.ring[i].y).toBeCloseTo(expectPt.y, 1);
    }
    // measured OSM height tag is preserved and labeled "osm"
    expect(fp.height).toBe(12);
    expect(fp.heightSource).toBe("osm");
  });

  it("uses documented estimates (labeled 'estimated') when no height tag exists", () => {
    const built = generateDemoGrid(center);
    const proj = makeProjection(center);
    const ring = [
      { lat: center.lat, lng: center.lng },
      { lat: center.lat + 0.0004, lng: center.lng },
      { lat: center.lat + 0.0004, lng: center.lng + 0.0004 },
    ];
    // levels-only -> estimate from levels; nothing -> per-type estimate
    const byLevels: RawBuilding[] = [{ id: 2, ring, building: "apartments", heightM: null, levels: 5, name: null }];
    const byType: RawBuilding[] = [{ id: 3, ring, building: "house", heightM: null, levels: null, name: null }];
    const f1 = buildFootprints(byLevels, proj, built.graph)[0];
    const f2 = buildFootprints(byType, proj, built.graph)[0];
    expect(f1.heightSource).toBe("estimated");
    expect(f1.height).toBeCloseTo(5 * 3.2, 1); // levels * metresPerLevel
    expect(f2.heightSource).toBe("estimated");
    expect(f2.height).toBeGreaterThan(0);
  });

  it("ringArea + pointInRing behave for a known square (footprint sanity)", () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(ringArea(sq)).toBeCloseTo(100, 3);
    expect(pointInRing(sq, 5, 5)).toBe(true);
    expect(pointInRing(sq, 15, 5)).toBe(false);
  });

  it("skips footprints outside the network study area (no stray distant buildings)", () => {
    const built = generateDemoGrid(center);
    const proj = makeProjection(center);
    const far = { lat: center.lat + 1.0, lng: center.lng + 1.0 }; // ~100km away
    const ring = [
      { lat: far.lat, lng: far.lng },
      { lat: far.lat + 0.0004, lng: far.lng },
      { lat: far.lat + 0.0004, lng: far.lng + 0.0004 },
    ];
    const raw: RawBuilding[] = [{ id: 9, ring, building: "house", heightM: 5, levels: null, name: null }];
    expect(buildFootprints(raw, proj, built.graph).length).toBe(0);
  });
});
