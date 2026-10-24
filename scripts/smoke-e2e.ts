#!/usr/bin/env bun
/**
 * CoTV-E end-to-end smoke test (v2 — map-aligned engine).
 *
 *   bun scripts/smoke-e2e.ts          # demo grid (offline)
 *   bun scripts/smoke-e2e.ts --osm    # REAL Chennai OSM via live Overpass
 *   bun scripts/smoke-e2e.ts --osm --simulate-accident
 *
 * Runs the REAL dispatch pipeline (runDispatchFlow) with live fetches,
 * then drives the shared simulation to completion with assertions.
 */

import { runDispatchFlow } from "../src/lib/cotve/dispatchFlow";
import { getController } from "../src/lib/cotve/simulation";
import { routePolyline, validateNetwork } from "../src/lib/cotve/network";
import { astar } from "../src/lib/cotve/baselines";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const OVERPASS = "https://overpass-api.de/api/interpreter";
const MIRROR = "https://overpass.kumi.systems/api/interpreter";

async function overpass(q: string) {
  let lastErr: Error | null = null;
  for (const url of [OVERPASS, MIRROR, OVERPASS]) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(q)}`,
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
      return (await res.json()) as { elements: { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>; members?: { type: string; role: string; ref: number }[] }[] };
    } catch (e) {
      lastErr = e as Error;
      console.log(`  (Overpass failed: ${(e as Error).message} — backing off 5s…)`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw lastErr;
}

function parseMaxspeed(v?: string) {
  if (!v) return null;
  const m = v.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let n = Number.parseFloat(m[1]);
  if (/mph/i.test(v)) n *= 0.44704;
  return n;
}

async function osmDeps(lat: number, lng: number, radiusM: number) {
  return {
    fetchRoads: async () => {
      try {
        const data = await overpass(`[out:json][timeout:30];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$"](around:${radiusM},${lat},${lng});out geom tags;`);
        const sigData = await overpass(`[out:json][timeout:25];node["highway"="traffic_signals"](around:${radiusM},${lat},${lng});out body;`);
        const signals = sigData.elements.filter((e) => e.lat !== undefined).map((e) => ({ lat: e.lat!, lng: e.lon! }));
        const ways = data.elements
          .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 2)
          .map((el) => {
            const tags = el.tags ?? {};
            const lanes = tags.lanes ? Number.parseInt(tags.lanes, 10) : null;
            return {
              id: el.id,
              nodes: el.geometry!.map((pt, i) => ({ id: i, lat: pt.lat, lng: pt.lon })),
              oneway: tags.oneway === "yes" || tags.oneway === "1",
              type: tags.highway ?? "residential",
              maxspeed: parseMaxspeed(tags.maxspeed),
              lanes: Number.isFinite(lanes as number) ? lanes : null,
            };
          });
        if (ways.length === 0) return { ok: false as const, error: "no ways" };
        return {
          ok: true as const,
          network: { ways, signals, restrictions: [], source: "osm" as const },
          meta: { osmSignalNodes: signals.length, turnRestrictions: 0, fetchedAt: Date.now(), license: "ODbL 1.0", endpoint: OVERPASS },
        };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    },
    fetchHospitals: async () => {
      try {
        const res = await overpass(`[out:json][timeout:25];(node["amenity"~"^(hospital|clinic)$"](around:6000,${lat},${lng});way["amenity"~"^(hospital|clinic)$"](around:6000,${lat},${lng}););out center tags;`);
        return { ok: true as const, elements: res.elements.map((el) => ({ type: el.type, id: el.id, lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon, tags: el.tags ?? {} })) };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    },
    fetchBuildings: async () => {
      try {
        const res = await overpass(`[out:json][timeout:30];way["building"](around:${radiusM},${lat},${lng});out geom tags;`);
        const buildings = res.elements
          .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 3)
          .map((el) => {
            const tags = el.tags ?? {};
            const h = tags.height ? Number.parseFloat(tags.height) : null;
            const lv = tags["building:levels"] ? Number.parseFloat(tags["building:levels"]) : null;
            return {
              id: el.id,
              ring: el.geometry!.map((pt: { lat: number; lon: number }) => ({ lat: pt.lat, lng: pt.lon })),
              building: tags.building ?? "yes",
              heightM: Number.isFinite(h as number) ? h : null,
              levels: Number.isFinite(lv as number) ? lv : null,
              name: tags.name ?? null,
            };
          })
          .filter((b) => b.ring.length >= 3);
        return { ok: true as const, buildings, meta: { count: buildings.length, fetchedAt: Date.now(), license: "ODbL 1.0", endpoint: OVERPASS } };
      } catch (e) {
        return { ok: false as const, error: String(e) };
      }
    },
    saveManifest: async () => undefined,
  };
}

