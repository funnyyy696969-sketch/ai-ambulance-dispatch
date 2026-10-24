import { settings, trafficSettings, criticalityConfig } from "./config";
import type {
  AmbulanceState,
  BuildingFootprint,
  Classification,
  LatLng,
  HospitalCandidate,
  LegMetrics,
  LiveFrame,
  PlannedRoute,
  RoadGraph,
  RoadSnap,
  SimEvent,
  SimPhase,
  TripMetrics,
} from "./types";
import { Projection } from "./geo";
import { edgePoseAt, routeLength } from "./network";
import {
  createRoutingContext,
  planRoutePpo,
  planRouteDijkstra,
  planRouteAstar,
  refreshEmbeddings,
  shouldRecalculate,
  type RoutingContext,
} from "./routeManager";
import { PpoAgent, quickTrain, type QuickTrainResult } from "./ppo";
import { RoadGNN } from "./gnn";
import { SignalController } from "./signals";
import { TrafficSimulator } from "./traffic";

export interface DispatchPayload {
  patient: LatLng;
  emergencyText: string;
  emergencyKind: string;
  /** treatment hospital (final destination, best match for the emergency) */
  hospital: HospitalCandidate;
  /** nearest suitable hospital the ambulance departs from (may equal hospital) */
  dispatchHospital: HospitalCandidate;
  patientAccessNode: number;
  hospitalAccessNode: number;
  /** road-access node of the dispatch hospital (ambulance start) */
  dispatchHospitalNode: number;
  patientAccess: RoadSnap;
  hospitalAccess: RoadSnap;
  dispatchHospitalAccess: RoadSnap;
  classification: Classification;
}

export interface DispatchResult {
  ok: boolean;
  error?: string;
  hospital?: HospitalCandidate;
  ambulanceNode?: number;
  leg1?: PlannedRoute;
  training?: QuickTrainResult;
}

export interface ControllerStatus {
  phase: SimPhase;
  t: number;
  errorMessage?: string;
  hospitalName: string;
  hospitalDemo: boolean;
  networkSource: string;
  ambulanceStatus: string;
  routeInfo: string;
  etaPatient: number | null;
  etaHospital: number | null;
  /** meters remaining on the CURRENT leg (patient or hospital) */
  remainM: number | null;
  distanceTraveled: number;
  signalStatus: string;
  priorityStatus: string;
  progressPct: number;
  routingMode: string;
  criticality: string;
  classificationNote: string;
  patientAccessM: number | null;
  blockedRoads: number;
  reroutes: number;
}

/**
 * The single shared simulation state. Both 3D screens and the dashboard
 * read from this controller. The ambulance moves strictly along edge
 * geometry (arc-length interpolation, tangent heading) — it can never
 * leave the road corridor or cross disconnected space.
 */
export class SimulationController {
  graph!: RoadGraph;
  projection!: Projection;
  traffic!: TrafficSimulator;
  signals!: SignalController;
  gnn = new RoadGNN();
  agent = new PpoAgent();
  rc!: RoutingContext;

  phase: SimPhase = "idle";
  t = 0;
  tDispatch = 0;
  speedMult = 1;
  paused = false;
  errorMessage = "";
  events: SimEvent[] = [];

  patient!: LatLng;
  patientNode = 0;
  hospitalCand: HospitalCandidate | null = null;
  /** nearest suitable hospital the ambulance departs from (may equal hospital) */
  dispatchHospitalCand: HospitalCandidate | null = null;
  hospitalNode = 0;
  depotNode = 0;
  /** real OSM building footprints (geometry-true, shared projection) */
  buildings: BuildingFootprint[] = [];
  emergencyText = "";
  emergencyKind = "general";
  classification: Classification = { criticality: "uncertain", matchedRule: null, notes: "" };

  ambulance: AmbulanceState | null = null;
  currentRoute: PlannedRoute | null = null;
  leg: "to-patient" | "to-hospital" = "to-patient";

  metrics: TripMetrics = emptyMetrics();
  private legMetrics: LegMetrics = emptyLeg();
  private lastRecalcT = 0;
  private pickupTimer = 0;
  private relevantIntersections = new Set<number>();
  private trainResult: QuickTrainResult | null = null;
  routeDistanceTraveled = 0;
  private arrivalHandlers: ((phase: SimPhase) => void)[] = [];
  private lastTrainStatus = "";

