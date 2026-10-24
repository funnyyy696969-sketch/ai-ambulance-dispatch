import { makeRng } from "./config";
import { snapToRoad, edgeTravelTime } from "./network";
import type { Projection } from "./geo";
import type { AccidentRecord, RoadGraph, SimulatedAccident } from "./types";

/**
 * Accident integration.
 *
 * REAL accident data policy (verified Oct 2026):
 *  - India's official accident sources publish AGGREGATE statistics, not
 *    per-crash coordinate records: MoRTH "Road Accidents in India" reports,
 *    OGD portal city/state aggregates, and TN RADMS (internal registry).
 *    No verified, publicly-fetchable point-coordinate accident dataset
 *    exists for Chennai; eDAR/irad.parivahan.gov.in is a registration
 *    portal, not a dataset download.
 *  - Therefore: a VALIDATED loader accepts a user-supplied verified CSV and
 *    preserves every record verbatim (row + raw line) — records are NEVER
 *    regenerated, and coordinates are NEVER relocated to arbitrary roads:
 *    a record farther than maxSnapM from any road is reported "unmapped".
 *  - Simulated accidents exist ONLY as clearly-labeled scenario events
 *    (id prefix "sim-", flag `simulated: true`) for testing blockage +
 *    rerouting. They are never presented as real accidents.
 */

export interface AccidentCsvOptions {
  sourceName: string;
  projection: Projection;
  graph: RoadGraph;
  maxSnapM: number;
  /** bbox sanity check (degrees); records outside are "invalid" */
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
}

function parseLatLng(v: string): number | null {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse a headered CSV of real accident records. Required column:
 * lat|latitude and lng|lon|longitude (case-insensitive). Optional:
 * date, severity|severity_class, category|type|accident_type. */
export function loadAccidentCsv(text: string, opts: AccidentCsvOptions): {
  records: AccidentRecord[];
  mapped: number;
  unmapped: number;
  invalid: number;
} {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { records: [], mapped: 0, unmapped: 0, invalid: 0 };
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const iLat = col("lat", "latitude");
  const iLng = col("lng", "lon", "longitude");
  const iDate = col("date", "accident_date", "year_date");
  const iSev = col("severity", "severity_class", "accident_severity");
  const iCat = col("category", "type", "accident_type");
  if (iLat === -1 || iLng === -1) {
    throw new Error(`CSV has no lat/lng columns (header: ${header.join(", ")}) — refusing to guess`);
  }
  const records: AccidentRecord[] = [];
  let mapped = 0, unmapped = 0, invalid = 0;
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const lat = parseLatLng(f[iLat] ?? "");
    const lng = parseLatLng(f[iLng] ?? "");
    const base = { row: i + 1, raw, date: f[iDate] ?? null, severity: f[iSev] ?? null, category: f[iCat] ?? null, source: opts.sourceName };
    if (lat === null || lng === null) {
      records.push({ ...base, lat, lng, snap: null, status: "invalid" });
      invalid++;
      continue;
    }
    if (lat < opts.bounds.minLat || lat > opts.bounds.maxLat || lng < opts.bounds.minLng || lng > opts.bounds.maxLng) {
      records.push({ ...base, lat, lng, snap: null, status: "invalid" });
      invalid++;
      continue;
    }
    const x = (lng - opts.projection.center.lng) * opts.projection.mPerDegLng;
    const y = (lat - opts.projection.center.lat) * opts.projection.mPerDegLat;
    const snap = snapToRoad(opts.graph, opts.projection, x, y, opts.maxSnapM);
    if (!snap) {
      // honest: report unmapped, NEVER move the record to a road
      records.push({ ...base, lat, lng, snap: null, status: "unmapped" });
      unmapped++;
      continue;
    }
    records.push({ ...base, lat, lng, snap, status: "mapped" });
    mapped++;
  }
  return { records, mapped, unmapped, invalid };
}

/** Clearly-labeled SIMULATED accident scenario: blocks one real road
 * segment of the network. Returns null for unblockable graphs. */
export function createSimulatedAccident(
  graph: RoadGraph,
  seed: number,
  preferEdgeId?: number,
): SimulatedAccident | null {
  const rng = makeRng(seed);
  let edge = preferEdgeId !== undefined ? graph.edgesById.get(preferEdgeId) : undefined;
  for (let tries = 0; tries < 40 && (!edge || edge.length < 40 || graph.nodesById.get(edge.from)?.isAccess || graph.nodesById.get(edge.to)?.isAccess); tries++) {
    edge = graph.edges[Math.floor(rng() * graph.edges.length)];
  }
  if (!edge || edge.length < 40) return null;
  return {
    id: `sim-accident-${Math.floor(rng() * 1e6)}`,
    simulated: true,
    edgeId: edge.id,
    severity: "major",
    createdAt: Date.now(),
    label: `SIMULATED major accident on ${edge.highwayType} segment (road blocked — scenario event, not a real accident)`,
  };
}

/** Travel-time blow-up factor for a blocked edge (used as a risk feature
 * for historical accident records — historical records never block roads). */
export function accidentRiskMultiplier(graph: RoadGraph, edgeId: number): number {
  const e = graph.edgesById.get(edgeId);
  if (!e) return 1;
  return 1 + 0.5 * (edgeTravelTime(e) / Math.max(e.baseTravelTime, 0.001) - 1);
}
