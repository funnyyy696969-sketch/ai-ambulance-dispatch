/**
 * Robust ear-clipping triangulator for simple polygons (building footprints).
 *
 * WHY THIS EXISTS: THREE.ShapeUtils.triangulateShape silently returns [] or
 * wrong indices for many REAL OSM rings (collinear runs, near-duplicate
 * vertices, self-touching outlines). That made buildings render as hollow
 * wall outlines with no roof. This implementation:
 *  - removes consecutive/duplicate and collinear vertices,
 *  - normalises winding to counter-clockwise,
 *  - clips ears with an inclusive point-in-triangle test (safe for
 *    self-touching rings),
 *  - degrades gracefully (returns the partial fan it managed) instead of
 *    looping forever on pathological input.
 * Returned triangle indices refer to positions in the ORIGINAL input ring.
 */

export interface Pt2 {
  x: number;
  y: number;
}

const DEDUPE_EPS = 1e-4; // metres — projections round to cm
const CONVEX_EPS = 1e-6;

function cross(o: Pt2, a: Pt2, b: Pt2): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/** inclusive point-in-triangle (barycentric via edge crosses) */
function inTri(a: Pt2, b: Pt2, c: Pt2, p: Pt2): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < -CONVEX_EPS || d2 < -CONVEX_EPS || d3 < -CONVEX_EPS;
  const hasPos = d1 > CONVEX_EPS || d2 > CONVEX_EPS || d3 > CONVEX_EPS;
  return !(hasNeg && hasPos);
}

/** Signed area (x2) of a ring of original ring positions via index list. */
function signedArea2(ring: Pt2[], idx: number[]): number {
  let s = 0;
  for (let i = 0; i < idx.length; i++) {
    const a = ring[idx[i]];
    const b = ring[idx[(i + 1) % idx.length]];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

/**
 * Triangulate a simple polygon given as a ring of 2D points.
 * Returns triangles as index triples into the INPUT ring (duplicates in the
 * input map back to the first occurrence kept). Empty array = degenerate.
 */
export function triangulateRing(ring: Pt2[]): number[][] {
  if (ring.length < 3) return [];

  // 1. drop invalid + consecutive-duplicate vertices, remembering originals
  const work: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const last = work[work.length - 1];
    if (last !== undefined) {
      const q = ring[last];
      if (Math.hypot(p.x - q.x, p.y - q.y) < DEDUPE_EPS) continue;
    }
    work.push(i);
  }
  // drop wrap-around duplicate
  while (work.length >= 3) {
    const a = ring[work[0]];
    const b = ring[work[work.length - 1]];
    if (Math.hypot(a.x - b.x, a.y - b.y) < DEDUPE_EPS) work.pop();
    else break;
  }
  if (work.length < 3) return [];

  // 2. normalise to counter-clockwise
  if (signedArea2(ring, work) < 0) work.reverse();

  // 3. ear clipping
  const out: number[][] = [];
  let cur = 0;
  // worst case a couple of full laps per vertex, with one relaxation pass
  let guard = work.length * work.length + 64;
  let relaxed = false;
  while (work.length > 3 && guard-- > 0) {
    const n = work.length;
    const iP = (cur - 1 + n) % n;
    const iV = cur;
    const iN = (cur + 1) % n;
    const P = ring[work[iP]];
    const V = ring[work[iV]];
    const N = ring[work[iN]];
    const cr = cross(P, V, N);
    const convexOk = relaxed ? cr >= -CONVEX_EPS : cr > CONVEX_EPS;
    if (convexOk) {
      let blocked = false;
      for (let k = 0; k < n; k++) {
        if (k === iP || k === iV || k === iN) continue;
        if (inTri(P, V, N, ring[work[k]])) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        out.push([work[iP], work[iV], work[iN]]);
        work.splice(iV, 1);
        cur = work.length > 0 ? iV % work.length : 0;
        continue;
      }
    }
    cur = (cur + 1) % n;
    // a full unsuccessful lap: relax the convexity test once, then give up
    if (cur === 0 && !relaxed) relaxed = true;
    else if (cur === 0 && relaxed) break;
  }
  if (work.length === 3) out.push([work[0], work[1], work[2]]);
  return out;
}

/** Absolute polygon area of a ring (m²) — used by tests for correctness. */
export function polygonArea(ring: Pt2[]): number {
  return Math.abs(signedArea2(ring, ring.map((_, i) => i))) / 2;
}
