import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { getController } from "@/lib/cotve/simulation";
import { edgePoseAt } from "@/lib/cotve/network";
import { buildingPalette } from "@/lib/cotve/config";
import { triangulateRing } from "@/lib/cotve/triangulate";
import { useSimStore } from "@/lib/cotve/store";
import type { BuildingFootprint, RoadGraph, VehicleKind } from "@/lib/cotve/types";

const ROAD_WIDTH: Record<string, number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 5.5, tertiary: 5,
  residential: 4, unclassified: 4, living_street: 3.5, service: 3,
};

/** Daylight city palette — bright, colorful, readable urban scene. */
const C_GROUND = "#9fb587"; // muted parkland green
const C_SIDEWALK = "#d3cec3"; // warm kerb/pavement grey
const C_ROAD = new THREE.Color("#575e68"); // asphalt
const C_ROAD_MAJOR = new THREE.Color("#616a76");
const C_LANE = "#e9dca6"; // lane divider (pale yellow)
const C_MARKING = "#f2f0e8"; // stop bars / crosswalks
const C_BLOCKED = new THREE.Color("#c53030"); // simulated accident closure
const C_VEH_GLASS = "#333d49";

const SIGNAL_COLORS = {
  green: new THREE.Color("#22c55e"),
  yellow: new THREE.Color("#eab308"),
  red: new THREE.Color("#ef4444"),
  off: new THREE.Color("#14181f"),
};

// per-kind vehicle dimensions: [length(x), height(y), width(z)]
const VEH_DIMS: Record<VehicleKind, [number, number, number]> = {
  car: [4.2, 1.4, 1.8],
  "two-wheeler": [2.0, 1.1, 0.8],
  auto: [2.7, 1.6, 1.5],
  bus: [8.5, 2.6, 2.2],
  truck: [6.5, 2.7, 2.3],
};
// cabin/window block per kind: [len, height, width, bottomY] (null = none)
const VEH_CAB: Record<VehicleKind, [number, number, number, number] | null> = {
  car: [2.3, 0.55, 1.62, 1.6],
  "two-wheeler": null,
  auto: [1.6, 0.5, 1.3, 1.75],
  bus: [7.4, 0.85, 2.05, 2.55],
  truck: [1.9, 0.85, 2.15, 2.75],
};

/** window texture tile = 6.4 m wide (two windows) x 3.4 m (one floor) */
const TILE_W = 6.4;
const TILE_H = 3.4;

let _winTex: THREE.CanvasTexture | null = null;
/** Procedural facade texture: white base (vertex colour multiplies through)
 * with two dark windows and a floor band per tile. */
function windowTexture(): THREE.CanvasTexture {
  if (_winTex) return _winTex;
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#5f6b7a";
  g.fillRect(9, 12, 17, 23);
  g.fillRect(38, 12, 17, 23);
  g.fillStyle = "#9aa3b0"; // mullions
  g.fillRect(16, 12, 2, 23);
  g.fillRect(45, 12, 2, 23);
  g.fillStyle = "#dcd8cf"; // floor band
  g.fillRect(0, 46, 64, 7);
  _winTex = new THREE.CanvasTexture(c);
  _winTex.wrapS = _winTex.wrapT = THREE.RepeatWrapping;
  _winTex.colorSpace = THREE.SRGBColorSpace;
  _winTex.anisotropy = 1;
  return _winTex;
}

const TERRACOTTA_KINDS = new Set([
  "house", "detached", "bungalow", "school", "church", "roof", "cabin",
]);
/** Roof colour derived deterministically from the type-based wall colour. */
function roofColorFor(kind: string, base: [number, number, number]): [number, number, number] {
  if (TERRACOTTA_KINDS.has(kind)) return [0.74, 0.45, 0.36];
  const l = (base[0] + base[1] + base[2]) / 3;
  return [l * 0.66, l * 0.70, l * 0.78]; // muted slate
}

interface SubSeg {
  ax: number; az: number; bx: number; bz: number; len: number; width: number; major: boolean; blocked: boolean;
}
interface SignalHead { nodeId: number; axis: 0 | 1; x: number; z: number; yaw: number; width: number; }

/** One sub-segment per polyline segment of every edge — ambulance movement,
 * road rendering, lane markings and the route ribbon all share this exact
 * geometry source (map/sim alignment by construction). */
function buildSubSegs(graph: RoadGraph): SubSeg[] {
  const out: SubSeg[] = [];
  for (const e of graph.edges) {
    const w = ROAD_WIDTH[e.highwayType] ?? 4;
    const major = ["primary", "secondary", "trunk"].includes(e.highwayType);
    for (let i = 1; i < e.geom.length; i++) {
      const a = e.geom[i - 1];
      const b = e.geom[i];
      out.push({ ax: a.x, az: a.y, bx: b.x, bz: b.y, len: Math.hypot(b.x - a.x, b.y - a.y), width: w, major, blocked: e.blocked });
    }
  }
  return out;
}

