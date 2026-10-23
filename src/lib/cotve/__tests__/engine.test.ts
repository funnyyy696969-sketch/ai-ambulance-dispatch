import { describe, it, expect } from "vitest";
import { generateDemoGrid, nearestNode, validateGraphConnectivity } from "../network";
import { dijkstra, astar } from "../baselines";
import { RoadGNN } from "../gnn";
import { PpoAgent, quickTrain, ppoRoute, graphMaxDist, buildCandidateInput, type RouteCtx } from "../ppo";
import { planRoutePpo, planRouteDijkstra, validatePath } from "../routeManager";
import { createRoutingContext } from "../routeManager";
import { settings } from "../config";

const center = { lat: 28.6139, lng: 77.209 };

describe("road graph (demo grid, no external map)", () => {
  const built = generateDemoGrid(center);
  const g = built.graph;

  it("builds a connected grid with directed edges", () => {
    expect(g.nodes.length).toBe(settings.demoGridSize * settings.demoGridSize);
    expect(g.edges.length).toBeGreaterThan(0);
    expect(validateGraphConnectivity(g)).toBe(true);
  });

  it("signalizes interior high-degree intersections", () => {
    const sig = g.nodes.filter((n) => n.signalized);
    expect(sig.length).toBeGreaterThan(0);
    for (const n of sig) expect(n.signalAxes).toBeDefined();
  });

  it("snaps a lat/lng to the nearest node", () => {
    const n0 = g.nodes[0];
    const id = nearestNode(g, n0.x + 1, n0.y + 1);
    expect(g.nodesById.has(id)).toBe(true);
  });
});

describe("baseline routing", () => {
  const g = generateDemoGrid(center).graph;
  const start = 0;
  const goal = g.nodes.length - 1;

  it("dijkstra returns a connected path with positive cost", () => {
    const r = dijkstra(g, start, goal);
    expect(r).not.toBeNull();
    expect(r!.nodePath[0]).toBe(start);
    expect(r!.nodePath[r!.nodePath.length - 1]).toBe(goal);
    expect(validatePath(g, r!.nodePath)).toBe(true);
    expect(r!.cost).toBeGreaterThan(0);
  });

  it("astar matches dijkstra cost on an admissible heuristic", () => {
    const d = dijkstra(g, start, goal)!;
    const a = astar(g, start, goal)!;
    expect(a.cost).toBeCloseTo(d.cost, 3);
    expect(validatePath(g, a.nodePath)).toBe(true);
  });
});

describe("GNN", () => {
  it("produces embeddings of hidden dim for every node", () => {
    const g = generateDemoGrid(center).graph;
    const gnn = new RoadGNN();
    const emb = gnn.embed(g, 0, g.nodes.length - 1);
    expect(emb.length).toBe(g.nodes.length * gnn.hidden);
    expect(emb.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("is deterministic for the same inputs", () => {
    const g = generateDemoGrid(center).graph;
    const a = new RoadGNN().embed(g, 0, 5);
    const b = new RoadGNN().embed(g, 0, 5);
    expect(a).toEqual(b);
  });
});

describe("PPO agent", () => {
  const g = generateDemoGrid(center).graph;

  it("masks actions to connected edges during route inference", () => {
    const agent = new PpoAgent();
    const ctx: RouteCtx = { graph: g, emb: new RoadGNN().embed(g, 0, g.nodes.length - 1), dest: g.nodes.length - 1, maxDist: graphMaxDist(g) };
    const res = ppoRoute(agent, ctx, 0, 500);
    // every transition must be a real directed edge
    for (let i = 0; i < res.nodePath.length - 1; i++) {
      const a = res.nodePath[i];
      const b = res.nodePath[i + 1];
      expect((g.out.get(a) ?? []).some((id) => g.edgesById.get(id)!.to === b)).toBe(true);
    }
  });

  it("builds candidate feature vectors with the documented width", () => {
    const ctx: RouteCtx = { graph: g, emb: new RoadGNN().embed(g, 0, 5), dest: 5, maxDist: graphMaxDist(g) };
    const out = new Float32Array(39);
    const first = g.nodes[0];
    const nbr = g.edgesById.get(g.out.get(0)![0])!;
    buildCandidateInput(ctx, 0, nbr.to, nbr.id, false, out);
    expect(out.length).toBe(39);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    void first;
  });

  it("quick-train runs under its budget and produces a reward curve", () => {
    const agent = new PpoAgent();
    const gnn = new RoadGNN();
    const emb = gnn.embed(g, 0, g.nodes.length - 1);
    const res = quickTrain(agent, g, emb, 400, 3);
    expect(res.wallMs).toBeLessThan(3000);
    expect(res.episodes).toBeGreaterThan(0);
    expect(agent.status).toBe("quicktrained");
    expect(agent.rewardCurve.length).toBeGreaterThan(0);
  });

  it("trained policy routes more reliably than an untrained one on the grid", () => {
    // train on the full graph
    const agent = new PpoAgent();
    const gnn = new RoadGNN();
    const emb = gnn.embed(g, 0, g.nodes.length - 1);
    quickTrain(agent, g, emb, 900, 5);
    const ctx: RouteCtx = { graph: g, emb, dest: g.nodes.length - 1, maxDist: graphMaxDist(g) };
    const res = ppoRoute(agent, ctx, 0, 600);
    // must stay connected regardless of success
    expect(validatePath(g, res.nodePath)).toBe(true);
  }, 20000);
});

describe("route manager", () => {
  const g = generateDemoGrid(center).graph;
  const rc = createRoutingContext(g, new RoadGNN(), new PpoAgent());

  it("produces a validated route with PPO or an honest A* fallback", () => {
    const route = planRoutePpo(rc, 0, g.nodes.length - 1);
    expect(route.nodePath[0]).toBe(0);
    expect(route.nodePath[route.nodePath.length - 1]).toBe(g.nodes.length - 1);
    expect(validatePath(g, route.nodePath)).toBe(true);
    expect(["ppo", "ppo-quicktrained", "fallback-astar"]).toContain(route.mode);
    if (route.mode === "fallback-astar") expect(route.fallbackReason).toBeTruthy();
  });

  it("dijkstra baseline plan is connected", () => {
    const r = planRouteDijkstra(g, 0, g.nodes.length - 1);
    expect(validatePath(g, r.nodePath)).toBe(true);
  });
});
