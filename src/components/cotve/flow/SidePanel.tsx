import { useState, type ReactNode } from "react";
import { Activity, Route, ScrollText, Siren, Sparkles, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, clockTime, useFlowStore } from "@/lib/cotve/backend";

const LEGEND: { color: string; label: string; shape?: "dot" | "square" | "pulse" }[] = [
  { color: "#ef4444", label: "Ambulance", shape: "dot" },
  { color: "#f97316", label: "Accident", shape: "pulse" },
  { color: "#3b82f6", label: "Hospital", shape: "square" },
  { color: "#cbd5e1", label: "Car", shape: "square" },
  { color: "#f59e0b", label: "Bus", shape: "square" },
  { color: "#a78bfa", label: "Truck", shape: "square" },
  { color: "#22d3ee", label: "Emergency vehicle", shape: "square" },
  { color: "#94a3b8", label: "Other", shape: "square" },
];

const STATUS_TONE: Record<string, string> = {
  idle: "bg-slate-600/40 text-slate-300",
  "to-accident": "bg-red-500/15 text-red-300",
  loading: "bg-amber-500/15 text-amber-300",
  "to-hospital": "bg-blue-500/15 text-blue-300",
  completed: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-600/25 text-red-200",
};

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-gray-700/70 px-3 py-3 last:border-b-0">
      <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-400">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between py-0.5 text-xs">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono tabular-nums text-slate-100">{value}</span>
    </div>
  );
}

