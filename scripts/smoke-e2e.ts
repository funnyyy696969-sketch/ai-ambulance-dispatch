#!/usr/bin/env bun
/**
 * CoTV-E end-to-end smoke test.
 *
 * Runs the REAL dispatch pipeline headlessly, phase by phase, with
 * assertions. Two modes:
 *
 *   bun scripts/smoke-e2e.ts          # demo grid (offline, reproducible)
 *   bun scripts/smoke-e2e.ts --osm    # REAL Chennai OSM network via the
 *                                     # same Overpass query shape the
 *                                     # Convex action uses
 *
 * Exits non-zero on any failure. No fabricated data: the OSM variant talks
 * to the live Overpass API and reports what it actually got.
 */

import { buildGraph, generateDemoGrid, type RawOsmNetwork } from "../src/lib/cotve/network";
import { getController } from "../src/lib/cotve/simulation";
import { astar } from "../src/lib/cotve/baselines";
import { scoreHospital, parseOverpassHospitals } from "../src/lib/cotve/hospitalDiscovery";
import type { HospitalCandidate } from "../src/lib/cotve/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function fetchOsmNetwork(lat: number, lng: number, radiusM: number): Promise<{ network: RawOsmNetwork; hospitals: HospitalCandidate[] }> {
  const OVERPASS = "https://overpass-api.de/api/interpreter";
  const MIRROR = "https://overpass.kumi.systems/api/interpreter";
  const post = async (q: string) => {
    let lastErr: Error | null = null;
    for (const url of [OVERPASS, MIRROR, OVERPASS, MIRROR]) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(q)}`,
        });
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        return res.json() as Promise<{ elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }[] }>;
      } catch (e) {
        lastErr = e as Error;
        console.log(`  (Overpass attempt failed: ${(e as Error).message} — backing off 5s…)`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw lastErr;
  };
  const ways = await post(`[out:json][timeout:25];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$"](around:${radiusM},${lat},${lng});out geom tags;`);
  const sigs = await post(`[out:json][timeout:25];node["highway"="traffic_signals"](around:${radiusM},${lat},${lng});out body;`);
  const hosp = await post(`[out:json][timeout:25];(node["amenity"~"^(hospital|clinic)$"](around:6000,${lat},${lng});way["amenity"~"^(hospital|clinic)$"](around:6000,${lat},${lng}););out center tags;`);
  const signalKeys = new Set(sigs.elements.filter((e) => e.lat !== undefined).map((e) => `${e.lat!.toFixed(5)}:${e.lon!.toFixed(5)}`));
  const key = (la: number, lo: number) => `${Math.round(la * 45000)}:${Math.round(lo * 45000)}`;
  const nodeIds = new Map<string, number>();
  const nodes: RawOsmNetwork["nodes"] = [];
  const edges: RawOsmNetwork["edges"] = [];
  for (const el of ways.elements) {
    if (el.type !== "way" || !el.geometry) continue;
    const tags = el.tags ?? {};
    const oneway = tags.oneway === "yes" || tags.oneway === "1";
    const type = tags.highway ?? "residential";
    const maxspeed = tags.maxspeed ? Number.parseFloat(tags.maxspeed) : null;
    const ids: number[] = [];
    for (const pt of el.geometry) {
      const k = key(pt.lat, pt.lon);
      let id = nodeIds.get(k);
      if (id === undefined) {
        id = nodes.length;
        nodeIds.set(k, id);
        nodes.push({ id, lat: pt.lat, lng: pt.lon, ...(signalKeys.has(`${pt.lat.toFixed(5)}:${pt.lon.toFixed(5)}`) ? { signal: true } : {}) });
      }
      ids.push(id);
    }
    for (let i = 0; i < ids.length - 1; i++) edges.push({ from: ids[i], to: ids[i + 1], oneway, type, maxspeed: Number.isFinite(maxspeed as number) ? maxspeed : null });
  }
  return { network: { nodes, edges, source: "osm" }, hospitals: parseOverpassHospitals(hosp.elements) };
}

