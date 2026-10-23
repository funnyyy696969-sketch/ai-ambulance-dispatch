import { api } from "../../convex/_generated/api";
import type { HospitalCandidate, LatLng } from "./types";
import {
  classifyEmergency,
  parseOverpassHospitals,
  scoreHospital,
  demoHospitals,
} from "./hospitalDiscovery";
import { buildGraph, generateDemoGrid, type BuiltGraph } from "./network";
import { astar, closestNodeTo } from "./baselines";
import { toLocal } from "./geo";
import { settings } from "./config";
import { getController } from "./simulation";
import type { EmergencyKindLabel } from "./config";
import type { QuickTrainResult } from "./ppo";

/** Result handed to the UI after the full dispatch pipeline. */
export interface DispatchFlowResult {
  ok: boolean;
  error?: string;
  graph?: BuiltGraph;
  hospital?: HospitalCandidate;
  candidates?: HospitalCandidate[];
  training?: QuickTrainResult;
}

interface FlowDeps {
  fetchHospitals: (args: { lat: number; lng: number; radiusM: number }) => Promise<
    | { ok: true; elements: { type: string; id: number; lat?: number | null; lng?: number | null; tags: Record<string, string> }[] }
    | { ok: false; error: string }
  >;
  fetchRoads: (args: { lat: number; lng: number; radiusM: number }) => Promise<
    | {
        ok: true;
        network: { nodes: { id: number; lat: number; lng: number; signal?: boolean }[]; edges: { from: number; to: number; oneway: boolean; type: string; maxspeed: number | null }[]; source: "osm" };
        meta: { osmSignalNodes: number; fetchedAt: number; license: string; endpoint: string };
      }
    | { ok: false; error: string }
  >;
  /** provenance record for the real OSM fetch (Convex mutation) */
  saveManifest: (args: {
    kind: string;
    endpoint: string;
    license: string;
    lat: number;
    lng: number;
    radiusM: number;
    nodeCount: number;
    edgeCount: number;
    osmSignalNodes: number;
    studyCity: string;
  }) => Promise<unknown>;
}

/**
 * Runs the full Phase-2 dispatch pipeline:
 *  roads -> graph -> hospitals -> scoring -> best hospital -> ambulance ->
 *  PPO quick-train -> GNN embeddings -> route -> simulation start.
 * Every degraded path is labeled, never silently faked.
 */
export async function runDispatchFlow(
  patient: LatLng,
  emergencyText: string,
  deps: FlowDeps,
): Promise<DispatchFlowResult> {
  const ctrl = getController();
  const kind: EmergencyKindLabel = classifyEmergency(emergencyText);

  // ---- road network (OSM, fallback demo grid, clearly labeled) ----
  let built: BuiltGraph | null = null;
  let networkNote: string | null = null;
  try {
    const res = await deps.fetchRoads({ lat: patient.lat, lng: patient.lng, radiusM: settings.networkRadiusM });
    if (res.ok && res.network.nodes.length <= settings.maxOsmNodes) {
      built = buildGraph(res.network, patient);
      networkNote = `OpenStreetMap road network: ${built.graph.nodes.length} intersections, ${built.graph.edges.length} directed segments (~${settings.networkRadiusM} m around the patient)`;
      const realSignals = built.graph.nodes.filter((n) => n.signalSource === "osm").length;
      if (realSignals > 0) networkNote += `, ${realSignals} REAL OSM traffic-signal locations`;
      await deps.saveManifest({
        kind: "osm-roads",
        endpoint: res.meta.endpoint,
        license: res.meta.license,
        lat: patient.lat,
        lng: patient.lng,
        radiusM: settings.networkRadiusM,
        nodeCount: built.graph.nodes.length,
        edgeCount: built.graph.edges.length,
        osmSignalNodes: res.meta.osmSignalNodes,
        studyCity: "Chennai, India",
      }).catch(() => undefined);
    } else if (res.ok) {
      networkNote = `OSM network too dense for the lightweight engine (${res.network.nodes.length} nodes > ${settings.maxOsmNodes}) — using demonstration grid`;
    } else {
      networkNote = `OSM road fetch failed (${res.error}) — using demonstration grid network`;
    }
  } catch (err) {
    networkNote = `OSM road fetch failed (${err instanceof Error ? err.message : String(err)}) — using demonstration grid network`;
  }
  if (!built) built = generateDemoGrid(patient);

  ctrl.setup(built.graph, built.projection);
  ctrl.log("network", networkNote);

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

  // ---- score & rank candidates on the actual road graph ----
  const patientNode = closestNodeTo(built.graph, ...xy(ctrl, patient));
  for (const c of candidates) {
    const { x, y } = toLocal(built.projection, c);
    const node = closestNodeTo(built.graph, x, y);
    const path = astar(built.graph, patientNode, node);
    c.scores = scoreHospital(c, kind, path ? path.cost : null, path ? path.distance : null);
  }
  candidates.sort((a, b) => (b.scores?.total ?? 0) - (a.scores?.total ?? 0));
  const best = candidates[0];
  if (!best) {
    return { ok: false, error: "No suitable hospital could be found. Try another area (select a different patient location) and dispatch again.", graph: built, candidates: [] };
  }
  ctrl.log("hospital", `Selected hospital: ${best.name} (score ${best.scores!.total.toFixed(2)})${usingDemoHospitals ? " — DEMO DATA" : ""}. ${best.scores!.notes.join(" ")}`);

  // ---- hand over to the simulation controller (PPO quick-train + routing) ----
  await new Promise((r) => setTimeout(r, 30)); // let the UI paint the training state
  const result = ctrl.dispatch({ patient, emergencyText, emergencyKind: kind, hospital: best });
  if (!result.ok) return { ok: false, error: result.error, graph: built, candidates };
  return { ok: true, graph: built, hospital: best, candidates, training: result.training };
}

function xy(ctrl: ReturnType<typeof getController>, ll: LatLng): [number, number] {
  return [
    (ll.lng - ctrl.projection.center.lng) * ctrl.projection.mPerDegLng,
    (ll.lat - ctrl.projection.center.lat) * ctrl.projection.mPerDegLat,
  ];
}

export { api };
