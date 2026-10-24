import { buildingPalette, buildingSettings, makeRng, settings } from "./config";
import { toLocal, type Projection } from "./geo";
import type { BuildingFootprint, LocalPt, RoadGraph } from "./types";

/** Raw OSM building ways as delivered by the Convex fetchBuildings action. */
export interface RawBuilding {
  id: number;
  ring: { lat: number; lng: number }[];
  building: string;
  heightM: number | null;
  levels: number | null;
  name: string | null;
}

/**
 * Project real OSM building footprints into local meters and assign a height.
 *
 * HONESTY RULES:
 *  - A height taken from an OSM `height` tag is measured (heightSource "osm").
 *  - When no height tag exists, `building:levels` * metresPerLevel is used;
 *    otherwise a documented per-type estimate. Both are heightSource
 *    "estimated" and are NEVER claimed as measured data.
 *  - Footprints keep their REAL geographic location via the shared projection
 *    (the same transform used for roads, signals, ambulance and hospitals).
 */
export function buildFootprints(
  raw: RawBuilding[],
  proj: Projection,
  graph: RoadGraph,
): BuildingFootprint[] {
  const rng = makeRng(settings.seed * 13 + 5);
  const out: BuildingFootprint[] = [];
  const { minX, minY, maxX, maxY } = graph.bounds;

  for (const b of raw) {
    if (out.length >= buildingSettings.maxBuildings) break;
    const ring: LocalPt[] = [];
    for (const p of b.ring) {
      const l = toLocal(proj, p);
      ring.push({ x: Math.round(l.x * 100) / 100, y: Math.round(l.y * 100) / 100 });
    }
    // drop the duplicate closing point if present (first == last)
    if (ring.length > 1) {
      const a = ring[0];
      const z = ring[ring.length - 1];
      if (Math.abs(a.x - z.x) < 0.01 && Math.abs(a.y - z.y) < 0.01) ring.pop();
    }
    if (ring.length < 3) continue;

    // keep only footprints inside/near the network bounds (same study area)
    let cx = 0;
    let cy = 0;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
    }
    cx /= ring.length;
    cy /= ring.length;
    if (cx < minX - 200 || cx > maxX + 200 || cy < minY - 200 || cy > maxY + 200) continue;

    // height: measured tag > levels-based > documented per-type estimate
    let height: number;
    let heightSource: BuildingFootprint["heightSource"];
    if (b.heightM !== null && Number.isFinite(b.heightM) && b.heightM > 0) {
      height = b.heightM;
      heightSource = "osm";
    } else if (b.levels !== null && b.levels > 0) {
      height = b.levels * buildingSettings.metresPerLevel;
      heightSource = "estimated";
    } else {
      const est = buildingSettings.estimatedHeights[b.building] ?? buildingSettings.estimatedHeights.default;
      height = est;
      heightSource = "estimated";
    }
    height = Math.max(3, Math.min(60, height));

    out.push({
      id: `b/${b.id}`,
      ring,
      height,
      heightSource,
      kind: b.building,
      // controlled colourful palette: stable per building id
      colorIdx: Math.floor(rng() * buildingPalette.length),
    });
  }
  return out;
}

/** Polygon area (m², absolute) — used for footprint sanity checks. */
export function ringArea(ring: LocalPt[]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Is point (x,y) inside the ring? (ray casting) — used for alignment checks. */
export function pointInRing(ring: LocalPt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