export default function SidePanel() {
  const frame = useFlowStore((s) => s.frame);
  const scenario = useFlowStore((s) => s.scenario);
  const setStore = useFlowStore((s) => s.set);
  const [method, setMethod] = useState("ppo");
  const [busy, setBusy] = useState<string | null>(null);

  const stats = frame?.stats;
  const gnn = frame?.gnn ?? {};
  const ppo = frame?.ppo ?? {};

  const dispatch = async (accidentId: string) => {
    setBusy(accidentId);
    try {
      const res = await api.dispatch(accidentId, undefined, method);
      if (!res.ok) setStore({ actionError: res.error ?? "dispatch failed" });
      else setStore({ actionError: null });
    } catch (err) {
      setStore({ actionError: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const train = async () => {
    setBusy("__train");
    try {
      await api.train(60);
    } catch (err) {
      setStore({ actionError: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const openAccidents = (frame?.accidents ?? []).filter(
    (a) => a.status === "reported" || a.status === "assigned",
  );

  return (
    <div className="cf-scroll flex h-full flex-col overflow-y-auto rounded-xl border border-gray-700 bg-gray-800/95 shadow-2xl shadow-black/50 backdrop-blur">
      <Section title="Simulation Info" icon={<Activity className="h-3 w-3" />}>
        <Row label="Time" value={clockTime(frame?.sim.time ?? 0)} />
        <Row label="Total Vehicles" value={stats?.totalVehicles ?? 0} />
        <Row label="Ambulances" value={stats?.ambulances ?? scenario?.ambulances.length ?? 0} />
        <Row label="Accidents" value={stats?.accidents ?? 0} />
        <Row label="Hospitals" value={stats?.hospitals ?? scenario?.hospitals.length ?? 0} />
        <div className="mt-2 grid grid-cols-2 gap-2 border-t border-slate-800 pt-2 text-[11px]">
          <div>
            <div className="text-slate-500">Avg speed</div>
            <div className="font-mono text-slate-200">
              {(stats?.avgSpeed ?? 0).toFixed(1)} m/s · {(stats?.avgSpeedKmh ?? 0).toFixed(0)} km/h
            </div>
          </div>
          <div>
            <div className="text-slate-500">Congestion</div>
            <div className="font-mono text-slate-200">
              {((stats?.density ?? 0) * 100).toFixed(1)}% · {stats?.stopped ?? 0} stopped
            </div>
          </div>
          <div>
            <div className="text-slate-500">Avg waiting</div>
            <div className="font-mono text-slate-200">{(stats?.avgWaiting ?? 0).toFixed(1)} s</div>
          </div>
          <div>
            <div className="text-slate-500">Scenario</div>
            <div className="font-mono text-slate-200">
              {frame?.sim.scenario ?? scenario?.name ?? "—"} @ {frame?.sim.speed ?? 1}×
            </div>
          </div>
        </div>
      </Section>

      <Section title="GNN + PPO Router" icon={<Sparkles className="h-3 w-3" />}>
        <Row label="GNN loss" value={gnn.loss != null ? Number(gnn.loss).toFixed(4) : "—"} />
        <Row label="GNN train steps" value={String(gnn.trainSteps ?? 0)} />
        <Row label="PPO updates" value={String(ppo.updates ?? 0)} />
        <Row label="PPO reach rate" value={ppo.reachRate != null ? `${Math.round(Number(ppo.reachRate) * 100)}%` : "—"} />
        <Row label="Policy entropy" value={ppo.entropy != null ? Number(ppo.entropy).toFixed(3) : "—"} />
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 flex-1 bg-slate-700 text-[11px] hover:bg-slate-600"
            disabled={busy === "__train"}
            onClick={train}
          >
            {busy === "__train" ? "Training…" : "Train 60 episodes"}
          </Button>
          <Badge variant="outline" className="text-[9px] text-slate-400">
            live CityFlow data
          </Badge>
        </div>
        <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
          Node features are measured every step (density, vehicle count, speed, congestion); edge
          features are road length, capacity and observed travel time.
        </p>
      </Section>

      <Section title="Legend" icon={<Siren className="h-3 w-3" />}>
        <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-300">
          {LEGEND.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span
                className={
                  l.shape === "pulse"
                    ? "h-2.5 w-2.5 rounded-full bg-orange-500 shadow-[0_0_0_3px_rgba(249,115,22,0.25)]"
                    : l.shape === "square"
                      ? "h-2.5 w-2.5 rounded-[2px]"
                      : "h-2.5 w-2.5 rounded-full"
                }
                style={{ background: l.color }}
              />
              {l.label}
            </li>
          ))}
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
            Signal green
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
            Signal red
          </li>
          <li className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-white bg-fuchsia-400" />
            Priority held
          </li>
        </ul>
      </Section>

      <Section title="Ambulance Routes" icon={<Route className="h-3 w-3" />}>
        <div className="space-y-2">
          {(frame?.ambulances ?? []).length === 0 && (
            <p className="text-[11px] text-slate-500">Waiting for the first frame…</p>
          )}
          {(frame?.ambulances ?? []).map((amb) => {
            const color = amb.color;
            const status = amb.status;
            return (
              <div
                key={amb.id}
                className="rounded-lg border border-slate-700/70 bg-slate-950/50 px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-2.5 w-6 rounded-sm"
                    style={{ background: color }}
                    aria-hidden
                  />
                  <span className="text-xs font-medium text-slate-100">{amb.colorLabel}</span>
                  <span
                    className={`ml-auto rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wide ${
                      STATUS_TONE[status] ?? "bg-slate-600/40 text-slate-300"
                    }`}
                  >
                    {String(status).replace(/-/g, " ")}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-slate-400">
                  <span className="font-mono">ETA {amb.eta != null ? `${Math.round(amb.eta)} s` : "—"}</span>
                  <span className="font-mono">{amb.road ?? "—"}</span>
                  <span className="font-mono">{(amb.speedKmh ?? 0).toFixed(0)} km/h</span>
                  {amb.method && <span className="text-slate-500">via {amb.method}</span>}
                  {amb.fallback && (
                    <span className="rounded bg-amber-500/15 px-1 text-amber-300">fallback</span>
                  )}
                </div>
                {amb.error && <div className="mt-1 text-[10px] text-red-400">{amb.error}</div>}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Accidents" icon={<TriangleAlert className="h-3 w-3" />}>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[10px] text-slate-500">Planner</span>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger className="h-7 bg-slate-900 text-[11px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ppo">GNN + PPO</SelectItem>
              <SelectItem value="astar">A*</SelectItem>
              <SelectItem value="dijkstra">Dijkstra</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          {(frame?.accidents ?? []).length === 0 && (
            <p className="text-[11px] text-slate-500">
              No accidents yet — press <span className="text-slate-300">Accident</span> in the
              control panel and click the map.
            </p>
          )}
          {(frame?.accidents ?? []).map((a) => (
            <div
              key={a.id}
              className="flex items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-950/50 px-2 py-1.5"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500/20 text-[10px] text-red-300">
                !
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] text-slate-200">
                  {a.id} · {a.severity} · {a.emergency}
                </div>
                <div className="truncate font-mono text-[10px] text-slate-500">
                  {a.road} @ {Math.round(a.dist)} m · {a.status}
                </div>
              </div>
              {a.status === "reported" ? (
                <Button
                  size="sm"
                  className="h-6 bg-red-600 px-2 text-[10px] hover:bg-red-500"
                  disabled={busy === a.id}
                  onClick={() => void dispatch(a.id)}
                >
                  {busy === a.id ? "…" : "Dispatch"}
                </Button>
              ) : (
                <Badge variant="outline" className="text-[9px] text-slate-400">
                  {a.ambulance ?? "—"}
                </Badge>
              )}
            </div>
          ))}
        </div>
        {openAccidents.length > 0 && openAccidents.every((a) => a.status !== "reported") && (
          <p className="mt-1 text-[10px] text-slate-500">All open accidents are covered.</p>
        )}
      </Section>

      <Section title="Event Log" icon={<ScrollText className="h-3 w-3" />}>
        <ul className="cf-scroll max-h-40 space-y-1 overflow-y-auto pr-1 text-[11px]">
          {[...(frame?.events ?? [])].reverse().map((e, i) => (
            <li key={`${e.t}-${i}`} className="flex gap-2 text-slate-400">
              <span className="font-mono text-slate-600">{clockTime(e.t)}</span>
              <span className="text-slate-300">{e.message}</span>
            </li>
          ))}
          {(frame?.events ?? []).length === 0 && (
            <li className="text-slate-500">Events appear as missions progress.</li>
          )}
        </ul>
      </Section>
    </div>
  );
}