  live: LiveFrame = {
    t: 0, phase: "idle", ambulance: null, vehicles: [], signals: new Map(), routeEdgeIds: [], pickupTimer: 0,
  };

  onArrival(cb: (phase: SimPhase) => void) {
    this.arrivalHandlers.push(cb);
  }

  log(kind: string, message: string) {
    this.events.push({ t: this.t, kind, message });
    if (this.events.length > 300) this.events.shift();
  }

  setup(graph: RoadGraph, projection: Projection) {
    this.graph = graph;
    this.projection = projection;
    this.traffic = new TrafficSimulator(graph);
    this.signals = new SignalController(graph);
    this.rc = createRoutingContext(graph, this.gnn, this.agent);
    this.phase = "idle";
    this.t = 0;
    this.events = [];
    this.log("network", `Road network ready: ${graph.nodes.length} junctions, ${graph.edges.length} directed segments, real geometry preserved (source: ${graph.source === "osm" ? "OpenStreetMap" : "DEMONSTRATION grid"})`);
  }

  /** Block a road segment (accident / closure). Both directions close, as a
   * physical road closure would. Triggers connected rerouting if needed. */
  blockEdge(edgeId: number, reason: string): boolean {
    const e = this.graph.edgesById.get(edgeId);
    if (!e) return false;
    e.blocked = true;
    const rev = this.graph.edges.find((x) => x.from === e.to && x.to === e.from && x.wayId === e.wayId);
    if (rev) rev.blocked = true;
    this.metrics.blockageEvents++;
    this.log("accident", `${reason}: segment #${edgeId} (${e.highwayType}, ${e.length.toFixed(0)} m) blocked — ${rev ? "both directions" : "one-way"}`);
    this.checkRouteIntegrity("road blocked by accident scenario");
    return true;
  }

