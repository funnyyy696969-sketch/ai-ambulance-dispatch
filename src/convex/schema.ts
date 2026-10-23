import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // add other tables here

    /** completed CoTV-E dispatch sessions (metrics are stored as JSON) */
    simulations: defineTable({
      createdAt: v.number(),
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
    }).index("by_created", ["createdAt"]),

    /** real OSM acquisition records (Overpass provenance for each fetch) */
    osmManifests: defineTable({
      fetchedAt: v.number(),
      kind: v.string(), // "osm-roads" | "osm-city-context"
      endpoint: v.string(),
      license: v.string(),
      lat: v.optional(v.number()),
      lng: v.optional(v.number()),
      radiusM: v.optional(v.number()),
      nodeCount: v.number(),
      edgeCount: v.number(),
      osmSignalNodes: v.number(),
      studyCity: v.string(),
    }).index("by_fetched", ["fetchedAt"]),

    // tableName: defineTable({
    //   ...
    //   // table fields
    // }).index("by_field", ["field"])
  },
  {
    schemaValidation: false,
  },
);

export default schema;