/** Real traffic-signal heads placed on the APPROACH of each axis (not in the
 * middle of the junction), each facing the oncoming traffic lane. */
function buildSignalHeads(graph: RoadGraph): SignalHead[] {
  const heads: SignalHead[] = [];
  for (const n of graph.nodes) {
    if (!n.signalized || !n.signalAxes) continue;
    for (const axis of [0, 1] as const) {
      const dirs = n.signalAxes[axis];
      if (dirs.length === 0) continue;
      let dx = 0, dz = 0;
      let wSum = 0;
      for (const eId of dirs) {
        const e = graph.edgesById.get(eId)!;
        const o = graph.nodesById.get(e.to)!;
        const len = Math.hypot(o.x - n.x, o.y - n.y) || 1;
        dx += (o.x - n.x) / len;
        dz += (o.y - n.y) / len;
        wSum += ROAD_WIDTH[e.highwayType] ?? 4;
      }
      const m = Math.hypot(dx, dz) || 1;
      dx /= m; dz /= m;
      // head sits just past the stop line on the outgoing side, facing back
      // toward the intersection so approaching traffic sees the lenses.
      const off = 7;
      heads.push({
        nodeId: n.id, axis, x: n.x + dx * off, z: n.y + dz * off,
        yaw: Math.atan2(dx, dz), width: Math.max(3, wSum / dirs.length),
      });
    }
  }
  return heads;
}

/**
 * Merge real building footprints into TWO geometries — walls (with window
 * UVs) and roofs (triangulated with the robust ear-clipper) — each a single
 * draw call with baked vertex colours, integrated-graphics friendly.
 * The previous hollow-outline bug is fixed by triangulateRing(): real OSM
 * concave rings now always get a solid roof.
 */
function buildBuildingsGeometry(buildings: BuildingFootprint[]): {
  walls: THREE.BufferGeometry;
  roofs: THREE.BufferGeometry;
} {
  const wPos: number[] = [];
  const wCol: number[] = [];
  const wUv: number[] = [];
  const rPos: number[] = [];
  const rCol: number[] = [];
  const sunX = 0.62, sunZ = 0.78;

  for (const b of buildings) {
    if (b.ring.length < 3) continue;
    const base = buildingPalette[b.colorIdx % buildingPalette.length];
    const h = b.height;
    const roof = roofColorFor(b.kind, base);

    // ---- walls with window tiling -------------------------------------
    let cum = 0;
    for (let i = 0; i < b.ring.length; i++) {
      const a = b.ring[i];
      const c = b.ring[(i + 1) % b.ring.length];
      const ex = c.x - a.x, ez = c.y - a.y;
      const el = Math.hypot(ex, ez);
      if (el < 0.05) continue;
      const u0 = cum / TILE_W;
      cum += el;
      const u1 = cum / TILE_W;
      const v1 = Math.max(0.4, h / TILE_H);
      // outward-ish normal; shade walls by sun alignment for depth
      const nx = ez / el, nz = -ex / el;
      const shade = 0.66 + 0.26 * Math.max(0, nx * sunX + nz * sunZ);
      const r = base[0] * shade, g = base[1] * shade, bl = base[2] * shade;
      // (a,0)-(c,0)-(c,h) + (a,0)-(c,h)-(a,h) with matching UVs
      wPos.push(a.x, 0, a.y, c.x, 0, c.y, c.x, h, c.y, a.x, 0, a.y, c.x, h, c.y, a.x, h, a.y);
      for (let k = 0; k < 6; k++) wCol.push(r, g, bl);
      wUv.push(u0, 0, u1, 0, u1, v1, u0, 0, u1, v1, u0, v1);
    }

    // ---- roof (robust triangulation, faces up) ------------------------
    let tris: number[][];
    try {
      tris = triangulateRing(b.ring);
    } catch {
      continue;
    }
    for (const t of tris) {
      const p0 = b.ring[t[0]], p1 = b.ring[t[1]], p2 = b.ring[t[2]];
      // wind so the face normal points up (+Y) in world space
      const up = (p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x);
      const order = up > 0 ? [p0, p2, p1] : [p0, p1, p2];
      // slight per-building brightness jitter so rooftops vary
      const jit = 0.94 + ((b.id.length * 37 + t[0] * 13) % 10) * 0.012;
      for (const p of order) {
        rPos.push(p.x, h + 0.05, p.y);
        rCol.push(Math.min(1, roof[0] * jit), Math.min(1, roof[1] * jit), Math.min(1, roof[2] * jit));
      }
    }
  }

  const walls = new THREE.BufferGeometry();
  walls.setAttribute("position", new THREE.Float32BufferAttribute(wPos, 3));
  walls.setAttribute("color", new THREE.Float32BufferAttribute(wCol, 3));
  walls.setAttribute("uv", new THREE.Float32BufferAttribute(wUv, 2));
  const roofs = new THREE.BufferGeometry();
  roofs.setAttribute("position", new THREE.Float32BufferAttribute(rPos, 3));
  roofs.setAttribute("color", new THREE.Float32BufferAttribute(rCol, 3));
  return { walls, roofs };
}