  dispatch(payload: DispatchPayload, trainBudgetMs: number = settings.ppoTrainBudgetMs): DispatchResult {
    try {
      this.patient = payload.patient;
      this.emergencyText = payload.emergencyText;
      this.emergencyKind = payload.emergencyKind;
      this.hospitalCand = payload.hospital;
      this.classification = payload.classification;
      this.phase = "dispatching";
      this.metrics = emptyMetrics();
      this.metrics.criticality = payload.classification.criticality;
      this.log("dispatch", `Emergency "${payload.emergencyText}" — classified ${payload.classification.criticality.toUpperCase()} (${payload.classification.matchedRule ?? "no rule match"})`);

      const priorityOn = payload.classification.criticality === "critical";
      this.signals.setPriorityEnabled(priorityOn);
      this.log("signals", priorityOn
        ? "CRITICAL emergency: route-specific signal priority ARMED (simulated signal timing)"
        : `NON-CRITICAL/uncertain emergency: signal priority stays OFF — normal simulated cycles`);

      this.patientNode = payload.patientAccessNode;
      this.hospitalNode = payload.hospitalAccessNode;
      this.dispatchHospitalCand = payload.dispatchHospital;
      this.metrics.patientAccessDistance = payload.patientAccess.distanceM;
      this.metrics.hospitalAccessDistance = payload.hospitalAccess.distanceM;

      // The ambulance starts at the DISPATCH hospital (nearest suitable one by
      // road travel time), NOT an arbitrary depot — see dispatchFlow.
      const bestDepot = payload.dispatchHospitalNode;
      this.depotNode = bestDepot;
      const dn = this.graph.nodesById.get(bestDepot)!;
      this.log("ambulance", `Simulated ambulance departs from ${payload.dispatchHospital.name}${payload.dispatchHospital.demo ? " (DEMO)" : ""} at (${dn.lat.toFixed(4)}, ${dn.lng.toFixed(4)}) — nearest suitable hospital by road-network travel time`);
      this.log("access", `Patient access point: ${payload.patientAccess.distanceM.toFixed(0)} m from the selected location (marker stays at the original point)`);

      refreshEmbeddings(this.rc, this.patientNode, this.hospitalNode);
      this.lastTrainStatus = this.agent.status;
      this.trainResult = quickTrain(this.agent, this.graph, this.rc.emb!, trainBudgetMs, settings.seed);
      this.metrics.ppoEpisodes = this.trainResult.episodes;
      this.metrics.ppoRewardCurve = this.trainResult.rewardCurve;
      this.log("ppo", `PPO quick-train: ${this.trainResult.episodes} episodes in ${this.trainResult.wallMs}ms (demonstration scale)`);

      const dLeg1 = planRouteDijkstra(this.graph, bestDepot, this.patientNode);
      const dLeg2 = planRouteDijkstra(this.graph, this.patientNode, this.hospitalNode);
      const aLeg1 = planRouteAstar(this.graph, bestDepot, this.patientNode);
      const aLeg2 = planRouteAstar(this.graph, this.patientNode, this.hospitalNode);
      this.metrics.baseline = {
        dijkstraTime: dLeg1.estimatedTime + dLeg2.estimatedTime,
        astarTime: aLeg1.estimatedTime + aLeg2.estimatedTime,
        dijkstraDistance: dLeg1.length + dLeg2.length,
        astarDistance: aLeg1.length + aLeg2.length,
      };

      const leg1 = planRoutePpo(this.rc, bestDepot, this.patientNode, settings.seed);
      this.currentRoute = leg1;
      this.leg = "to-patient";
      this.legMetrics = emptyLeg();
      for (const n of leg1.nodePath) {
        if (this.graph.nodesById.get(n)!.signalized) this.relevantIntersections.add(n);
      }
      const an = this.graph.nodesById.get(bestDepot)!;
      const firstEdge = leg1.edgeIds.length ? this.graph.edgesById.get(leg1.edgeIds[0])! : null;
      this.ambulance = {
        nodeId: bestDepot,
        edgeId: firstEdge?.id ?? null,
        edgePos: 0,
        x: an.x, y: an.y,
        heading: firstEdge ? edgePoseAt(firstEdge, 0).heading : 0,
        speed: 0, waiting: false, route: leg1, routeIdx: 0,
      };
      this.tDispatch = this.t;
      this.phase = "to-patient";
      this.lastRecalcT = this.t;
      this.log("route", `Route to patient access: ${leg1.length.toFixed(0)} m, ETA ${leg1.estimatedTime.toFixed(0)} s — mode: ${modeLabel(leg1.mode)}${leg1.fallbackReason ? ` (fallback: ${leg1.fallbackReason})` : ""}`);
      this.syncLive();
      return { ok: true, hospital: payload.hospital, ambulanceNode: bestDepot, leg1, training: this.trainResult };
    } catch (err) {
      this.phase = "error";
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.log("error", this.errorMessage);
      return { ok: false, error: this.errorMessage };
    }
  }

  reset() {
    this.phase = "idle";
    this.t = 0;
    this.paused = false;
    this.ambulance = null;
    this.currentRoute = null;
    this.metrics = emptyMetrics();
    this.errorMessage = "";
    this.hospitalCand = null;
    this.dispatchHospitalCand = null;
    this.classification = { criticality: "uncertain", matchedRule: null, notes: "" };
    this.syncLive();
  }

  tick(dtReal: number) {
    if (this.paused || this.phase === "idle" || this.phase === "error" || this.phase === "complete") return;
    const dt = Math.min(0.06, dtReal) * this.speedMult;
    this.t += dt;
    this.traffic.tick(dt);
    this.updateSignals(dt);
    if (this.phase === "pickup") {
      this.pickupTimer -= dt;
      if (this.pickupTimer <= 0) this.startHospitalLeg();
    } else if (this.ambulance && this.currentRoute) {
      this.moveAmbulance(dt);
      this.checkRouteIntegrity("route integrity check");
      this.maybeRecalculate();
    }
    this.syncLive();
  }

