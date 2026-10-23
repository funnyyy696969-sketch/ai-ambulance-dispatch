import { create } from "zustand";
import type {
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
  saved: boolean;
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
  saved: false,
  set: (p) => set(p),
}));
