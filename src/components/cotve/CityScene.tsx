import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { getController } from "@/lib/cotve/simulation";
import { buildingsForGraph, edgePoseAt, routePolyline } from "@/lib/cotve/network";
import { useSimStore } from "@/lib/cotve/store";
import type { RoadGraph } from "@/lib/cotve/types";

const ROAD_WIDTH: Record<string, number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 5.5, tertiary: 5,
  residential: 4, unclassified: 4, living_street: 3.5, service: 3,
};

const SIGNAL_COLORS = {
  green: new THREE.Color("#22c55e"),
  yellow: new THREE.Color("#eab308"),
  red: new THREE.Color("#ef4444"),
};
const C_ROAD = new THREE.Color("#334155");
const C_ROAD_MAJOR = new THREE.Color("#475569");
const C_BLOCKED = new THREE.Color("#b91c1c");

interface SubSeg {
  ax: number; az: number; bx: number; bz: number; len: number; width: number; major: boolean; blocked: boolean;
}
interface SignalHead { nodeId: number; axis: 0 | 1; x: number; z: number; }

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

function buildSignalHeads(graph: RoadGraph): { heads: SignalHead[]; poles: { x: number; z: number }[] } {
  const heads: SignalHead[] = [];
  const poles: { x: number; z: number }[] = [];
  for (const n of graph.nodes) {
    if (!n.signalized || !n.signalAxes) continue;
    poles.push({ x: n.x, z: n.y });
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
      heads.push({ nodeId: n.id, axis, x: n.x + (dx / m) * 6, z: n.y + (dz / m) * 6 });
    }
  }
  return { heads, poles };
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
  const buildings = useMemo(() => buildingsForGraph(graph), [graph]);
  const { heads, poles } = useMemo(() => buildSignalHeads(graph), [graph]);
  // accident markers: midpoints of blocked edges (SIMULATED, labeled in HUD)
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
  const bldRef = useRef<THREE.InstancedMesh>(null!);
  const poleRef = useRef<THREE.InstancedMesh>(null!);
  const headRef = useRef<THREE.InstancedMesh>(null!);
  const vehRef = useRef<THREE.InstancedMesh>(null!);
  const ambRef = useRef<THREE.Group>(null!);
  const lightRedRef = useRef<THREE.MeshBasicMaterial>(null!);
  const lightBlueRef = useRef<THREE.MeshBasicMaterial>(null!);
  const routeRef = useRef<THREE.Line>(null!);
  const patientRef = useRef<THREE.Mesh>(null!);
  const patientAccessRef = useRef<THREE.Mesh>(null!);
  const accessLineRef = useRef<THREE.Line>(null!);
  const hospitalRef = useRef<THREE.Group>(null!);
  const hospitalAccessRef = useRef<THREE.Mesh>(null!);
  const depotRef = useRef<THREE.Mesh>(null!);
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
    if (bldRef.current) {
      buildings.forEach((b, i) => {
        tmpQ.setFromAxisAngle(E_UP, -b.rot);
        tmpV.set(b.x, b.h / 2, b.y);
        tmpS.set(b.w, b.h, b.d);
        tmpM.compose(tmpV, tmpQ, tmpS);
        bldRef.current.setMatrixAt(i, tmpM);
      });
      bldRef.current.instanceMatrix.needsUpdate = true;
    }
    if (poleRef.current) {
      poles.forEach((p, i) => {
        tmpM.makeTranslation(p.x, 2.5, p.z);
        poleRef.current.setMatrixAt(i, tmpM);
      });
      poleRef.current.instanceMatrix.needsUpdate = true;
    }
    if (headRef.current) {
      heads.forEach((h, i) => {
        tmpM.makeTranslation(h.x, 5, h.z);
        headRef.current.setMatrixAt(i, tmpM);
        headRef.current.setColorAt(i, SIGNAL_COLORS.red);
      });
      headRef.current.instanceMatrix.needsUpdate = true;
    }
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
  }, [segs, buildings, poles, heads, blockedMids, tmpM, tmpQ, tmpS, tmpV, E_UP]);

  useFrame(({ clock }) => {
    const live = ctrl.live;
    const t = clock.elapsedTime;

    // vehicles along REAL edge geometry
    if (vehRef.current && live.vehicles) {
      live.vehicles.forEach((v, i) => {
        if (i >= vehRef.current.count) return;
        const e = ctrl.graph.edgesById.get(v.edgeId);
        if (!e) {
          tmpM.makeScale(0, 0, 0);
        } else {
          const pose = edgePoseAt(e, v.pos);
          tmpQ.setFromAxisAngle(E_UP, -pose.heading);
          tmpV.set(pose.x, 0.9, pose.y);
          tmpS.set(3.6, 1.5, 1.8);
          tmpM.compose(tmpV, tmpQ, tmpS);
        }
        vehRef.current.setMatrixAt(i, tmpM);
      });
      vehRef.current.instanceMatrix.needsUpdate = true;
    }

    // ambulance: position + tangent heading straight from the controller
    const a = live.ambulance;
    if (a && ambRef.current) {
      ambRef.current.visible = true;
      ambRef.current.position.set(a.x, 1.1, a.y);
      ambRef.current.rotation.y = -a.heading;
      const blink = Math.sin(t * 9) > 0;
      lightRedRef.current.color.set(blink ? "#ef4444" : "#7f1d1d");
      lightBlueRef.current.color.set(blink ? "#1d4ed8" : "#1e3a8a");
    } else if (ambRef.current) {
      ambRef.current.visible = false;
    }

    if (headRef.current && live.signals) {
      heads.forEach((h, i) => {
        const s = live.signals.get(h.nodeId);
        if (!s || !headRef.current.instanceColor) return;
        headRef.current.setColorAt(i, tmpC.copy(SIGNAL_COLORS[ctrl.signals.colorOf(s, h.axis)]));
      });
      if (headRef.current.instanceColor) headRef.current.instanceColor.needsUpdate = true;
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
    if (hospitalRef.current) {
      const h = ctrl.hospitalCand ? ctrl.hospitalXY() : null;
      hospitalRef.current.visible = !!h;
      if (h) hospitalRef.current.position.set(h.x, 0, h.y);
    }
    if (hospitalAccessRef.current) {
      const ha = ctrl.hospitalCand ? ctrl.hospitalAccessXY() : null;
      hospitalAccessRef.current.visible = !!ha;
      if (ha) hospitalAccessRef.current.position.set(ha.x, 1.2, ha.y);
    }
    if (depotRef.current) {
      const d = ctrl.ambulance ? ctrl.depotXY() : null;
      depotRef.current.visible = !!d;
      if (d) depotRef.current.position.set(d.x, 1, d.y);
    }

    void zoomRef;
  });

  return (
    <group>
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[
          Math.max(graph.bounds.maxX - graph.bounds.minX, 800) * 3,
          Math.max(graph.bounds.maxY - graph.bounds.minY, 800) * 3,
        ]} />
        <meshBasicMaterial color="#0b1220" />
      </mesh>

      {/* roads: one instance per real polyline segment; blocked -> red */}
      <instancedMesh ref={roadsRef} args={[undefined, undefined, Math.max(segs.length, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial />
      </instancedMesh>

      <instancedMesh ref={bldRef} args={[undefined, undefined, buildings.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#1e293b" />
      </instancedMesh>

      <instancedMesh ref={poleRef} args={[undefined, undefined, Math.max(poles.length, 1)]} frustumCulled={false}>
        <cylinderGeometry args={[0.15, 0.15, 5, 6]} />
        <meshBasicMaterial color="#64748b" />
      </instancedMesh>

      <instancedMesh ref={headRef} args={[undefined, undefined, Math.max(heads.length, 1)]} frustumCulled={false}>
        <sphereGeometry args={[0.9, 10, 8]} />
        <meshBasicMaterial />
      </instancedMesh>

      <instancedMesh ref={vehRef} args={[undefined, undefined, Math.max(ctrl.traffic?.vehicles.length ?? 0, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#94a3b8" />
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

      <group ref={hospitalRef} visible={false}>
        <mesh position={[0, 4, 0]}>
          <boxGeometry args={[10, 8, 10]} />
          <meshBasicMaterial color="#0e7490" />
        </mesh>
        <mesh position={[0, 9.4, 5.05]}>
          <boxGeometry args={[5, 1.2, 0.3]} />
          <meshBasicMaterial color="#f8fafc" />
        </mesh>
        <mesh position={[0, 9.4, 5.05]}>
          <boxGeometry args={[1.2, 5, 0.3]} />
          <meshBasicMaterial color="#f8fafc" />
        </mesh>
      </group>

      <mesh ref={depotRef} visible={false}>
        <cylinderGeometry args={[2, 2, 2, 10]} />
        <meshBasicMaterial color="#22c55e" />
      </mesh>

      <group ref={ambRef} visible={false}>
        <mesh>
          <boxGeometry args={[4.4, 1.6, 2]} />
          <meshBasicMaterial color="#f8fafc" />
        </mesh>
        <mesh position={[0.4, 1.05, 0]}>
          <boxGeometry args={[2.2, 0.55, 1.8]} />
          <meshBasicMaterial color="#cbd5e1" />
        </mesh>
        <mesh position={[0, -0.1, 1.02]}>
          <boxGeometry args={[4.4, 0.5, 0.06]} />
          <meshBasicMaterial color="#dc2626" />
        </mesh>
        <mesh position={[0.2, 1.45, 0.45]}>
          <boxGeometry args={[0.7, 0.3, 0.4]}>
            <meshBasicMaterial ref={lightRedRef} color="#ef4444" />
          </boxGeometry>
        </mesh>
        <mesh position={[0.2, 1.45, -0.45]}>
          <boxGeometry args={[0.7, 0.3, 0.4]}>
            <meshBasicMaterial ref={lightBlueRef} color="#1d4ed8" />
          </boxGeometry>
        </mesh>
      </group>
    </group>
  );
}
