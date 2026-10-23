import { useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { TrafficCone } from "lucide-react";
import CityScene from "./CityScene";
import { getController } from "@/lib/cotve/simulation";
import { useSimStore } from "@/lib/cotve/store";

function SignalCamera({ zoomRef }: { zoomRef: React.MutableRefObject<number> }) {
  const ctrl = getController();
  const { camera } = useThree();
  const posTarget = useRef(new THREE.Vector3(0, 150, 260));
  const lookTarget = useRef(new THREE.Vector3());
  const look = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    const z = zoomRef.current;
    const next = ctrl.nextSignalNode();
    if (next) {
      const n = ctrl.graph.nodesById.get(next.nodeId)!;
      posTarget.current.set(n.x + 70 * z, 55 * z, n.y + 70 * z);
      lookTarget.current.set(n.x, 4, n.y);
    } else {
      const a = ctrl.live.ambulance;
      const b = ctrl.graph.bounds;
      const cx = a ? a.x : (b.minX + b.maxX) / 2;
      const cy = a ? a.y : (b.minY + b.maxY) / 2;
      posTarget.current.set(cx + 90 * z, 90 * z, cy + 90 * z);
      lookTarget.current.set(cx, 0, cy);
    }
    const k = 1 - Math.exp(-dt * 3);
    camera.position.lerp(posTarget.current, k);
    look.current.lerp(lookTarget.current, k);
    camera.lookAt(look.current);
  });
  return null;
}

export default function SimViewSignals() {
  const zoomRef = useRef(1);
  const status = useSimStore((s) => s.status);
  const ctrl = getController();
  const next = status && status.phase !== "idle" ? ctrl.nextSignalNode() : null;
  const s = next ? ctrl.signals.states.get(next.nodeId) : null;
  const ambAxisColor = s
    ? ctrl.signals.colorOf(s, s.priorityAxis ?? s.greenAxis)
    : null;

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-[#0b1220]"
      onWheel={(e) => {
        zoomRef.current = Math.min(3, Math.max(0.4, zoomRef.current + e.deltaY * 0.001));
      }}
    >
      <Canvas dpr={[1, 1.5]} gl={{ antialias: false, powerPreference: "low-power" }} camera={{ fov: 50, near: 0.5, far: 4000, position: [0, 150, 260] }}>
        <CityScene zoomRef={zoomRef} />
        <SignalCamera zoomRef={zoomRef} />
      </Canvas>

      <div className="pointer-events-none absolute left-3 top-3 space-y-1.5">
        <div className="rounded-md bg-black/65 px-3 py-1.5 font-mono text-xs text-slate-200">
          <TrafficCone className="mr-1 inline h-3.5 w-3.5 text-amber-400" />
          {next ? `Intersection #${next.nodeId} · ${next.distanceM.toFixed(0)} m ahead` : "No route intersection in focus"}
        </div>
        {s && (
          <div className="flex items-center gap-2 rounded-md bg-black/65 px-3 py-1.5 text-xs">
            <span className="h-3 w-3 rounded-full" style={{ background: ambAxisColor === "green" ? "#22c55e" : ambAxisColor === "yellow" ? "#eab308" : "#ef4444" }} />
            <span className="font-mono text-slate-200">{s.phase}</span>
            <span className={s.priority === "none" ? "text-slate-400" : "font-semibold text-red-400"}>
              {s.priority === "none" ? "normal cycle" : `EMERGENCY ${s.priority.toUpperCase()}`}
            </span>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/55 px-2 py-1 text-[10px] text-slate-400">Screen 2 · signal camera · scroll = zoom</div>
      <div className="pointer-events-none absolute bottom-3 left-3 rounded bg-black/60 px-3 py-1.5 text-[10px] text-slate-300">
        Priority is route-specific: only intersections on the active ambulance route receive emergency preemption; all others keep their normal cycle.
      </div>
    </div>
  );
}
