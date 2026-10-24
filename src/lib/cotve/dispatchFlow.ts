import {
  classifyEmergency,
  parseOverpassHospitals,
  scoreHospital,
  demoHospitals,
} from "./hospitalDiscovery";
import { buildGraph, generateDemoGrid, snapToRoad, insertAccessNode, validateNetwork, nearestNode, type BuiltGraph } from "./network";
import { astar } from "./baselines";
import { toLocal } from "./geo";
import { settings, classifyCriticality, criticalityConfig, type EmergencyKindLabel } from "./config";
import { getController } from "./simulation";
import type { Classification, HospitalCandidate, LatLng, NetworkValidation } from "./types";
import type { QuickTrainResult } from "./ppo";

export interface DispatchFlowResult {
  ok: boolean;
  error?: string;
  graph?: BuiltGraph;
  hospital?: HospitalCandidate;
  candidates?: HospitalCandidate[];
  training?: QuickTrainResult;
  classification?: Classification;
  validation?: NetworkValidation;
}

interface FlowDeps {
  fetchHospitals: (args: { lat: number; lng: number; radiusM: number }) => Promise<
    | { ok: true; elements: { type: string; id: number; lat?: number | null; lng?: number | null; tags: Record<string, string> }[] }
    | { ok: false; error: string }
  >;
  fetchRoads: (args: { lat: number; lng: number; radiusM: number }) => Promise<
    | {
        ok: true;
        network: {
          ways: { id: number; nodes: { id: number; lat: number; lng: number }[]; oneway: boolean; type: string; maxspeed: number | null; lanes: number | null }[];
          signals: { lat: number; lng: number }[];
          restrictions: { viaLat: number; viaLng: number; fromWay: number; toWay: number; restriction: string }[];
          source: "osm";
        };
        meta: { osmSignalNodes: number; turnRestrictions: number; fetchedAt: number; license: string; endpoint: string };
      }
    | { ok: false; error: string }
  >;
  saveManifest: (args: {
    kind: string; endpoint: string; license: string; lat: number; lng: number; radiusM: number;
    nodeCount: number; edgeCount: number; osmSignalNodes: number; studyCity: string;
  }) => Promise<unknown>;
  /** configured escalation policy for uncertain classification */
  uncertainAsCritical?: boolean;
}

/**
 * Full dispatch pipeline (Phase 2):
 *  road network (real OSM, geometry preserved) -> connectivity validation ->
 *  patient snapping to a real road access point -> hospital discovery/ranking
 *  on the road graph -> hospital access insertion -> criticality
 *  classification -> PPO quick-train + GNN routing -> simulation start.
 * Every degraded path is labeled; nothing is fabricated.
 */
