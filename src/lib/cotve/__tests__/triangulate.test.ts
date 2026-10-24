/**
 * Triangulator correctness suite. The strong invariant: the sum of triangle
 * areas must equal the polygon area — this catches hollow (missing) and
 * overlapping (garbage) triangulation, which previously made real OSM
 * buildings render as hollow outlines.
 */
import { describe, it, expect } from "vitest";
import { triangulateRing, polygonArea, type Pt2 } from "../triangulate";

const triArea = (ring: Pt2[], t: number[]) =>
  Math.abs(
    (ring[t[1]].x - ring[t[0]].x) * (ring[t[2]].y - ring[t[0]].y) -
      (ring[t[2]].x - ring[t[0]].x) * (ring[t[1]].y - ring[t[0]].y),
  ) / 2;

const coversAllVertices = (ring: Pt2[], tris: number[][]) => {
  const seen = new Set<number>();
  for (const t of tris) for (const i of t) seen.add(i);
  // every unique vertex must appear in at least one triangle
  const uniq = new Set(ring.map((p) => `${p.x},${p.y}`));
  const seenPts = new Set([...seen].map((i) => `${ring[i].x},${ring[i].y}`));
  expect(seenPts.size).toBe(uniq.size);
};

describe("triangulateRing", () => {
  it("triangulates a square into 2 triangles covering full area", () => {
    const sq: Pt2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }];
    const tris = triangulateRing(sq);
    expect(tris.length).toBe(2);
    const sum = tris.reduce((s, t) => s + triArea(sq, t), 0);
    expect(sum).toBeCloseTo(polygonArea(sq), 6);
    coversAllVertices(sq, tris);
  });

  it("triangulates a concave L-shape completely (the OSM failure case)", () => {
    const L: Pt2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 },
      { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 },
    ];
    const tris = triangulateRing(L);
    expect(tris.length).toBe(L.length - 2);
    const sum = tris.reduce((s, t) => s + triArea(L, t), 0);
    expect(sum).toBeCloseTo(polygonArea(L), 6);
    coversAllVertices(L, tris);
  });

  it("handles clockwise winding identically", () => {
    const cw: Pt2[] = [{ x: 0, y: 0 }, { x: 0, y: 8 }, { x: 10, y: 8 }, { x: 10, y: 0 }];
    const tris = triangulateRing(cw);
    const sum = tris.reduce((s, t) => s + triArea(cw, t), 0);
    expect(sum).toBeCloseTo(polygonArea(cw), 6);
  });

  it("tolerates duplicate and collinear vertices (real OSM rings)", () => {
    const messy: Pt2[] = [
      { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, // collinear run
      { x: 10, y: 0 }, { x: 10, y: 8 },                // duplicate
      { x: 0, y: 8 }, { x: 0, y: 0 },                  // wrap duplicate
    ];
    const tris = triangulateRing(messy);
    expect(tris.length).toBeGreaterThan(0);
    const sum = tris.reduce((s, t) => s + triArea(messy, t), 0);
    expect(sum).toBeCloseTo(polygonArea(messy), 4);
  });

  it("handles a U-shape (deep concavity)", () => {
    const U: Pt2[] = [
      { x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 10 },
      { x: 8, y: 10 }, { x: 8, y: 3 }, { x: 4, y: 3 },
      { x: 4, y: 10 }, { x: 0, y: 10 },
    ];
    const tris = triangulateRing(U);
    const sum = tris.reduce((s, t) => s + triArea(U, t), 0);
    expect(sum).toBeCloseTo(polygonArea(U), 6);
  });

  it("returns [] for degenerate input", () => {
    expect(triangulateRing([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toEqual([]);
    expect(triangulateRing([])).toEqual([]);
  });
});
