import { useState } from "react";
import {
  Crosshair,
  Pause,
  Play,
  RotateCcw,
  Square,
  Siren,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, clockTime, refreshScenario, useFlowStore } from "@/lib/cotve/backend";

const SPEEDS = [0.5, 1, 2, 5];
const STEP_HORIZON = 3600;

export default function ControlPanel({
  placeMode,
  setPlaceMode,
  severity,
  setSeverity,
  emergency,
  setEmergency,
  autoDispatch,
  setAutoDispatch,
}: {
  placeMode: boolean;
  setPlaceMode: (v: boolean) => void;
  severity: string;
  setSeverity: (v: string) => void;
  emergency: string;
  setEmergency: (v: string) => void;
  autoDispatch: boolean;
  setAutoDispatch: (v: boolean) => void;
}) {
  const frame = useFlowStore((s) => s.frame);
  const transport = useFlowStore((s) => s.transport);
  const setStore = useFlowStore((s) => s.set);
  const [busy, setBusy] = useState(false);

  const sim = frame?.sim;
  const started = (sim?.step ?? 0) > 0;
  const running = !!sim?.running;
  const time = sim?.time ?? 0;
  const step = sim?.step ?? 0;
  const speed = sim?.speed ?? 1;

  const control = async (action: string, value?: number) => {
    setBusy(true);
    try {
      const res = await api.control(action, value);
      if (res?.error) setStore({ actionError: res.error });
      if (action === "reset") await refreshScenario();
    } catch (err) {
      setStore({ actionError: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const onPlay = () => void control(started && running ? "pause" : started ? "resume" : "start");
  const onStop = () => void control("stop");
  const onReset = () => void control("reset");

  return (
    <div className="pointer-events-auto w-[286px] rounded-xl border border-gray-700 bg-gray-800/95 shadow-2xl shadow-black/50 backdrop-blur">
      <div className="flex items-center gap-2 border-b border-gray-700 px-3 py-2">
        <Siren className="h-4 w-4 text-red-500" />
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-200">
          Simulation Control
        </span>
        <span
          className={`ml-auto h-2 w-2 rounded-full ${
            transport === "ws" || transport === "poll"
              ? "bg-emerald-400"
              : transport === "connecting"
                ? "bg-amber-400 animate-pulse"
                : "bg-red-500"
          }`}
          title={`backend: ${transport}`}
        />
      </div>

      <div className="space-y-3 px-3 py-3">
        {/* transport buttons */}
        <div className="grid grid-cols-4 gap-2">
          <Button
            size="sm"
            className="h-9 flex-col gap-0.5 bg-emerald-600 hover:bg-emerald-500"
            onClick={onPlay}
            disabled={busy || transport === "offline"}
          >
            {running ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            <span className="text-[10px]">{running ? "Pause" : "Play"}</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-9 flex-col gap-0.5 bg-slate-700 hover:bg-slate-600"
            onClick={onStop}
            disabled={busy}
          >
            <Square className="h-4 w-4" />
            <span className="text-[10px]">Stop</span>
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-9 flex-col gap-0.5 bg-slate-700 hover:bg-slate-600"
            onClick={onReset}
            disabled={busy}
          >
            <RotateCcw className="h-4 w-4" />
            <span className="text-[10px]">Reset</span>
          </Button>
          <Button
            size="sm"
            variant={placeMode ? "default" : "secondary"}
            className={`h-9 flex-col gap-0.5 ${
              placeMode
                ? "bg-red-600 text-white hover:bg-red-500"
                : "bg-slate-700 hover:bg-slate-600"
            }`}
            onClick={() => setPlaceMode(!placeMode)}
            disabled={transport === "offline"}
          >
            <Crosshair className="h-4 w-4" />
            <span className="text-[10px]">Accident</span>
          </Button>
        </div>

        {/* clock + step readout */}
        <div className="rounded-lg bg-slate-950/70 px-3 py-2 font-mono text-sm text-slate-100">
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">Time</span>
            <span className="tabular-nums">{clockTime(time)}</span>
          </div>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">Step</span>
            <span className="tabular-nums text-slate-300">
              {step} / {STEP_HORIZON}
            </span>
          </div>
        </div>

        {/* step scrubber - only moves forward (CityFlow is forward-only) */}
        <div className="space-y-1.5">
          <Slider
            value={[Math.min(step, STEP_HORIZON)]}
            max={STEP_HORIZON}
            step={1}
            min={0}
            disabled={transport === "offline"}
            onValueCommit={(v) => {
              const target = v[0];
              if (target > step) void control("step", target - step);
            }}
          />
          <div className="flex justify-between text-[9px] text-slate-500">
            <span>0</span>
            <span>step forward only</span>
            <span>{STEP_HORIZON}</span>
          </div>
        </div>

        {/* speed */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-slate-500">
            <span>Speed</span>
            <span className="font-mono text-slate-300">{speed}×</span>
          </div>
          <Slider
            value={[Math.max(0, SPEEDS.indexOf(speed) >= 0 ? SPEEDS.indexOf(speed) : 1)]}
            max={SPEEDS.length - 1}
            step={1}
            min={0}
            onValueCommit={(v) => void control("speed", SPEEDS[v[0]])}
          />
          <div className="flex justify-between text-[9px] text-slate-500">
            {SPEEDS.map((s) => (
              <span key={s} className={s === speed ? "text-emerald-400" : undefined}>
                {s}×
              </span>
            ))}
          </div>
        </div>

        {/* accident tool */}
        <div className="space-y-2 rounded-lg border border-slate-700/70 bg-slate-950/60 p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">
              New accident
            </span>
            <label className="flex items-center gap-1.5 text-[10px] text-slate-400">
              <input
                type="checkbox"
                checked={autoDispatch}
                onChange={(e) => setAutoDispatch(e.target.checked)}
                className="h-3 w-3 accent-emerald-500"
              />
              auto dispatch
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="h-8 bg-slate-900 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minor">Minor</SelectItem>
                <SelectItem value="major">Major</SelectItem>
                <SelectItem value="critical">Critical</SelectItem>
              </SelectContent>
            </Select>
            <Select value={emergency} onValueChange={setEmergency}>
              <SelectTrigger className="h-8 bg-slate-900 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="trauma">Trauma</SelectItem>
                <SelectItem value="cardiac">Cardiac</SelectItem>
                <SelectItem value="stroke">Stroke</SelectItem>
                <SelectItem value="respiratory">Respiratory</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-[10px] leading-snug text-slate-500">
            {placeMode
              ? "Click the map to report the accident at that point."
              : "Press Accident, then click the map."}
          </p>
        </div>
      </div>
    </div>
  );
}