async function main() {
  const useOsm = process.argv.includes("--osm");
  const simulateAccident = process.argv.includes("--simulate-accident");
  const patient = { lat: 13.0418, lng: 80.2341 }; // T. Nagar, Chennai

  console.log(`=== CoTV-E smoke E2E v2 (${useOsm ? "REAL Chennai OSM" : "demo grid"}) ===\n`);

  const deps = useOsm
    ? await osmDeps(patient.lat, patient.lng, 900)
    : {
        fetchRoads: async () => ({ ok: false as const, error: "offline" }),
        fetchHospitals: async () => ({ ok: true as const, elements: [] }),
        fetchBuildings: async () => ({ ok: true as const, buildings: [], meta: { count: 0, fetchedAt: Date.now(), license: "n/a", endpoint: "offline" } }),
        saveManifest: async () => undefined,
      };
  // offline mode: force demo hospitals by returning empty OSM result
  const result = await runDispatchFlow(patient, "Heart emergency", {
    ...deps,
    fetchHospitals: useOsm ? deps.fetchHospitals : async () => ({ ok: true as const, elements: [] }),
    uncertainAsCritical: false,
  });
  check("dispatch flow ok", result.ok, result.error ?? "");
  const ctrl = getController();
  check("validation ok", !!result.validation?.ok, `${result.validation?.nodes} junctions, ${result.validation?.edges} segments`);
  check("classification critical (cardiac)", result.classification?.criticality === "critical", result.classification?.notes ?? "");
  check("signal priority armed for critical", ctrl.signals.priorityEnabled === true);
  check("patient access node inserted (real road snap)", ctrl.graph.nodesById.get(ctrl.patientNode)?.isAccess === true, `access dist ${ctrl.metrics.patientAccessDistance.toFixed(1)} m`);
  const hn = ctrl.graph.nodesById.get(ctrl.hospitalNode);
  check("hospital destination on network & connected", !!hn && astar(ctrl.graph, ctrl.patientNode, ctrl.hospitalNode) !== null, hn?.isAccess ? "road-access node" : "nearest junction (demo hospital outside network — labeled fallback)");
  check("route is geometry-true", routePolyline(ctrl.graph, ctrl.currentRoute!.edgeIds).length > 1, `${ctrl.currentRoute!.length.toFixed(0)} m via ${ctrl.currentRoute!.mode}`);
  // hospital-based dispatch: ambulance departs from the dispatch hospital node
  check("ambulance departs from dispatch hospital node", ctrl.ambulance?.nodeId === ctrl.depotNode && !!ctrl.dispatchHospitalCand, `start node ${ctrl.depotNode}, dispatch=${ctrl.dispatchHospitalCand?.name ?? "—"}, treatment=${ctrl.hospitalCand?.name ?? "—"}`);
  if (useOsm) {
    const measured = ctrl.buildings.filter((b) => b.heightSource === "osm").length;
    check("real OSM building footprints loaded", ctrl.buildings.length > 0, `${ctrl.buildings.length} footprints, ${measured} measured height`);
  } else {
    // demo grid now fills blocks with SYNTHETIC (clearly-labeled, estimated-height,
    // off-road) buildings so the 3D scene reads like a real colorful city.
    const allSynthetic = ctrl.buildings.every((b) => b.heightSource === "estimated" && b.id.startsWith("demo/"));
    check("demo grid fills with labeled synthetic buildings", ctrl.buildings.length > 0 && allSynthetic, `${ctrl.buildings.length} synthetic footprints (labeled, off-road)`);
  }

  const sigCount = ctrl.signals.states.size;
  console.log(`  (signalized junctions in network: ${sigCount}${useOsm ? " — real OSM highway=traffic_signals" : " — inferred demo"})`);

  if (simulateAccident) {
    // let it drive a bit, then block a road ahead — choosing, like a real
    // incident policy would, a segment whose closure leaves a connected
    // alternative (severing the final approach is an honest "route
    // unavailable" case, covered by unit tests instead)
    for (let i = 0; i < 400; i++) ctrl.tick(0.05);
    const a = ctrl.ambulance!;
    const route = ctrl.currentRoute!;
    const dest = ctrl.leg === "to-patient" ? ctrl.patientNode : ctrl.hospitalNode;
    let placed = false;
    const candIdx: number[] = [];
    for (let p = a.routeIdx + 1; p <= route.edgeIds.length - 2; p++) candIdx.push(p);
    const mid = (candIdx[0] ?? 0 + (candIdx[candIdx.length - 1] ?? 0)) / 2;
    candIdx.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid));
    for (const idx of candIdx) {
      const id = route.edgeIds[idx];
      if (id === undefined) continue;
      const e = ctrl.graph.edgesById.get(id)!;
      const rev = ctrl.graph.edges.find((x) => x.from === e.to && x.to === e.from && x.wayId === e.wayId);
      e.blocked = true;
      if (rev) rev.blocked = true;
      const stillConnected = astar(ctrl.graph, ctrl.ambulance!.nodeId, dest) !== null;
      e.blocked = false;
      if (rev) rev.blocked = false;
      if (stillConnected) {
        ctrl.blockEdge(id, "SIMULATED accident scenario (smoke)");
        placed = true;
        break;
      }
    }
    if (placed) {
      ctrl.tick(0.05);
      check("blocked road not on remaining route", ctrl.currentRoute!.edgeIds.slice(ctrl.ambulance!.routeIdx).every((id) => !ctrl.graph.edgesById.get(id)!.blocked));
      check("reroute happened", ctrl.metrics.reroutes >= 1, `${ctrl.metrics.reroutes} reroutes`);
    } else {
      console.log("  (no safe mid-route accident placement found on this route — scenario skipped)");
    }
  }

  let ticks = 0;
  let maxDev = 0;
  while (ctrl.phase !== "complete" && ctrl.phase !== "error" && ticks < 120000) {
    ctrl.tick(0.05);
    ticks++;
    const poly = routePolyline(ctrl.graph, ctrl.currentRoute!.edgeIds);
    if (poly.length > 1 && ctrl.ambulance) {
      let best = Infinity;
      for (let i = 1; i < poly.length; i++) {
        const a0 = poly[i - 1], b0 = poly[i];
        const dx = b0.x - a0.x, dy = b0.y - a0.y;
        const l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((ctrl.ambulance.x - a0.x) * dx + (ctrl.ambulance.y - a0.y) * dy) / l2));
        best = Math.min(best, Math.hypot(a0.x + dx * t - ctrl.ambulance.x, a0.y + dy * t - ctrl.ambulance.y));
      }
      maxDev = Math.max(maxDev, best);
    }
  }
  check("journey completed", ctrl.phase === "complete", `phase=${ctrl.phase} ${ctrl.errorMessage}`);
  check("ambulance stayed on road geometry", maxDev < 1.0, `max deviation ${maxDev.toFixed(2)} m`);
  check("signal restoration completed", [...ctrl.signals.states.values()].every((s) => s.priority === "none"), `req=${ctrl.signals.requests} act=${ctrl.signals.activations} restore=${ctrl.signals.restorations}`);
  check("network still validated", validateNetwork(ctrl.graph).ok !== false);

  console.log(`  metrics: response=${ctrl.metrics.responseTime.toFixed(1)}s pickup=${ctrl.metrics.pickupDuration.toFixed(0)}s transport=${ctrl.metrics.transportTime.toFixed(1)}s total=${ctrl.metrics.totalTime.toFixed(1)}s access=${ctrl.metrics.patientAccessDistance.toFixed(0)}m reroutes=${ctrl.metrics.reroutes}`);
  console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("SMOKE CRASH:", e);
  process.exit(1);
});
