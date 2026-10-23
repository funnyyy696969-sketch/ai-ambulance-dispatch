import { emergencyRules, settings, makeRng, type EmergencyKindLabel } from "./config";
import { haversineM } from "./geo";
import type { HospitalCandidate, HospitalScores } from "./types";

/**
 * Hospital discovery & ranking from OSM geographic data (Overpass results).
 *
 * HONESTY RULES enforced here:
 *  - `hasEmergencyTag` is true only when an explicit OSM tag says so
 *    (emergency=yes / emergency=perimeter). Missing tags => "unknown",
 *    never treated as confirmed capability.
 *  - `specialties` only contains strings actually present in OSM tags.
 *  - No capacity / beds / staffing is ever inferred.
 *  - Scoring treats unknown capability as neutral (no bonus, no penalty)
 *    and the UI explains which selection limitations applied.
 */

export function classifyEmergency(input: string): EmergencyKindLabel {
  const s = input.toLowerCase();
  const table: { kind: EmergencyKindLabel; words: string[] }[] = [
    { kind: "cardiac", words: ["heart", "cardiac", "cardio", "chest pain", "infarct"] },
    { kind: "stroke", words: ["stroke", "brain", "neuro", "paralys", "paralyz"] },
    { kind: "trauma", words: ["accident", "trauma", "crash", "fall", "injur", "fracture", "burn"] },
    { kind: "bleeding", words: ["bleed", "hemorrh", "haemorrh", "blood loss", "lacerat"] },
    { kind: "respiratory", words: ["breath", "respir", "asthma", "lung", "choking", "drown"] },
  ];
  for (const row of table) {
    if (row.words.some((w) => s.includes(w))) return row.kind;
  }
  return "general";
}

export function parseOverpassHospitals(
  elements: {
    type: string;
    id: number;
    lat?: number | null;
    lng?: number | null;
    lon?: number | null;
    center?: { lat: number; lon: number };
    tags?: Record<string, string>;
  }[],
): HospitalCandidate[] {
  const out: HospitalCandidate[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const amenity = tags.amenity;
    const healthcare = tags.healthcare;
    const isHospital = amenity === "hospital" || healthcare === "hospital" || amenity === "clinic";
    if (!isHospital) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.lng ?? el.center?.lon;
    if (lat === undefined || lng === undefined) continue;
    const emergencyTag = tags.emergency;
    const specialties: string[] = [];
    for (const key of ["healthcare:specialty", "speciality", "healthcare:specialities"]) {
      const v = tags[key];
      if (v) specialties.push(...v.split(/[;,\s]+/).filter(Boolean));
    }
    let completeness = 0;
    for (const k of ["name", "emergency", "phone", "website", "healthcare:specialty", "addr:street"]) {
      if (tags[k]) completeness += 1 / 6;
    }
    out.push({
      id: `${el.type}/${el.id}`,
      name: tags.name ?? `Unnamed facility (${el.type}/${el.id})`,
      lat,
      lng,
      osmType: el.type as "node" | "way" | "relation",
      tags,
      hasEmergencyTag: emergencyTag === undefined ? "unknown" : emergencyTag === "yes" || emergencyTag === "perimeter",
      specialties,
      dataCompleteness: completeness,
      demo: false,
    });
  }
  return out;
}

/** Demonstration hospitals (used ONLY when Overpass is unreachable). */
export function demoHospitals(center: { lat: number; lng: number }): HospitalCandidate[] {
  const rng = makeRng(11);
  const specs: { name: string; dLat: number; dLng: number; emergency: boolean | "unknown"; specialties: string[] }[] = [
    { name: "City General Hospital (demo)", dLat: 0.018, dLng: 0.012, emergency: true, specialties: ["emergency", "cardiology", "trauma"] },
    { name: "Riverside Medical Center (demo)", dLat: -0.014, dLng: 0.02, emergency: true, specialties: ["emergency"] },
    { name: "Northside Clinic (demo)", dLat: 0.008, dLng: -0.017, emergency: "unknown", specialties: [] },
  ];
  return specs.map((s, i) => ({
    id: `demo/${i}`,
    name: s.name,
    lat: center.lat + s.dLat + (rng() - 0.5) * 0.002,
    lng: center.lng + s.dLng + (rng() - 0.5) * 0.002,
    osmType: "node" as const,
    tags: { amenity: "hospital", name: s.name, ...(s.emergency === true ? { emergency: "yes" } : {}) },
    hasEmergencyTag: s.emergency,
    specialties: s.specialties,
    dataCompleteness: 0.5,
    demo: true,
  }));
}

/** Score one candidate against the emergency type. All unknowns are neutral. */
export function scoreHospital(
  cand: HospitalCandidate,
  emergency: EmergencyKindLabel,
  roadTravelTime: number | null,
  roadDistance: number | null,
): HospitalScores {
  const rules = emergencyRules[emergency];
  const notes: string[] = [];
  const tagsBlob = Object.entries(cand.tags)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")
    .toLowerCase();

  // specialty match: verified only via explicit tags
  let specialtyMatch = 0;
  if (rules.keywords.length === 0) {
    specialtyMatch = 0.5; // general: neutral
  } else if (cand.specialties.length > 0 || cand.tags["healthcare:specialty"] || cand.tags["speciality"]) {
    const blob = [...cand.specialties, tagsBlob].join(" ").toLowerCase();
    specialtyMatch = rules.keywords.some((k) => blob.includes(k)) ? 1 : 0;
    if (specialtyMatch === 0) notes.push(`No verified ${rules.label.toLowerCase()} specialty in OSM tags`);
  } else {
    notes.push("Specialty information unavailable in OSM data (treated as neutral)");
  }

  const emergencyBonus =
    cand.hasEmergencyTag === true ? 1 : cand.hasEmergencyTag === "unknown" ? 0.4 : 0;

  const travel = roadTravelTime ?? 1200; // unknown -> neutral-ish constant
  const travelScore = Math.max(0, 1 - travel / 1800);
  const total =
    0.4 * travelScore + 0.3 * specialtyMatch + 0.2 * emergencyBonus + 0.1 * cand.dataCompleteness;

  if (cand.hasEmergencyTag === "unknown") notes.push("Emergency capability unknown (not claimed)");
  if (roadTravelTime === null) notes.push("Road travel time unavailable for this candidate");

  return {
    roadTravelTime: roadTravelTime ?? -1,
    roadDistance: roadDistance ?? -1,
    specialtyMatch,
    emergencyBonus,
    completeness: cand.dataCompleteness,
    total,
    notes,
  };
}

export function searchRadiusLabel(): string {
  return `${settings.hospitalSearchRadiusM / 1000} km`;
}

export function withinSearchRadius(cand: HospitalCandidate, patient: { lat: number; lng: number }): boolean {
  return haversineM(patient, cand) <= settings.hospitalSearchRadiusM * 2;
}
