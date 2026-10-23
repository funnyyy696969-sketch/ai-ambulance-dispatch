import { settings, signalSettings, trafficSettings } from "./config";
import type {
  AmbulanceState,
  LatLng,
  HospitalCandidate,
  LegMetrics,
  LiveFrame,
  PlannedRoute,
  RoadGraph,
  SimEvent,
  SimPhase,
  TripMetrics,
} from "./types";
import { Projection } from "./geo";
import { dist, haversineM } from "./geo";
import {
  edgeTravelTime,
  nearestNode,
  pickDepots,
  routeLength,
} from "./network";
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
  hospital: HospitalCandidate;
}

export interface DispatchResult {
  ok: boolean
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
  distanceTraveled: number;
  signalStatus: string;
  priorityStatus: string;
  progressPct: number;
  routingMode: string;
}

/**
 * The single shared simulation state. BOTH 3D screens and the dashboard read
 * from this controller — there is exactly one ambulance simulation, one
 * clock, one route. Screens are views, never independent simulations.
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
  hospitalNode = 0;
  depotNode = 0;
  emergencyText = "";
  emergencyKind = "general";

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
    t: 0,
    phase: "idle",
    ambulance: null,
    vehicles: [],
    signals: new Map(),
    routeEdgeIds: [],
    pickupTimer: 0,
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
    this.log("network", `Road network ready: ${graph.nodes.length} intersections, ${graph.edges.length} directed segments (source: ${graph.source === "osm" ? "OpenStreetMap" : "demonstration grid"})`);
  }

  /**
   * Full dispatch pipeline (synchronous; Overpass fetching + hospital
   * ranking happened in the page before this call).
   */
  dispatch(payload: DispatchPayload, trainBudgetMs: number = settings.ppoTrainBudgetMs): DispatchResult {
    try {
      this.patient = payload.patient;
      this.emergencyText = payload.emergencyText;
      this.emergencyKind = payload.emergencyKind;
      this.hospitalCand = payload.hospital;
      this.phase = "dispatching";
      this.metrics = emptyMetrics();
      this.log("dispatch", `Emergency "${payload.emergencyText}" — dispatch starting`);

      this.patientNode = nearestNode(this.graph, ...this.latLngToXY(payload.patient));
      const hx = (payload.hospital.lng - this.projection.center.lng) * this.projection.mPerDegLng;
      const hy = (payload.hospital.lat - this.projection.center.lat) * this.projection.mPerDegLat;
      this.hospitalNode = nearestNode(this.graph, hx, hy);

      // 1. ambulance selection (simulated depots — clearly labeled)
      const depots = pickDepots(this.graph);
      let bestDepot = depots[0];
      let bestTime = Infinity;
      for (const d of depots) {
        const r = planRouteAstar(this.graph, d, this.patientNode);
        if (r && r.estimatedTime < bestTime) {
          bestTime = r.estimatedTime;
          bestDepot = d;
        }
      }
      this.depotNode = bestDepot;
      const dn = this.graph.nodesById.get(bestDepot)!;
      this.log("ambulance", `Simulated ambulance assigned from depot at (${dn.lat.toFixed(4)}, ${dn.lng.toFixed(4)}) — nearest by road-network travel time`);

      // 2. PPO quick-train on this network (browser, demonstration scale)
      refreshEmbeddings(this.rc, this.patientNode, this.hospitalNode);
      this.lastTrainStatus = this.agent.status;
      this.trainResult = quickTrain(this.agent, this.graph, this.rc.emb!, trainBudgetMs, settings.seed);
      this.metrics.ppoEpisodes = this.trainResult.episodes;
      this.metrics.ppoRewardCurve = this.trainResult.rewardCurve;
      this.log("ppo", `PPO quick-train: ${this.trainResult.episodes} episodes in ${this.trainResult.wallMs}ms, mean reward trend ${this.trainResult.finalMeanReward} (demonstration scale)`);

      // 3. baselines on the initial congestion snapshot (for comparison)
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

      // 4. leg 1: ambulance -> patient with PPO routing
      const leg1 = planRoutePpo(this.rc, bestDepot, this.patientNode, settings.seed);
      this.currentRoute = leg1;
      this.leg = "to-patient";
      this.legMetrics = emptyLeg();
      this.relevantIntersections = new Set(
        leg1.nodePath.filter((n) => this.graph.nodesById.get(n)!.signalized),
      );
      const an = this.graph.nodesById.get(bestDepot)!;
      this.ambulance = {
        nodeId: bestDepot,
        edgeId: leg1.edgeIds[0] ?? null,
        edgePos: 0,
        x: an.x,
        y: an.y,
        speed: 0,
        waiting: false,
        route: leg1,
        routeIdx: 0,
      };
      this.tDispatch = this.t;
      this.phase = "to-patient";
      this.lastRecalcT = this.t;
      this.log(
        "route",
        `Route to patient planned: ${leg1.length.toFixed(0)} m, ETA ${leg1.estimatedTime.toFixed(0)} s — mode: ${modeLabel(leg1.mode)}${leg1.fallbackReason ? ` (fallback: ${leg1.fallbackReason})` : ""}`,
      );
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
    this.syncLive();
  }

  private latLngToXY(ll: LatLng): [number, number] {
    return [
      (ll.lng - this.projection.center.lng) * this.projection.mPerDegLng,
      (ll.lat - this.projection.center.lat) * this.projection.mPerDegLat,
    ];
  }

  /** Fixed-step tick. `dtReal` is real seconds; sim time is scaled. */
  tick(dtReal: number) {
    if (this.paused || this.phase === "idle" || this.phase === "error" || this.phase === "complete") return;
    const dt = Math.min(0.06, dtReal) * this.speedMult;
    this.t += dt;
    this.traffic.tick(dt);
    this.updateSignals(dt);
    if (this.phase === "pickup") {
      this.pickupTimer -= dt;
      this.metrics.pickupDuration = settings.pickupDurationS;
      if (this.pickupTimer <= 0) this.startHospitalLeg();
    } else if (this.ambulance && this.currentRoute) {
      this.moveAmbulance(dt);
      this.maybeRecalculate();
    }
    this.syncLive();
  }

  private updateSignals(dt: number) {
    if (!this.ambulance || !this.currentRoute) {
      for (const s of this.signals.states.values()) {
        if (s.priority === "none") {
          s.tInPhase += dt;
          if (s.phase === "green" && s.tInPhase >= signalSettings.greenS) { s.phase = "yellow"; s.tInPhase = 0; }
          else if (s.phase === "yellow" && s.tInPhase >= signalSettings.yellowS) { s.phase = "allred"; s.tInPhase = 0; }
          else if (s.phase === "allred" && s.tInPhase >= signalSettings.allRedS) { s.phase = "green"; s.greenAxis = s.greenAxis === 0 ? 1 : 0; s.tInPhase = 0; }
        }
      }
      return;
    }
    // upcoming route intersections
    const approaching: { nodeId: number; distanceM: number; axis: 0 | 1; passed: boolean }[] = [];
    let d = this.currentRoute.length !== 0 ? this.edgeLen(this.ambulance) - this.ambulance.edgePos : 0;
    let prevNode = this.ambulance.nodeId;
    for (let i = this.ambulance.routeIdx; i < this.currentRoute.edgeIds.length; i++) {
      const e = this.graph.edgesById.get(this.currentRoute.edgeIds[i])!;
      if (i > this.ambulance.routeIdx) d += e.length;
      const n = this.graph.nodesById.get(e.to)!;
      if (n.signalized) {
        approaching.push({
          nodeId: n.id,
          distanceM: d,
          axis: this.signals.arrivalAxis(n.id, prevNode),
          passed: false,
        });
      }
      prevNode = e.to;
      if (approaching.length >= 3) break;
    }
    // signals already passed on this route: tell controller to restore
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
    this.signals.update(dt, approaching);
  }

  private edgeLen(a: AmbulanceState): number {
    return a.edgeId !== null ? this.graph.edgesById.get(a.edgeId)!.length : 0;
  }

  private moveAmbulance(dt: number) {
    const a = this.ambulance!;
    const route = this.currentRoute!;
    if (a.routeIdx >= route.edgeIds.length) {
      this.arrive();
      return;
    }
    const e = this.graph.edgesById.get(route.edgeIds[a.routeIdx])!;
    const nextNode = e.to;
    const nn = this.graph.nodesById.get(nextNode)!;
    // signal check at the intersection we are approaching
    if (nn.signalized && a.edgePos >= e.length - 2.5) {
      const axis = this.signals.arrivalAxis(nextNode, a.nodeId);
      if (!this.signals.canPass(nextNode, axis)) {
        a.waiting = true;
        a.speed = 0;
        this.legMetrics.signalWaitTime += dt;
        return;
      }
    }
    a.waiting = false;
    // blocked by a vehicle directly ahead? slow down (basic separation)
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
      a.nodeId = nextNode;
      a.edgePos = 0;
      a.routeIdx++;
      if (a.routeIdx >= route.edgeIds.length) {
        this.arrive();
        return;
      }
      const ne = this.graph.edgesById.get(route.edgeIds[a.routeIdx])!;
      a.edgeId = ne.id;
    } else {
      a.edgeId = e.id;
    }
    // world position: lerp along current edge
    const from = this.graph.nodesById.get(a.nodeId)!;
    const to = this.graph.nodesById.get(this.graph.edgesById.get(a.edgeId!)!.to)!;
    const l = this.graph.edgesById.get(a.edgeId!)!.length;
    const f = Math.min(1, a.edgePos / Math.max(l, 0.001));
    a.x = from.x + (to.x - from.x) * f;
    a.y = from.y + (to.y - from.y) * f;
  }

  private maybeRecalculate() {
    if (!this.currentRoute || !this.ambulance) return;
    const dest = this.leg === "to-patient" ? this.patientNode : this.hospitalNode;
    if (this.t - this.lastRecalcT < settings.recalcIntervalS) return;
    this.lastRecalcT = this.t;
    if (shouldRecalculate(this.graph, this.currentRoute, this.ambulance.routeIdx, this.ambulance.nodeId, dest)) {
      const prev = this.currentRoute;
      const replanned = planRoutePpo(this.rc, this.ambulance.nodeId, dest, settings.seed + Math.floor(this.t));
      this.currentRoute = replanned;
      this.ambulance.route = replanned;
      this.ambulance.routeIdx = 0;
      this.ambulance.edgeId = replanned.edgeIds[0] ?? null;
      this.ambulance.edgePos = 0;
      this.legMetrics.recalcs++;
      for (const n of replanned.nodePath) {
        if (this.graph.nodesById.get(n)!.signalized) this.relevantIntersections.add(n);
      }
      this.log("route", `Route recalculated (traffic change): ${replanned.length.toFixed(0)} m, ETA ${replanned.estimatedTime.toFixed(0)} s — ${modeLabel(replanned.mode)}`);
      void prev;
    }
  }

  private arrive() {
    const a = this.ambulance!;
    if (this.leg === "to-patient") {
      const pn = this.graph.nodesById.get(this.patientNode)!;
      a.x = pn.x;
      a.y = pn.y;
      a.speed = 0;
      a.waiting = false;
      this.metrics.responseTime = this.t - this.tDispatch;
      this.metrics.legs.toPatient = { ...this.legMetrics, travelTime: this.metrics.responseTime, ppoSteps: this.currentRoute?.steps ?? 0 };
      this.log("patient", `Ambulance reached the patient. Response time ${(this.metrics.responseTime).toFixed(1)} s — simulated pickup starting (${settings.pickupDurationS} s, NOT a real pickup)`);
      this.phase = "pickup";
      this.pickupTimer = settings.pickupDurationS;
      this.emitArrival();
    } else {
      const hn = this.graph.nodesById.get(this.hospitalNode)!;
      a.x = hn.x;
      a.y = hn.y;
      a.speed = 0;
      this.metrics.transportTime = this.t - this.tDispatch - this.metrics.responseTime - this.metrics.pickupDuration;
      this.metrics.legs.toHospital = { ...this.legMetrics, travelTime: this.metrics.transportTime, ppoSteps: this.currentRoute?.steps ?? 0 };
      this.metrics.totalTime = this.t - this.tDispatch;
      this.metrics.signalRequests = this.signals.requests;
      this.metrics.signalActivations = this.signals.activations;
      this.metrics.signalRestorations = this.signals.restorations;
      this.metrics.relevantIntersections = this.relevantIntersections.size;
      this.phase = "complete";
      this.log("hospital", `Ambulance arrived at ${this.hospitalCand?.name}. Total journey ${this.metrics.totalTime.toFixed(1)} s, distance ${this.routeDistanceTraveled.toFixed(0)} m. Simulation complete.`);
      this.emitArrival();
    }
  }

  private startHospitalLeg() {
    this.log("patient", "Patient aboard (simulated). Routing to selected hospital…");
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
    this.log("route", `Hospital route planned: ${leg2.length.toFixed(0)} m, ETA ${leg2.estimatedTime.toFixed(0)} s — mode: ${modeLabel(leg2.mode)}${leg2.fallbackReason ? ` (fallback: ${leg2.fallbackReason})` : ""}`);
  }

  private emitArrival() {
    for (const cb of this.arrivalHandlers) cb(this.phase);
  }

  /** Push a snapshot into the shared live frame (read by both 3D views). */
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
    if (a && route) {
      const dest = this.leg === "to-patient" ? this.patientNode : this.hospitalNode;
      const dn = this.graph.nodesById.get(dest)!;
      const remaining = routeLength(this.graph, route.edgeIds.slice(a.routeIdx)) - a.edgePos;
      const v = Math.max(a.speed, 6);
      const eta = remaining / v;
      if (this.leg === "to-patient") etaPatient = eta;
      else etaHospital = eta;
      void dn;
    }
    let signalStatus = "—";
    let priorityStatus = "—";
    if (a && route && a.edgeId !== null) {
      const next = this.nextSignalNode();
      if (next) {
        const s = this.signals.states.get(next.nodeId);
        signalStatus = s ? `${s.phase} (axis ${s.greenAxis === 0 ? "N-S" : "E-W"} green)` : "unsignalized";
        priorityStatus = s?.priority === "none" ? "normal" : s ? `EMERGENCY ${s.priority}` : "—";
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
      distanceTraveled: this.routeDistanceTraveled,
      signalStatus,
      priorityStatus,
      progressPct,
      routingMode: route ? modeLabel(route.mode) : "—",
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
    const [x, y] = this.latLngToXY(this.patient ?? { lat: 0, lng: 0 });
    return { x, y };
  }

  hospitalXY(): { x: number; y: number } | null {
    if (!this.hospitalCand) return null;
    return {
      x: (this.hospitalCand.lng - this.projection.center.lng) * this.projection.mPerDegLng,
      y: (this.hospitalCand.lat - this.projection.center.lat) * this.projection.mPerDegLat,
    };
  }

  depotXY(): { x: number; y: number } | null {
    if (!this.graph || this.depotNode === 0 && !this.ambulance) return null;
    const n = this.graph.nodesById.get(this.depotNode);
    return n ? { x: n.x, y: n.y } : null;
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
    dispatchDelay: 0,
    responseTime: 0,
    pickupDuration: 0,
    transportTime: 0,
    totalTime: 0,
    legs: { toPatient: null, toHospital: null },
    signalRequests: 0,
    signalActivations: 0,
    signalRestorations: 0,
    relevantIntersections: 0,
    ppoEpisodes: 0,
    ppoRewardCurve: [],
    baseline: null,
  };
}

export function emptyLeg(): LegMetrics {
  return { distance: 0, travelTime: 0, estimatedTime: 0, signalWaitTime: 0, recalcs: 0, invalidActions: 0, ppoSteps: 0 };
}

/** singleton accessor */
let _controller: SimulationController | null = null;
export function getController(): SimulationController {
  if (!_controller) _controller = new SimulationController();
  return _controller;
}

void haversineM;
void dist;
void edgeTravelTime;
