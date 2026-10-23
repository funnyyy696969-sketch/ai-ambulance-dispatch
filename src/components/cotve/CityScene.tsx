import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { getController } from "@/lib/cotve/simulation";
import { buildingsForGraph } from "@/lib/cotve/network";
import type { RoadGraph } from "@/lib/cotve/types";

const ROAD_WIDTH: Record<string, number> = {
  motorway: 9, trunk: 8, primary: 7, secondary: 5.5, tertiary: 5,
  residential: 4, unclassified: 4, living_street: 3.5, service: 3, demo: 5,
};

const SIGNAL_COLORS = {
  green: new THREE.Color("#22c55e"),
  yellow: new THREE.Color("#eab308"),
  red: new THREE.Color("#ef4444"),
};

interface Seg {
  ax: number; az: number; bx: number; bz: number;
  len: number; width: number; primary: boolean;
}

interface SignalHead {
  nodeId: number;
  axis: 0 | 1;
  x: number; z: number;
}

function buildSegments(graph: RoadGraph): Seg[] {
  const seen = new Set<string>();
  const segs: Seg[] = [];
  for (const e of graph.edges) {
    const a = graph.nodesById.get(e.from)!;
    const b = graph.nodesById.get(e.to)!;
    const key = `${Math.min(e.from, e.to)}-${Math.max(e.from, e.to)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    segs.push({
      ax: a.x, az: a.y, bx: b.x, bz: b.y,
      len: e.length,
      width: ROAD_WIDTH[e.highwayType] ?? 4,
      primary: e.highwayType === "primary" || e.highwayType === "secondary" || e.highwayType === "trunk",
    });
  }
  return segs;
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

/** All static + dynamic city rendering. Reads the shared controller's live
 * frame imperatively every frame — no React re-renders in the hot path. */
export default function CityScene({ zoomRef }: { zoomRef: React.MutableRefObject<number> }) {
  const ctrl = getController();
  const graph = ctrl.graph;

  const segs = useMemo(() => buildSegments(graph), [graph]);
  const buildings = useMemo(() => buildingsForGraph(graph), [graph]);
  const { heads, poles } = useMemo(() => buildSignalHeads(graph), [graph]);

  const roadsRef = useRef<THREE.InstancedMesh>(null!);
  const bldRef = useRef<THREE.InstancedMesh>(null!);
  const poleRef = useRef<THREE.InstancedMesh>(null!);
  const headRef = useRef<THREE.InstancedMesh>(null!);
  const vehRef = useRef<THREE.InstancedMesh>(null!);
  const ambRef = useRef<THREE.Group>(null!);
  const lightRedRef = useRef<THREE.MeshBasicMaterial>(null!);
  const lightBlueRef = useRef<THREE.MeshBasicMaterial>(null!);
  const routeRef = useRef<THREE.Line>(null!);
  const routeObj = useMemo(
    () => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: "#f59e0b" })),
    [],
  );
  const patientRef = useRef<THREE.Mesh>(null!);
  const hospitalRef = useRef<THREE.Group>(null!);
  const depotRef = useRef<THREE.Mesh>(null!);
  const lastRouteRef = useRef<unknown>(null);
  const tmpM = useMemo(() => new THREE.Matrix4(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);
  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpS = useMemo(() => new THREE.Vector3(), []);
  const tmpC = useMemo(() => new THREE.Color(), []);
  const E_UP = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  // static instance matrices
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
      });
      roadsRef.current.instanceMatrix.needsUpdate = true;
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
    if (vehRef.current) {
      for (let i = 0; i < vehRef.current.count; i++) {
        tmpM.makeScale(0, 0, 0);
        vehRef.current.setMatrixAt(i, tmpM);
      }
      vehRef.current.instanceMatrix.needsUpdate = true;
    }
  }, [segs, buildings, poles, heads, tmpM, tmpQ, tmpS, tmpV, E_UP]);

  const graphKey = graph;
  void graphKey;

  useFrame(({ clock }) => {
    const live = ctrl.live;
    const t = clock.elapsedTime;

    // ---- vehicles ----
    if (vehRef.current && live.vehicles) {
      live.vehicles.forEach((v, i) => {
        if (i >= vehRef.current.count) return;
        const e = ctrl.graph.edgesById.get(v.edgeId);
        if (!e) {
          tmpM.makeScale(0, 0, 0);
        } else {
          const a = ctrl.graph.nodesById.get(e.from)!;
          const b = ctrl.graph.nodesById.get(e.to)!;
          const f = v.pos / Math.max(e.length, 0.001);
          const x = a.x + (b.x - a.x) * f;
          const z = a.y + (b.y - a.y) * f;
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          tmpQ.setFromAxisAngle(E_UP, -ang);
          tmpV.set(x, 0.9, z);
          tmpS.set(3.6, 1.5, 1.8);
          tmpM.compose(tmpV, tmpQ, tmpS);
        }
        vehRef.current.setMatrixAt(i, tmpM);
      });
      vehRef.current.instanceMatrix.needsUpdate = true;
    }

    // ---- ambulance ----
    const a = live.ambulance;
    if (a) {
      ambRef.current.visible = true;
      ambRef.current.position.set(a.x, 1.1, a.y);
      const e = a.edgeId !== null ? ctrl.graph.edgesById.get(a.edgeId) : null;
      if (e) {
        const from = ctrl.graph.nodesById.get(e.from)!;
        const to = ctrl.graph.nodesById.get(e.to)!;
        const ang = Math.atan2(to.y - from.y, to.x - from.x);
        ambRef.current.rotation.y = -ang;
      }
      // blinking light bar
      const blink = Math.sin(t * 9) > 0;
      lightRedRef.current.color.set(blink ? "#ef4444" : "#7f1d1d");
      lightBlueRef.current.color.set(blink ? "#1d4ed8" : "#1e3a8a");
    } else if (ambRef.current) {
      ambRef.current.visible = false;
    }

    // ---- signal head colors ----
    if (headRef.current && live.signals) {
      heads.forEach((h, i) => {
        const s = live.signals.get(h.nodeId);
        if (!s || !headRef.current.instanceColor) return;
        headRef.current.setColorAt(i, tmpC.copy(SIGNAL_COLORS[ctrl.signals.colorOf(s, h.axis)]));
      });
      if (headRef.current.instanceColor) headRef.current.instanceColor.needsUpdate = true;
    }

    // ---- route line ----
    if (routeRef.current && live.routeEdgeIds !== lastRouteRef.current) {
      lastRouteRef.current = live.routeEdgeIds;
      const pts: THREE.Vector3[] = [];
      for (const id of live.routeEdgeIds) {
        const e = ctrl.graph.edgesById.get(id);
        if (!e) continue;
        const from = ctrl.graph.nodesById.get(e.from)!;
        const to = ctrl.graph.nodesById.get(e.to)!;
        if (pts.length === 0) pts.push(new THREE.Vector3(from.x, 0.4, from.y));
        pts.push(new THREE.Vector3(to.x, 0.4, to.y));
      }
      routeRef.current.geometry.dispose();
      routeRef.current.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      routeRef.current.visible = pts.length > 1;
    }

    // ---- markers ----
    if (patientRef.current) {
      const p = ctrl.patient ? ctrl.patientXY() : null;
      patientRef.current.visible = !!p && (live.phase === "to-patient" || live.phase === "pickup");
      if (p) {
        patientRef.current.position.set(p.x, 2.5, p.y);
        const pulse = 1 + 0.15 * Math.sin(t * 4);
        patientRef.current.scale.setScalar(pulse);
      }
    }
    if (hospitalRef.current) {
      const h = ctrl.hospitalCand ? ctrl.hospitalXY() : null;
      hospitalRef.current.visible = !!h;
      if (h) hospitalRef.current.position.set(h.x, 0, h.y);
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
      {/* ground */}
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow={false}>
        <planeGeometry args={[
          Math.max(graph.bounds.maxX - graph.bounds.minX, 800) * 3,
          Math.max(graph.bounds.maxY - graph.bounds.minY, 800) * 3,
        ]} />
        <meshBasicMaterial color="#0b1220" />
      </mesh>

      {/* roads */}
      <instancedMesh ref={roadsRef} args={[undefined, undefined, segs.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#334155" />
      </instancedMesh>

      {/* buildings */}
      <instancedMesh ref={bldRef} args={[undefined, undefined, buildings.length]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#1e293b" />
      </instancedMesh>

      {/* signal poles */}
      <instancedMesh ref={poleRef} args={[undefined, undefined, Math.max(poles.length, 1)]} frustumCulled={false}>
        <cylinderGeometry args={[0.15, 0.15, 5, 6]} />
        <meshBasicMaterial color="#64748b" />
      </instancedMesh>

      {/* signal heads (colored per frame) */}
      <instancedMesh ref={headRef} args={[undefined, undefined, Math.max(heads.length, 1)]} frustumCulled={false}>
        <sphereGeometry args={[0.9, 10, 8]} />
        <meshBasicMaterial />
      </instancedMesh>

      {/* background traffic */}
      <instancedMesh ref={vehRef} args={[undefined, undefined, Math.max(ctrl.traffic?.vehicles.length ?? 0, 1)]} frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#94a3b8" />
      </instancedMesh>

      {/* route line (imperative THREE.Line to avoid the SVG <line> clash) */}
      <primitive ref={routeRef} object={routeObj} visible={false} />

      {/* patient marker */}
      <mesh ref={patientRef} visible={false}>
        <sphereGeometry args={[2.2, 14, 10]} />
        <meshBasicMaterial color="#ef4444" />
      </mesh>

      {/* hospital marker: box + white cross */}
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

      {/* depot marker */}
      <mesh ref={depotRef} visible={false}>
        <cylinderGeometry args={[2, 2, 2, 10]} />
        <meshBasicMaterial color="#22c55e" />
      </mesh>

      {/* ambulance */}
      <group ref={ambRef} visible={false}>
        <mesh position={[0, 0, 0]}>
          <boxGeometry args={[4.4, 1.6, 2]} />
          <meshBasicMaterial color="#f8fafc" />
        </mesh>
        <mesh position={[0.4, 1.05, 0]}>
          <boxGeometry args={[2.2, 0.55, 1.8]} />
          <meshBasicMaterial color="#cbd5e1" />
        </mesh>
        {/* red stripe */}
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
