"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";

/**
 * OpenStreetMap data access via the public Overpass API.
 *
 * Called from the browser through Convex actions (avoids CORS issues and
 * keeps API concerns server-side). On any failure the action returns
 * { ok: false, error } and the client falls back to demonstration data,
 * which is always clearly labeled in the UI.
 */

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const ROAD_TYPES = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street";

interface OverpassEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

async function overpass(query: string): Promise<{ elements: OverpassEl[] }> {
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return (await res.json()) as { elements: OverpassEl[] };
}

function parseMaxspeed(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (/mph/i.test(v)) n *= 0.44704;
  return n; // m/s
}

export const searchHospitals = action({
  args: { lat: v.number(), lng: v.number(), radiusM: v.number() },
  handler: async (_ctx, { lat, lng, radiusM }) => {
    try {
      const q = `[out:json][timeout:25];(
        node["amenity"~"^(hospital|clinic)$"](around:${radiusM},${lat},${lng});
        way["amenity"~"^(hospital|clinic)$"](around:${radiusM},${lat},${lng});
      );out center tags;`;
      const data = await overpass(q);
      const elements = data.elements.map((el) => ({
        type: el.type,
        id: el.id,
        lat: el.lat ?? el.center?.lat,
        lng: el.lon ?? el.center?.lon,
        tags: el.tags ?? {},
      }));
      return { ok: true as const, elements };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const fetchRoads = action({
  args: { lat: v.number(), lng: v.number(), radiusM: v.number() },
  handler: async (_ctx, { lat, lng, radiusM }) => {
    try {
      const q = `[out:json][timeout:25];way["highway"~"^(${ROAD_TYPES})$"](around:${radiusM},${lat},${lng});out geom tags;`;
      const data = await overpass(q);
      // REAL OSM traffic-signal nodes in the same radius (second query)
      const qSignals = `[out:json][timeout:25];node["highway"="traffic_signals"](around:${radiusM},${lat},${lng});out body;`;
      const signalCoords = new Set<string>();
      try {
        const sigData = await overpass(qSignals);
        for (const el of sigData.elements) {
          if (el.lat !== undefined && el.lon !== undefined) {
            signalCoords.add(`${el.lat.toFixed(5)}:${el.lon.toFixed(5)}`);
          }
        }
      } catch {
        // signals are an enhancement, not a requirement — absence is reported
      }
      // dedupe nodes by ~2m grid so shared intersections merge
      const key = (la: number, lo: number) =>
        `${Math.round(la * 45000)}:${Math.round(lo * 45000)}`;
      const nodeIds = new Map<string, number>();
      const nodes: { id: number; lat: number; lng: number; signal?: boolean }[] = [];
      const edges: { from: number; to: number; oneway: boolean; type: string; maxspeed: number | null }[] = [];
      for (const el of data.elements) {
        if (el.type !== "way" || !el.geometry) continue;
        const tags = el.tags ?? {};
        const oneway = tags.oneway === "yes" || tags.oneway === "1";
        const maxspeed = parseMaxspeed(tags.maxspeed);
        const type = tags.highway ?? "residential";
        const ids: number[] = [];
        for (const pt of el.geometry) {
          const k = key(pt.lat, pt.lon);
          let id = nodeIds.get(k);
          if (id === undefined) {
            id = nodes.length;
            nodeIds.set(k, id);
            nodes.push({
              id,
              lat: pt.lat,
              lng: pt.lon,
              // real `highway=traffic_signals` tag within ~1m of this node
              ...(signalCoords.has(`${pt.lat.toFixed(5)}:${pt.lon.toFixed(5)}`) ? { signal: true } : {}),
            });
          }
          ids.push(id);
        }
        for (let i = 0; i < ids.length - 1; i++) {
          edges.push({ from: ids[i], to: ids[i + 1], oneway, type, maxspeed });
        }
      }
      if (nodes.length < 20) {
        return { ok: false as const, error: `Only ${nodes.length} road nodes in range — too sparse` };
      }
      return {
        ok: true as const,
        network: { nodes, edges, source: "osm" as const },
        meta: {
          osmSignalNodes: signalCoords.size,
          fetchedAt: Date.now(),
          license: "ODbL 1.0 — © OpenStreetMap contributors",
          endpoint: OVERPASS_URL,
        },
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