  private updateSignals(dt: number) {
    if (!this.ambulance || !this.currentRoute) {
      this.signals.update(dt, []);
      return;
    }
    const approaching: { nodeId: number; distanceM: number; axis: 0 | 1; passed: boolean }[] = [];
    let d = this.currentRoute.length !== 0 ? this.edgeLen(this.ambulance) - this.ambulance.edgePos : 0;
    let prevNode = this.ambulance.nodeId;
    for (let i = this.ambulance.routeIdx; i < this.currentRoute.edgeIds.length; i++) {
      const e = this.graph.edgesById.get(this.currentRoute.edgeIds[i])!;
      if (i > this.ambulance.routeIdx) d += e.length;
      const n = this.graph.nodesById.get(e.to)!;
      if (n.signalized) {
        approaching.push({ nodeId: n.id, distanceM: d, axis: this.signals.arrivalAxis(n.id, prevNode), passed: false });
      }
      prevNode = e.to;
      if (approaching.length >= 3) break;
    }
    for (let i = 0; i < this.ambulance.routeIdx; i++) {
      const e = this.graph.edgesById.get(this.currentRoute.edgeIds[i])!;
      const n = this.graph.nodesById.get(e.to)!;
      if (n.signalized) {
        const s = this.signals.states.get(n.id);
        if (s && (s.priority === "holding" || s.priority === "transition")) {
          approaching.push({ nodeId: n.id, distanceM: -1, axis: 0, passed: true });
        }
      }
    }
    for (const s of this.signals.states.values()) {
      if ((s.priority === "holding" || s.priority === "transition") && !approaching.some((a) => a.nodeId === s.nodeId)) {
        approaching.push({ nodeId: s.nodeId, distanceM: -1, axis: 0, passed: true });
      }
    }
    this.signals.update(dt, approaching);
  }

  private edgeLen(a: AmbulanceState): number {
    return a.edgeId !== null ? this.graph.edgesById.get(a.edgeId)!.length : 0;
  }

  /** Move along the REAL edge geometry (arc-length interpolation). */
  private moveAmbulance(dt: number) {
    const a = this.ambulance!;
    const route = this.currentRoute!;
    if (a.routeIdx >= route.edgeIds.length) { this.arrive(); return; }
    const e = this.graph.edgesById.get(route.edgeIds[a.routeIdx])!;
    const nn = this.graph.nodesById.get(e.to)!;
    if (nn.signalized && a.edgePos >= e.length - 2.5) {
      const axis = this.signals.arrivalAxis(e.to, a.nodeId);
      if (!this.signals.canPass(e.to, axis)) {
        a.waiting = true;
        a.speed = 0;
        this.legMetrics.signalWaitTime += dt;
        const pose = edgePoseAt(e, a.edgePos);
        a.x = pose.x; a.y = pose.y;
        return;
      }
    }
    a.waiting = false;
    let v = Math.min(e.speedLimit * trafficSettings.ambulanceSpeedFactor, trafficSettings.ambulanceMaxSpeed);
    v *= Math.max(0.35, 1 - 0.5 * e.density);
    if (this.traffic.ambulanceBlockedAhead(e.id, a.edgePos) && a.edgePos < e.length - 12) {
      v = Math.min(v, 4);
    }
    a.speed = v;
    a.edgePos += v * dt;
    this.legMetrics.distance += v * dt;
    this.routeDistanceTraveled += v * dt;
    if (a.edgePos >= e.length) {
      a.nodeId = e.to;
      a.edgePos = 0;
      a.routeIdx++;
      if (a.routeIdx >= route.edgeIds.length) { this.arrive(); return; }
      a.edgeId = route.edgeIds[a.routeIdx];
    } else {
      a.edgeId = e.id;
    }
    const pose = edgePoseAt(this.graph.edgesById.get(a.edgeId!)!, a.edgePos);
    a.x = pose.x; a.y = pose.y; a.heading = pose.heading;
  }

  /** Reject routes through blocked roads; reroute via a CONNECTED transition
   * (keep the edge we are already on, rejoin the graph at its end node). */
  checkRouteIntegrity(reason: string) {
    const route = this.currentRoute;
    const a = this.ambulance;
    if (!route || !a) return;
    const dest = this.leg === "to-patient" ? this.patientNode : this.hospitalNode;
    for (let i = Math.max(a.routeIdx, 0); i < route.edgeIds.length; i++) {
      if (this.graph.edgesById.get(route.edgeIds[i])?.blocked) {
        this.rerouteFromCurrent(reason, dest); // may set phase=error (route unavailable)
        return;
      }
    }
  }

