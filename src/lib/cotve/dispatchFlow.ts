import {
  classifyEmergency,
  parseOverpassHospitals,
  scoreHospital,
  demoHospitals,
} from "./hospitalDiscovery";
import { buildGraph, generateDemoGrid, snapToRoad, insertAccessNode, validateNetwork, nearestNode, type BuiltGraph } from "./network";
import { buildFootprints, demoBuildings, type RawBuilding } from "./buildings";
import { astar } from "./baselines";
import { settings, classifyCriticality, criticalityConfig, emergencyRules, type EmergencyKindLabel } from "./config";
import { getController } from "./simulation";
import type { Classification, HospitalCandidate, LatLng, NetworkValidation } from "./types";
import type { QuickTrainResult } from "./ppo";

export interface DispatchFlowResult {
  ok: boolean;
  error?: string;
  graph?: BuiltGraph;
  hospital?: HospitalCandidate;
  /** nearest suitable hospital the ambulance departs from (may equal hospital) */
  dispatchHospital?: HospitalCandidate;
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
  /** real OSM building footprints (optional; when absent no real buildings render) */
  fetchBuildings?: (args: { lat: number; lng: number; radiusM: number }) => Promise<
    | {
        ok: true;
        buildings: { id: number; ring: { lat: number; lng: number }[]; building: string; heightM: number | null; levels: number | null; name: string | null }[];
        meta: { count: number; fetchedAt: number; license: string; endpoint: string };
      }
    | { ok: false; error: string }
  >;
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

  // ---- real OSM building footprints (shared projection, geometry-true) ----
  ctrl.buildings = [];
  if (built.graph.source === "osm" && deps.fetchBuildings) {
    try {
      const bres = await deps.fetchBuildings({ lat: patient.lat, lng: patient.lng, radiusM: settings.networkRadiusM });
      if (bres.ok) {
        ctrl.buildings = buildFootprints(bres.buildings as RawBuilding[], built.projection, built.graph);
        const measured = ctrl.buildings.filter((b) => b.heightSource === "osm").length;
        ctrl.log("buildings", `Real OSM building footprints: ${ctrl.buildings.length} rendered (${measured} with measured height tags, ${ctrl.buildings.length - measured} estimated). Footprints keep their true geographic position.`);
      } else {
        ctrl.log("buildings", `Building fetch failed (${bres.error}) — 3D view shows roads only (no fabricated buildings)`);
      }
    } catch (err) {
      ctrl.log("buildings", `Building fetch failed (${err instanceof Error ? err.message : String(err)}) — 3D view shows roads only (no fabricated buildings)`);
    }
  } else if (built.graph.source === "demo-grid") {
    // Demonstration grid: SYNTHETIC buildings fill the blocks between the
    // lattice roads (kept off the road corridors so routes never cross them).
    // Clearly labeled synthetic — never claimed as real OSM data.
    ctrl.buildings = demoBuildings(built.graph, patient);
    ctrl.log("buildings", `Demonstration grid: ${ctrl.buildings.length} SYNTHETIC buildings (colorful, block-filling, off-road) — NOT real OSM data. Enable OSM for real footprints.`);
  }

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
  // A REAL OSM hospital is selectable only if it snaps onto a road inside the
  // built network — otherwise the route would end at a nearby junction rather
  // than the hospital, breaking hospital-snapping correctness. Off-network real
  // candidates are EXCLUDED and reported, never silently substituted.
  // Demonstration hospitals (clearly labeled) keep the nearest-junction
  // fallback, since they are placeholders outside the demo grid by design.
  const excludedOffNetwork: HospitalCandidate[] = [];
  const selectable: HospitalCandidate[] = [];
  // dispatch-time (hospital -> patient) travel time, for choosing the nearest
  // suitable dispatch hospital (where the ambulance actually starts).
  const dispatchTime = new Map<string, number>();
  for (const c of candidates) {
    const lx = (c.lng - built.projection.center.lng) * built.projection.mPerDegLng;
    const ly = (c.lat - built.projection.center.lat) * built.projection.mPerDegLat;
    const snap = snapToRoad(built.graph, built.projection, lx, ly, settings.maxSnapM * 4);
    c.access = snap;
    if (!snap && !c.demo) {
      excludedOffNetwork.push(c);
      continue;
    }
    const targetNode = snap ? built.graph.edgesById.get(snap.edgeId)!.from : nearestNode(built.graph, lx, ly);
    const path = astar(built.graph, patientAccessNode, targetNode);
    c.scores = scoreHospital(c, kind, path ? path.cost : null, path ? path.distance : null);
    // dispatch leg: hospital access node -> patient access node (directed)
    const back = astar(built.graph, targetNode, patientAccessNode);
    dispatchTime.set(c.id, back ? back.cost : Number.POSITIVE_INFINITY);
    selectable.push(c);
  }
  if (excludedOffNetwork.length) {
    ctrl.log("hospital", `${excludedOffNetwork.length} of ${candidates.length} OSM hospital candidates lie outside the built ${settings.networkRadiusM} m road network and cannot be given a road-access point — excluded from selection (not substituted): ${excludedOffNetwork.slice(0, 3).map((c) => c.name).join("; ")}${excludedOffNetwork.length > 3 ? " …" : ""}`);
  }
  selectable.sort((a, b) => (b.scores?.total ?? 0) - (a.scores?.total ?? 0));
  const best = selectable[0];
  if (!best) {
    return {
      ok: false, graph: built, candidates,
      error: `All ${candidates.length} hospital candidates lie outside the built ${settings.networkRadiusM} m road network, so none could be assigned a road-access point. Select a patient location nearer a hospital, or increase the network radius.`,
    };
  }
  ctrl.log("hospital", `Treatment hospital (best for ${emergencyRules[kind].label}): ${best.name} (score ${best.scores!.total.toFixed(2)})${usingDemoHospitals ? " — DEMO DATA" : ""}. ${best.scores!.notes.join(" ")}`);

