#!/usr/bin/env bun
/**
 * CoTV-E diagnostic: WHY did the ambulance not depart from the hospital next
 * to the patient, and does the route/scene really follow raw OSM geometry?
 *
 *   bun scripts/debug-dispatch.ts                     # live OSM at map default center
 *   bun scripts/debug-dispatch.ts --lat .. --lng ..   # custom patient point
 *   bun scripts/debug-dispatch.ts --fail-hospitals    # simulate hospital fetch failure
 *
 * What it checks (all against LIVE data, nothing fabricated):
 *  1. Overpass health: per-query status/latency for roads, signals, hospitals
 *     (old query vs healthcare-tag query), buildings.
 *  2. Hospital coverage: hospitals tagged healthcare=* only that the current
 *     amenity-only query MISSES.
 *  3. Dispatch-origin: compares the legacy flat metric (A* from the snapped
 *     edge's from-node) with the app's offset-aware metric, vs actual origin.
 *  4. Graph integrity: access-node edges must lie on raw OSM ways (catches
 *     stale-edge splits that attach access nodes to the wrong road).
 *  5. Map alignment: every route-polyline point must lie on a raw OSM way.
 */

import { runDispatchFlow } from "../src/lib/cotve/dispatchFlow";
import { getController } from "../src/lib/cotve/simulation";
import { astar } from "../src/lib/cotve/baselines";
import { edgeTravelTime, snapToRoad, routePolyline } from "../src/lib/cotve/network";
import { makeProjection, toLocal } from "../src/lib/cotve/geo";
import type { LocalPt, LatLng } from "../src/lib/cotve/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failures++;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const failHospitals = process.argv.includes("--fail-hospitals");
const patient: LatLng = {
  lat: Number(arg("--lat") ?? 28.6139),
  lng: Number(arg("--lng") ?? 77.209),
};

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const ROAD_TYPES = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street";

async function overpass(q: string, label: string): Promise<{ elements: any[]; ms: number; via: string }> {
  let lastErr: Error | null = null;
  for (let round = 0; round < 2; round++) {
    for (const url of ENDPOINTS) {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: `data=${encodeURIComponent(q)}`,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { elements: any[] };
        console.log(`  query "${label}": ${data.elements.length} elements in ${Date.now() - t0} ms (${new URL(url).host}, round ${round + 1})`);
        return { elements: data.elements, ms: Date.now() - t0, via: url };
      } catch (e) {
        lastErr = e as Error;
        console.log(`  query "${label}": FAILED (${(e as Error).message}) on ${new URL(url).host}, round ${round + 1}`);
        await new Promise((r) => setTimeout(r, 1200 + round * 2000));
      }
    }
  }
  throw lastErr ?? new Error("overpass failed");
}

interface RawWayLocal { pts: LocalPt[] }