/** Daylight sky shared by BOTH 3D screens (set declaratively in the Canvas). */
export const SKY_COLOR = "#cfe6f5";
export const SKY_FOG: [number, number] = [450, 2300];

export default function CityScene({ zoomRef }: { zoomRef: React.MutableRefObject<number> }) {
  const networkReady = useSimStore((s) => s.networkReady);
  const version = useSimStore((s) => s.simVersion);
  const blockVersion = useSimStore((s) => s.blockVersion);
  if (!networkReady || !getController().graph) return null;
  return <CitySceneInner key={`${version}-${blockVersion}`} zoomRef={zoomRef} />;
}

function CitySceneInner({ zoomRef }: { zoomRef: React.MutableRefObject<number> }) {
  const ctrl = getController();
  const graph = ctrl.graph;
  const blockVersion = useSimStore((s) => s.blockVersion);

  const segs = useMemo(() => buildSubSegs(graph), [graph]);
  // real OSM footprints (clearly-labeled synthetic on the demo grid)
  const building = useMemo(() => buildBuildingsGeometry(ctrl.buildings), [ctrl.buildings]);
  const heads = useMemo(() => buildSignalHeads(graph), [graph]);
  // accident markers: midpoints of blocked edges (SIMULATED, labeled in HUD)
  // blockVersion intentionally busts this cache (edges mutate in place)
  const blockedMids = useMemo(() => {
    void blockVersion; // intentional cache-bust: edges mutate in place
    const mids: { x: number; z: number }[] = [];
    for (const e of graph.edges) {
      if (!e.blocked) continue;
      const i = Math.floor(e.geom.length / 2);
      mids.push({ x: e.geom[i].x, z: e.geom[i].y });
    }
    return mids;
  }, [graph, blockVersion]);

  const roadsRef = useRef<THREE.InstancedMesh>(null!);
  const walkRef = useRef<THREE.InstancedMesh>(null!);
  const laneRef = useRef<THREE.InstancedMesh>(null!);
  const poleRef = useRef<THREE.InstancedMesh>(null!);
  const housingRef = useRef<THREE.InstancedMesh>(null!);
  const lensRedRef = useRef<THREE.InstancedMesh>(null!);
  const lensAmberRef = useRef<THREE.InstancedMesh>(null!);
  const lensGreenRef = useRef<THREE.InstancedMesh>(null!);
  const stopRef = useRef<THREE.InstancedMesh>(null!);
  const crossRef = useRef<THREE.InstancedMesh>(null!);
  const vehRef = useRef<THREE.InstancedMesh>(null!);
  const cabRef = useRef<THREE.InstancedMesh>(null!);
  const ambRef = useRef<THREE.Group>(null!);
  const lightRedRef = useRef<THREE.MeshBasicMaterial>(null!);
  const lightBlueRef = useRef<THREE.MeshBasicMaterial>(null!);
  const routeRef = useRef<THREE.InstancedMesh>(null!);
  const patientRef = useRef<THREE.Group>(null!);
  const patientRingRef = useRef<THREE.Mesh>(null!);
  const patientAccessRef = useRef<THREE.Mesh>(null!);
  const accessLineRef = useRef<THREE.Line>(null!);
  const hospitalRef = useRef<THREE.Group>(null!);
  const dispatchHospRef = useRef<THREE.Group>(null!);
  const hospitalAccessRef = useRef<THREE.Mesh>(null!);
  const accidentRef = useRef<THREE.InstancedMesh>(null!);
  const lastRouteRef = useRef<unknown>(null);
  const accessObj = useMemo(
    () => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#334155" })),
    [],
  );
  const tmpM = useMemo(() => new THREE.Matrix4(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);
  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpS = useMemo(() => new THREE.Vector3(), []);
  const tmpC = useMemo(() => new THREE.Color(), []);
  const E_UP = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  const headCount = Math.max(heads.length, 1);
  const CROSS_PER_HEAD = 4;
  const MAX_ROUTE_SEGS = 3200;

  useLayoutEffect(() => {
    // roads + kerbs/pavements + lane dividers, all from the SAME sub-segments
    if (roadsRef.current) {
      segs.forEach((s, i) => {
        const mx = (s.ax + s.bx) / 2;
        const mz = (s.az + s.bz) / 2;
        const ang = Math.atan2(s.bz - s.az, s.bx - s.ax);
        tmpQ.setFromAxisAngle(E_UP, -ang);
        tmpV.set(mx, 0.05, mz);
        tmpS.set(s.len, 0.16, s.width);
        tmpM.compose(tmpV, tmpQ, tmpS);
        roadsRef.current.setMatrixAt(i, tmpM);
        roadsRef.current.setColorAt(i, s.blocked ? C_BLOCKED : s.major ? C_ROAD_MAJOR : C_ROAD);
      });
      roadsRef.current.instanceMatrix.needsUpdate = true;
      if (roadsRef.current.instanceColor) roadsRef.current.instanceColor.needsUpdate = true;
    }
    if (walkRef.current) {
      segs.forEach((s, i) => {
        const mx = (s.ax + s.bx) / 2;
        const mz = (s.az + s.bz) / 2;
        const ang = Math.atan2(s.bz - s.az, s.bx - s.ax);
        tmpQ.setFromAxisAngle(E_UP, -ang);
        tmpV.set(mx, 0.005, mz);
        tmpS.set(s.len + 1.2, 0.09, s.width + 3.4);
        tmpM.compose(tmpV, tmpQ, tmpS);
        walkRef.current.setMatrixAt(i, tmpM);
      });
      walkRef.current.instanceMatrix.needsUpdate = true;
    }
    if (laneRef.current) {
      segs.forEach((s, i) => {
        if (!s.major || s.blocked) {
          tmpM.makeScale(0, 0, 0);
        } else {
          const mx = (s.ax + s.bx) / 2;
          const mz = (s.az + s.bz) / 2;
          const ang = Math.atan2(s.bz - s.az, s.bx - s.ax);
          tmpQ.setFromAxisAngle(E_UP, -ang);
          tmpV.set(mx, 0.14, mz);
          tmpS.set(s.len, 0.02, 0.18);
          tmpM.compose(tmpV, tmpQ, tmpS);
        }
        laneRef.current.setMatrixAt(i, tmpM);
      });
      laneRef.current.instanceMatrix.needsUpdate = true;
    }
    // signal poles + housings (existing structure, graphite finish)
    if (poleRef.current) {
      heads.forEach((h, i) => {
        tmpM.makeTranslation(h.x, 3, h.z);
        poleRef.current.setMatrixAt(i, tmpM);
      });
      poleRef.current.instanceMatrix.needsUpdate = true;
    }
    if (housingRef.current) {
      heads.forEach((h, i) => {
        tmpQ.setFromAxisAngle(E_UP, -h.yaw);
        tmpV.set(h.x, 5.4, h.z);
        tmpS.set(1, 2.6, 0.5);
        tmpM.compose(tmpV, tmpQ, tmpS);
        housingRef.current.setMatrixAt(i, tmpM);
      });
      housingRef.current.instanceMatrix.needsUpdate = true;
    }
    // stop bars + zebra crosswalks at every signalized approach
    if (stopRef.current) {
      heads.forEach((h, i) => {
        tmpQ.setFromAxisAngle(E_UP, -h.yaw);
        tmpV.set(h.x, 0.16, h.z);
        tmpS.set(0.5, 0.03, Math.min(5, h.width * 0.9));
        tmpM.compose(tmpV, tmpQ, tmpS);
        stopRef.current.setMatrixAt(i, tmpM);
      });
      stopRef.current.instanceMatrix.needsUpdate = true;
    }
    if (crossRef.current) {
      let idx = 0;
      const span = (w: number) => Math.min(4.6, w * 0.8);
      heads.forEach((h) => {
        const half = span(h.width) / 2;
        for (let k = 0; k < CROSS_PER_HEAD; k++) {
          const off = -half + (2 * half * k) / (CROSS_PER_HEAD - 1);
          // stripe sits just beyond the stop line, across the approach
          const px = h.x + Math.sin(h.yaw) * 2.4 + Math.cos(h.yaw) * off;
          const pz = h.z + Math.cos(h.yaw) * 2.4 - Math.sin(h.yaw) * off;
          tmpQ.setFromAxisAngle(E_UP, -h.yaw);
          tmpV.set(px, 0.16, pz);
          tmpS.set(2.0, 0.02, 0.6); // zebra: long along travel, spaced across
          tmpM.compose(tmpV, tmpQ, tmpS);
          crossRef.current.setMatrixAt(idx++, tmpM);
        }
      });
      for (; idx < crossRef.current.count; idx++) {
        tmpM.makeScale(0, 0, 0);
        crossRef.current.setMatrixAt(idx, tmpM);
      }
      crossRef.current.instanceMatrix.needsUpdate = true;
    }
    // lenses: 3 stacked per head (red top, amber mid, green bottom)
    const placeLens = (ref: React.MutableRefObject<THREE.InstancedMesh>, yOff: number) => {
      if (!ref.current) return;
      heads.forEach((h, i) => {
        const fx = h.x - Math.sin(h.yaw) * 0.3;
        const fz = h.z - Math.cos(h.yaw) * 0.3;
        tmpQ.setFromAxisAngle(E_UP, -h.yaw);
        tmpV.set(fx, 5.4 + yOff, fz);
        tmpS.set(0.62, 0.62, 0.25);
        tmpM.compose(tmpV, tmpQ, tmpS);
        ref.current.setMatrixAt(i, tmpM);
        ref.current.setColorAt(i, SIGNAL_COLORS.off);
      });
      ref.current.instanceMatrix.needsUpdate = true;
      if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
    };
    placeLens(lensRedRef, 0.8);
    placeLens(lensAmberRef, 0.0);
    placeLens(lensGreenRef, -0.8);
    // accident markers: big red cone + two small orange helper cones
    if (accidentRef.current) {
      let idx = 0;
      blockedMids.forEach((m) => {
        const spots: [number, number, number, number][] = [
          [m.x, 2.0, m.z, 1], // main
          [m.x + 4.5, 0.9, m.z + 3, 0.5],
          [m.x - 4.5, 0.9, m.z - 3, 0.5],
        ];
        for (const [x, y, z, s] of spots) {
          if (idx >= accidentRef.current.count) break;
          tmpM.compose(
            tmpV.set(x, y, z),
            tmpQ.identity(),
            tmpS.set(s, s, s),
          );
          accidentRef.current.setMatrixAt(idx, tmpM);
          accidentRef.current.setColorAt(idx, tmpC.set(s === 1 ? "#dc2626" : "#f97316"));
          idx++;
        }
      });
      for (; idx < accidentRef.current.count; idx++) {
        tmpM.makeScale(0, 0, 0);
        accidentRef.current.setMatrixAt(idx, tmpM);
      }
      accidentRef.current.instanceMatrix.needsUpdate = true;
      if (accidentRef.current.instanceColor) accidentRef.current.instanceColor.needsUpdate = true;
    }
    // vehicles + route ribbon start hidden
    for (const ref of [vehRef, cabRef, routeRef]) {
      if (!ref.current) continue;
      for (let i = 0; i < ref.current.count; i++) {
        tmpM.makeScale(0, 0, 0);
        ref.current.setMatrixAt(i, tmpM);
      }
      ref.current.instanceMatrix.needsUpdate = true;
    }
  }, [segs, heads, blockedMids, tmpM, tmpQ, tmpS, tmpV, tmpC, E_UP]);

  useFrame(({ clock }) => {
    const live = ctrl.live;
    const t = clock.elapsedTime;

    // vehicles along REAL edge geometry, per-kind size + colour + cabin
    if (vehRef.current && live.vehicles) {
      live.vehicles.forEach((v, i) => {
        if (i >= vehRef.current.count) return;
        const e = ctrl.graph.edgesById.get(v.edgeId);
        if (!e) {
          tmpM.makeScale(0, 0, 0);
          vehRef.current.setMatrixAt(i, tmpM);
          if (cabRef.current) cabRef.current.setMatrixAt(i, tmpM);
          return;
        }
        const pose = edgePoseAt(e, v.pos);
        const dim = VEH_DIMS[v.kind] ?? VEH_DIMS.car;
        tmpQ.setFromAxisAngle(E_UP, -pose.heading);
        tmpV.set(pose.x, dim[1] / 2 + 0.2, pose.y);
        tmpS.set(dim[0], dim[1], dim[2]);
        tmpM.compose(tmpV, tmpQ, tmpS);
        vehRef.current.setMatrixAt(i, tmpM);
        vehRef.current.setColorAt(i, tmpC.set(v.color));
        if (cabRef.current) {
          const cab = VEH_CAB[v.kind];
          if (!cab) {
            tmpM.makeScale(0, 0, 0);
          } else {
            tmpV.set(pose.x, cab[3] + cab[1] / 2, pose.y);
            tmpS.set(cab[0], cab[1], cab[2]);
            tmpM.compose(tmpV, tmpQ, tmpS);
          }
          cabRef.current.setMatrixAt(i, tmpM);
        }
      });
      vehRef.current.instanceMatrix.needsUpdate = true;
      if (vehRef.current.instanceColor) vehRef.current.instanceColor.needsUpdate = true;
      if (cabRef.current) cabRef.current.instanceMatrix.needsUpdate = true;
    }

    // ambulance: position + tangent heading straight from the controller
    const a = live.ambulance;
    if (a && ambRef.current) {
      ambRef.current.visible = true;
      ambRef.current.position.set(a.x, 0, a.y);
      ambRef.current.rotation.y = -a.heading;
      const blink = Math.sin(t * 9) > 0;
      lightRedRef.current.color.set(blink ? "#ef4444" : "#3a0d0d");
      lightBlueRef.current.color.set(blink ? "#2563eb" : "#0c1e4a");
    } else if (ambRef.current) {
      ambRef.current.visible = false;
    }

    // 3-lens signal heads: light the active lens, keep others dark
    if (lensRedRef.current && lensAmberRef.current && lensGreenRef.current && live.signals) {
      heads.forEach((h, i) => {
        const s = live.signals.get(h.nodeId);
        const col = s ? ctrl.signals.colorOf(s, h.axis) : "red";
        const lit = SIGNAL_COLORS[col];
        lensRedRef.current.setColorAt(i, col === "red" ? lit : SIGNAL_COLORS.off);
        lensAmberRef.current.setColorAt(i, col === "yellow" ? lit : SIGNAL_COLORS.off);
        lensGreenRef.current.setColorAt(i, col === "green" ? lit : SIGNAL_COLORS.off);
      });
      for (const r of [lensRedRef, lensAmberRef, lensGreenRef]) {
        if (r.current?.instanceColor) r.current.instanceColor.needsUpdate = true;
      }
    }

    // thick navigation-style route ribbon from the SAME edge geometry used
    // for routing + movement (never a straight line, never across buildings)
    if (routeRef.current && live.routeEdgeIds !== lastRouteRef.current) {
      lastRouteRef.current = live.routeEdgeIds;
      const cap = routeRef.current.count;
      let i = 0;
      for (const id of live.routeEdgeIds) {
        const e = ctrl.graph.edgesById.get(id);
        if (!e) continue;
        for (let k = 1; k < e.geom.length && i < cap; k++) {
          const p = e.geom[k - 1];
          const q = e.geom[k];
          const ang = Math.atan2(q.y - p.y, q.x - p.x);
          tmpQ.setFromAxisAngle(E_UP, -ang);
          tmpV.set((p.x + q.x) / 2, 0.34, (p.y + q.y) / 2);
          tmpS.set(Math.hypot(q.x - p.x, q.y - p.y) + 0.5, 0.1, 2.5);
          tmpM.compose(tmpV, tmpQ, tmpS);
          routeRef.current.setMatrixAt(i++, tmpM);
        }
      }
      for (let k = i; k < cap; k++) {
        tmpM.makeScale(0, 0, 0);
        routeRef.current.setMatrixAt(k, tmpM);
      }
      routeRef.current.instanceMatrix.needsUpdate = true;
      routeRef.current.visible = i > 0;
    }

    // markers
    if (patientRef.current) {
      const p = ctrl.patient ? ctrl.patientXY() : null;
      patientRef.current.visible = !!p;
      if (p) {
        patientRef.current.position.set(p.x, 0, p.y);
        patientRef.current.scale.setScalar(1 + 0.08 * Math.sin(t * 4));
      }
    }
    if (patientRingRef.current) {
      const p = ctrl.patient ? ctrl.patientXY() : null;
      patientRingRef.current.visible = !!p;
      if (p) {
        patientRingRef.current.position.set(p.x, 0.18, p.y);
        const s = 1 + 0.25 * (0.5 + 0.5 * Math.sin(t * 3));
        patientRingRef.current.scale.set(s, s, 1);
      }
    }
    if (patientAccessRef.current) {
      const pa = ctrl.patient ? ctrl.patientAccessXY() : null;
      patientAccessRef.current.visible = !!pa;
      if (pa) patientAccessRef.current.position.set(pa.x, 1.2, pa.y);
    }
    if (accessLineRef.current) {
      const p = ctrl.patient ? ctrl.patientXY() : null;
      const pa = ctrl.patient ? ctrl.patientAccessXY() : null;
      const show = !!p && !!pa;
      accessLineRef.current.visible = show;
      if (show) {
        accessLineRef.current.geometry.dispose();
        accessLineRef.current.geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(p!.x, 0.5, p!.y),
          new THREE.Vector3(pa!.x, 0.5, pa!.y),
        ]);
      }
    }
    // treatment hospital
    if (hospitalRef.current) {
      const h = ctrl.hospitalCand ? ctrl.hospitalXY() : null;
      hospitalRef.current.visible = !!h;
      if (h) hospitalRef.current.position.set(h.x, 0, h.y);
    }
    // dispatch hospital (ambulance start) — only shown when distinct
    if (dispatchHospRef.current) {
      const dh = ctrl.dispatchHospitalCand ? ctrl.dispatchHospitalXY() : null;
      const distinct = dh && (!ctrl.hospitalCand || ctrl.dispatchHospitalCand!.id !== ctrl.hospitalCand?.id);
      dispatchHospRef.current.visible = !!distinct;
      if (distinct) dispatchHospRef.current.position.set(dh!.x, 0, dh!.y);
    }
    if (hospitalAccessRef.current) {
      const ha = ctrl.hospitalCand ? ctrl.hospitalAccessXY() : null;
      hospitalAccessRef.current.visible = !!ha;
      if (ha) hospitalAccessRef.current.position.set(ha.x, 1.2, ha.y);
    }

    void zoomRef;
  });

  const b = graph.bounds;
  const gw = Math.max(b.maxX - b.minX, 800) * 4;
  const gh = Math.max(b.maxY - b.minY, 800) * 4;

  return (
    <group>
      {/* ground: muted parkland green (daylight) */}
      <mesh position={[0, -0.06, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[gw, gh]} />
        <meshBasicMaterial color={C_GROUND} />
      </mesh>

      {/* real OSM building footprints: windowed walls + solid roofs */}
      {building.walls.attributes.position.count > 0 && (
        <mesh geometry={building.walls} frustumCulled={false}>
          <meshBasicMaterial map={windowTexture()} vertexColors />
        </mesh>
      )}
      {building.roofs.attributes.position.count > 0 && (
        <mesh geometry={building.roofs} frustumCulled={false}>
          <meshBasicMaterial vertexColors side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* kerbs/pavements UNDER the asphalt (wider strip) */}
      <instancedMesh ref={walkRef} args={[undefined, undefined, Math.max(segs.length, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={C_SIDEWALK} />
      </instancedMesh>

      {/* roads: one instance per real polyline segment; blocked -> red */}
      <instancedMesh ref={roadsRef} args={[undefined, undefined, Math.max(segs.length, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial />
      </instancedMesh>

      {/* lane divider on major roads */}
      <instancedMesh ref={laneRef} args={[undefined, undefined, Math.max(segs.length, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={C_LANE} />
      </instancedMesh>

      {/* route ribbon (navigation-style thick line, real geometry) */}
      <instancedMesh ref={routeRef} args={[undefined, undefined, MAX_ROUTE_SEGS]} frustumCulled={false} visible={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#f59e0b" />
      </instancedMesh>

      {/* traffic signals: pole + housing + 3 stacked lenses per head */}
      <instancedMesh ref={poleRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <cylinderGeometry args={[0.16, 0.2, 6, 6]} />
        <meshBasicMaterial color="#3a3f46" />
      </instancedMesh>
      <instancedMesh ref={housingRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#1c2026" />
      </instancedMesh>
      <instancedMesh ref={lensRedRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <sphereGeometry args={[0.5, 8, 6]} />
        <meshBasicMaterial />
      </instancedMesh>
      <instancedMesh ref={lensAmberRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <sphereGeometry args={[0.5, 8, 6]} />
        <meshBasicMaterial />
      </instancedMesh>
      <instancedMesh ref={lensGreenRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <sphereGeometry args={[0.5, 8, 6]} />
        <meshBasicMaterial />
      </instancedMesh>

      {/* stop bars + zebra crossings at signalized approaches */}
      <instancedMesh ref={stopRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={C_MARKING} />
      </instancedMesh>
      <instancedMesh ref={crossRef} args={[undefined, undefined, Math.max(heads.length * CROSS_PER_HEAD, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={C_MARKING} />
      </instancedMesh>

      {/* normal traffic: body + dark glass cabin */}
      <instancedMesh ref={vehRef} args={[undefined, undefined, Math.max(ctrl.traffic?.vehicles.length ?? 0, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial />
      </instancedMesh>
      <instancedMesh ref={cabRef} args={[undefined, undefined, Math.max(ctrl.traffic?.vehicles.length ?? 0, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={C_VEH_GLASS} />
      </instancedMesh>

      {/* simulated accident markers on blocked segments */}
      <instancedMesh ref={accidentRef} args={[undefined, undefined, Math.max(blockedMids.length * 3, 1)]} frustumCulled={false} visible={blockedMids.length > 0}>
        <coneGeometry args={[1.6, 4, 8]} />
        <meshBasicMaterial />
      </instancedMesh>

      <primitive ref={accessLineRef} object={accessObj} visible={false} />

      {/* patient pin + pulsing ground ring */}
      <group ref={patientRef} visible={false}>
        <mesh position={[0, 7.4, 0]}>
          <sphereGeometry args={[1.6, 14, 10]} />
          <meshBasicMaterial color="#dc2626" />
        </mesh>
        <mesh position={[0, 3.9, 0]} rotation={[Math.PI, 0, 0]}>
          <coneGeometry args={[1.1, 5.6, 12]} />
          <meshBasicMaterial color="#dc2626" />
        </mesh>
      </group>
      <mesh ref={patientRingRef} visible={false} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[2.7, 4.0, 26]} />
        <meshBasicMaterial color="#ef4444" transparent opacity={0.55} />
      </mesh>
      <mesh ref={patientAccessRef} visible={false}>
        <sphereGeometry args={[1.1, 10, 8]} />
        <meshBasicMaterial color="#f87171" />
      </mesh>
      <mesh ref={hospitalAccessRef} visible={false}>
        <sphereGeometry args={[1.1, 10, 8]} />
        <meshBasicMaterial color="#38bdf8" />
      </mesh>

      {/* treatment hospital: white block + red cross on all faces + roof */}
      <group ref={hospitalRef} visible={false}>
        <mesh position={[0, 6, 0]}>
          <boxGeometry args={[12, 12, 12]} />
          <meshBasicMaterial color="#f4f6f8" />
        </mesh>
        {[[-6.05, 0, 0], [6.05, 0, Math.PI], [0, -6.05, Math.PI / 2], [0, 6.05, -Math.PI / 2]].map(([x, z, ry], i) => (
          <group key={i} position={[x, 6.4, z]} rotation={[0, ry, 0]}>
            <mesh><boxGeometry args={[4.4, 1.5, 0.2]} /><meshBasicMaterial color="#dc2626" /></mesh>
            <mesh><boxGeometry args={[1.5, 4.4, 0.2]} /><meshBasicMaterial color="#dc2626" /></mesh>
          </group>
        ))}
        <mesh position={[0, 12.15, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <boxGeometry args={[5, 5, 0.2]} />
          <meshBasicMaterial color="#dc2626" />
        </mesh>
      </group>

      {/* dispatch hospital / ambulance bay: white block + green cross */}
      <group ref={dispatchHospRef} visible={false}>
        <mesh position={[0, 5, 0]}>
          <boxGeometry args={[10, 10, 10]} />
          <meshBasicMaterial color="#eef2f0" />
        </mesh>
        {[[-5.05, 0], [5.05, 0]].map(([x, z], i) => (
          <group key={i} position={[x, 5.6, z]} rotation={[0, i === 0 ? 0 : Math.PI, 0]}>
            <mesh><boxGeometry args={[3.8, 1.3, 0.2]} /><meshBasicMaterial color="#16a34a" /></mesh>
            <mesh><boxGeometry args={[1.3, 3.8, 0.2]} /><meshBasicMaterial color="#16a34a" /></mesh>
          </group>
        ))}
        {/* ambulance bay door */}
        <mesh position={[0, 2.2, 5.02]}>
          <boxGeometry args={[4.4, 4.4, 0.15]} />
          <meshBasicMaterial color="#334155" />
        </mesh>
        <mesh position={[0, 10.3, 0]}>
          <boxGeometry args={[1.6, 0.6, 1.6]} />
          <meshBasicMaterial color="#facc15" />
        </mesh>
      </group>

      {/* ambulance: body + cabin + wheels + light bar + red cross */}
      <group ref={ambRef} visible={false}>
        <mesh position={[0, 1.2, 0]}>
          <boxGeometry args={[4.6, 1.7, 2.1]} />
          <meshBasicMaterial color="#f8fafc" />
        </mesh>
        <mesh position={[1.6, 1.0, 0]}>
          <boxGeometry args={[1.4, 1.2, 1.9]} />
          <meshBasicMaterial color="#e2e8f0" />
        </mesh>
        {/* windshield */}
        <mesh position={[2.32, 1.25, 0]}>
          <boxGeometry args={[0.06, 0.75, 1.7]} />
          <meshBasicMaterial color="#3b4a5c" />
        </mesh>
        {/* red stripe */}
        <mesh position={[0, 1.0, 1.06]}>
          <boxGeometry args={[4.6, 0.5, 0.06]} />
          <meshBasicMaterial color="#dc2626" />
        </mesh>
        <mesh position={[0, 1.0, -1.06]}>
          <boxGeometry args={[4.6, 0.5, 0.06]} />
          <meshBasicMaterial color="#dc2626" />
        </mesh>
        {/* red cross on sides */}
        {[-1.07, 1.07].map((z, i) => (
          <group key={i} position={[-0.6, 1.5, z]}>
            <mesh><boxGeometry args={[1.1, 0.32, 0.04]} /><meshBasicMaterial color="#dc2626" /></mesh>
            <mesh><boxGeometry args={[0.32, 1.1, 0.04]} /><meshBasicMaterial color="#dc2626" /></mesh>
          </group>
        ))}
        {/* light bar (flashing red/blue) */}
        <mesh position={[0.2, 2.15, 0.45]}>
          <boxGeometry args={[0.8, 0.32, 0.4]} />
          <meshBasicMaterial ref={lightRedRef} color="#ef4444" />
        </mesh>
        <mesh position={[0.2, 2.15, -0.45]}>
          <boxGeometry args={[0.8, 0.32, 0.4]} />
          <meshBasicMaterial ref={lightBlueRef} color="#2563eb" />
        </mesh>
        {/* wheels */}
        {[[1.5, 1.05], [1.5, -1.05], [-1.5, 1.05], [-1.5, -1.05]].map(([x, z], i) => (
          <mesh key={i} position={[x, 0.45, z]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.45, 0.45, 0.3, 10]} />
            <meshBasicMaterial color="#111111" />
          </mesh>
        ))}
      </group>
    </group>
  );
}