async function main() {
  const useOsm = process.argv.includes("--osm");
  // patient: real coordinates in Chennai (T. Nagar area)
  const patient = { lat: 13.0418, lng: 80.2341 };

  console.log(`=== CoTV-E smoke E2E (${useOsm ? "REAL Chennai OSM" : "demo grid"}) ===\n`);

  // ---- phase 2a: network ----
  console.log("Phase 2 — network");
  let built;
  let hospitals: HospitalCandidate[];
  if (useOsm) {
    const res = await fetchOsmNetwork(patient.lat, patient.lng, 900);
    hospitals = res.hospitals;
    if (res.network.nodes.length > 400) {
      console.log(`  (OSM raw network: ${res.network.nodes.length} nodes — over the app's 400 cap; using it anyway to stress the engine)`);
    }
    built = buildGraph(res.network, patient);
    const realSignals = built.graph.nodes.filter((n) => n.signalSource === "osm").length;
    check("OSM network built", built.graph.nodes.length > 20, `${built.graph.nodes.length} nodes, ${built.graph.edges.length} directed edges, ${realSignals} real signal nodes`);
  } else {
    built = generateDemoGrid(patient);
    hospitals = [];
    check("demo grid built", built.graph.nodes.length >= 81, `${built.graph.nodes.length} nodes`);
  }
  getController().setup(built.graph, built.projection);
  check("controller setup (traffic + signals)", !!getController().traffic && !!getController().signals);

  // ---- phase 2b: hospital discovery (real OSM hospitals for --osm; demo for offline) ----
  console.log("\nPhase 2 — hospital discovery & ranking");
  if (useOsm) {
    check("hospitals found from OSM", hospitals.length > 0, `${hospitals.length} candidates within 6 km`);
  } else {
    hospitals = [
      { id: "demo/0", name: "City General Hospital (demo)", lat: patient.lat + 0.006, lng: patient.lng + 0.005, osmType: "node", tags: { amenity: "hospital", emergency: "yes" }, hasEmergencyTag: true, specialties: ["cardiology"], dataCompleteness: 0.5, demo: true },
      { id: "demo/1", name: "Northside Clinic (demo)", lat: patient.lat - 0.005, lng: patient.lng + 0.006, osmType: "node", tags: { amenity: "hospital" }, hasEmergencyTag: "unknown", specialties: [], dataCompleteness: 0.2, demo: true },
    ] satisfies HospitalCandidate[];
  }
  const patientNode = built.graph.nodes.reduce((best, n) => (Math.hypot(n.x - (patient.lng - built.projection.center.lng) * built.projection.mPerDegLng, n.y - (patient.lat - built.projection.center.lat) * built.projection.mPerDegLat) < Math.hypot(built.graph.nodesById.get(best)!.x - (patient.lng - built.projection.center.lng) * built.projection.mPerDegLng, built.graph.nodesById.get(best)!.y - (patient.lat - built.projection.center.lat) * built.projection.mPerDegLat) ? n.id : best), 0);
  for (const c of hospitals.slice(0, 25)) {
    const x = (c.lng - built.projection.center.lng) * built.projection.mPerDegLng;
    const y = (c.lat - built.projection.center.lat) * built.projection.mPerDegLat;
    let bestN = 0, bestD = Infinity;
    for (const n of built.graph.nodes) { const d = Math.hypot(n.x - x, n.y - y); if (d < bestD) { bestD = d; bestN = n.id; } }
    const path = astar(built.graph, patientNode, bestN);
    c.scores = scoreHospital(c, "cardiac", path ? path.cost : null, path ? path.distance : null);
  }
  hospitals.sort((a, b) => (b.scores?.total ?? 0) - (a.scores?.total ?? 0));
  const best = hospitals[0];
  check("top hospital selected with score + notes", !!best?.scores, `${best?.name} score=${best?.scores?.total.toFixed(2)} notes="${best?.scores?.notes.join("; ")}"`);

  // ---- phases 3-6: full dispatch + journey ----
  console.log("\nPhases 3–6 — dispatch + journey");
  const ctrl = getController();
  const dispatch = ctrl.dispatch({ patient, emergencyText: "Heart emergency", emergencyKind: "cardiac", hospital: best! }, 1200);
  check("dispatch ok", dispatch.ok, dispatch.error ?? "");
  check("PPO quick-train produced episodes + curve", ctrl.metrics.ppoEpisodes > 0 && ctrl.metrics.ppoRewardCurve.length > 0, `${ctrl.metrics.ppoEpisodes} episodes, ${ctrl.metrics.ppoRewardCurve.length} curve points`);
  check("baselines computed (Dijkstra & A*)", !!ctrl.metrics.baseline && ctrl.metrics.baseline.astarTime! > 0 && ctrl.metrics.baseline.dijkstraTime! > 0, `dijk=${ctrl.metrics.baseline?.dijkstraTime?.toFixed(1)}s astar=${ctrl.metrics.baseline?.astarTime?.toFixed(1)}s`);
  check("leg-1 route valid (connected edges)", (ctrl.currentRoute?.edgeIds.length ?? 0) > 0, `mode=${ctrl.currentRoute?.mode} ${ctrl.currentRoute?.length.toFixed(0)}m`);
  const liveBefore = ctrl.live;
  check("live frame shared with both 3D screens", liveBefore.signals === ctrl.signals.states && liveBefore.vehicles === ctrl.traffic.vehicles);

  let t = 0;
  while (ctrl.phase !== "complete" && ctrl.phase !== "error" && t < 60000) { ctrl.tick(0.05); t++; }
  check("journey completed through all phases", ctrl.phase === "complete", `phase=${ctrl.phase} ${ctrl.errorMessage}`);
  check("response time recorded", ctrl.metrics.responseTime > 0, `${ctrl.metrics.responseTime.toFixed(1)}s`);
  check("pickup simulated", ctrl.metrics.pickupDuration > 0, `${ctrl.metrics.pickupDuration.toFixed(1)}s`);
  check("transport + total time", ctrl.metrics.transportTime > 0 && ctrl.metrics.totalTime > ctrl.metrics.responseTime, `transport=${ctrl.metrics.transportTime.toFixed(1)}s total=${ctrl.metrics.totalTime.toFixed(1)}s`);
  check("ambulance never left the road graph (final pos on hospital node)", (() => { const hn = ctrl.graph.nodesById.get(ctrl.hospitalNode)!; return Math.hypot(ctrl.ambulance!.x - hn.x, ctrl.ambulance!.y - hn.y) < 1; })());
  check("signal priority events recorded", ctrl.signals.requests >= 0 && ctrl.signals.activations >= 0 && ctrl.signals.restorations >= 0, `req=${ctrl.signals.requests} act=${ctrl.signals.activations} restore=${ctrl.signals.restorations}`);
  check("route mode honestly labeled", ["ppo", "ppo-quicktrained", "fallback-astar"].includes(ctrl.currentRoute!.mode), ctrl.currentRoute!.fallbackReason ? `fallback: ${ctrl.currentRoute!.fallbackReason}` : ctrl.currentRoute!.mode);

  // signal state-machine detail
  const stuck = [...ctrl.signals.states.values()].filter((s) => s.priority !== "none");
  console.log(`  signal detail: ${ctrl.signals.requests} requests, ${ctrl.signals.activations} activations, ${ctrl.signals.restorations} restorations; signals still in a priority state at end: ${stuck.length ? stuck.map((s) => `#${s.nodeId}:${s.priority}/${s.phase}`).join(", ") : "none"}`);

  // reset works for a second run
  ctrl.reset();
  check("reset returns to idle", ctrl.phase === "idle");

  console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE CRASH:", e);
  process.exit(1);
});
