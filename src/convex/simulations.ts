import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const save = mutation({
  args: {
    emergencyText: v.string(),
    emergencyKind: v.string(),
    patientLat: v.number(),
    patientLng: v.number(),
    hospitalName: v.string(),
    hospitalLat: v.number(),
    hospitalLng: v.number(),
    hospitalDemo: v.boolean(),
    networkSource: v.string(),
    responseTimeSec: v.number(),
    totalTimeSec: v.number(),
    totalDistanceM: v.number(),
    routingMode: v.string(),
    signalRequests: v.number(),
    signalActivations: v.number(),
    ppoEpisodes: v.number(),
    metrics: v.any(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("simulations", { createdAt: Date.now(), ...args });
    return id;
  },
});

export const saveOsmManifest = mutation({
  args: {
    kind: v.string(),
    endpoint: v.string(),
    license: v.string(),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
    radiusM: v.optional(v.number()),
    nodeCount: v.number(),
    edgeCount: v.number(),
    osmSignalNodes: v.number(),
    studyCity: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("osmManifests", { fetchedAt: Date.now(), ...args });
  },
});

export const listOsmManifests = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    return await ctx.db
      .query("osmManifests")
      .withIndex("by_fetched", (q) => q.gt("fetchedAt", 0))
      .order("desc")
      .take(limit ?? 6);
  },
});

export const listRecent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const n = limit ?? 10;
    return await ctx.db
      .query("simulations")
      .withIndex("by_created", (q) => q.gt("createdAt", 0))
      .order("desc")
      .take(n);
  },
});
