import type { LatLng } from "./types";

const EARTH_R = 6371000;

export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface Projection {
  center: LatLng;
  /** meters per degree */
  mPerDegLat: number;
  mPerDegLng: number;
}

export function makeProjection(center: LatLng): Projection {
  const mPerDegLat = Math.PI / 180 * EARTH_R;
  const mPerDegLng = Math.PI / 180 * EARTH_R * Math.cos(center.lat * Math.PI / 180);
  return { center, mPerDegLat, mPerDegLng };
}

/** lat/lng -> local meters (x east, y north) */
export function toLocal(p: Projection, ll: LatLng): { x: number; y: number } {
  return {
    x: (ll.lng - p.center.lng) * p.mPerDegLng,
    y: (ll.lat - p.center.lat) * p.mPerDegLat,
  };
}

/** local meters -> lat/lng */
export function toLatLng(p: Projection, x: number, y: number): LatLng {
  return {
    lng: p.center.lng + x / p.mPerDegLng,
    lat: p.center.lat + y / p.mPerDegLat,
  };
}

export function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}
