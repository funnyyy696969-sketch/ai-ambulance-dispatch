import { useRef, useState } from "react";
// note: HUD values refresh via the store's 4 Hz status sync
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Ambulance as AmbulanceIcon, Gauge, Timer } from "lucide-react";
import CityScene, { SKY_COLOR, SKY_FOG } from "./CityScene";
import { getController, modeLabel } from "@/lib/cotve/simulation";
import { useSimStore } from "@/lib/cotve/store";

type CamMode = "follow" | "elevated" | "top";

function FollowCamera({ modeRef, zoomRef }: { modeRef: React.MutableRefObject<CamMode>; zoomRef: React.MutableRefObject<number> }) {
  const ctrl = getController();
  const { camera } = useThree();
  const posTarget = useRef(new THREE.Vector3(0, 120, 200));
  const lookTarget = useRef(new THREE.Vector3(0, 0, 0));
  const look = useRef(new THREE.Vector3());
  const dir = useRef(new THREE.Vector3(1, 0, 0));

  useFrame((_, dt) => {
    if (!ctrl.graph) return; // no network built yet (pre-dispatch)
    const a = ctrl.live.ambulance;
    if (a && a.edgeId !== null) {
      const e = ctrl.graph.edgesById.get(a.edgeId);
      if (e) {
        const from = ctrl.graph.nodesById.get(e.from)!;
        const to = ctrl.graph.nodesById.get(e.to)!;
        dir.current.set(to.x - from.x, 0, to.y - from.y).normalize();
      }
    }
    const z = zoomRef.current;
    const mode = modeRef.current;
    if (a) {
      const d = dir.current;
      if (mode === "top") {
        posTarget.current.set(a.x, 190 * z, a.y + 1);
        lookTarget.current.set(a.x, 0, a.y);
      } else if (mode === "elevated") {
        posTarget.current.set(a.x - d.x * 60 * z, 48 * z, a.y - d.z * 60 * z);
        lookTarget.current.set(a.x + d.x * 25, 2, a.y + d.z * 25);
      } else {
        posTarget.current.set(a.x - d.x * 24 * z, 10 * z, a.y - d.z * 24 * z);
        lookTarget.current.set(a.x + d.x * 18, 2, a.y + d.z * 18);
      }
    } else {
      // overview while idle
      const b = ctrl.graph.bounds;
      posTarget.current.set((b.minX + b.maxX) / 2, 260 * z, (b.minY + b.maxY) / 2 + 240 * z);
      lookTarget.current.set((b.minX + b.maxX) / 2, 0, (b.minY + b.maxY) / 2);
    }
    const k = 1 - Math.exp(-dt * 4.5);
    camera.position.lerp(posTarget.current, k);
    look.current.lerp(lookTarget.current, k);
    camera.lookAt(look.current);
  });
  return null;
}

export default function SimViewAmbulance() {
  const modeRef = useRef<CamMode>("follow");
  const zoomRef = useRef(1);
  const [mode, setMode] = useState<CamMode>("follow");
  const status = useSimStore((s) => s.status);
  // HUD refreshes with the 4 Hz store sync; read speed from the live frame
  const liveSpeed = getController().live.ambulance ? getController().live.ambulance!.speed * 3.6 : 0;

  return (
    <div
      className="relative h-full w-full overflow-hidden rounded-lg border border-border bg-[#cfe6f5]"
      onWheel={(e) => {
        zoomRef.current = Math.min(3, Math.max(0.4, zoomRef.current + e.deltaY * 0.001));
      }}
    >
      <Canvas dpr={[1, 1.5]} gl={{ antialias: false, powerPreference: "low-power" }} camera={{ fov: 55, near: 0.5, far: 4000, position: [0, 120, 200] }}>
        <color attach="background" args={[SKY_COLOR]} />
        <fog attach="fog" args={[SKY_COLOR, SKY_FOG[0], SKY_FOG[1]]} />
        <CityScene zoomRef={zoomRef} />
        <FollowCamera modeRef={modeRef} zoomRef={zoomRef} />
      </Canvas>

      <div className="absolute left-3 top-3 flex gap-1">
        {(["follow", "elevated", "top"] as CamMode[]).map((m) => (
          <button
            key={m}
            onClick={() => {
              modeRef.current = m;
              setMode(m);
            }}
            className={`rounded px-2 py-1 text-[11px] capitalize transition-colors ${
              mode === m ? "bg-red-600 text-white" : "bg-black/55 text-slate-300 hover:bg-black/75"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-4 rounded-md bg-black/60 px-3 py-1.5 font-mono text-xs text-slate-200">
        <span className="flex items-center gap-1"><AmbulanceIcon className="h-3.5 w-3.5 text-red-400" />{status?.ambulanceStatus ?? "standby"}</span>
        <span className="flex items-center gap-1"><Gauge className="h-3.5 w-3.5 text-cyan-400">{/* km/h */}</Gauge>{liveSpeed.toFixed(0)} km/h</span>
        <span className="flex items-center gap-1"><Timer className="h-3.5 w-3.5 text-amber-400" />{status?.etaPatient != null ? `ETA pt ${status.etaPatient.toFixed(0)}s` : status?.etaHospital != null ? `ETA hosp ${status.etaHospital.toFixed(0)}s` : "—"}</span>
        <span className="text-slate-400">{status?.routingMode ?? ""}</span>
      </div>
      <div className="pointer-events-none absolute right-3 top-3 rounded bg-black/55 px-2 py-1 text-[10px] text-slate-400">Screen 1 · follow camera · scroll = zoom · {modeLabel((getController().currentRoute?.mode ?? "ppo"))}</div>
    </div>
  );
}
