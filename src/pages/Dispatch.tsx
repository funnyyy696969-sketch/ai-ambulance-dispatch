import { useEffect, useState } from "react";
import { Link } from "react-router";
import { MonitorX, Siren, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import CityFlowMap from "@/components/cotve/flow/CityFlowMap";
import ComparisonPanel from "@/components/cotve/flow/ComparisonPanel";
import ControlPanel from "@/components/cotve/flow/ControlPanel";
import MiniMap from "@/components/cotve/flow/MiniMap";
import SidePanel from "@/components/cotve/flow/SidePanel";
import BrowserSim from "@/components/cotve/BrowserSim";
import { api, BACKEND_URL, clockTime, startBackend, useFlowStore } from "@/lib/cotve/backend";

export default function Dispatch() {
  const transport = useFlowStore((s) => s.transport);
  const frame = useFlowStore((s) => s.frame);
  const scenario = useFlowStore((s) => s.scenario);
  const actionError = useFlowStore((s) => s.actionError);
  const setStore = useFlowStore((s) => s.set);

  const [mode, setMode] = useState<"console" | "browser">("console");
  const [placeMode, setPlaceMode] = useState(false);
  const [severity, setSeverity] = useState("major");
  const [emergency, setEmergency] = useState("trauma");
  const [autoDispatch, setAutoDispatch] = useState(true);

  useEffect(() => startBackend(), []);

  const offline = transport === "offline";

  const handlePick = async (lat: number, lng: number) => {
    if (!placeMode) return;
    try {
      const res = await api.addAccident({ lat, lng, severity, emergency });
      if (!res.ok || !res.accident) {
        setStore({ actionError: res.error ?? "accident could not be placed" });
        return;
      }
      if (autoDispatch) {
        const d = await api.dispatch(res.accident.id, undefined, "ppo");
        if (!d.ok) setStore({ actionError: d.error ?? "dispatch failed" });
      }
    } catch (err) {
      setStore({ actionError: (err as Error).message });
    }
  };

  if (mode === "browser") {
    return <BrowserSim onExit={() => setMode("console")} />;
  }

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100">
      {/* ---------------- top navigation ---------------- */}
      <header className="sticky top-0 z-50 border-b border-gray-700 bg-gray-800/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1800px] flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2.5">
          <Link to="/" className="flex items-center gap-2 text-sm font-bold tracking-tight text-white">
            <Siren className="h-5 w-5 text-red-500" />
            CityFlow
            <span className="text-xs font-normal text-gray-400">| Traffic Simulation Platform</span>
          </Link>
          <nav className="ml-2 hidden items-center gap-4 text-xs text-gray-300 md:flex">
            <a className="hover:text-white" href="#simulation">
              Simulation
            </a>
            <a className="hover:text-white" href="#comparison">
              Comparison
            </a>
            <button className="hover:text-white" onClick={() => setMode("browser")}>
              Browser sim
            </button>
            <a className="hover:text-white" href="#help">
              Help
            </a>
          </nav>

          <div className="ml-auto flex items-center gap-3 font-mono text-xs text-gray-400">
            <span className="hidden sm:inline">Time: {clockTime(frame?.sim.time ?? 0)}</span>
            <span className="hidden sm:inline">
              Step: {frame?.sim.step ?? 0} / 3600
            </span>
            <span
              className={`rounded px-2 py-0.5 ${
                offline
                  ? "bg-red-500/15 text-red-300"
                  : transport === "connecting"
                    ? "bg-amber-500/15 text-amber-300"
                    : "bg-emerald-500/15 text-emerald-300"
              }`}
            >
              {offline ? "backend offline" : transport === "connecting" ? "connecting…" : `backend ${transport}`}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-7 border-gray-600 bg-transparent text-xs text-gray-200 hover:bg-gray-700"
              onClick={() => setMode("browser")}
            >
              <MonitorX className="mr-1.5 h-3.5 w-3.5" />
              Offline mode
            </Button>
          </div>
        </div>
      </header>

      {/* ---------------- simulation stage ---------------- */}
      <main
        id="simulation"
        className="mx-auto grid max-w-[1800px] grid-cols-1 gap-3 p-3 xl:grid-cols-[1fr_340px]"
      >
        <div className="relative h-[calc(100vh-160px)] min-h-[540px] overflow-hidden rounded-xl border border-gray-700 bg-[#0b1120]">
          <CityFlowMap placeMode={placeMode} onPick={handlePick} />

          <div className="absolute left-3 top-3 z-[1000]">
            <ControlPanel
              placeMode={placeMode}
              setPlaceMode={setPlaceMode}
              severity={severity}
              setSeverity={setSeverity}
              emergency={emergency}
              setEmergency={setEmergency}
              autoDispatch={autoDispatch}
              setAutoDispatch={setAutoDispatch}
            />
          </div>

          <div className="absolute bottom-3 right-3 z-[1000]">
            <MiniMap />
          </div>

          {!scenario && (
            <div className="absolute inset-0 z-[900] flex items-center justify-center bg-gray-900/70">
              <div className="max-w-md rounded-lg border border-gray-700 bg-gray-800 px-5 py-4 text-center text-sm text-gray-300">
                {offline ? (
                  <>
                    <p className="mb-2 font-semibold text-red-300">CityFlow backend not reachable</p>
                    <p className="mb-3 text-xs leading-relaxed text-gray-400">
                      Start it with <code className="text-gray-200">cd backend && python -m cotve.server</code>{" "}
                      (see Help below), or work in offline mode.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-gray-600 bg-transparent text-xs"
                      onClick={() => setMode("browser")}
                    >
                      Open browser simulation
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="mb-1 font-semibold text-emerald-300">Connecting to CityFlow…</p>
                    <p className="text-xs text-gray-400">Loading the road network and engine state.</p>
                  </>
                )}
              </div>
            </div>
          )}

          {actionError && (
            <div className="absolute left-1/2 top-3 z-[1100] flex max-w-[520px] -translate-x-1/2 items-center gap-2 rounded-lg border border-red-500/50 bg-red-950/90 px-3 py-2 text-xs text-red-200 shadow-lg">
              <span className="min-w-0 break-words">{actionError}</span>
              <button
                className="ml-1 shrink-0 text-red-300 hover:text-white"
                onClick={() => setStore({ actionError: null })}
                aria-label="dismiss"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        <aside className="h-[620px] xl:h-[calc(100vh-160px)]">
          <SidePanel />
        </aside>
      </main>

      {/* ---------------- planner comparison ---------------- */}
      <section id="comparison" className="mx-auto max-w-[1800px] px-3 pb-6">
        <ComparisonPanel />
      </section>

      {/* ---------------- help ---------------- */}
      <section id="help" className="mx-auto max-w-[1800px] px-3 pb-10">
        <div className="rounded-xl border border-gray-700 bg-gray-800/95 p-4 text-xs leading-relaxed text-gray-400">
          <h2 className="mb-2 text-sm font-semibold text-gray-200">Running the platform</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-1 font-semibold text-gray-300">1 · Python backend (CityFlow)</h3>
              <pre className="overflow-x-auto rounded bg-gray-900/70 p-2 font-mono text-[11px] text-gray-300">
{`cd backend
python -m venv .venv
.venv\\Scripts\\activate        # Windows
pip install -r requirements.txt
python -m cotve.server         # http://127.0.0.1:8000`}
              </pre>
            </div>
            <div>
              <h3 className="mb-1 font-semibold text-gray-300">2 · This dashboard</h3>
              <pre className="overflow-x-auto rounded bg-gray-900/70 p-2 font-mono text-[11px] text-gray-300">
{`bun install
bun run dev                   # http://localhost:5173`}
              </pre>
              <p className="mt-2">
                The dashboard streams engine frames over WebSocket (<code className="text-gray-300">/ws</code>)
                and falls back to REST polling when sockets are blocked. Backend URL defaults to{" "}
                <code className="text-gray-300">{BACKEND_URL}</code> and can be overridden with{" "}
                <code className="text-gray-300">VITE_COTVE_BACKEND</code>.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
