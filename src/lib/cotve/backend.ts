import { create } from "zustand";

/** The Python (FastAPI) service that owns the CityFlow engine.
 *  Override with VITE_COTVE_BACKEND if it is not on localhost:8000. */
export const BACKEND_URL: string =
  (import.meta.env.VITE_COTVE_BACKEND as string | undefined) ?? "http://127.0.0.1:8000";
const WS_URL = BACKEND_URL.replace(/^http/, "ws") + "/ws";

const M_PER_DEG_LAT = 111_320;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface FlowRoad {
  id: string;
  points: [number, number][]; // [lat, lng]
  m: [number, number][]; // world metres
  group: string;
  lanes: number;
  length: number;
  speed: number;
}

export interface FlowIntersection {
  id: string;
  lat: number;
  lng: number;
  x: number;
  y: number;
  signal: boolean;
}

export interface FlowFacility {
  id: string;
  name: string;
  x: number;
  y: number;
  lat: number;
  lng: number;
  specialties?: string[];
}

export interface FlowAccident {
  id: string;
  lat: number;
  lng: number;
  x: number;
  y: number;
  road: string;
  dist: number;
  severity: string;
  emergency: string;
  status: string;
  ambulance: string | null;
  hospital: string | null;
  reportedT: number;
  ambulanceArrivedT: number | null;
  pickupT: number | null;
  hospitalArrivedT: number | null;
  patient: string;
}

export interface FlowScenario {
  name: string;
  interval: number;
  origin: LatLng;
  bounds: [
    [number, number],
    [number, number],
  ];
  roads: FlowRoad[];
  intersections: FlowIntersection[];
  hospitals: FlowFacility[];
  depots: FlowFacility[];
  ambulances: { id: string; color: string; depot: string; status: string }[];
  accidents: FlowAccident[];
  params: Record<string, number | string | null>;
}

export interface FlowAmbulance {
  id: string;
  color: string;
  status: string;
  road: string | null;
  x: number | null;
  y: number | null;
  h: number | null;
  speed: number;
  speedKmh: number;
  eta: number | null;
  accident: string | null;
  hospital: string | null;
  method: string;
  fallback: boolean;
  error: string | null;
  dispatchT: number | null;
  arrivedT: number | null;
  pickupT: number | null;
  hospitalT: number | null;
  colorLabel: string;
}

export interface FlowFrame {
  sim: {
    engine: string;
    step: number;
    time: number;
    interval: number;
    paused: boolean;
    running: boolean;
    speed: number;
    scenario: string;
  };
  stats: {
    totalVehicles: number;
    ambulances: number;
    accidents: number;
    hospitals: number;
    density: number;
    avgSpeed: number;
    avgSpeedKmh: number;
    stopped: number;
    avgWaiting: number;
  };
  vehicles: { x: number; y: number; h: number; k: string; s: number }[];
  ambulanceVehicles: { x: number; y: number; h: number; s: number; id: string }[];
  ambulances: FlowAmbulance[];
  routes: {
    id: string;
    color: string;
    status: string;
    points: [number, number][];
    eta: number | null;
    hospital?: string | null;
    accident?: string | null;
  }[];
  signals: {
    id: string;
    x: number;
    y: number;
    phase: number;
    nPhases: number;
    phaseProgress: number;
    priority: boolean;
    heldBy: string | null;
    approaches: Record<string, string>;
  }[];
  accidents: FlowAccident[];
  hospitals: FlowFacility[];
  events: { t: number; kind: string; message: string }[];
  gnn: Record<string, number | string | null>;
  ppo: Record<string, number | string | null>;
  training: Record<string, number | string | null> | null;
}

export interface EvalResult {
  ok: boolean;
  scenario: Record<string, unknown>;
  accident: [number, number];
  scenarios: [number, number][];
  methods: Record<string, string>;
  definitions: Record<string, string>;
  results: {
    method: string;
    label: string;
    ok: boolean;
    runs: number;
    runsOk: number;
    fallback: boolean;
    error: string | null;
    metrics: Record<string, number | null>;
    perRun: {
      ok: boolean;
      fallback: boolean;
      error: string | null;
      metrics: Record<string, number | null>;
      steps: number;
    }[];
  }[];
  wallMs: number;
}

export type Transport = "connecting" | "ws" | "poll" | "offline";

interface FlowState {
  transport: Transport;
  scenario: FlowScenario | null;
  frame: FlowFrame | null;
  simError: string | null;
  /** last backend error surfaced to the UI (dispatch/train/eval failures) */
  actionError: string | null;
  connecting: boolean;
  evaluation: EvalResult | null;
  evaluating: boolean;
  set: (p: Partial<FlowState>) => void;
}

export const useFlowStore = create<FlowState>((set) => ({
  transport: "connecting",
  scenario: null,
  frame: null,
  simError: null,
  actionError: null,
  connecting: false,
  evaluation: null,
  evaluating: false,
  set: (p) => set(p),
}));

