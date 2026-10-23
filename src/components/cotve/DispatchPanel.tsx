import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Siren, MapPin, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSimStore } from "@/lib/cotve/store";
import { getController } from "@/lib/cotve/simulation";
import { runDispatchFlow } from "@/lib/cotve/dispatchFlow";
import { emergencyOptions } from "@/lib/cotve/config";
import { toast } from "sonner";

export default function DispatchPanel() {
  const [emergency, setEmergency] = useState("Heart emergency");
  const patient = useSimStore((s) => s.patient);
  const dispatching = useSimStore((s) => s.dispatching);
  const training = useSimStore((s) => s.training);
  const status = useSimStore((s) => s.status);
  const setStore = useSimStore((s) => s.set);

  const searchHospitals = useAction(api.osm.searchHospitals);
  const fetchRoads = useAction(api.osm.fetchRoads);

  const onDispatch = async () => {
    if (!patient) {
      toast.error("Select the patient location on the map first (click the map).");
      return;
    }
    if (!emergency.trim()) {
      toast.error("Enter the disease / emergency type.");
      return;
    }
    setStore({ dispatching: true, saved: false, training: null });
    try {
      const res = await runDispatchFlow(patient, emergency.trim(), {
        fetchHospitals: (a) => searchHospitals(a),
        fetchRoads: (a) => fetchRoads(a),
      });
      if (!res.ok) {
        toast.error(res.error ?? "Dispatch failed");
        setStore({ dispatching: false });
        return;
      }
      const ctrl = getController();
      setStore({
        dispatching: false,
        hospitals: res.candidates ?? [],
        selectedHospital: res.hospital ?? null,
        networkSource: ctrl.graph.source,
        networkInfo: ctrl.events.find((e) => e.kind === "network")?.message ?? null,
        training: res.training ?? null,
        depotLatLng: ctrl.depotXY()
          ? {
              lat: ctrl.graph.nodesById.get(ctrl.depotNode)!.lat,
              lng: ctrl.graph.nodesById.get(ctrl.depotNode)!.lng,
            }
          : null,
      });
      toast.success(`Dispatched — ${res.hospital?.name ?? "hospital"} selected`);
    } catch (err) {
      toast.error(`Dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      setStore({ dispatching: false });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <MapPin className="h-4 w-4 text-red-500" />
        Patient location
        <span className="ml-auto font-mono text-xs text-muted-foreground">
          {patient ? `${patient.lat.toFixed(5)}, ${patient.lng.toFixed(5)}` : "not selected"}
        </span>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Disease / emergency type</label>
        <Input
          value={emergency}
          onChange={(e) => setEmergency(e.target.value)}
          placeholder="e.g. Heart emergency, stroke, accident…"
          list="emergency-examples"
        />
        <datalist id="emergency-examples">
          {emergencyOptions.map((o) => (
            <option key={o.value} value={o.label} />
          ))}
        </datalist>
        <p className="text-[11px] text-muted-foreground">
          CoTV-E does not diagnose disease — this only steers hospital specialty matching.
        </p>
      </div>
      <Button
        onClick={onDispatch}
        disabled={dispatching || status?.phase === "to-patient" || status?.phase === "pickup" || status?.phase === "to-hospital"}
        className="w-full bg-red-600 text-white hover:bg-red-500 font-semibold tracking-wide"
        size="lg"
      >
        <Siren className="mr-2 h-4 w-4" />
        {dispatching ? "DISPATCHING…" : "DISPATCH AMBULANCE"}
      </Button>
      {dispatching && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Fetching OpenStreetMap data, discovering hospitals, quick-training the PPO agent…
          {training === null && <span className="ml-1 animate-pulse">⣾</span>}
        </div>
      )}
      {status?.phase === "error" && status.errorMessage && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {status.errorMessage}
        </div>
      )}
    </div>
  );
}
