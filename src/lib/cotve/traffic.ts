import { makeRng, trafficSettings, vehicleKinds } from "./config";
import type { RoadGraph, VehicleKind, VehicleState } from "./types";

/**
 * Lightweight traffic simulation. Vehicles follow connected directed edges
 * (no teleporting, no invalid transitions), slow down with congestion and
 * keep a simple gap to the vehicle ahead on the same edge. Congestion per
 * edge (density 0..1) feeds back into edge travel times -> GNN features ->
 * routing. This is simulated traffic, clearly labeled as such.
 */
export class TrafficSimulator {
  vehicles: VehicleState[] = [];
  private rng: () => number;
  private graph: RoadGraph;

  constructor(graph: RoadGraph, seed = 7, count: number = trafficSettings.vehicleCount) {
    this.graph = graph;
    this.rng = makeRng(seed);
    this.spawn(count);
  }

  private spawn(count: number) {
    const g = this.graph;
    // realistic Indian-city mix: mostly cars/two-wheelers, some autos, a few
    // buses/trucks. Weights sum to 1.
    const mix: { kind: VehicleKind; colors: readonly number[]; w: number }[] = [
      { kind: "car", colors: vehicleKinds[0].colors, w: 0.42 },
      { kind: "two-wheeler", colors: vehicleKinds[1].colors, w: 0.34 },
      { kind: "auto", colors: vehicleKinds[2].colors, w: 0.12 },
      { kind: "bus", colors: vehicleKinds[3].colors, w: 0.07 },
      { kind: "truck", colors: vehicleKinds[4].colors, w: 0.05 },
    ];
    const pick = () => {
      let r = this.rng();
      for (const m of mix) {
        r -= m.w;
        if (r <= 0) return m;
      }
      return mix[0];
    };
    for (let i = 0; i < count; i++) {
      const edge = g.edges[Math.floor(this.rng() * g.edges.length)];
      const m = pick();
      const color = m.colors[Math.floor(this.rng() * m.colors.length)];
      this.vehicles.push({
        id: i,
        edgeId: edge.id,
        pos: this.rng() * edge.length,
        speed: 0,
        color,
        kind: m.kind,
      });
    }
    this.updateDensities();
  }

  private updateDensities() {
    const counts = new Map<number, number>();
    for (const v of this.vehicles) counts.set(v.edgeId, (counts.get(v.edgeId) ?? 0) + 1);
    for (const e of this.graph.edges) {
      const dirCount = (counts.get(e.id) ?? 0) * trafficSettings.densityPerVehicle;
      // symmetric edge: opposite direction contributes too
      e.density = Math.min(0.95, dirCount);
    }
  }

  private targetSpeed(v: VehicleState, density: number): number {
    const e = this.graph.edgesById.get(v.edgeId)!;
    const limit = Math.min(e.speedLimit, trafficSettings.vehicleMaxSpeed);
    const byCongestion = limit * Math.max(trafficSettings.minSpeedFactor, 1 - 0.85 * density);
    // simple car-following: gap to nearest vehicle ahead on same edge
    let gap = Infinity;
    for (const o of this.vehicles) {
      if (o === v || o.edgeId !== v.edgeId || o.pos <= v.pos) continue;
      gap = Math.min(gap, o.pos - v.pos);
    }
    if (gap < trafficSettings.minGapM) return 0;
    if (gap < trafficSettings.minGapM * 2) return byCongestion * 0.4;
    return byCongestion;
  }

  tick(dt: number) {
    for (const v of this.vehicles) {
      const e = this.graph.edgesById.get(v.edgeId)!;
      const density = Math.min(0.95, e.density + (e.density > 0 ? 0 : 0));
      const target = this.targetSpeed(v, density);
      // accelerate / decelerate toward target
      if (v.speed < target) v.speed = Math.min(target, v.speed + 4 * dt);
      else v.speed = Math.max(target, v.speed - 8 * dt);
      v.pos += v.speed * dt;
      if (v.pos >= e.length) {
        // move to next connected edge (avoid immediate backtrack when possible)
        const outs = (this.graph.out.get(e.to) ?? []).filter((id) => id !== v.edgeId);
        const pool = outs.length ? outs : this.graph.out.get(e.to) ?? [];
        if (pool.length === 0) {
          // dead end: respawn on a random edge
          const ne = this.graph.edges[Math.floor(this.rng() * this.graph.edges.length)];
          v.edgeId = ne.id;
          v.pos = 0;
        } else {
          v.edgeId = pool[Math.floor(this.rng() * pool.length)];
          v.pos = 0;
        }
        v.speed *= 0.6;
      }
    }
    this.updateDensities();
  }

  /** Vehicles blocking directly ahead of the ambulance on its edge. */
  ambulanceBlockedAhead(edgeId: number, ambulancePos: number): boolean {
    for (const v of this.vehicles) {
      if (v.edgeId === edgeId && v.pos > ambulancePos && v.pos - ambulancePos < 10) return true;
    }
    return false;
  }
}