async function main() {
  console.log(`=== CoTV-E dispatch diagnostic @ ${patient.lat}, ${patient.lng} ===\n`);

  // ---------- 1. live fetches (mirroring the Convex actions) ----------
  console.log("-- Overpass queries --");
  const waysRes = await overpass(
    `[out:json][timeout:30];(way["highway"~"^(${ROAD_TYPES})$"](around:900,${patient.lat},${patient.lng});node["highway"="traffic_signals"](around:900,${patient.lat},${patient.lng}););out geom tags;`,
    "roads+signals merged",
  );
  const rawWays = waysRes.elements.filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 2);
  const signalEls = waysRes.elements.filter((el) => el.type === "node" && typeof el.lat === "number");
  console.log(`  -> ${rawWays.length} ways, ${signalEls.length} signal nodes`);
  check("merged roads+signals query returns node coords", signalEls.length === 0 || typeof signalEls[0].lon === "number");

  const hospOldQ = `[out:json][timeout:25];(node["amenity"~"^(hospital|clinic)$"](around:6000,${patient.lat},${patient.lng});way["amenity"~"^(hospital|clinic)$"](around:6000,${patient.lat},${patient.lng}););out center tags;`;
  const hospNewQ = `[out:json][timeout:25];(node["amenity"~"^(hospital|clinic)$"](around:6000,${patient.lat},${patient.lng});way["amenity"~"^(hospital|clinic)$"](around:6000,${patient.lat},${patient.lng});node["healthcare"~"^(hospital|clinic)$"](around:6000,${patient.lat},${patient.lng});way["healthcare"~"^(hospital|clinic)$"](around:6000,${patient.lat},${patient.lng}););out center tags;`;
  let hospOld: any[] = [];
  let hospNew: any[] = [];
  try {
    hospOld = (await overpass(hospOldQ, "hospitals (amenity-only, legacy query)")).elements;
  } catch (e) {
    console.log(`  hospital query failed: ${e}`);
  }
  try {
    hospNew = (await overpass(hospNewQ, "hospitals (amenity+healthcare, app query)")).elements;
  } catch {
    /* reported below */
  }
  const key = (el: any) => `${el.type}/${el.id}`;
  const oldKeys = new Set(hospOld.map(key));
  const missed = hospNew.filter((el) => !oldKeys.has(key(el)));
  const missedHealthcareOnly = missed.filter((el) => (el.tags?.amenity ?? "") === "" && (el.tags?.healthcare ?? "") !== "");
  console.log(`  -> amenity-only: ${hospOld.length}; with healthcare tags (what the app queries): ${hospNew.length}; MISSED by the legacy amenity-only query: ${missed.length} (${missedHealthcareOnly.length} healthcare-only)`);
  if (missedHealthcareOnly.length) {
    for (const el of missedHealthcareOnly.slice(0, 5)) {
      const c = el.center ?? el;
      const d = havM(patient, { lat: c.lat, lng: c.lon ?? c.lng });
      console.log(`     missed: ${el.tags?.name ?? "(unnamed)"} [healthcare=${el.tags?.healthcare}] at ${d.toFixed(0)} m from patient`);
    }
  }

  let buildingCount = 0;
  try {
    const b = await overpass(`[out:json][timeout:30];way["building"](around:900,${patient.lat},${patient.lng});out geom tags;`, "buildings");
    buildingCount = b.elements.filter((el) => el.geometry && el.geometry.length >= 3).length;
    console.log(`  -> ${buildingCount} building footprints`);
  } catch {
    console.log("  -> buildings FAILED (3D would render roads only)");
  }

  // ---------- 2. run the REAL dispatch pipeline ----------
  console.log("\n-- runDispatchFlow --");
  const fetchRoads = async () => {
    const ways = rawWays.map((el) => {
      const tags = el.tags ?? {};
      const lanes = tags.lanes ? Number.parseInt(tags.lanes, 10) : null;
      return {
        id: el.id,
        nodes: el.geometry.map((pt: any, i: number) => ({ id: i, lat: pt.lat, lng: pt.lon })),
        oneway: tags.oneway === "yes" || tags.oneway === "1",
        type: tags.highway ?? "residential",
        maxspeed: null as number | null,
        lanes: Number.isFinite(lanes as number) ? lanes : null,
      };
    });
    return {
      ok: true as const,
      network: {
        ways,
        signals: signalEls.map((el) => ({ lat: el.lat, lng: el.lon })),
        restrictions: [],
        source: "osm" as const,
      },
      meta: { osmSignalNodes: signalEls.length, turnRestrictions: 0, fetchedAt: Date.now(), license: "ODbL 1.0", endpoint: ENDPOINTS[0] },
    };
  };
  const fetchHospitals = async () => {
    if (failHospitals) return { ok: false as const, error: "simulated Overpass hospital failure" };
    return { ok: true as const, elements: hospNew.map((el) => ({ type: el.type, id: el.id, lat: el.lat ?? el.center?.lat, lng: el.lon ?? el.center?.lon, tags: el.tags ?? {} })) };
  };

  const result = await runDispatchFlow(patient, "Heart emergency", {
    fetchRoads,
    fetchHospitals,
    fetchBuildings: async () => ({
      ok: true as const,
      buildings: [],
      meta: { count: 0, fetchedAt: Date.now(), license: "n/a", endpoint: "skip" },
    }),
    saveManifest: async () => undefined,
    uncertainAsCritical: false,
  });
  check("dispatch flow ok", result.ok, result.error ?? "");
  if (!result.ok) {
    console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
    process.exit(1);
  }

  const ctrl = getController();
  const g = ctrl.graph;
  console.log(`  network source: ${g.source}, nodes=${g.nodes.length}, edges=${g.edges.length}`);
  console.log(`  treatment hospital: ${ctrl.hospitalCand?.name}${ctrl.hospitalCand?.demo ? " (DEMO)" : ""}`);
  console.log(`  dispatch hospital:  ${ctrl.dispatchHospitalCand?.name}${ctrl.dispatchHospitalCand?.demo ? " (DEMO)" : ""}`);
  check("network is real OSM (not demo fallback)", g.source === "osm");
  check("hospitals are real (not demo fallback)", !ctrl.dispatchHospitalCand?.demo && !ctrl.hospitalCand?.demo);

  // ---------- 3. dispatch-origin analysis ----------
  console.log("\n-- dispatch origin analysis --");
  const proj = makeProjection(patient);
  const toXY = (ll: LatLng) => toLocal(proj, ll);
  const candidates = result.candidates ?? [];
  interface Row { name: string; lineM: number; cur: number | null; fixed: number | null; isDispatch: boolean; isTreatment: boolean; isLineNearest: boolean }
  const rows: Row[] = [];
  for (const c of candidates) {
    const { x, y } = toXY(c);
    const snap = snapToRoad(g, proj, x, y, 480);
    let cur: number | null = null;
    let fixed: number | null = null;
    if (snap) {
      const e = g.edgesById.get(snap.edgeId);
      if (e) {
        // LEGACY flat metric: A* from the snapped edge's from-node only
        const a = astar(g, e.from, ctrl.patientNode);
        cur = a ? a.cost : null;
        // APP metric (baselines.exitTimeFromSnap): direction- and offset-aware.
        // dispatch leg = hospital access point -> patient node. From the access
        // point on edge e, the ambulance can only travel FORWARD toward e.to
        // (oneway or not — you cannot reverse); if the road is two-way it may
        // also exit via e.from (having driven back along the edge).
        const fracFwd = snap.arcPos / e.length;
        const tFwd = edgeTravelTime(e) * fracFwd;   // access -> e.from (backwards)
        const tRev = edgeTravelTime(e) * (1 - fracFwd); // access -> e.to (forwards)
        const cands: number[] = [];
        const exitTo = astar(g, e.to, ctrl.patientNode);
        if (exitTo) cands.push(tRev + exitTo.cost);
        if (!e.oneway) {
          const exitFrom = astar(g, e.from, ctrl.patientNode);
          if (exitFrom) cands.push(tFwd + exitFrom.cost);
        }
        fixed = cands.length ? Math.min(...cands) : null;
      }
    }
    rows.push({
      name: c.name,
      lineM: havM(patient, c),
      cur,
      fixed,
      isDispatch: ctrl.dispatchHospitalCand?.id === c.id,
      isTreatment: ctrl.hospitalCand?.id === c.id,
      isLineNearest: false,
    });
  }
  rows.sort((a, b) => a.lineM - b.lineM);
  if (rows.length) rows[0].isLineNearest = true;
  rows.sort((a, b) => (a.fixed ?? Infinity) - (b.fixed ?? Infinity));
  for (const r of rows.slice(0, 8)) {
    console.log(
      `  ${r.isDispatch ? ">> DISPATCH" : r.isTreatment ? "   treatment" : "          "} ${r.name.slice(0, 46).padEnd(46)} line=${r.lineM.toFixed(0).padStart(6)}m cur=${r.cur == null ? "unreach".padStart(8) : r.cur.toFixed(0).padStart(8)}s fixed=${r.fixed == null ? "unreach".padStart(8) : r.fixed.toFixed(0).padStart(8)}s${r.isLineNearest ? "  [line-nearest]" : ""}`,
    );
  }
  const realRows = rows.filter((r) => !r.name.includes("(demo)"));
  const bestFixed = realRows.reduce<Row | null>((b, r) => (r.fixed != null && (b == null || r.fixed < (b.fixed ?? Infinity)) ? r : b), null);
  const bestCur = realRows.reduce<Row | null>((b, r) => (r.cur != null && (b == null || r.cur < (b.cur ?? Infinity)) ? r : b), null);
  if (bestFixed && bestCur) {
    check(
      "dispatch origin = nearest reachable hospital by road time (offset-aware)",
      bestFixed.isDispatch,
      `chosen=${rows.find((r) => r.isDispatch)?.name ?? "?"} fixed-best=${bestFixed.name} cur-metric-best=${bestCur.name}`,
    );
    if (!bestFixed.isDispatch) {
      console.log(`     ^ divergence: current metric favors "${bestCur.name}" (edge.from distortion)`);
    }
  }
  // actual origin location vs dispatch hospital building
  const depot = ctrl.graph.nodesById.get(ctrl.depotNode);
  if (depot && ctrl.dispatchHospitalCand) {
    const d = havM({ lat: depot.lat, lng: depot.lng }, ctrl.dispatchHospitalCand);
    check("ambulance start node sits at the dispatch hospital's road access", d < 500, `start is ${d.toFixed(0)} m from hospital building`);
  }

  // ---------- 4. graph integrity: access nodes attached to the RIGHT road ----------
  console.log("\n-- graph integrity (access nodes vs raw OSM ways) --");
  const projRaw = makeProjection(patient);
  const rawSegs: [LocalPt, LocalPt][] = [];
  for (const el of rawWays) {
    const pts: LocalPt[] = el.geometry.map((pt: any) => toLocal(projRaw, { lat: pt.lat, lng: pt.lon }));
    for (let i = 1; i < pts.length; i++) rawSegs.push([pts[i - 1], pts[i]]);
  }
  const distToRaw = (p: LocalPt): number => {
    let best = Infinity;
    for (const [a, b] of rawSegs) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
      best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
    }
    return best;
  };
  let corrupted = 0;
  for (const n of g.nodes) {
    if (!n.isAccess) continue;
    for (const eId of g.out.get(n.id) ?? []) {
      const e = g.edgesById.get(eId)!;
      if (e.geom.length < 2) continue;
      const mid: LocalPt = { x: (e.geom[0].x + e.geom[1].x) / 2, y: (e.geom[0].y + e.geom[1].y) / 2 };
      const d = distToRaw(mid);
      if (d > 5) {
        corrupted++;
        console.log(`  CORRUPTED: access node "${n.accessLabel}" (id ${n.id}) out-edge #${eId} leaves the raw road by ${d.toFixed(1)} m`);
      }
    }
  }
  check("all access nodes attach to real OSM roads", corrupted === 0, corrupted ? `${corrupted} corrupted connections` : "graph clean");

  // ---------- 5. route follows raw OSM geometry (map alignment) ----------
  console.log("\n-- map alignment (route vs raw OSM ways) --");
  const poly = routePolyline(g, ctrl.currentRoute!.edgeIds);
  let maxDev = 0;
  for (const p of poly) maxDev = Math.max(maxDev, distToRaw(p));
  check("route polyline lies on raw OSM ways", maxDev < 3, `${poly.length} points, max deviation ${maxDev.toFixed(2)} m`);
  check("building fetch returned real footprints in this run", buildingCount > 0, `${buildingCount} available from Overpass (scene fetches its own)`);

  console.log(failures === 0 ? "\n=== ALL CHECKS PASSED ===" : `\n=== ${failures} CHECK(S) FAILED ===`);
  process.exit(failures === 0 ? 0 : 1);
}

function havM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

main().catch((e) => {
  console.error("DIAGNOSTIC CRASH:", e);
  process.exit(1);
});