  private rerouteFromCurrent(reason: string, dest: number): boolean {
    const a = this.ambulance!;
    const route = this.currentRoute!;
    const currentEdge = this.graph.edgesById.get(route.edgeIds[a.routeIdx])!;
    let rest;
    try {
      rest = planRoutePpo(this.rc, currentEdge.to, dest, settings.seed + Math.floor(this.t));
    } catch {
      // honest route-unavailable handling: never fabricate a route
      this.phase = "error";
      this.errorMessage = `Route unavailable: ${reason} — no connected road route remains to the destination. The blockage cut off the final approach. Please retry (the simulation will re-plan from a fresh dispatch).`;
      this.log("error", this.errorMessage);
      this.syncLive();
      return false;
    }
    const combined: PlannedRoute = {
      nodePath: [a.nodeId, ...rest.nodePath],
      edgeIds: [currentEdge.id, ...rest.edgeIds],
      length: currentEdge.length + rest.length,
      estimatedTime: currentEdge.baseTravelTime + rest.estimatedTime,
      mode: rest.mode,
      fallbackReason: rest.fallbackReason,
      invalidActionCount: rest.invalidActionCount,
      steps: rest.steps,
    };
    this.currentRoute = combined;
    a.route = combined;
    a.routeIdx = 0; // still ON currentEdge (index 0) — no teleporting
    a.edgeId = currentEdge.id;
    this.metrics.reroutes++;
    this.legMetrics.recalcs++;
    this.log("reroute", `${reason}: rerouted from the next connected junction — new route ${combined.length.toFixed(0)} m via ${modeLabel(combined.mode)}`);
    return true;
  }

  private maybeRecalculate() {
    if (!this.currentRoute || !this.ambulance) return;
    const dest = this.leg === "to-patient" ? this.patientNode : this.hospitalNode;
    if (this.t - this.lastRecalcT < settings.recalcIntervalS) return;
    this.lastRecalcT = this.t;
    const cur = this.currentRoute.edgeIds[this.ambulance.routeIdx];
    const e = cur !== undefined ? this.graph.edgesById.get(cur)! : null;
    if (!e) return;
    if (shouldRecalculate(this.graph, this.currentRoute, this.ambulance.routeIdx + 1, e.to, dest)) {
      this.rerouteFromCurrent("traffic change made a faster connected route available", dest);
    }
  }

  private arrive() {
    const a = this.ambulance!;
    if (this.leg === "to-patient") {
      const pn = this.graph.nodesById.get(this.patientNode)!;
      a.x = pn.x; a.y = pn.y; a.speed = 0; a.waiting = false;
      this.metrics.responseTime = this.t - this.tDispatch;
      this.metrics.legs.toPatient = { ...this.legMetrics, travelTime: this.metrics.responseTime, ppoSteps: this.currentRoute?.steps ?? 0 };
      this.pickupTimer = this.classification.criticality === "critical"
        ? criticalityConfig.pickupDurationCriticalS
        : criticalityConfig.pickupDurationNonCriticalS;
      this.metrics.pickupDuration = this.pickupTimer;
      this.log("patient", `Ambulance reached the patient's road-access point. Response time ${this.metrics.responseTime.toFixed(1)} s — SIMULATED pickup starting (${this.pickupTimer.toFixed(0)} s, not a real pickup)`);
      this.phase = "pickup";
      this.emitArrival();
    } else {
      const hn = this.graph.nodesById.get(this.hospitalNode)!;
      a.x = hn.x; a.y = hn.y; a.speed = 0;
      this.metrics.transportTime = this.t - this.tDispatch - this.metrics.responseTime - this.metrics.pickupDuration;
      this.metrics.legs.toHospital = { ...this.legMetrics, travelTime: this.metrics.transportTime, ppoSteps: this.currentRoute?.steps ?? 0 };
      this.metrics.totalTime = this.t - this.tDispatch;
      this.metrics.signalRequests = this.signals.requests;
      this.metrics.signalActivations = this.signals.activations;
      this.metrics.signalRestorations = this.signals.restorations;
      this.metrics.relevantIntersections = this.relevantIntersections.size;
      this.phase = "complete";
      this.log("hospital", `Ambulance arrived at ${this.hospitalCand?.name}'s road-access point. Total journey ${this.metrics.totalTime.toFixed(1)} s, distance ${this.routeDistanceTraveled.toFixed(0)} m. Simulation complete.`);
      this.emitArrival();
    }
  }

