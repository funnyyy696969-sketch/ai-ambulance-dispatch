/** CoTV-E core types. All positions are in local meters (equirectangular
 * projection around the map center); lat/lng kept for map display. */

export type LatLng = { lat: number; lng: number };

export type NetworkSource = "osm" | "demo-grid";

export interface RoadNode {
  id: number;
  x: number; // local meters, east
  y: number; // local meters, north
  lat: number;
  lng: number;
  /** in/out degree (undirected view) */
  degree: number;
  /** true if this intersection is managed by a traffic signal */
  signalized: boolean;
  /** 0 = NS axis, 1 = EW axis (assigned by signal controller) */
  signalAxes?: [number[], number[]];
}

export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  length: number; // meters
  highwayType: string;
  speedLimit: number; // m/s
  baseTravelTime: number; // seconds, length / speedLimit
  oneway: boolean;
  /** dynamic congestion 0..1 (updated by traffic simulation) */
  density: number;
}

export interface RoadGraph {
  source: NetworkSource;
  center: LatLng;
  nodes: RoadNode[];
  nodesById: Map<number, RoadNode>;
  /** directed adjacency: node id -> outgoing edge ids */
  out: Map<number, number[]>;
  edges: RoadEdge[];
  edgesById: Map<number, RoadEdge>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

export type EmergencyKind =
  | "cardiac"
  | "stroke"
  | "trauma"
  | "respiratory"
  | "bleeding"
  | "general";

export interface HospitalCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  osmType: "node" | "way" | "relation";
  tags: Record<string, string>;
  /** derived, honestly-labeled fields */
  hasEmergencyTag: boolean | "unknown";
  specialties: string[]; // verified from tags only, may be empty
  dataCompleteness: number; // 0..1 based on tag presence
  demo: boolean; // true when generated demonstration data
  scores?: HospitalScores;
}

export interface HospitalScores {
  roadTravelTime: number; // seconds, ambulance->hospital (A* estimate)
  roadDistance: number; // meters
  specialtyMatch: number; // 0..1
  emergencyBonus: number; // 0..1
  completeness: number; // 0..1
  total: number; // weighted sum
  notes: string[];
}

export type RoutingMode =
  | "ppo"
  | "ppo-quicktrained"
  | "fallback-astar"
  | "dijkstra"
  | "astar";

export interface PlannedRoute {
  nodePath: number[];
  edgeIds: number[];
  length: number; // meters
  estimatedTime: number; // seconds (with congestion)
  mode: RoutingMode;
  /** populated when PPO failed and the fallback produced the route */
  fallbackReason?: string;
  invalidActionCount: number;
  steps: number;
}

export type SignalPhase = "green" | "yellow" | "allred";

export interface SignalState {
  nodeId: number;
  greenAxis: 0 | 1;
  phase: SignalPhase;
  tInPhase: number;
  /** emergency priority state machine */
  priority: "none" | "transition" | "holding" | "restoring";
  priorityAxis: 0 | 1 | null;
  /** last time (sim seconds) priority was used, for restoration bookkeeping */
  passedAt: number | null;
}

export type SimPhase =
  | "idle"
  | "dispatching"
  | "to-patient"
  | "pickup"
  | "to-hospital"
  | "complete"
  | "error";

export interface VehicleState {
  id: number;
  edgeId: number;
  pos: number; // meters along edge
  speed: number;
  color: number;
}

export interface AmbulanceState {
  nodeId: number; // current from-node
  edgeId: number | null;
  edgePos: number;
  x: number;
  y: number;
  speed: number;
  waiting: boolean;
  route: PlannedRoute | null;
  routeIdx: number; // index into route.edgeIds
}

export interface SimEvent {
  t: number; // sim time
  kind: string;
  message: string;
}

export interface LegMetrics {
  distance: number;
  travelTime: number; // actual simulated seconds
  estimatedTime: number; // planned estimate
  signalWaitTime: number;
  recalcs: number;
  invalidActions: number;
  ppoSteps: number;
}

export interface TripMetrics {
  dispatchDelay: number; // planning time (wall seconds)
  responseTime: number; // ambulance -> patient
  pickupDuration: number;
  transportTime: number; // patient -> hospital
  totalTime: number;
  legs: { toPatient: LegMetrics | null; toHospital: LegMetrics | null };
  signalRequests: number;
  signalActivations: number;
  signalRestorations: number;
  relevantIntersections: number;
  ppoEpisodes: number;
  ppoRewardCurve: number[];
  baseline: {
    dijkstraTime: number | null;
    astarTime: number | null;
    dijkstraDistance: number | null;
    astarDistance: number | null;
  } | null;
}

export interface LiveFrame {
  t: number;
  phase: SimPhase;
  ambulance: AmbulanceState | null;
  vehicles: VehicleState[];
  signals: Map<number, SignalState>;
  routeEdgeIds: number[];
  pickupTimer: number;
}