  // ---- dispatch hospital: NEAREST suitable hospital by road travel time ----
  // (the ambulance departs from here, then transports to the treatment
  // hospital). "Suitable" = has a road-access point on the network. Ties and
  // unknowns resolve to the treatment hospital. Straight-line distance is
  // never used — only road-network travel time.
  let dispatchHosp = best;
  let minDispatch = dispatchTime.get(best.id) ?? Number.POSITIVE_INFINITY;
  for (const c of selectable) {
    const dt = dispatchTime.get(c.id) ?? Number.POSITIVE_INFINITY;
    if (dt < minDispatch) { minDispatch = dt; dispatchHosp = c; }
  }
  const sameHospital = dispatchHosp.id === best.id;
  ctrl.log("dispatch", sameHospital
    ? `Dispatch hospital = treatment hospital (nearest suitable is also the best match): ${best.name} — ambulance departs from it.`
    : `Ambulance dispatches from NEAREST suitable hospital ${dispatchHosp.name} (road travel time ${minDispatch.toFixed(0)} s), then transports patient to treatment hospital ${best.name}.`);

  // ---- hospital road access nodes (treatment + dispatch, may share) ----
  const accessFor = (c: HospitalCandidate, label: string): { node: number; access: import("./types").RoadSnap } => {
    if (c.access) {
      const node = insertAccessNode(built.graph, c.access, label);
      return { node, access: { ...c.access } };
    }
    const hx = (c.lng - built.projection.center.lng) * built.projection.mPerDegLng;
    const hy = (c.lat - built.projection.center.lat) * built.projection.mPerDegLat;
    const node = nearestNode(built.graph, hx, hy);
    const n = built.graph.nodesById.get(node)!;
    return { node, access: { edgeId: -1, arcPos: 0, x: n.x, y: n.y, lat: c.lat, lng: c.lng, distanceM: 0 } };
  };
  const treat = accessFor(best, "hospital-access");
  const hospAccessNodeSameAsDispatch = sameHospital;
  const dispatch = sameHospital
    ? { node: treat.node, access: treat.access }
    : accessFor(dispatchHosp, "dispatch-hospital-access");

  // ---- PPO quick-train + routing (inside the controller) ----
  await new Promise((r) => setTimeout(r, 30));
  const result = ctrl.dispatch({
    patient, emergencyText, emergencyKind: kind,
    hospital: best,                       // treatment hospital (destination)
    dispatchHospital: dispatchHosp,       // nearest suitable hospital (ambulance start)
    patientAccessNode,
    hospitalAccessNode: treat.node,
    dispatchHospitalNode: dispatch.node,
    patientAccess: { ...patientSnap },
    hospitalAccess: treat.access,
    dispatchHospitalAccess: dispatch.access,
    classification,
  });
  void hospAccessNodeSameAsDispatch;
  if (!result.ok) return { ok: false, error: result.error, graph: built, candidates };
  return { ok: true, graph: built, hospital: best, dispatchHospital: dispatchHosp, candidates, training: result.training, classification, validation };
}

export { criticalityConfig, classifyCriticality };
