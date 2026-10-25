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
// Multiple public mirrors, tried over TWO rounds with escalating backoff.
// Live probing (Oct 2026) observed back-to-back 502/429/504 across all
// instances — the earlier single round silently produced demo-grid fallbacks
// (the 2D-map-vs-3D-infrastructure mismatch users saw). Rounds make success
// far more likely; failure still falls back to clearly-labeled demo data.
const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];

const ROAD_TYPES = "motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street";

// Public Overpass instances REJECT requests with a default/blank User-Agent
// (live-verified Oct 2026: HTTP 429 "Please include a meaningful User-Agent").
// A descriptive UA identifying the research project fixes that class of
// failures outright.
const USER_AGENT =
  "CoTV-E/1.0 (academic emergency-ambulance routing and traffic-signal-priority research)";
// Per-attempt ceiling so a queued/hung mirror cycles to the next one instead
// of stalling the whole fetch (some mirrors queue requests under load).
const ATTEMPT_TIMEOUT_MS = 45_000;

interface OverpassEl {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; ref: number }[];
}

async function overpass(query: string): Promise<{ elements: OverpassEl[] }> {
  let lastErr: Error | null = null;
  for (let round = 0; round < 2; round++) {
    for (const url of OVERPASS_MIRRORS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status} (${new URL(url).host})`);
        return (await res.json()) as { elements: OverpassEl[] };
      } catch (e) {
        lastErr = e as Error;
        // brief pause between mirrors; longer pause between rounds so 429
        // rate limits can clear before retrying
        await new Promise((r) => setTimeout(r, 1200 + round * 3000));
      }
    }
  }
  throw lastErr ?? new Error("All Overpass endpoints failed");
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
      // amenity=* covers the common tagging; healthcare=* is also queried
      // because some facilities (e.g. government hospitals in Indian cities)
      // are mapped ONLY with healthcare tags — omitting it silently dropped
      // real hospitals from selection (verified: 3 misses at the default
      // study center, including two major government hospitals).
      const q = `[out:json][timeout:25];(
        node["amenity"~"^(hospital|clinic)$"](around:${radiusM},${lat},${lng});
        way["amenity"~"^(hospital|clinic)$"](around:${radiusM},${lat},${lng});
        node["healthcare"~"^(hospital|clinic)$"](around:${radiusM},${lat},${lng});
        way["healthcare"~"^(hospital|clinic)$"](around:${radiusM},${lat},${lng});
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

export const fetchBuildings = action({
  args: { lat: v.number(), lng: v.number(), radiusM: v.number() },
  handler: async (_ctx, { lat, lng, radiusM }) => {
    try {
      // Real OSM building footprints (closed ways) with geometry + height tags.
      // `out geom` returns the full footprint ring in order.
      const q = `[out:json][timeout:30];way["building"](around:${radiusM},${lat},${lng});out geom tags;`;
      const data = await overpass(q);
      const buildings = data.elements
        .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 3)
        .map((el) => {
          const tags = el.tags ?? {};
          const heightRaw = tags.height;
          const levelsRaw = tags["building:levels"];
          const heightM = heightRaw ? Number.parseFloat(heightRaw) : null;
          const levels = levelsRaw ? Number.parseFloat(levelsRaw) : null;
          return {
            id: el.id,
            ring: el.geometry!.map((pt: { lat: number; lon: number }) => ({ lat: pt.lat, lng: pt.lon })),
            building: tags.building ?? "yes",
            heightM: Number.isFinite(heightM as number) ? (heightM as number) : null,
            levels: Number.isFinite(levels as number) ? (levels as number) : null,
            name: tags.name ?? null,
          };
        })
        .filter((b) => b.ring.length >= 3);
      return {
        ok: true as const,
        buildings,
        meta: { count: buildings.length, fetchedAt: Date.now(), license: "ODbL 1.0 — © OpenStreetMap contributors", endpoint: OVERPASS_URL },
      };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const fetchRoads = action({
  args: { lat: v.number(), lng: v.number(), radiusM: v.number() },
  handler: async (_ctx, { lat, lng, radiusM }) => {
    try {
      // 1. full way geometry (junction-or-not points preserved)
      const q = `[out:json][timeout:30];way["highway"~"^(${ROAD_TYPES})$"](around:${radiusM},${lat},${lng});out geom tags;`;
      const data = await overpass(q);
      // 2. REAL OSM traffic-signal nodes in the same radius
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
      // 3. REAL turn restrictions (relations), via-node coords resolved in batch
      const restrictions: { viaLat: number; viaLng: number; fromWay: number; toWay: number; restriction: string }[] = [];
      try {
        const qRel = `[out:json][timeout:25];relation["type"="restriction"]["restriction"~"^no_"](around:${radiusM},${lat},${lng});out body;`;
        const relData = await overpass(qRel);
        const viaNodeIds: number[] = [];
        const parsed: { viaRef: number; from: number; to: number; restriction: string }[] = [];
        for (const el of relData.elements) {
          if (el.type !== "relation" || !el.members) continue;
          const restriction = el.tags?.restriction;
          if (!restriction || !restriction.startsWith("no_")) continue;
          const via = el.members.find((m: { type: string; role: string }) => m.type === "node" && m.role === "via");
          const from = el.members.find((m: { type: string; role: string }) => m.type === "way" && m.role === "from");
          const to = el.members.find((m: { type: string; role: string }) => m.type === "way" && m.role === "to");
          if (!via || !from || !to) continue;
          viaNodeIds.push(via.ref);
          parsed.push({ viaRef: via.ref, from: from.ref, to: to.ref, restriction });
        }
        if (viaNodeIds.length > 0) {
          const qNodes = `[out:json][timeout:25];node(id:${viaNodeIds.join(",")});out body;`;
          const nodeData = await overpass(qNodes);
          const coords = new Map<number, { lat: number; lng: number }>();
          for (const el of nodeData.elements) {
            if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
              coords.set(el.id, { lat: el.lat, lng: el.lon });
            }
          }
          for (const p of parsed) {
            const c = coords.get(p.viaRef);
            if (c) restrictions.push({ viaLat: c.lat, viaLng: c.lng, fromWay: p.from, toWay: p.to, restriction: p.restriction });
          }
        }
      } catch {
        // restrictions are an enhancement — absence is reported in meta
      }
      // assemble RAW WAYS with full geometry (osm way id preserved)
      const ways = data.elements
        .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 2)
        .map((el) => {
          const tags = el.tags ?? {};
          const lanes = tags.lanes ? Number.parseInt(tags.lanes, 10) : null;
          return {
            id: el.id,
            nodes: el.geometry!.map((pt: { lat: number; lon: number }, i: number) => ({ id: i, lat: pt.lat, lng: pt.lon })),
            oneway: tags.oneway === "yes" || tags.oneway === "1",
            type: tags.highway ?? "residential",
            maxspeed: parseMaxspeed(tags.maxspeed),
            lanes: Number.isFinite(lanes as number) ? lanes : null,
          };
        });
      if (ways.length === 0) {
        return { ok: false as const, error: "No routable ways in range" };
      }
      return {
        ok: true as const,
        network: { ways, signals: [...signalCoords].map((k) => { const [la, lo] = k.split(":").map(Number); return { lat: la, lng: lo }; }), restrictions, source: "osm" as const },
        meta: {
          osmSignalNodes: signalCoords.size,
          turnRestrictions: restrictions.length,
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
