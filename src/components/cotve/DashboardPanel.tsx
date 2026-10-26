import { useEffect, useMemo, useState } from "react";
import DatasetsPanel from "./DatasetsPanel";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, RotateCcw, TriangleAlert } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer, BarChart, Bar, CartesianGrid } from "recharts";
import { useSimStore } from "@/lib/cotve/store";
import { getController, modeLabel } from "@/lib/cotve/simulation";
import { toLatLng } from "@/lib/cotve/geo";
import { emergencyRules, type EmergencyKindLabel } from "@/lib/cotve/config";

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className={`text-right ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function fmt(s: number | null | undefined, digits = 1): string {
  return s === null || s === undefined || s < 0 ? "—" : `${s.toFixed(digits)}s`;
}

function meters(m: number | null | undefined): string {
  return m === null || m === undefined || m < 0 ? "—" : `${(m / 1000).toFixed(2)} km`;
}

/** Clearly-labeled SIMULATED accident: blocks a road ahead on the active
 * route and triggers connected rerouting. Never presented as real. */
function SimulateAccidentButton() {
  const status = useSimStore((s) => s.status);
  const setStore = useSimStore((s) => s.set);
  const ctrl = getController();
  const active = status?.phase === "to-patient" || status?.phase === "to-hospital";
  const onClick = () => {
    const a = ctrl.ambulance;
    const route = ctrl.currentRoute;
    if (!a || !route) return;
    // pick an open route edge ahead (not the one we are on)
    const ahead = route.edgeIds.slice(a.routeIdx + 1).find((id) => !ctrl.graph.edgesById.get(id)!.blocked);
    const target = ahead ?? route.edgeIds[a.routeIdx];
    if (target === undefined) return;
    ctrl.blockEdge(target, "SIMULATED accident scenario (test event, not a real accident)");
    const polys: [number, number][][] = ctrl.graph.edges
      .filter((e) => e.blocked)
      .map((e) => e.geom.map((p) => {
        const ll = toLatLng(ctrl.projection, p.x, p.y);
        return [ll.lat, ll.lng] as [number, number];
      }));
    setStore({ blockVersion: useSimStore.getState().blockVersion + 1, blockedPolys: polys });
  };
  return (
    <Button size="sm" variant="outline" disabled={!active} onClick={onClick} className="border-red-500/50 text-red-600 hover:bg-red-50">
      <TriangleAlert className="mr-1 h-3.5 w-3.5" /> Simulate accident
    </Button>
  );
}

export default function DashboardPanel() {
  const [tab, setTab] = useState("status");
  const status = useSimStore((s) => s.status);
  const metrics = useSimStore((s) => s.metrics);
  const events = useSimStore((s) => s.events);
  const hospitals = useSimStore((s) => s.hospitals);
  const selected = useSimStore((s) => s.selectedHospital);
  const dispatchHosp = useSimStore((s) => s.dispatchHospital);
  const patient = useSimStore((s) => s.patient);
  const emergencyText = useSimStore((s) => s.emergencyText);
  const training = useSimStore((s) => s.training);
  const networkInfo = useSimStore((s) => s.networkInfo);
  const saved = useSimStore((s) => s.saved);
  const setStore = useSimStore((s) => s.set);
  const saveSim = useMutation(api.simulations.save);
  const history = useQuery(api.simulations.listRecent, { limit: 8 });

  const ctrl = getController();
  const complete = status?.phase === "complete";

  // persist the trip summary once, on completion
  useEffect(() => {
    if (!(complete && !saved && metrics && selected && patient)) return;
    setStore({ saved: true });
    saveSim({
      emergencyText,
      emergencyKind: classifyKind(emergencyText),
      patientLat: patient.lat,
      patientLng: patient.lng,
      hospitalName: selected.name,
      hospitalLat: selected.lat,
      hospitalLng: selected.lng,
      hospitalDemo: selected.demo,
      networkSource: status?.networkSource ?? "—",
      responseTimeSec: metrics.responseTime,
      totalTimeSec: metrics.totalTime,
      totalDistanceM: ctrl.routeDistanceTraveled,
      routingMode: status?.routingMode ?? "—",
      signalRequests: metrics.signalRequests,
      signalActivations: metrics.signalActivations,
      ppoEpisodes: metrics.ppoEpisodes,
      metrics,
    }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [complete, saved]);

  const rewardData = useMemo(
    () => (training?.rewardCurve ?? metrics?.ppoRewardCurve ?? []).map((r, i) => ({ ep: i, reward: r })),
    [training, metrics],
  );

  const baselineData = useMemo(() => {
    const b = metrics?.baseline;
    const actual = metrics?.totalTime ?? 0;
    if (!b) return [];
    return [
      { name: "Dijkstra", est: b.dijkstraTime ?? 0, actual: 0 },
      { name: "A*", est: b.astarTime ?? 0, actual: 0 },
      { name: "GNN+PPO (sim)", est: actual, actual },
    ];
  }, [metrics]);

  const downloadCsv = () => {
    if (!metrics) return;
    const rows: string[][] = [
      ["metric", "value", "unit"],
      ["emergency", emergencyText, ""],
      ["hospital", selected?.name ?? "", ""],
      ["network_source", status?.networkSource ?? "", ""],
      ["response_time", metrics.responseTime.toFixed(1), "s"],
      ["pickup_duration_simulated", metrics.pickupDuration.toFixed(1), "s"],
      ["transport_time", metrics.transportTime.toFixed(1), "s"],
      ["total_journey_time", metrics.totalTime.toFixed(1), "s"],
      ["distance_traveled", ctrl.routeDistanceTraveled.toFixed(0), "m"],
      ["signal_priority_requests", String(metrics.signalRequests), ""],
      ["signal_priority_activations", String(metrics.signalActivations), ""],
      ["signal_restorations", String(metrics.signalRestorations), ""],
      ["relevant_intersections", String(metrics.relevantIntersections), ""],
      ["ppo_episodes_quicktrain", String(metrics.ppoEpisodes), ""],
      ["ppo_routing_mode", status?.routingMode ?? "", ""],
      ["criticality", status?.criticality ?? "", ""],
      ["patient_access_distance_m", metrics.patientAccessDistance.toFixed(1), "m"],
      ["hospital_access_distance_m", metrics.hospitalAccessDistance.toFixed(1), "m"],
      ["blockage_events", String(metrics.blockageEvents), ""],
      ["reroutes", String(metrics.reroutes), ""],
      ["baseline_dijkstra_est_time", metrics.baseline?.dijkstraTime?.toFixed(1) ?? "", "s"],
      ["baseline_astar_est_time", metrics.baseline?.astarTime?.toFixed(1) ?? "", "s"],
      ["route_mode_to_patient", metrics.legs.toPatient ? modeLabel(getController().currentRoute?.mode ?? "ppo") : "", ""],
    ];
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "cotve_trip_metrics.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Control dashboard</CardTitle>
          <Badge variant={phaseVariant(status?.phase)} className="font-mono text-[10px] uppercase">
            {status?.phase ?? "standby"}
          </Badge>
        </div>
        {/* actions live on their OWN always-rendered row: the header height is
            constant from first paint, so nothing below ever reflows when the
            journey starts, completes or is reset */}
        <div className="mt-2 flex h-8 items-center gap-2">
          <SimulateAccidentButton />
          <Button size="sm" variant="outline" onClick={downloadCsv} disabled={!complete}>
            <Download className="mr-1 h-3.5 w-3.5" /> CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!complete}
            onClick={() => {
              ctrl.reset();
              setStore({
                status: ctrl.status(),
                metrics: ctrl.metrics,
                saved: false,
                routeLatLngs: [],
                // full stale-state clear: the hospital/access/route of the
                // finished trip must not survive a reset (it used to keep
                // showing the old hospital after returning to the map)
                selectedHospital: null,
                dispatchHospital: null,
                hospitals: [],
                patientAccessLatLng: null,
                hospitalAccessLatLng: null,
                blockedPolys: [],
                classification: null,
                depotLatLng: null,
                training: null,
              });
            }}
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset
          </Button>
        </div>
        <Progress value={status?.progressPct ?? 0} className="mt-2 h-1.5" />
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        <Tabs value={tab} onValueChange={setTab} className="flex h-full flex-col">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="metrics">Metrics</TabsTrigger>
            <TabsTrigger value="hospitals">Hospitals</TabsTrigger>
            <TabsTrigger value="datasets">Datasets</TabsTrigger>
            <TabsTrigger value="log">Log</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="status" className="mt-3 space-y-1 overflow-y-auto">
            <Row label="Patient location" value={patient ? `${patient.lat.toFixed(5)}, ${patient.lng.toFixed(5)}` : "—"} mono />
            <Row label="Emergency type" value={emergencyText || "—"} />
            <Row label="Treatment hospital" value={selected ? `${selected.name}${selected.demo ? " (DEMO)" : ""}` : "—"} />
            <Row label="Ambulance start (dispatch hospital)" value={dispatchHosp ? `${dispatchHosp.name}${dispatchHosp.demo ? " (DEMO)" : ""}` : useSimStore.getState().depotLatLng ? `${useSimStore.getState().depotLatLng!.lat.toFixed(5)}, ${useSimStore.getState().depotLatLng!.lng.toFixed(5)}` : "—"} />
            <Row label="Ambulance status" value={status?.ambulanceStatus ?? "—"} />
            <Row label="Current route" value={status?.routeInfo ?? "—"} />
            <Row label="Simulation time" value={fmt(status?.t ?? null)} mono />
            <Row label="ETA → patient" value={fmt(status?.etaPatient ?? null)} mono />
            <Row label="ETA → hospital" value={fmt(status?.etaHospital ?? null)} mono />
            <Row label="Distance traveled" value={meters(status?.distanceTraveled ?? null)} mono />
            <Row label="Next signal" value={status?.signalStatus ?? "—"} />
            <Row label="Emergency priority" value={status?.priorityStatus ?? "—"} />
            <Row label="Classification" value={status ? `${status.criticality} — ${status.classificationNote}` : "—"} />
            <Row label="Patient access distance" value={status?.patientAccessM != null ? `${status.patientAccessM.toFixed(0)} m to road` : "—"} mono />
            <Row label="Blocked roads / reroutes" value={status ? `${status.blockedRoads} / ${status.reroutes}` : "—"} mono />
            <Row label="Routing mode" value={status?.routingMode ?? "—"} />
            {networkInfo && (
              <p className="mt-2 rounded-md bg-muted/60 px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">{networkInfo}</p>
            )}
          </TabsContent>

          <TabsContent value="metrics" className="mt-3 space-y-3 overflow-y-auto">
            {metrics && metrics.totalTime > 0 ? (
              <>
                <div className="grid grid-cols-2 gap-2 text-sm [grid-auto-rows:1fr]">
                  <MetricTile label="Response time" value={fmt(metrics.responseTime)} />
                  <MetricTile label="Pickup (simulated)" value={fmt(metrics.pickupDuration)} />
                  <MetricTile label="Transport time" value={fmt(metrics.transportTime)} />
                  <MetricTile label="Total journey" value={fmt(metrics.totalTime)} />
                  <MetricTile label="Signal wait" value={fmt((metrics.legs.toPatient?.signalWaitTime ?? 0) + (metrics.legs.toHospital?.signalWaitTime ?? 0))} />
                  <MetricTile label="Route recalcs" value={String((metrics.legs.toPatient?.recalcs ?? 0) + (metrics.legs.toHospital?.recalcs ?? 0))} />
                  <MetricTile label="Priority requests / activations" value={`${metrics.signalRequests} / ${metrics.signalActivations}`} />
                  <MetricTile label="Restorations · intersections" value={`${metrics.signalRestorations} · ${metrics.relevantIntersections}`} />
                  <MetricTile label="Classification" value={metrics.criticality} />
                  <MetricTile label="Access dist (patient / hospital)" value={`${metrics.patientAccessDistance.toFixed(0)} / ${metrics.hospitalAccessDistance.toFixed(0)} m`} />
                  <MetricTile label="Blockage events · reroutes" value={`${metrics.blockageEvents} · ${metrics.reroutes}`} />
                </div>
                <div className="h-40">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Baseline comparison (estimated travel time, same network & initial congestion — not re-simulated)</div>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={baselineData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                      <YAxis tick={{ fontSize: 10 }} unit="s" width={54} />
                      <ReTooltip formatter={(v: number | string) => `${Number(v).toFixed(1)} s`} />
                      <Bar dataKey="est" fill="#f59e0b" radius={3} name="travel time (s)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="h-40">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    PPO quick-train reward per batch ({training?.episodes ?? metrics.ppoEpisodes} episodes, {training?.wallMs ?? "—"} ms — demonstration scale)
                  </div>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={rewardData} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                      <XAxis dataKey="ep" tick={{ fontSize: 10 }} />
                      <YAxis tick={{ fontSize: 10 }} width={54} />
                      <ReTooltip formatter={(v: number | string) => Number(v).toFixed(2)} />
                      <Line dataKey="reward" stroke="#22d3ee" dot={false} strokeWidth={1.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                {metrics.baseline && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Method</TableHead>
                        <TableHead className="text-right">Est. time (s)</TableHead>
                        <TableHead className="text-right">Distance (km)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <TableRow>
                        <TableCell>Dijkstra (baseline)</TableCell>
                        <TableCell className="text-right font-mono">{fmt(metrics.baseline.dijkstraTime)}</TableCell>
                        <TableCell className="text-right font-mono">{meters(metrics.baseline.dijkstraDistance)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>A* (baseline)</TableCell>
                        <TableCell className="text-right font-mono">{fmt(metrics.baseline.astarTime)}</TableCell>
                        <TableCell className="text-right font-mono">{meters(metrics.baseline.astarDistance)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell>GNN + PPO (simulated, actual)</TableCell>
                        <TableCell className="text-right font-mono">{fmt(metrics.totalTime)}</TableCell>
                        <TableCell className="text-right font-mono">{meters(ctrl.routeDistanceTraveled)}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
                <p className="text-[11px] text-muted-foreground">
                  All times come from the synthetic traffic simulation. They are not real-world performance and the baselines are evaluated on the initial congestion snapshot.
                </p>
              </>
            ) : (
              <p className="pt-6 text-center text-sm text-muted-foreground">Run a dispatch to collect metrics. Metrics shown here are unavailable until a simulation completes.</p>
            )}
          </TabsContent>

          <TabsContent value="hospitals" className="mt-3 overflow-y-auto">
            {hospitals.length === 0 ? (
              <p className="pt-6 text-center text-sm text-muted-foreground">Hospitals appear here after dispatch (from OpenStreetMap; demo data is labeled).</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hospital</TableHead>
                    <TableHead className="text-right">Road ETA</TableHead>
                    <TableHead className="text-right">Spec.</TableHead>
                    <TableHead className="text-right">Emerg.</TableHead>
                    <TableHead className="text-right">Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hospitals.map((h) => (
                    <TableRow key={h.id} className={selected?.id === h.id ? "bg-primary/10" : ""}>
                      <TableCell>
                        <div className="max-w-52 truncate font-medium">{h.name}</div>
                        {h.scores?.notes[0] && <div className="max-w-52 truncate text-[10px] text-muted-foreground">{h.scores.notes[0]}</div>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{h.scores ? fmt(h.scores.roadTravelTime < 0 ? null : h.scores.roadTravelTime, 0) : "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{h.scores ? h.scores.specialtyMatch.toFixed(1) : "—"}</TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {h.hasEmergencyTag === true ? "yes" : h.hasEmergencyTag === "unknown" ? "unk" : "no"}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">{h.scores?.total.toFixed(2) ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TabsContent>

          <TabsContent value="datasets" className="mt-3 h-[420px] overflow-y-auto">
            <DatasetsPanel />
          </TabsContent>

          <TabsContent value="log" className="mt-3 overflow-y-auto">
            <div className="space-y-1 font-mono text-[11px] leading-relaxed">
              {[...events].reverse().map((e, i) => (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">{e.t.toFixed(1)}s</span>
                  <span className="shrink-0 text-cyan-600">{e.kind}</span>
                  <span>{e.message}</span>
                </div>
              ))}
              {events.length === 0 && <p className="pt-4 text-center font-sans text-sm text-muted-foreground">No events yet.</p>}
            </div>
          </TabsContent>

          <TabsContent value="history" className="mt-3 overflow-y-auto">
            {history && history.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Emergency</TableHead>
                    <TableHead>Hospital</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((h) => (
                    <TableRow key={h._id}>
                      <TableCell className="text-xs">{new Date(h.createdAt).toLocaleTimeString()}</TableCell>
                      <TableCell className="max-w-24 truncate text-xs">{h.emergencyText}</TableCell>
                      <TableCell className="max-w-32 truncate text-xs">{h.hospitalName}{h.hospitalDemo ? " (demo)" : ""}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{h.totalTimeSec.toFixed(1)}s</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="pt-6 text-center text-sm text-muted-foreground">Completed trips are stored in Convex and listed here.</p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    // label block is bottom-padded to a fixed height so every VALUE in the
    // grid sits on the same baseline — tiles used to misalign vertically
    // whenever a label wrapped to a second line
    <div className="flex h-full flex-col justify-between rounded-md border border-border bg-muted/40 px-2.5 py-2">
      <div className="min-h-[24px] text-[10px] leading-tight uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm leading-none font-semibold">{value}</div>
    </div>
  );
}

function phaseVariant(phase?: string): "default" | "secondary" | "destructive" | "outline" {
  switch (phase) {
    case "complete": return "default";
    case "error": return "destructive";
    case "idle": return "secondary";
    default: return "outline";
  }
}

function classifyKind(text: string): string {
  // reuse the shared classifier through config keyword lists
  const s = text.toLowerCase();
  for (const k of Object.keys(emergencyRules) as EmergencyKindLabel[]) {
    if (emergencyRules[k].keywords.some((w) => s.includes(w))) return k;
  }
  return "general";
}
