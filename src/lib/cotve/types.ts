/** CoTV-E core types. All positions are in local meters (equirectangular
 * projection around the map center); lat/lng kept for map display.
 *
 * Routing-correctness upgrade: edges carry their REAL OSM geometry as a
 * polyline, junctions are the only graph nodes, and graphs carry turn
 * restrictions + blockage state. */

export type LatLng = { lat: number; lng: number };

export type NetworkSource = "osm" | "demo-grid";

export interface LocalPt {
  x: number;
  y: number;
}

export interface RoadNode {
  id: number;
  x: number; // local meters, east
  y: number; // local meters, north
  lat: number;
  lng: number;
  degree: number;
  signalized: boolean;
  signalSource?: "osm" | "inferred" | "demo";
  /** incident outgoing edge ids split into two axes (NS=0, EW=1) */
  signalAxes?: [number[], number[]];
  /** synthetic road-access node inserted for patient/hospital/depot */
  isAccess?: boolean;
  accessLabel?: string;
}

export interface RoadEdge {
  id: number;
  from: number;
  to: number;
  length: number; // meters, measured along geom
  highwayType: string;
  speedLimit: number; // m/s
  baseTravelTime: number; // seconds
  oneway: boolean;
  /** dynamic congestion 0..1 (updated by traffic simulation) */
  density: number;
  /** REAL road geometry: polyline in local meters, endpoints inclusive */
  geom: LocalPt[];
  /** cumulative arc lengths of geom points (geom[0] = 0) */
  cum: number[];
  /** originating OSM way id (turn restrictions + provenance) */
  wayId: number;
  /** available OSM lanes tag, if any */
  lanes: number | null;
  /** blocked in the current simulation (accident / closure) */
  blocked: boolean;
}

export interface TurnRestriction {
  fromWay: number;
  toWay: number;
  restriction: string; // e.g. no_left_turn, no_straight_on, no_u_turn
}

export interface RoadGraph {
  source: NetworkSource;
  center: LatLng;
  nodes: RoadNode[];
  nodesById: Map<number, RoadNode>;
  out: Map<number, number[]>;
  edges: RoadEdge[];
  edgesById: Map<number, RoadEdge>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** real OSM turn restrictions keyed by the junction (via) node id */
  turnRestrictions: Map<number, TurnRestriction[]>;
  /** OSM-verified signal coordinate keys (diagnostics) */
  signalNodeCount: number;
  /** dropped during construction (disconnected / invalid) */
  droppedNodes: number;
  droppedEdges: number;
}

/** Result of snapping a geographical point onto the road network. */
export interface RoadSnap {
  edgeId: number;
  /** arc position along the edge polyline where the snap point lies */
  arcPos: number;
  x: number;
  y: number;
  lat: number;
  lng: number;
  /** distance from the originally selected point to the road, meters */
  distanceM: number;
}

export type NetworkValidationIssue = {
  severity: "error" | "warning";
  kind: string;
  detail: string;
};

export interface NetworkValidation {
  ok: boolean;
  nodes: number;
  edges: number;
  components: number;
  isolatedNodes: number;
  invalidLengths: number;
  missingGeometry: number;
  droppedNodes: number;
  droppedEdges: number;
  turnRestrictions: number;
  issues: NetworkValidationIssue[];
}

export type EmergencyKind =
  | "cardiac"
  | "stroke"
  | "trauma"
  | "respiratory"
  | "bleeding"
  | "general";

export type Criticality = "critical" | "non-critical" | "uncertain";

export interface Classification {
  criticality: Criticality;
  matchedRule: string | null;
  notes: string;
}

export interface HospitalCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  osmType: "node" | "way" | "relation";
  tags: Record<string, string>;
  hasEmergencyTag: boolean | "unknown";
  specialties: string[]; // verified from tags only
  dataCompleteness: number;
  demo: boolean;
  scores?: HospitalScores;
  /** road-access point on the network (set during dispatch) */
  access?: RoadSnap | null;
}

export interface HospitalScores {
  roadTravelTime: number;
  roadDistance: number;
  specialtyMatch: number;
  emergencyBonus: number;
  completeness: number;
  total: number;
  notes: string[];
}

export type RoutingMode = "ppo" | "ppo-quicktrained" | "fallback-astar" | "dijkstra" | "astar";

export interface PlannedRoute {
  nodePath: number[];
  edgeIds: number[];
  length: number;
  estimatedTime: number;
  mode: RoutingMode;
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
  priority: "none" | "transition" | "holding" | "restoring";
  priorityAxis: 0 | 1 | null;
  passedAt: number | null;
  /** false for non-critical emergencies — the controller never preempts */
  priorityEnabled: boolean;
}

export type SimPhase =
  | "idle"
  | "dispatching"
  | "to-patient"
  | "pickup"
  | "to-hospital"
  | "complete"
  | "error";

export type VehicleKind = "car" | "two-wheeler" | "auto" | "bus" | "truck";

export interface VehicleState {
  id: number;
  edgeId: number;
  pos: number;
  speed: number;
  color: number;
  kind: VehicleKind;
}

/** A real OSM building footprint projected into local meters. The ring is a
 * closed polygon (first point not repeated); `heightSource` distinguishes a
 * measured OSM height from a documented estimate. */
export interface BuildingFootprint {
  id: string;
  ring: LocalPt[];
  height: number;
  heightSource: "osm" | "estimated";
  /** OSM building tag value (e.g. "residential", "commercial") */
  kind: string;
  /** palette index used for controlled colourful rendering */
  colorIdx: number;
}

export interface AmbulanceState {
  nodeId: number; // junction the ambulance is currently on or leaving
  edgeId: number | null;
  edgePos: number; // arc position along edge geometry
  x: number;
  y: number;
  /** heading in radians (world: x east, y north) */
  heading: number;
  speed: number;
  waiting: boolean;
  route: PlannedRoute | null;
  routeIdx: number;
}

export interface SimEvent {
  t: number;
  kind: string;
  message: string;
}

export interface LegMetrics {
  distance: number;
  travelTime: number;
  estimatedTime: number;
  signalWaitTime: number;
  recalcs: number;
  invalidActions: number;
  ppoSteps: number;
}

export interface TripMetrics {
  dispatchDelay: number;
  responseTime: number;
  pickupDuration: number;
  transportTime: number;
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
  /** meters from the originally selected point to its road access point */
  patientAccessDistance: number;
  hospitalAccessDistance: number;
  /** accident blockage events during the trip */
  blockageEvents: number;
  reroutes: number;
  criticality: Criticality;
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

/** Real accident record loaded from a user-supplied verified CSV. */
export interface AccidentRecord {
  row: number;
  raw: string;
  date: string | null;
  lat: number | null;
  lng: number | null;
  severity: string | null;
  category: string | null;
  source: string;
  /** nearest road snap, or null when the record could not be mapped */
  snap: RoadSnap | null;
  status: "mapped" | "unmapped" | "invalid";
}

/** Clearly-labeled simulated accident (never presented as real). */
export interface SimulatedAccident {
  id: string;
  simulated: true;
  edgeId: number;
  severity: "major" | "severe";
  createdAt: number;
  label: string;
}
