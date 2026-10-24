import { create } from "zustand";
import type {
  Classification,
  HospitalCandidate,
  LatLng,
  NetworkSource,
  SimEvent,
  TripMetrics,
} from "./types";
import type { ControllerStatus } from "./simulation";
import type { QuickTrainResult } from "./ppo";

export interface UiState {
  patient: LatLng | null;
  emergencyText: string;
  networkSource: NetworkSource | null;
  networkInfo: string | null;
  hospitals: HospitalCandidate[];
  hospitalsLoading: boolean;
  hospitalsError: string | null;
  selectedHospital: HospitalCandidate | null;
  depotLatLng: LatLng | null;
  dispatching: boolean;
  status: ControllerStatus | null;
  metrics: TripMetrics | null;
  events: SimEvent[];
  training: QuickTrainResult | null;
  routeLatLngs: [number, number][];
  /** patient + hospital ROAD-ACCESS points (lat,lng) for map display */
  patientAccessLatLng: [number, number] | null;
  hospitalAccessLatLng: [number, number] | null;
  /** blocked road polylines (accident scenarios), geometry-true */
  blockedPolys: [number, number][][];
  /** criticality classification of the current emergency */
  classification: Classification | null;
  saved: boolean;
  /** true once a road network has been built (3D scene gate) */
  networkReady: boolean;
  /** bumped per dispatch so the 3D scene remounts on a fresh graph */
  simVersion: number;
  /** bumped when a road is blocked (accident) so renderers refresh */
  blockVersion: number;
  set: (p: Partial<UiState>) => void;
}

export const useSimStore = create<UiState>((set) => ({
  patient: null,
  emergencyText: "",
  networkSource: null,
  networkInfo: null,
  hospitals: [],
  hospitalsLoading: false,
  hospitalsError: null,
  selectedHospital: null,
  depotLatLng: null,
  dispatching: false,
  status: null,
  metrics: null,
  events: [],
  training: null,
  routeLatLngs: [],
  patientAccessLatLng: null,
  hospitalAccessLatLng: null,
  blockedPolys: [],
  classification: null,
  saved: false,
  networkReady: false,
  simVersion: 0,
  blockVersion: 0,
  set: (p) => set(p),
}));
