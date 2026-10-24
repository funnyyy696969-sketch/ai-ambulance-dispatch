import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { getController } from "@/lib/cotve/simulation";
import { edgePoseAt, routePolyline } from "@/lib/cotve/network";
import { buildingPalette } from "@/lib/cotve/config";
import { useSimStore } from "@/lib/cotve/store";
import type { BuildingFootprint, RoadGraph, VehicleKind } from "@/lib/cotve/types";

const ROAD_WIDTH: Record<string, number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 5.5, tertiary: 5,
  residential: 4, unclassified: 4, living_street: 3.5, service: 3,
};

const SIGNAL_COLORS = {
  green: new THREE.Color("#22c55e"),
  yellow: new THREE.Color("#eab308"),
  red: new THREE.Color("#ef4444"),
  off: new THREE.Color("#14181f"),
};
const C_ROAD = new THREE.Color("#3a4656");
const C_ROAD_MAJOR = new THREE.Color("#4b5a70");
const C_BLOCKED = new THREE.Color("#b91c1c");

// per-kind vehicle dimensions: [length(x), height(y), width(z)]
const VEH_DIMS: Record<VehicleKind, [number, number, number]> = {
  car: [4.2, 1.4, 1.8],
  "two-wheeler": [2.0, 1.1, 0.8],
  auto: [2.7, 1.6, 1.5],
  bus: [8.5, 2.6, 2.2],
  truck: [6.5, 2.7, 2.3],
};

interface SubSeg {
  ax: number; az: number; bx: number; bz: number; len: number; width: number; major: boolean; blocked: boolean;
}
interface SignalHead { nodeId: number; axis: 0 | 1; x: number; z: number; yaw: number; }

/** One sub-segment per polyline segment of every edge — the ambulance and
 * the rendered roads share the exact same geometry source. */
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
      for (const eId of dirs) {
        const e = graph.edgesById.get(eId)!;
        const o = graph.nodesById.get(e.to)!;
        const len = Math.hypot(o.x - n.x, o.y - n.y) || 1;
        dx += (o.x - n.x) / len;
        dz += (o.y - n.y) / len;
      }
      const m = Math.hypot(dx, dz) || 1;
      dx /= m; dz /= m;
      // head sits just past the stop line on the outgoing side, facing back
      // toward the intersection so approaching traffic sees the lenses.
      const off = 7;
      heads.push({ nodeId: n.id, axis, x: n.x + dx * off, z: n.y + dz * off, yaw: Math.atan2(dx, dz) });
    }
  }
  return heads;
}

/**
 * Merge all real building footprints into ONE BufferGeometry with baked
 * vertex colours (top face bright, walls shaded by facing direction) — a
 * single draw call, integrated-graphics friendly. Footprints are triangulated
 * with THREE.ShapeUtils (handles concave rings) and extruded to their height.
 */