  private startHospitalLeg() {
    const leg2 = planRoutePpo(this.rc, this.patientNode, this.hospitalNode, settings.seed + 7);
    this.currentRoute = leg2;
    this.leg = "to-hospital";
    this.legMetrics = emptyLeg();
    this.lastRecalcT = this.t;
    const a = this.ambulance!;
    a.route = leg2;
    a.routeIdx = 0;
    a.edgeId = leg2.edgeIds[0] ?? null;
    a.edgePos = 0;
    for (const n of leg2.nodePath) {
      if (this.graph.nodesById.get(n)!.signalized) this.relevantIntersections.add(n);
    }
    this.phase = "to-hospital";
    this.log("patient", "Patient aboard (simulated). Routing to the selected hospital's access point.");
    this.log("route", `Hospital route planned: ${leg2.length.toFixed(0)} m, ETA ${leg2.estimatedTime.toFixed(0)} s — mode: ${modeLabel(leg2.mode)}${leg2.fallbackReason ? ` (fallback: ${leg2.fallbackReason})` : ""}`);
  }

  private emitArrival() {
    for (const cb of this.arrivalHandlers) cb(this.phase);
  }

  private syncLive() {
    this.live.t = this.t;
    this.live.phase = this.phase;
    this.live.ambulance = this.ambulance;
    this.live.vehicles = this.traffic?.vehicles ?? [];
    this.live.signals = this.signals?.states ?? new Map();
    this.live.routeEdgeIds = this.currentRoute?.edgeIds ?? [];
    this.live.pickupTimer = this.phase === "pickup" ? this.pickupTimer : 0;
  }

  status(): ControllerStatus {
    const a = this.ambulance;
    const route = this.currentRoute;
    let etaPatient: number | null = null;
    let etaHospital: number | null = null;
    let remainM: number | null = null;
    if (a && route && a.edgeId !== null) {
      const e = this.graph.edgesById.get(a.edgeId)!;
      let remaining = Math.max(0, e.length - a.edgePos);
      for (let i = a.routeIdx + 1; i < route.edgeIds.length; i++) remaining += this.graph.edgesById.get(route.edgeIds[i])!.length;
      const v = Math.max(a.speed, 6);
      remainM = remaining;
      if (this.leg === "to-patient") etaPatient = remaining / v;
      else etaHospital = remaining / v;
    }
    let signalStatus = "—";
    let priorityStatus = "—";
    if (a && route && a.edgeId !== null) {
      const next = this.nextSignalNode();
      if (next) {
        const s = this.signals.states.get(next.nodeId);
        const src = this.graph.nodesById.get(next.nodeId)!.signalSource;
        const srcLabel = src === "osm" ? "OSM-verified location" : src === "inferred" ? "inferred (demo grid)" : "signal data unavailable";
        signalStatus = s ? `${s.phase} (${srcLabel})` : "unsignalized junction";
        priorityStatus = !this.signals.priorityEnabled
          ? "inactive (non-critical)"
          : s?.priority === "none" ? "armed — normal cycle" : s ? `EMERGENCY ${s.priority}` : "—";
      } else {
        signalStatus = "no signalized junction on remaining route";
        priorityStatus = this.signals.priorityEnabled ? "armed — normal cycle" : "inactive (non-critical)";
      }
    }
    const totalLen = route ? routeLength(this.graph, route.edgeIds) : 0;
    const progressPct = a && route && totalLen > 0 ? Math.min(100, (100 * routeProgress(this.graph, route, a)) / totalLen) : 0;
    return {
      phase: this.phase,
      t: this.t,
      errorMessage: this.errorMessage || undefined,
      hospitalName: this.hospitalCand?.name ?? "—",
      hospitalDemo: this.hospitalCand?.demo ?? false,
      networkSource: this.graph?.source ?? "—",
      ambulanceStatus: ambulanceStatus(this),
      routeInfo: route ? `${route.edgeIds.length} segments · ${totalLen.toFixed(0)} m · ${modeLabel(route.mode)}` : "—",
      etaPatient,
      etaHospital,
      remainM,
      distanceTraveled: this.routeDistanceTraveled,
      signalStatus,
      priorityStatus,
      progressPct,
      routingMode: route ? modeLabel(route.mode) : "—",
      criticality: this.classification.criticality,
      classificationNote: this.classification.notes,
      patientAccessM: this.metrics.patientAccessDistance || null,
      blockedRoads: this.graph ? this.graph.edges.filter((e) => e.blocked).length : 0,
      reroutes: this.metrics.reroutes,
    };
  }

