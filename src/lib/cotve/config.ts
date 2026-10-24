import type { Criticality } from "./types";

/** CoTV-E configuration.
 *
 * The original prompt specified YAML config files. In this web port the same
 * configuration lives in typed TS modules (the browser cannot read arbitrary
 * YAML at runtime without shipping a parser); the schema is identical in
 * spirit: settings / emergency rules / traffic settings.
 */

export const settings = {
  /** radius (m) around the patient used to build the road network */
  networkRadiusM: 900,
  /** max road-network nodes before falling back to the demo grid */
  maxOsmNodes: 600,
  /** max distance (m) a selected patient/hospital point may be from a road
   * before the app asks the user to choose another location */
  maxSnapM: 120,
  /** demo grid size (nodes per side) when OSM is unavailable */
  demoGridSize: 9,
  demoGridSpacingM: 130,
  /** default speed by highway type (m/s) when maxspeed tag missing */
  defaultSpeeds: {
    motorway: 27,
    trunk: 22,
    primary: 16,
    secondary: 13,
    tertiary: 11,
    residential: 8,
    unclassified: 8,
    living_street: 6,
    service: 5,
    demo: 12,
  } as Record<string, number>,
  hospitalSearchRadiusM: 6000,
  /** simulated patient pickup duration (s) */
  pickupDurationS: 8,
  /** route recalculated when A* on live traffic beats it by this ratio */
  recalcImprovementRatio: 1.2,
  recalcIntervalS: 8,
  /** PPO quick-train budget (wall-clock ms) during dispatch */
  ppoTrainBudgetMs: 1800,
  ppoEpisodesPerBatch: 6,
  ppoMaxStepsPerEpisode: 260,
  /** abandon PPO and fall back to A* after this many steps relative to A* path */
  ppoStepFactorBeforeFallback: 5,
  seed: 42,
} as const;

/** Emergency type -> verified-tag keywords used for hospital specialty
 * matching. Only explicit OSM tags count as "verified"; absence is treated
 * as unknown, never as confirmed capability. */
export type EmergencyKindLabel =
  | "cardiac"
  | "stroke"
  | "trauma"
  | "bleeding"
  | "respiratory"
  | "general";

export const emergencyRules: Record<
  EmergencyKindLabel,
  { label: string; keywords: string[]; tagKeys: string[] }
> = {
  cardiac: {
    label: "Cardiac / heart emergency",
    keywords: ["cardio", "cardi", "heart"],
    tagKeys: ["healthcare:specialty", "speciality", "medical", "healthcare"],
  },
  stroke: {
    label: "Stroke",
    keywords: ["stroke", "neuro", "brain"],
    tagKeys: ["healthcare:specialty", "speciality", "medical", "healthcare"],
  },
  trauma: {
    label: "Accident / trauma",
    keywords: ["trauma", "traumatology", "surgical", "orthoped", "accident"],
    tagKeys: ["healthcare:specialty", "speciality", "medical", "healthcare", "emergency"],
  },
  bleeding: {
    label: "Severe bleeding",
    keywords: ["trauma", "surgical", "blood", "emergency"],
    tagKeys: ["healthcare:specialty", "speciality", "medical", "healthcare", "emergency"],
  },
  respiratory: {
    label: "Respiratory emergency",
    keywords: ["pulmo", "respir", "lung", "thorax"],
    tagKeys: ["healthcare:specialty", "speciality", "medical", "healthcare"],
  },
  general: {
    label: "General emergency",
    keywords: [],
    tagKeys: [],
  },
};

export const emergencyOptions: { value: EmergencyKindLabel; label: string }[] =
  (Object.keys(emergencyRules) as EmergencyKindLabel[]).map((k) => ({
    value: k,
    label: emergencyRules[k].label,
  }));

/** ---------------- Critical emergency classification ----------------
 * A documented, configurable keyword policy — NOT a clinical diagnosis.
 * A free-text emergency is classified as:
 *   critical     — matches a documented critical keyword phrase
 *   non-critical — matches a documented minor phrase
 *   uncertain    — no documented match; NEVER silently upgraded to critical
 * The escalation policy below is configurable and shown in the UI. */
export const criticalityConfig = {
  /** when true, "uncertain" emergencies are treated as critical for
   * dispatch priority (configurable escalation policy) */
  uncertainAsCritical: false,
  /** simulated pickup duration differences per class */
  pickupDurationCriticalS: 8,
  pickupDurationNonCriticalS: 14,
};

export const criticalityRules: { label: string; criticality: "critical" | "non-critical"; keywords: string[] }[] = [
  { label: "severe road accident", criticality: "critical", keywords: ["severe accident", "severe road accident", "major accident", "major road accident", "serious accident", "multi-vehicle", "collision", "crash"] },
  { label: "cardiac emergency", criticality: "critical", keywords: ["heart emergency", "heart attack", "cardiac arrest", "cardiac", "chest pain"] },
  { label: "stroke", criticality: "critical", keywords: ["stroke", "face droop", "slurred speech"] },
  { label: "major injury / severe bleeding", criticality: "critical", keywords: ["major injury", "severe bleeding", "heavy bleeding", "hemorrh", "haemorrh", "unconscious", "not breathing"] },
  { label: "severe respiratory distress", criticality: "critical", keywords: ["severe breath", "can't breathe", "cannot breathe", "respiratory distress", "choking", "drowning"] },
  { label: "minor injury", criticality: "non-critical", keywords: ["minor injury", "sprain", "small cut", "bruise", "minor cut"] },
  { label: "non-urgent illness", criticality: "non-critical", keywords: ["fever", "cold", "cough", "headache", "nausea", "sore throat"] },
];

export function classifyCriticality(text: string): { criticality: Criticality; matchedRule: string | null; notes: string } {
  const s = text.toLowerCase();
  for (const r of criticalityRules) {
    if (r.keywords.some((k) => s.includes(k))) {
      return {
        criticality: r.criticality,
        matchedRule: r.label,
        notes: `matched configured ${r.criticality} rule "${r.label}" — keyword policy, not a clinical diagnosis`,
      };
    }
  }
  return {
    criticality: "uncertain",
    matchedRule: null,
    notes: "no configured criticality rule matched — priority stays OFF unless escalation is enabled",
  };
}

export const trafficSettings = {
  /** number of simulated background vehicles */
  vehicleCount: 44,
  vehicleMaxSpeed: 11, // m/s
  /** congestion growth per vehicle on an edge (per direction) */
  densityPerVehicle: 0.14,
  minSpeedFactor: 0.18, // speed floor at full congestion
  /** how fast ambient congestion drifts (0..1 per sim minute) */
  ambientDriftPerMin: 0.05,
  /** ambulance speed multiplier over the speed limit */
  ambulanceSpeedFactor: 1.15,
  ambulanceMaxSpeed: 16,
  /** spacing for simple car-following (m) */
  minGapM: 7,
} as const;

export const signalSettings = {
  greenS: 9,
  yellowS: 3,
  allRedS: 1.2,
  /** distance (m) from intersection at which emergency priority is requested */
  priorityApproachM: 170,
  /** min green hold while the ambulance approaches (s) */
  priorityMinGreenS: 6,
  /** ambulance is considered "past" the intersection this far after passing (m) */
  passedThresholdM: 12,
} as const;

/** Mulberry32 seeded RNG — reproducible scenarios. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