function buildBuildingsGeometry(buildings: BuildingFootprint[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  // sun direction for wall shading (normalized 2D)
  const sunX = 0.6, sunZ = 0.8;
  const tmpContour: THREE.Vector2[] = [];

  for (const b of buildings) {
    if (b.ring.length < 3) continue;
    tmpContour.length = 0;
    for (const p of b.ring) tmpContour.push(new THREE.Vector2(p.x, p.y));
    let tris: number[][];
    try {
      tris = THREE.ShapeUtils.triangulateShape(tmpContour, []);
    } catch {
      continue; // skip malformed footprint rather than render garbage
    }
    if (!tris || tris.length === 0) continue;
    const base = buildingPalette[b.colorIdx % buildingPalette.length];
    const h = b.height;

    // top face (bright)
    for (const t of tris) {
      for (const idx of t) {
        const p = b.ring[idx];
        positions.push(p.x, h, p.y);
        colors.push(Math.min(1, base[0] * 1.04), Math.min(1, base[1] * 1.04), Math.min(1, base[2] * 1.04));
      }
    }
    // walls (shaded by facing the sun)
    for (let i = 0; i < b.ring.length; i++) {
      const a = b.ring[i];
      const c = b.ring[(i + 1) % b.ring.length];
      const ex = c.x - a.x, ez = c.y - a.y;
      const el = Math.hypot(ex, ez) || 1;
      // outward-ish normal (perpendicular); shade by sun alignment
      const nx = ez / el, nz = -ex / el;
      const shade = 0.62 + 0.28 * Math.max(0, nx * sunX + nz * sunZ);
      const r = base[0] * shade, g = base[1] * shade, bl = base[2] * shade;
      // two triangles: (a,0)-(c,0)-(c,h) and (a,0)-(c,h)-(a,h)
      positions.push(a.x, 0, a.y); colors.push(r, g, bl);
      positions.push(c.x, 0, c.y); colors.push(r, g, bl);
      positions.push(c.x, h, c.y); colors.push(r, g, bl);
      positions.push(a.x, 0, a.y); colors.push(r, g, bl);
      positions.push(c.x, h, c.y); colors.push(r, g, bl);
      positions.push(a.x, h, a.y); colors.push(r, g, bl);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

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
  // real OSM footprints (empty when unavailable — never fabricated)
  const buildingGeo = useMemo(() => buildBuildingsGeometry(ctrl.buildings), [ctrl.buildings]);
  const heads = useMemo(() => buildSignalHeads(graph), [graph]);
  // accident markers: midpoints of blocked edges (SIMULATED, labeled in HUD)
  // blockVersion intentionally busts this cache (edges mutate in place)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const blockedMids = useMemo(() => {
    const mids: { x: number; z: number }[] = [];
    for (const e of graph.edges) {
      if (!e.blocked) continue;
      const i = Math.floor(e.geom.length / 2);
      mids.push({ x: e.geom[i].x, z: e.geom[i].y });
    }
    return mids;
  }, [graph, blockVersion]);

  const roadsRef = useRef<THREE.InstancedMesh>(null!);
  const poleRef = useRef<THREE.InstancedMesh>(null!);
  const housingRef = useRef<THREE.InstancedMesh>(null!);
  const lensRedRef = useRef<THREE.InstancedMesh>(null!);
  const lensAmberRef = useRef<THREE.InstancedMesh>(null!);
  const lensGreenRef = useRef<THREE.InstancedMesh>(null!);
  const vehRef = useRef<THREE.InstancedMesh>(null!);
  const ambRef = useRef<THREE.Group>(null!);
  const lightRedRef = useRef<THREE.MeshBasicMaterial>(null!);
  const lightBlueRef = useRef<THREE.MeshBasicMaterial>(null!);
  const routeRef = useRef<THREE.Line>(null!);
  const patientRef = useRef<THREE.Mesh>(null!);
  const patientAccessRef = useRef<THREE.Mesh>(null!);
  const accessLineRef = useRef<THREE.Line>(null!);
  const hospitalRef = useRef<THREE.Group>(null!);
  const dispatchHospRef = useRef<THREE.Group>(null!);
  const hospitalAccessRef = useRef<THREE.Mesh>(null!);
  const accidentRef = useRef<THREE.InstancedMesh>(null!);
  const lastRouteRef = useRef<unknown>(null);
  const routeObj = useMemo(
    () => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#f59e0b" })),
    [],
  );
  const accessObj = useMemo(
    () => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#f8fafc" })),
    [],
  );
  const tmpM = useMemo(() => new THREE.Matrix4(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);
  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpS = useMemo(() => new THREE.Vector3(), []);
  const tmpC = useMemo(() => new THREE.Color(), []);
  const E_UP = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  const headCount = Math.max(heads.length, 1);

  useLayoutEffect(() => {
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
    if (poleRef.current) {
      heads.forEach((h, i) => {
        // mast beside the approach, signal head on top
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
    // lenses: 3 stacked per head (red top, amber mid, green bottom)
    const placeLens = (ref: React.MutableRefObject<THREE.InstancedMesh>, yOff: number) => {
      if (!ref.current) return;
      heads.forEach((h, i) => {
        // lens sits on the face toward the intersection
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
    if (accidentRef.current) {
      blockedMids.forEach((m, i) => {
        if (i >= accidentRef.current.count) return;
        tmpM.makeTranslation(m.x, 1.6, m.z);
        accidentRef.current.setMatrixAt(i, tmpM);
      });
      accidentRef.current.instanceMatrix.needsUpdate = true;
    }
    if (vehRef.current) {
      for (let i = 0; i < vehRef.current.count; i++) {
        tmpM.makeScale(0, 0, 0);
        vehRef.current.setMatrixAt(i, tmpM);
      }
      vehRef.current.instanceMatrix.needsUpdate = true;
    }
  }, [segs, heads, blockedMids, tmpM, tmpQ, tmpS, tmpV, E_UP]);

  useFrame(({ clock }) => {
    const live = ctrl.live;
    const t = clock.elapsedTime;

    // vehicles along REAL edge geometry, per-kind size + colour
    if (vehRef.current && live.vehicles) {
      live.vehicles.forEach((v, i) => {
        if (i >= vehRef.current.count) return;
        const e = ctrl.graph.edgesById.get(v.edgeId);
        if (!e) {
          tmpM.makeScale(0, 0, 0);
        } else {
          const pose = edgePoseAt(e, v.pos);
          const dim = VEH_DIMS[v.kind] ?? VEH_DIMS.car;
          tmpQ.setFromAxisAngle(E_UP, -pose.heading);
          tmpV.set(pose.x, dim[1] / 2 + 0.2, pose.y);
          tmpS.set(dim[0], dim[1], dim[2]);
          tmpM.compose(tmpV, tmpQ, tmpS);
          vehRef.current.setColorAt(i, tmpC.set(v.color));
        }
        vehRef.current.setMatrixAt(i, tmpM);
      });
      vehRef.current.instanceMatrix.needsUpdate = true;
      if (vehRef.current.instanceColor) vehRef.current.instanceColor.needsUpdate = true;
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

    // route line from the SAME edge geometry used for routing + movement
    if (routeRef.current && live.routeEdgeIds !== lastRouteRef.current) {
      lastRouteRef.current = live.routeEdgeIds;
      const pts = routePolyline(ctrl.graph, live.routeEdgeIds).map((p) => new THREE.Vector3(p.x, 0.4, p.y));
      routeRef.current.geometry.dispose();
      routeRef.current.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      routeRef.current.visible = pts.length > 1;
    }

    // markers
    if (patientRef.current) {
      const p = ctrl.patient ? ctrl.patientXY() : null;
      patientRef.current.visible = !!p;
      if (p) {
        patientRef.current.position.set(p.x, 2.5, p.y);
        patientRef.current.scale.setScalar(1 + 0.15 * Math.sin(t * 4));
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
          new THREE.Vector3(p!.x, 0.3, p!.y),
          new THREE.Vector3(pa!.x, 0.3, pa!.y),
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

  return (
    <group>
      {/* ground */}
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[
          Math.max(graph.bounds.maxX - graph.bounds.minX, 800) * 3,
          Math.max(graph.bounds.maxY - graph.bounds.minY, 800) * 3,
        ]} />
        <meshBasicMaterial color="#0e1622" />
      </mesh>

      {/* real OSM building footprints, extruded + colourful (one draw call) */}
      {buildingGeo.attributes.position.count > 0 && (
        <mesh geometry={buildingGeo} frustumCulled={false}>
          <meshBasicMaterial vertexColors />
        </mesh>
      )}

      {/* roads: one instance per real polyline segment; blocked -> red */}
      <instancedMesh ref={roadsRef} args={[undefined, undefined, Math.max(segs.length, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial />
      </instancedMesh>

      {/* traffic signals: pole + housing + 3 stacked lenses per head */}
      <instancedMesh ref={poleRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <cylinderGeometry args={[0.16, 0.2, 6, 6]} />
        <meshBasicMaterial color="#3f4a5a" />
      </instancedMesh>
      <instancedMesh ref={housingRef} args={[undefined, undefined, headCount]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#11151c" />
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

      <instancedMesh ref={vehRef} args={[undefined, undefined, Math.max(ctrl.traffic?.vehicles.length ?? 0, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial />
      </instancedMesh>

      {/* simulated accident markers on blocked segments */}
      <instancedMesh ref={accidentRef} args={[undefined, undefined, Math.max(blockedMids.length, 1)]} frustumCulled={false} visible={blockedMids.length > 0}>
        <coneGeometry args={[1.8, 3.5, 8]} />
        <meshBasicMaterial color="#ef4444" />
      </instancedMesh>

      <primitive ref={routeRef} object={routeObj} visible={false} />
      <primitive ref={accessLineRef} object={accessObj} visible={false} />

      <mesh ref={patientRef} visible={false}>
        <sphereGeometry args={[2.2, 14, 10]} />
        <meshBasicMaterial color="#ef4444" />
      </mesh>
      <mesh ref={patientAccessRef} visible={false}>
        <sphereGeometry args={[1.1, 10, 8]} />
        <meshBasicMaterial color="#fca5a5" />
      </mesh>
      <mesh ref={hospitalAccessRef} visible={false}>
        <sphereGeometry args={[1.1, 10, 8]} />
        <meshBasicMaterial color="#7dd3fc" />
      </mesh>

      {/* treatment hospital: teal block with a white cross */}
      <group ref={hospitalRef} visible={false}>
        <mesh position={[0, 5, 0]}>
          <boxGeometry args={[11, 10, 11]} />
          <meshBasicMaterial color="#0e7490" />
        </mesh>
        <mesh position={[0, 5, 5.6]}>
          <boxGeometry args={[5, 1.2, 0.3]} />
          <meshBasicMaterial color="#f8fafc" />
        </mesh>
        <mesh position={[0, 5, 5.6]}>
          <boxGeometry args={[1.2, 5, 0.3]} />
          <meshBasicMaterial color="#f8fafc" />
        </mesh>
      </group>

      {/* dispatch hospital (ambulance bay): distinct green block + siren */}
      <group ref={dispatchHospRef} visible={false}>
        <mesh position={[0, 3.5, 0]}>
          <boxGeometry args={[9, 7, 9]} />
          <meshBasicMaterial color="#15803d" />
        </mesh>
        <mesh position={[0, 7.4, 0]}>
          <boxGeometry args={[2.2, 0.8, 2.2]} />
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
          <meshBasicMaterial color="#cbd5e1" />
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