/* --------------------------------------------------------------------- */
/* transport                                                              */
/* --------------------------------------------------------------------- */

async function request<T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
      else if (typeof body?.error === "string") detail = body.error;
    } catch {
      /* body was not json - keep the status line */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; cityflow: boolean; session: boolean }>("/api/health"),
  scenario: () => request<FlowScenario>("/api/scenario"),
  state: () => request<FlowFrame>("/api/state"),
  control: (action: string, value?: number) =>
    request<{ ok: boolean; sim?: FlowFrame["sim"]; error?: string }>("/api/sim", {
      method: "POST",
      body: JSON.stringify(value == null ? { action } : { action, value }),
    }),
  addAccident: (body: {
    lat?: number;
    lng?: number;
    severity?: string;
    emergency?: string;
  }) =>
    request<{ ok: boolean; accident?: FlowAccident; error?: string }>("/api/accidents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  removeAccident: (id: string) =>
    request<{ ok: boolean; error?: string }>(`/api/accidents/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  dispatch: (accidentId: string, ambulanceId?: string, method = "ppo") =>
    request<{
      ok: boolean;
      ambulance?: string;
      eta?: number;
      info?: Record<string, unknown>;
      candidates?: { ambulance: string; eta: number }[];
      error?: string;
    }>("/api/dispatch", {
      method: "POST",
      body: JSON.stringify({ accidentId, ambulanceId, method }),
    }),
  train: (episodes = 60) =>
    request<Record<string, number>>(`/api/train?episodes=${episodes}`, { method: "POST" }),
  evaluate: (body: { runs?: number; emergency?: string; methods?: string[] }) =>
    request<EvalResult>("/api/evaluation", { method: "POST", body: JSON.stringify(body) }, 180_000),
};

/* --------------------------------------------------------------------- */
/* helpers                                                                */
/* --------------------------------------------------------------------- */

/** World metres -> [lat, lng], matching backend/cotve/roadnet.py GeoTransform. */
export function projector(origin: LatLng) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return (x: number, y: number): [number, number] => [
    origin.lat + y / M_PER_DEG_LAT,
    origin.lng + x / mPerDegLng,
  ];
}

/** [lat, lng] -> world metres. */
export function unprojector(origin: LatLng) {
  const mPerDegLng = M_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return (lat: number, lng: number): [number, number] => [
    (lng - origin.lng) * mPerDegLng,
    (lat - origin.lat) * M_PER_DEG_LAT,
  ];
}

export function clockTime(t: number): string {
  const total = Math.max(0, Math.floor(t));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/* --------------------------------------------------------------------- */
/* connection manager: WebSocket first, plain polling as the fallback     */
/* --------------------------------------------------------------------- */

let socket: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

function setStore(p: Partial<FlowState>) {
  useFlowStore.getState().set(p);
}

async function pollOnce() {
  try {
    const frame = await api.state();
    setStore({ frame, simError: null, transport: "poll" });
  } catch (err) {
    setStore({ simError: (err as Error).message, transport: "offline" });
  }
}

function startPolling() {
  if (pollTimer) return;
  void pollOnce();
  pollTimer = setInterval(() => void pollOnce(), 400);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function connectSocket() {
  if (stopped) return;
  try {
    socket = new WebSocket(`${WS_URL}?hz=5`);
  } catch {
    startPolling();
    return;
  }
  socket.onopen = () => {
    setStore({ transport: "ws", simError: null });
    stopPolling();
  };
  socket.onmessage = (ev) => {
    try {
      const frame = JSON.parse(ev.data as string) as FlowFrame;
      setStore({ frame, simError: null });
    } catch {
      /* ignore a malformed frame */
    }
  };
  socket.onerror = () => {
    socket?.close();
  };
  socket.onclose = () => {
    socket = null;
    if (stopped) return;
    // sockets can be blocked by the browser/dev-server proxy - poll instead
    setStore({ transport: "poll" });
    startPolling();
    reconnectTimer = setTimeout(() => void connectSocket(), 6000);
  };
}

/** Start following the backend. Returns a cleanup that disconnects. */
export function startBackend(): () => void {
  stopped = false;
  setStore({ transport: "connecting" });
  const bootstrap = async () => {
    try {
      await api.health();
      const scenario = await api.scenario();
      setStore({ scenario, transport: "ws" });
      connectSocket();
    } catch (err) {
      setStore({ transport: "offline", simError: (err as Error).message });
      reconnectTimer = setTimeout(() => void bootstrap(), 3000);
    }
  };
  void bootstrap();
  return () => {
    stopped = true;
    socket?.close();
    socket = null;
    stopPolling();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
}

/** Ask the backend again for the scenario (after a scenario reset). */
export async function refreshScenario(): Promise<void> {
  try {
    setStore({ scenario: await api.scenario() });
  } catch (err) {
    setStore({ simError: (err as Error).message });
  }
}