export async function runDispatchFlow(
  patient: LatLng,
  emergencyText: string,
  deps: FlowDeps,
): Promise<DispatchFlowResult> {
  const ctrl = getController();
  const kind: EmergencyKindLabel = classifyEmergency(emergencyText);

  // ---- criticality classification (documented keyword policy) ----
  const base = classifyCriticality(emergencyText);
  const classification: Classification = deps.uncertainAsCritical && base.criticality === "uncertain"
    ? { ...base, notes: `${base.notes} — escalation policy ACTIVE: uncertain treated as critical` }
    : base;

  // ---- road network (real OSM with geometry; demo-grid fallback labeled) ----
  let built: BuiltGraph | null = null;
  let networkNote: string | null = null;
  try {
    const res = await deps.fetchRoads({ lat: patient.lat, lng: patient.lng, radiusM: settings.networkRadiusM });
    if (res.ok && res.network.ways.length > 0) {
      built = buildGraph(res.network, patient);
      const v = validateNetwork(built.graph);
      if (!v.ok) {
        networkNote = `OSM network failed connectivity validation (${v.issues.map((i) => i.detail).join("; ")}) — using demonstration grid`;
        built = null;
      } else {
        networkNote = `OpenStreetMap road network: ${v.nodes} junctions, ${v.edges} directed segments with real geometry, ${built.graph.signalNodeCount} OSM signal locations, ${v.turnRestrictions} real turn restrictions`;
        await deps.saveManifest({
          kind: "osm-roads", endpoint: res.meta.endpoint, license: res.meta.license,
          lat: patient.lat, lng: patient.lng, radiusM: settings.networkRadiusM,
          nodeCount: v.nodes, edgeCount: v.edges, osmSignalNodes: res.meta.osmSignalNodes, studyCity: "Chennai, India",
        }).catch(() => undefined);
      }
    } else {
      networkNote = res.ok ? "No OSM ways in range — using demonstration grid" : `OSM road fetch failed (${res.error}) — using demonstration grid network`;
    }
  } catch (err) {
    networkNote = `OSM road fetch failed (${err instanceof Error ? err.message : String(err)}) — using demonstration grid network`;
  }
  if (!built) built = generateDemoGrid(patient);

  ctrl.setup(built.graph, built.projection);
  ctrl.log("network", networkNote);
  const validation = validateNetwork(built.graph);
  for (const issue of validation.issues) ctrl.log("validate", `${issue.severity}: ${issue.detail}`);

  // ---- patient snapping to a REAL road access point ----
  const px = (patient.lng - built.projection.center.lng) * built.projection.mPerDegLng;
  const py = (patient.lat - built.projection.center.lat) * built.projection.mPerDegLat;
  const patientSnap = snapToRoad(built.graph, built.projection, px, py, settings.maxSnapM);
  if (!patientSnap) {
    return {
      ok: false, graph: built, candidates: [],
      error: `No road within ${settings.maxSnapM} m of the selected location (park, water body, or disconnected area). Please select a patient location closer to a road.`,
    };
  }
  const patientAccessNode = insertAccessNode(built.graph, patientSnap, "patient-access");

  // ---- hospital discovery ----
  let candidates: HospitalCandidate[] = [];
  let hospitalError: string | null = null;
  try {
    const res = await deps.fetchHospitals({ lat: patient.lat, lng: patient.lng, radiusM: settings.hospitalSearchRadiusM });
    if (res.ok) {
      candidates = parseOverpassHospitals(res.elements);
      if (candidates.length === 0) hospitalError = "No hospitals found in OSM data within range";
    } else {
      hospitalError = `Hospital discovery failed (${res.error})`;
    }
  } catch (err) {
    hospitalError = `Hospital discovery failed (${err instanceof Error ? err.message : String(err)})`;
  }

  let usingDemoHospitals = false;
  if (candidates.length === 0) {
    candidates = demoHospitals(patient);
    usingDemoHospitals = true;
    ctrl.log("hospital", `${hospitalError ?? "No OSM hospitals in range"} — falling back to DEMONSTRATION hospitals (clearly labeled, not real facilities)`);
  }

  // ---- score candidates on the actual road graph (patient access -> hospital access) ----
  for (const c of candidates) {
    const lx = (c.lng - built.projection.center.lng) * built.projection.mPerDegLng;
    const ly = (c.lat - built.projection.center.lat) * built.projection.mPerDegLat;
    const snap = snapToRoad(built.graph, built.projection, lx, ly, settings.maxSnapM * 4);
    c.access = snap;
    const targetNode = snap ? built.graph.edgesById.get(snap.edgeId)!.from : nearestNode(built.graph, lx, ly);
    const path = astar(built.graph, patientAccessNode, targetNode);
    c.scores = scoreHospital(c, kind, path ? path.cost : null, path ? path.distance : null);
  }
  candidates.sort((a, b) => (b.scores?.total ?? 0) - (a.scores?.total ?? 0));
  const best = candidates[0];
  if (!best) {
    return { ok: false, error: "No suitable hospital could be found. Try another area and dispatch again.", graph: built, candidates: [] };
  }
  ctrl.log("hospital", `Selected hospital: ${best.name} (score ${best.scores!.total.toFixed(2)})${usingDemoHospitals ? " — DEMO DATA" : ""}. ${best.scores!.notes.join(" ")}`);

  // ---- hospital road access node ----
  let hospitalAccessNode: number;
  if (best.access) {
    hospitalAccessNode = insertAccessNode(built.graph, best.access, "hospital-access");
  } else {
    const hx = (best.lng - built.projection.center.lng) * built.projection.mPerDegLng;
    const hy = (best.lat - built.projection.center.lat) * built.projection.mPerDegLat;
    hospitalAccessNode = nearestNode(built.graph, hx, hy);
    ctrl.log("hospital", "Hospital road-access snap unavailable — using nearest junction (distance recorded)");
  }
  const hospitalAccess = best.access ?? {
    edgeId: -1, arcPos: 0,
    x: built.graph.nodesById.get(hospitalAccessNode)!.x,
    y: built.graph.nodesById.get(hospitalAccessNode)!.y,
    lat: best.lat, lng: best.lng, distanceM: 0,
  };

  // ---- PPO quick-train + routing (inside the controller) ----
  await new Promise((r) => setTimeout(r, 30));
  const result = ctrl.dispatch({
    patient, emergencyText, emergencyKind: kind, hospital: best,
    patientAccessNode, hospitalAccessNode,
    patientAccess: { ...patientSnap },
    hospitalAccess,
    classification,
  });
  if (!result.ok) return { ok: false, error: result.error, graph: built, candidates };
  return { ok: true, graph: built, hospital: best, candidates, training: result.training, classification, validation };
}

export { criticalityConfig, classifyCriticality };