  nextSignalNode(): { nodeId: number; distanceM: number } | null {
    const a = this.ambulance;
    const route = this.currentRoute;
    if (!a || !route) return null;
    let d = -a.edgePos;
    for (let i = a.routeIdx; i < route.edgeIds.length; i++) {
      const e = this.graph.edgesById.get(route.edgeIds[i])!;
      d += e.length;
      if (this.graph.nodesById.get(e.to)!.signalized) return { nodeId: e.to, distanceM: d };
    }
    return null;
  }

  patientXY(): { x: number; y: number } {
    const ll = this.patient ?? { lat: 0, lng: 0 };
    return {
      x: (ll.lng - this.projection.center.lng) * this.projection.mPerDegLng,
      y: (ll.lat - this.projection.center.lat) * this.projection.mPerDegLat,
    };
  }

  patientAccessXY(): { x: number; y: number } | null {
    const n = this.graph?.nodesById.get(this.patientNode);
    return n && this.patient ? { x: n.x, y: n.y } : null;
  }

  hospitalXY(): { x: number; y: number } | null {
    if (!this.hospitalCand || !this.projection) return null;
    return {
      x: (this.hospitalCand.lng - this.projection.center.lng) * this.projection.mPerDegLng,
      y: (this.hospitalCand.lat - this.projection.center.lat) * this.projection.mPerDegLat,
    };
  }

  hospitalAccessXY(): { x: number; y: number } | null {
    const n = this.graph?.nodesById.get(this.hospitalNode);
    return n && this.hospitalCand ? { x: n.x, y: n.y } : null;
  }

  depotXY(): { x: number; y: number } | null {
    if (!this.graph || !this.ambulance) return null;
    const n = this.graph.nodesById.get(this.depotNode);
    return n ? { x: n.x, y: n.y } : null;
  }

  /** geographic (projected) location of the dispatch hospital building. */
  dispatchHospitalXY(): { x: number; y: number } | null {
    if (!this.dispatchHospitalCand || !this.projection) return null;
    return {
      x: (this.dispatchHospitalCand.lng - this.projection.center.lng) * this.projection.mPerDegLng,
      y: (this.dispatchHospitalCand.lat - this.projection.center.lat) * this.projection.mPerDegLat,
    };
  }
}

function routeProgress(graph: RoadGraph, route: PlannedRoute, a: AmbulanceState): number {
  let d = 0;
  for (let i = 0; i < a.routeIdx && i < route.edgeIds.length; i++) d += graph.edgesById.get(route.edgeIds[i])!.length;
  return d + a.edgePos;
}

function ambulanceStatus(c: SimulationController): string {
  switch (c.phase) {
    case "idle": return "Standby";
    case "dispatching": return "Planning dispatch…";
    case "to-patient": return c.ambulance?.waiting ? "Waiting at signal" : "En route to patient";
    case "pickup": return `On scene — simulated pickup (${c.live.pickupTimer.toFixed(0)} s left)`;
    case "to-hospital": return c.ambulance?.waiting ? "Waiting at signal" : "Transporting to hospital";
    case "complete": return "Journey complete";
    case "error": return "Error";
  }
}

export function modeLabel(mode: PlannedRoute["mode"]): string {
  switch (mode) {
    case "ppo": return "GNN+PPO";
    case "ppo-quicktrained": return "GNN+PPO (quick-trained)";
    case "fallback-astar": return "A* fallback";
    case "dijkstra": return "Dijkstra";
    case "astar": return "A*";
  }
}

export function emptyMetrics(): TripMetrics {
  return {
    dispatchDelay: 0, responseTime: 0, pickupDuration: 0, transportTime: 0, totalTime: 0,
    legs: { toPatient: null, toHospital: null },
    signalRequests: 0, signalActivations: 0, signalRestorations: 0, relevantIntersections: 0,
    ppoEpisodes: 0, ppoRewardCurve: [], baseline: null,
    patientAccessDistance: 0, hospitalAccessDistance: 0,
    blockageEvents: 0, reroutes: 0, criticality: "uncertain",
  };
}

export function emptyLeg(): LegMetrics {
  return { distance: 0, travelTime: 0, estimatedTime: 0, signalWaitTime: 0, recalcs: 0, invalidActions: 0, ppoSteps: 0 };
}

let _controller: SimulationController | null = null;
export function getController(): SimulationController {
  if (!_controller) _controller = new SimulationController();
  return _controller;
}
