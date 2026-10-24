import { buildingSettings, colorForBuildingType, makeRng, settings } from "./config";
import { toLocal, type Projection } from "./geo";
import type { BuildingFootprint, LatLng, LocalPt, RoadGraph } from "./types";

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
      // type-based colour: homes warm, offices cool, etc. — varied, not random
      colorIdx: colorForBuildingType(b.building, rng),
    });
  }
  return out;
}

/**
 * SYNTHETIC buildings for the DEMONSTRATION grid fallback (clearly labeled,
 * never claimed as real OSM). Fills each block BETWEEN the lattice roads with
 * a few footprints, inset from the road centreline by a clearance margin so
 * no building ever sits on or crosses a road (routes therefore never cross
 * buildings). Colours come from the same type-based palette as real data, so
 * the demo scene reads like a real colourful city.
 */
export function demoBuildings(
  graph: RoadGraph,
  center: LatLng,
  seed = settings.seed,
): BuildingFootprint[] {
  const rng = makeRng(seed * 7 + 3);
  const g = settings.demoGridSize;
  const sp = settings.demoGridSpacingM;
  const half = ((g - 1) * sp) / 2;
  const clearance = 14; // metres from road centreline to any wall (covers curve jitter + road width)
  const kinds = ["residential", "apartments", "house", "commercial", "retail", "office", "residential", "house"];
  const out: BuildingFootprint[] = [];

  // each block spans between grid lines; place 1–4 footprints inside it,
  // keeping every wall >= clearance away from the surrounding roads.
  for (let r = 0; r < g - 1; r++) {
    for (let c = 0; c < g - 1; c++) {
      const x0 = c * sp - half + clearance;
      const x1 = (c + 1) * sp - half - clearance;
      const y0 = r * sp - half + clearance;
      const y1 = (r + 1) * sp - half - clearance;
      if (x1 - x0 < 16 || y1 - y0 < 16) continue;
      const cols = 1 + Math.floor(rng() * 2);
      const rows = 1 + Math.floor(rng() * 2);
      const cw = (x1 - x0) / cols;
      const ch = (y1 - y0) / rows;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if (rng() < 0.18) continue; // leave some open (courtyard / lot)
          const gap = 2.5;
          const bx0 = x0 + i * cw + gap;
          const bx1 = x0 + (i + 1) * cw - gap;
          const by0 = y0 + j * ch + gap;
          const by1 = y0 + (j + 1) * ch - gap;
          if (bx1 - bx0 < 6 || by1 - by0 < 6) continue;
          // slightly irregular quadrilateral so it is not a perfect box
          const jx = () => (rng() - 0.5) * 3;
          const ring: LocalPt[] = [
            { x: bx0 + jx(), y: by0 + jx() },
            { x: bx1 + jx(), y: by0 + jx() },
            { x: bx1 + jx(), y: by1 + jx() },
            { x: bx0 + jx(), y: by1 + jx() },
          ];
          const kind = kinds[Math.floor(rng() * kinds.length)];
          const est = buildingSettings.estimatedHeights[kind] ?? buildingSettings.estimatedHeights.default;
          out.push({
            id: `demo/${r}-${c}-${i}-${j}`,
            ring,
            height: est * (0.8 + rng() * 0.7),
            heightSource: "estimated",
            kind,
            colorIdx: colorForBuildingType(kind, rng),
          });
        }
      }
    }
  }
  return out.slice(0, buildingSettings.maxBuildings);
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
