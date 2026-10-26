import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { Pause, Play, FastForward, Siren } from "lucide-react";
import { Button } from "@/components/ui/button";
import MapPicker from "@/components/cotve/MapPicker";
import DispatchPanel from "@/components/cotve/DispatchPanel";
import DashboardPanel from "@/components/cotve/DashboardPanel";
import SimViewAmbulance from "@/components/cotve/SimViewAmbulance";
import SimViewSignals from "@/components/cotve/SimViewSignals";
import { getController } from "@/lib/cotve/simulation";
import { routePolyline } from "@/lib/cotve/network";
import { toLatLng } from "@/lib/cotve/geo";
import { useSimStore } from "@/lib/cotve/store";

/** Drives the shared SimulationController from requestAnimationFrame and
 * syncs a UI snapshot into the store at 4 Hz. One loop, one simulation —
 * both 3D screens read the same state. */
function useSimulationLoop() {
  const raf = useRef(0);
  useEffect(() => {
    const ctrl = getController();
    let last = performance.now();
    let accum = 0;
    let lastRoute: unknown = null;
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      ctrl.tick(dt);
      accum += dt;
      if (accum >= 0.25) {
        accum = 0;
        const st = useSimStore.getState();
        if (ctrl.currentRoute !== lastRoute) {
          lastRoute = ctrl.currentRoute;
          // route polyline from the SAME edge geometry used for routing,
          // movement and 3D rendering (map/sim consistency)
          const pts: [number, number][] = ctrl.currentRoute && ctrl.projection
            ? routePolyline(ctrl.graph, ctrl.currentRoute.edgeIds).map((p) => {
                const ll = toLatLng(ctrl.projection, p.x, p.y);
                return [ll.lat, ll.lng] as [number, number];
              })
            : [];
          st.set({
            routeLatLngs: pts,
            patientAccessLatLng: ctrl.patientAccessXY() && ctrl.projection
              ? (() => { const p = ctrl.patientAccessXY()!; const ll = toLatLng(ctrl.projection, p.x, p.y); return [ll.lat, ll.lng] as [number, number]; })()
              : null,
            hospitalAccessLatLng: ctrl.hospitalAccessXY() && ctrl.projection
              ? (() => { const p = ctrl.hospitalAccessXY()!; const ll = toLatLng(ctrl.projection, p.x, p.y); return [ll.lat, ll.lng] as [number, number]; })()
              : null,
          });
        }
        st.set({ status: ctrl.status(), metrics: ctrl.metrics, events: [...ctrl.events] });
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, []);
}

export default function Dispatch() {
  useSimulationLoop();
  const status = useSimStore((s) => s.status);
  const setStore = useSimStore((s) => s.set);
  const running = !getController().paused && status?.phase !== "complete";
  const ctrl = getController();
  const phase = status?.phase ?? "idle";
  const speedKmh = (ctrl.live.ambulance?.speed ?? 0) * 3.6;

  // bottom status panel values (single simulation state, 4 Hz sync)
  const distPatient =
    phase === "pickup" ? "0 m · at patient"
    : phase === "to-patient" && status?.remainM != null ? `${status.remainM.toFixed(0)} m`
    : phase === "to-hospital" || phase === "complete" ? "picked up"
    : "—";
  const distHospital =
    phase === "to-hospital" && status?.remainM != null ? `${status.remainM.toFixed(0)} m`
    : phase === "complete" ? "0 m · arrived"
    : "—";
  const pickupState =
    phase === "pickup" ? "loading patient…"
    : phase === "to-hospital" || phase === "complete" ? "completed"
    : phase === "idle" ? "—" : "waiting";
  const priorityActive =
    !!status && status.priorityStatus.startsWith("EMERGENCY");

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* top bar */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-2.5">
        <Link to="/" className="flex items-center gap-2 font-bold tracking-tight">
          <Siren className="h-5 w-5 text-red-500" />
          CoTV-E <span className="hidden text-xs font-normal text-muted-foreground sm:inline">Emergency Dispatch Console</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden font-mono text-xs text-muted-foreground md:inline">
            t = {(status?.t ?? 0).toFixed(1)}s · {status?.networkSource === "osm" ? "OSM network" : status?.networkSource === "demo-grid" ? "DEMO grid network" : "no network"}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              getController().paused = !getController().paused;
              setStore({});
            }}
            disabled={!status || status.phase === "idle" || status.phase === "complete"}
          >
            {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {running ? "Pause" : "Resume"}
          </Button>
          {[1, 2, 4].map((m) => (
            <Button
              key={m}
              size="sm"
              variant={getController().speedMult === m ? "default" : "outline"}
              onClick={() => {
                getController().speedMult = m;
                setStore({});
              }}
              className="px-2"
            >
              <FastForward className="h-3.5 w-3.5" />
              {m}×
            </Button>
          ))}
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-3 p-3 xl:grid-cols-[400px_1fr]">
        {/* left: map + dispatch + dashboard */}
        <div className="flex min-h-0 flex-col gap-3">
          <div className="h-[320px] shrink-0">
            <MapPicker />
          </div>
          <DispatchPanel />
          <div className="min-h-[380px] flex-1 xl:min-h-0">
            <DashboardPanel />
          </div>
        </div>

        {/* right: dual synchronized 3D screens */}
        <div className="grid min-h-0 grid-cols-1 gap-3 lg:grid-rows-2">
          <div className="min-h-[300px]">
            <SimViewAmbulance />
          </div>
          <div className="min-h-[300px]">
            <SimViewSignals />
          </div>
        </div>
      </main>

      {/* bottom status panel: live emergency-response readout.
           sticky so it is ALWAYS visible on any window size (it used to sit
           below the fold and clip chips on smaller screens). */}
      <footer className="sticky bottom-0 z-20 border-t border-border bg-card px-3 py-2 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] sm:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:gap-x-5">
          <StatusChip label="Status" value={status?.ambulanceStatus ?? "standby"} strong accent="text-red-600" />
          <StatusChip label="Speed" value={`${speedKmh.toFixed(0)} km/h`} mono />
          <StatusChip label="To patient" value={distPatient} mono />
          <StatusChip
            label="ETA patient"
            value={status?.etaPatient != null ? `${status.etaPatient.toFixed(0)} s` : "—"}
            mono
          />
          <StatusChip label="Pickup" value={pickupState} />
          <StatusChip label="To hospital" value={distHospital} mono />
          <StatusChip
            label="ETA hospital"
            value={status?.etaHospital != null ? `${status.etaHospital.toFixed(0)} s` : "—"}
            mono
          />
          <StatusChip
            label="Route"
            value={status ? `${status.routingMode} · ${status.progressPct.toFixed(0)}%` : "—"}
            mono
          />
          <StatusChip
            label="Signal priority"
            value={status?.priorityStatus ?? "—"}
            accent={priorityActive ? "text-red-600 font-semibold" : undefined}
          />
          <StatusChip
            label="Roads blocked"
            value={`${status?.blockedRoads ?? 0} · ${status?.reroutes ?? 0} reroutes`}
            mono
          />
        </div>
      </footer>
    </div>
  );
}

function StatusChip({
  label,
  value,
  strong,
  mono,
  accent,
}: {
  label: string;
  value: string;
  strong?: boolean;
  mono?: boolean;
  accent?: string;
}) {
  return (
    <span className="flex max-w-full items-baseline gap-1.5">
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      {/* long values wrap inside the chip instead of overflowing the bar */}
      <span className={`${mono ? "font-mono" : ""} ${strong ? "font-semibold" : ""} ${accent ?? "text-foreground"} min-w-0 break-words`}>
        {value}
      </span>
    </span>
  );
}
