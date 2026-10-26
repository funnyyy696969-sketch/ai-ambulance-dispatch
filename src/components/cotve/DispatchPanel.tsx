import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Siren, MapPin, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSimStore } from "@/lib/cotve/store";
import { getController } from "@/lib/cotve/simulation";
import { runDispatchFlow } from "@/lib/cotve/dispatchFlow";
import { emergencyCategories } from "@/lib/cotve/config";
import { toast } from "sonner";

/** sentinel value: user wants to describe an emergency not in the list */
const CUSTOM = "__custom";

export default function DispatchPanel() {
  const [emergency, setEmergency] = useState("Cardiac emergency");
  const [customText, setCustomText] = useState("");
  const [escalateUncertain, setEscalateUncertain] = useState(false);
  const finalEmergency = emergency === CUSTOM ? customText.trim() : emergency;
  const patient = useSimStore((s) => s.patient);
  const dispatching = useSimStore((s) => s.dispatching);
  const training = useSimStore((s) => s.training);
  const status = useSimStore((s) => s.status);
  const classification = useSimStore((s) => s.classification);
  const setStore = useSimStore((s) => s.set);

  const searchHospitals = useAction(api.osm.searchHospitals);
  const fetchRoads = useAction(api.osm.fetchRoads);
  const fetchBuildings = useAction(api.osm.fetchBuildings);
  const saveOsmManifest = useMutation(api.simulations.saveOsmManifest);  const onDispatch = async () => {
    if (!patient) {
      toast.error("Select the patient location on the map first (click the map).");
      return;
    }
    if (!finalEmergency) {
      toast.error(
        emergency === CUSTOM
          ? "Describe the emergency in the text field."
          : "Select the emergency type from the dropdown.",
      );
      return;
    }
    setStore({
      dispatching: true,
      saved: false,
      training: null,
      emergencyText: finalEmergency,
      // drop the PREVIOUS run's results immediately so the hospital, route
      // and access points can never linger on the map/dashboard while a new
      // dispatch is being computed (they are replaced on success).
      selectedHospital: null,
      dispatchHospital: null,
      hospitals: [],
      routeLatLngs: [],
      patientAccessLatLng: null,
      hospitalAccessLatLng: null,
      blockedPolys: [],
      depotLatLng: null,
    });
    try {
      const res = await runDispatchFlow(patient, finalEmergency, {
        fetchHospitals: (a) => searchHospitals(a),
        fetchRoads: (a) => fetchRoads(a),
        fetchBuildings: (a) => fetchBuildings(a),
        saveManifest: (a) => saveOsmManifest(a),
        uncertainAsCritical: escalateUncertain,
      });
      if (!res.ok) {
        toast.error(res.error ?? "Dispatch failed");
        setStore({ dispatching: false });
        return;
      }
      const ctrl = getController();
      setStore({
        dispatching: false,
        networkReady: true,
        simVersion: useSimStore.getState().simVersion + 1,
        classification: res.classification ?? null,
        hospitals: res.candidates ?? [],
        selectedHospital: res.hospital ?? null,
        dispatchHospital: res.dispatchHospital ?? null,
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
      toast.success(`Dispatched — ${res.classification?.criticality ?? "?"} · ${res.hospital?.name ?? "hospital"} selected`);
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
        <label className="text-xs font-medium text-muted-foreground">Emergency type</label>
        <Select value={emergency} onValueChange={setEmergency}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Select emergency type" />
          </SelectTrigger>
          <SelectContent position="popper" align="start" sideOffset={4} className="max-h-72">
            {emergencyCategories.map((label) => (
              <SelectItem key={label} value={label}>
                {label}
              </SelectItem>
            ))}
            <SelectItem value={CUSTOM}>Other / describe another emergency…</SelectItem>
          </SelectContent>
        </Select>
        {emergency === CUSTOM && (
          <Input
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Describe the emergency, e.g. snake bite…"
          />
        )}
        <p className="text-[11px] text-muted-foreground">
          CoTV-E does not diagnose disease — the selection only steers criticality and hospital specialty matching.
        </p>
        <label className="flex items-center gap-2 pt-1 text-[11px] text-muted-foreground">
          <input type="checkbox" checked={escalateUncertain} onChange={(e) => setEscalateUncertain(e.target.checked)} className="accent-red-600" />
          Escalation policy: treat UNCLASSIFIED emergencies as critical
        </label>
      </div>
      {/* fixed-height slots: the panel must not grow/shrink while dispatching
          or when the classification arrives (it used to reflow the whole
          dashboard below every time) */}
      <div className="min-h-[72px]">
        {classification ? (
          <div className={`rounded-md border px-3 py-2 text-xs ${
            classification.criticality === "critical" ? "border-red-500/50 bg-red-50 text-red-800" :
            classification.criticality === "non-critical" ? "border-emerald-500/50 bg-emerald-50 text-emerald-800" :
            "border-amber-500/50 bg-amber-50 text-amber-800"
          }`}>
            <div className="font-semibold uppercase">{classification.criticality}</div>
            <div className="mt-0.5 text-[11px] opacity-90">{classification.notes}</div>
            {classification.criticality !== "critical" && (
              <div className="mt-1 text-[11px]">Emergency signal priority stays OFF for this class.</div>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            Criticality classification appears here after dispatch (keyword policy — not a clinical diagnosis).
          </div>
        )}
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
      <div className="min-h-[40px]">
        {dispatching && (
          <div className="rounded-md border border-amber-500/50 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Fetching OpenStreetMap data, discovering hospitals, quick-training the PPO agent…
            {training === null && <span className="ml-1 animate-pulse">⣾</span>}
          </div>
        )}
      </div>
      {status?.phase === "error" && status.errorMessage && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-50 px-3 py-2 text-xs text-red-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {status.errorMessage}
        </div>
      )}
    </div>
  );
}
