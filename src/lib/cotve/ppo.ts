import { makeRng, settings, trafficSettings } from "./config";
import type { RoadGraph } from "./types";
import { edgeTravelTime, isTurnAllowed } from "./network";
import { dist } from "./geo";

/**
 * Proximal Policy Optimization — the ONLY RL method in CoTV-E.
 *
 * - Actions are scored per outgoing road edge (candidate next node) and
 *   masked to connected edges; the agent can never jump between
 *   disconnected roads.
 * - State includes GNN embeddings of the current node + candidate node,
 *   edge features, distance-to-destination shaping features and a
 *   revisit flag.
 * - Implementation: tiny actor/critic MLPs with hand-written gradients
 *   (policy-gradient with the PPO clipped surrogate + value loss +
 *   entropy bonus). Sized to train a few thousand steps in ~2s in a
 *   browser on CPU.
 */

export const ACTOR_IN = 39; // 16 emb_u + 16 emb_v + 4 edge + 3 shape
export const CRITIC_IN = 34; // 16 emb_u + 16 emb_d + 2 progress
const H = 24;

class TinyMLP {
  readonly inDim: number;
  W1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  b2: Float32Array;
  // grad buffers
  gW1: Float32Array;
  gb1: Float32Array;
  gw2: Float32Array;
  gb2: Float32Array;

  constructor(inDim: number, rng: () => number) {
    this.inDim = inDim;
    const scale = Math.sqrt(2 / inDim);
    this.W1 = new Float32Array(inDim * H);
    for (let i = 0; i < this.W1.length; i++) this.W1[i] = (rng() * 2 - 1) * scale;
    this.b1 = new Float32Array(H);
    this.w2 = new Float32Array(H);
    for (let i = 0; i < H; i++) this.w2[i] = (rng() * 2 - 1) * 0.1;
    this.b2 = new Float32Array(1);
    this.gW1 = new Float32Array(inDim * H);
    this.gb1 = new Float32Array(H);
    this.gw2 = new Float32Array(H);
    this.gb2 = new Float32Array(1);
  }

  forward(x: Float32Array, xOff: number): { s: number; a: Float32Array; x: Float32Array; xOff: number } {
    const a = new Float32Array(H);
    for (let h = 0; h < H; h++) {
      let z = this.b1[h];
      for (let i = 0; i < this.inDim; i++) z += x[xOff + i] * this.W1[i * H + h];
      a[h] = Math.tanh(z);
    }
    let s = this.b2[0];
    for (let h = 0; h < H; h++) s += this.w2[h] * a[h];
    return { s, a, x, xOff };
  }

  backward(c: { s: number; a: Float32Array; x: Float32Array; xOff: number }, ds: number, inDim: number) {
    this.gb2[0] += ds;
    for (let h = 0; h < H; h++) {
      const da = this.w2[h] * ds;
      this.gw2[h] += ds * c.a[h];
      const dz = da * (1 - c.a[h] * c.a[h]);
      this.gb1[h] += dz;
      for (let i = 0; i < inDim; i++) this.gW1[i * H + h] += dz * c.x[c.xOff + i];
    }
  }

  zeroGrad() {
    this.gW1.fill(0);
    this.gb1.fill(0);
    this.gw2.fill(0);
    this.gb2.fill(0);
  }

  apply(lr: number, batchSize: number) {
    const k = lr / Math.max(1, batchSize);
    for (let i = 0; i < this.W1.length; i++) this.W1[i] -= k * this.gW1[i];
    for (let i = 0; i < this.b1.length; i++) this.b1[i] -= k * this.gb1[i];
    for (let i = 0; i < this.w2.length; i++) this.w2[i] -= k * this.gw2[i];
    this.b2[0] -= k * this.gb2[0];
  }

  gradNorm(): number {
    let s = 0;
    for (const g of [this.gW1, this.gb1, this.gw2, this.gb2]) for (const v of g) s += v * v;
    return Math.sqrt(s);
  }
}

export interface PpoSnapshot {
  episode: number;
  rewardCurve: number[];
  status: "untrained" | "quicktrained";
}

export class PpoAgent {
  actor: TinyMLP;
  critic: TinyMLP;
  inDim: number;
  episode = 0;
  rewardCurve: number[] = [];
  status: PpoSnapshot["status"] = "untrained";

  constructor(seed = settings.seed) {
    const rng = makeRng(seed * 31 + 7);
    this.inDim = ACTOR_IN;
    this.actor = new TinyMLP(ACTOR_IN, rng);
    this.critic = new TinyMLP(CRITIC_IN, rng);
  }

  snapshot(): PpoSnapshot {
    return { episode: this.episode, rewardCurve: [...this.rewardCurve], status: this.status };
  }

  /** Score one candidate (next node) — used by inference. */
  scoreCandidate(x: Float32Array): number {
    return this.actor.forward(x, 0).s;
  }

  valueState(x: Float32Array): number {
    return this.critic.forward(x, 0).s;
  }
}

// ---------- feature building ----------

export interface RouteCtx {
  graph: RoadGraph;
  emb: Float32Array; // GNN embeddings, node -> 16 floats
  dest: number;
  maxDist: number;
}

export function buildCandidateInput(ctx: RouteCtx, u: number, v: number, edgeId: number, revisit: boolean, out: Float32Array) {
  const g = ctx.graph;
  const nu = g.nodesById.get(u)!;
  const nv = g.nodesById.get(v)!;
  const nd = g.nodesById.get(ctx.dest)!;
  const e = g.edgesById.get(edgeId)!;
  const o = 0;
  for (let h = 0; h < 16; h++) {
    out[o + h] = ctx.emb[u * 16 + h];
    out[o + 16 + h] = ctx.emb[v * 16 + h];
  }
  const maxTime = 120;
  out[32] = Math.min(1, e.length / 400);
  out[33] = Math.min(1, edgeTravelTime(e) / maxTime);
  out[34] = e.density;
  out[35] = Math.min(1, e.speedLimit / 20);
  out[36] = (dist(nu.x, nu.y, nd.x, nd.y) - dist(nv.x, nv.y, nd.x, nd.y)) / ctx.maxDist;
  out[37] = Math.min(1, dist(nv.x, nv.y, nd.x, nd.y) / ctx.maxDist);
  out[38] = revisit ? 1 : 0;
}

export function buildCriticInput(ctx: RouteCtx, u: number, progress: number, out: Float32Array) {
  const nu = ctx.graph.nodesById.get(u)!;
  const nd = ctx.graph.nodesById.get(ctx.dest)!;
  for (let h = 0; h < 16; h++) {
    out[h] = ctx.emb[u * 16 + h];
    out[16 + h] = ctx.emb[ctx.dest * 16 + h];
  }
  out[32] = Math.min(1, dist(nu.x, nu.y, nd.x, nd.y) / ctx.maxDist);
  out[33] = progress;
}

// ---------- rollout + update ----------

const GAMMA = 0.95;
const CLIP_EPS = 0.2;
const ENT_COEF = 0.02;
const VF_COEF = 0.5;
const LR = 0.03;

interface Sample {
  candInputs: Float32Array; // K x ACTOR_IN
  K: number;
  action: number;
  oldLogProb: number;
  criticIn: Float32Array; // CRITIC_IN
  ret: number;
}

function softmax(scores: number[]): number[] {
  const m = Math.max(...scores);
  const ex = scores.map((s) => Math.exp(s - m));
  const sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / sum);
}

/** One rollout episode on the graph with the current policy. */
function runEpisode(agent: PpoAgent, ctx: RouteCtx, start: number, rng: () => number, maxSteps: number, explore: boolean) {
  const samples: Sample[] = [];
  const rewards: number[] = [];
  let node = start;
  const visited: number[] = [start];
  const takenEdges: number[] = [];
  let totalReward = 0;
  const candBuf = new Float32Array(ACTOR_IN);
  const criticBuf = new Float32Array(CRITIC_IN);
  const normTime = 120;

  for (let step = 0; step < maxSteps; step++) {
    if (node === ctx.dest) {
      rewards.push(10);
      totalReward += 10;
      break;
    }
    const outs = ctx.graph.out.get(node) ?? [];
    if (outs.length === 0) break;
    const prev = visited.length >= 2 ? visited[visited.length - 2] : -1;
    const recent = new Set(visited.slice(-6));
    const cand: { v: number; e: number; revisit: boolean; relaxed: boolean }[] = [];
    const prevEdge = takenEdges.length ? ctx.graph.edgesById.get(takenEdges[takenEdges.length - 1])! : null;
    for (const eId of outs) {
      const e = ctx.graph.edgesById.get(eId)!;
      if (e.blocked) continue;
      if (prevEdge && !isTurnAllowed(ctx.graph, prevEdge, e)) continue;
      const relaxed = e.to === prev || recent.has(e.to);
      cand.push({ v: e.to, e: eId, revisit: recent.has(e.to), relaxed });
    }
    if (cand.length === 0) break;
    const inputs: Float32Array[] = [];
    for (const c of cand) {
      buildCandidateInput(ctx, node, c.v, c.e, c.revisit, candBuf);
      inputs.push(candBuf.slice());
    }
    const scores = inputs.map((x) => agent.actor.forward(x, 0).s);
    const probs = softmax(scores);
    let action: number;
    if (explore) {
      let r = rng();
      action = probs.length - 1;
      for (let i = 0; i < probs.length; i++) {
        r -= probs[i];
        if (r <= 0) {
          action = i;
          break;
        }
      }
    } else {
      action = probs.indexOf(Math.max(...probs));
    }
    const logProb = Math.log(Math.max(probs[action], 1e-8));
    buildCriticInput(ctx, node, step / maxSteps, criticBuf);

    const chosen = cand[action];
    const e = ctx.graph.edgesById.get(chosen.e)!;
    let r = (dist(ctx.graph.nodesById.get(node)!.x, ctx.graph.nodesById.get(node)!.y, ctx.graph.nodesById.get(ctx.dest)!.x, ctx.graph.nodesById.get(ctx.dest)!.y) -
      dist(ctx.graph.nodesById.get(chosen.v)!.x, ctx.graph.nodesById.get(chosen.v)!.y, ctx.graph.nodesById.get(ctx.dest)!.x, ctx.graph.nodesById.get(ctx.dest)!.y)) /
      ctx.maxDist;
    r -= 0.02 * (edgeTravelTime(e) / normTime);
    r -= 0.05 * e.density;
    if (chosen.relaxed) r -= 0.2;
    samples.push({ candInputs: concatInputs(inputs), K: inputs.length, action, oldLogProb: logProb, criticIn: criticBuf.slice(), ret: 0 });
    rewards.push(r);
    totalReward += r;
    node = chosen.v;
    visited.push(node);
    takenEdges.push(chosen.e);
    if (visited.filter((n) => n === node).length > 4) break; // loop guard
  }
  if (node !== ctx.dest && (rewards.length === 0 || rewards[rewards.length - 1] !== 10)) {
    rewards.push(-5);
    totalReward -= 5;
  }
  // discounted returns
  let g = 0;
  for (let i = rewards.length - 1; i >= 0; i--) {
    g = rewards[i] + GAMMA * g;
    if (samples[i]) samples[i].ret = g;
  }
  return { samples, totalReward, reached: node === ctx.dest };
}

function concatInputs(inputs: Float32Array[]): Float32Array {
  const out = new Float32Array(inputs.length * ACTOR_IN);
  inputs.forEach((x, i) => out.set(x, i * ACTOR_IN));
  return out;
}

/** PPO update: clipped surrogate + value MSE + entropy bonus. */
function update(agent: PpoAgent, batch: Sample[]) {
  for (let epoch = 0; epoch < 3; epoch++) {
    agent.actor.zeroGrad();
    agent.critic.zeroGrad();
    for (const s of batch) {
      const scores: number[] = [];
      const caches: { s: number; a: Float32Array; x: Float32Array; xOff: number }[] = [];
      for (let k = 0; k < s.K; k++) {
        // slice: forward caches reference the input, so each candidate needs
        // its own buffer (no shared scratch space here)
        const f = agent.actor.forward(s.candInputs.slice(k * ACTOR_IN, (k + 1) * ACTOR_IN), 0);
        scores.push(f.s);
        caches.push(f);
      }
      const probs = softmax(scores);
      const logProb = Math.log(Math.max(probs[s.action], 1e-8));
      const ratio = Math.exp(logProb - s.oldLogProb);
      // advantage uses the pre-update critic pass (computed below with the
      // same weights, evaluated once more for clarity)
      const adv0 = s.ret - agent.critic.forward(s.criticIn, 0).s;
      const adv = adv0;
      // clipped surrogate gradient
      let active = true;
      if (adv > 0 && ratio > 1 + CLIP_EPS) active = false;
      if (adv < 0 && ratio < 1 - CLIP_EPS) active = false;
      if (active) {
        const w = -adv * ratio;
        for (let k = 0; k < s.K; k++) {
          const ds = w * ((k === s.action ? 1 : 0) - probs[k]);
          agent.actor.backward(caches[k], ds, ACTOR_IN);
        }
      }
      // entropy gradient (maximize H)
      let logSumPi = 0;
      for (let k = 0; k < s.K; k++) logSumPi += probs[k] * Math.log(Math.max(probs[k], 1e-8));
      for (let k = 0; k < s.K; k++) {
        const dH = probs[k] * (logSumPi - Math.log(Math.max(probs[k], 1e-8)));
        agent.actor.backward(caches[k], -ENT_COEF * dH, ACTOR_IN);
      }
      // critic (reuse the cached activation from the same forward pass used
      // for the advantage so backward() sees correct tanh outputs)
      const vc = agent.critic.forward(s.criticIn.slice(), 0);
      agent.critic.backward(vc, VF_COEF * 2 * (vc.s - s.ret), CRITIC_IN);
    }
    // gradient clip by norm (simple scale-down)
    const norm = Math.max(agent.actor.gradNorm(), agent.critic.gradNorm());
    const scale = norm > 5 ? 5 / norm : 1;
    if (scale < 1) {
      for (const arr of [agent.actor.gW1, agent.actor.gb1, agent.actor.gw2, agent.actor.gb2, agent.critic.gW1, agent.critic.gb1, agent.critic.gw2, agent.critic.gb2]) {
        for (let i = 0; i < arr.length; i++) arr[i] *= scale;
      }
    }
    agent.actor.apply(LR, batch.length);
    agent.critic.apply(LR, batch.length);
  }
}

export interface QuickTrainResult {
  episodes: number;
  rewardCurve: number[];
  wallMs: number;
  finalMeanReward: number;
}

/** In-browser quick-train under a wall-clock budget. Honest labeling: this is
 * a demonstration-scale PPO run (tiny nets, few episodes), not production
 * training. Returns the reward curve for the UI. */
export function quickTrain(
  agent: PpoAgent,
  graph: RoadGraph,
  emb: Float32Array,
  budgetMs: number = settings.ppoTrainBudgetMs,
  seed: number = settings.seed,
): QuickTrainResult {
  const t0 = performance.now();
  const rng = makeRng(seed * 97 + 3);
  const maxDist = Math.max(graph.bounds.maxX - graph.bounds.minX, graph.bounds.maxY - graph.bounds.minY);
  const nodes = graph.nodes.map((n) => n.id);
  const ctx: RouteCtx = { graph, emb, dest: nodes[0], maxDist };
  let batches = 0;
  while (performance.now() - t0 < budgetMs && batches < 400) {
    const batch: Sample[] = [];
    let batchR = 0;
    for (let ep = 0; ep < settings.ppoEpisodesPerBatch; ep++) {
      const start = nodes[Math.floor(rng() * nodes.length)];
      const goal = nodes[Math.floor(rng() * nodes.length)];
      ctx.dest = goal;
      if (start === goal) continue;
      const { samples, totalReward } = runEpisode(agent, ctx, start, rng, settings.ppoMaxStepsPerEpisode, true);
      batch.push(...samples);
      batchR += totalReward;
    }
    if (batch.length === 0) continue;
    update(agent, batch);
    agent.episode += settings.ppoEpisodesPerBatch;
    const meanR = batchR / settings.ppoEpisodesPerBatch;
    batches++;
    agent.rewardCurve.push(Number(meanR.toFixed(2)));
    if (agent.rewardCurve.length > 400) agent.rewardCurve.shift();
  }
  agent.status = "quicktrained";
  const finalMean = agent.rewardCurve.slice(-10);
  return {
    episodes: agent.episode,
    rewardCurve: [...agent.rewardCurve],
    wallMs: Math.round(performance.now() - t0),
    finalMeanReward: finalMean.length ? Number((finalMean.reduce((a, b) => a + b, 0) / finalMean.length).toFixed(2)) : 0,
  };
}

export interface PpoRouteResult {
  nodePath: number[];
  edgeIds: number[];
  steps: number;
  invalidActionCount: number;
  reached: boolean;
}

/** Greedy policy rollout for routing (inference). Masked to connected
 * edges; revisits avoided unless it is the only option (counted as an
 * invalid/relaxed action). */
export function ppoRoute(
  agent: PpoAgent,
  ctx: RouteCtx,
  start: number,
  maxSteps: number,
  rng: () => number = Math.random,
): PpoRouteResult {
  const nodePath = [start];
  const edgeIds: number[] = [];
  let node = start;
  let invalid = 0;
  const visited = new Set<number>([start]);
  const candBuf = new Float32Array(ACTOR_IN);
  let steps = 0;
  while (node !== ctx.dest && steps < maxSteps) {
    steps++;
    const outs = ctx.graph.out.get(node) ?? [];
    if (outs.length === 0) break;
    const prevEdge = edgeIds.length ? ctx.graph.edgesById.get(edgeIds[edgeIds.length - 1])! : null;
    const prev = nodePath.length >= 2 ? nodePath[nodePath.length - 2] : -1;
    const cand: { v: number; e: number; relaxed: boolean }[] = [];
    for (const eId of outs) {
      const e = ctx.graph.edgesById.get(eId)!;
      if (e.blocked) continue; // blocked roads are never valid actions
      if (e.to === prev || visited.has(e.to)) continue; // mask: no backtrack / revisit
      if (prevEdge && !isTurnAllowed(ctx.graph, prevEdge, e)) continue; // real restrictions
      cand.push({ v: e.to, e: eId, relaxed: false });
    }
    if (cand.length === 0) {
      // only revisiting options exist — escape by the LEAST-regressive move
      // (closest to the destination), counted as a relaxed/invalid step
      const visitedOpts = outs
        .map((eId) => ctx.graph.edgesById.get(eId)!)
        .filter((e) => !e.blocked && (!prevEdge || isTurnAllowed(ctx.graph, prevEdge, e)))
        .map((e) => ({ v: e.to, e: e.id, relaxed: true }));
      visitedOpts.sort((a, b) => {
        const na = ctx.graph.nodesById.get(a.v)!;
        const nb = ctx.graph.nodesById.get(b.v)!;
        const nd = ctx.graph.nodesById.get(ctx.dest)!;
        return Math.hypot(na.x - nd.x, na.y - nd.y) - Math.hypot(nb.x - nd.x, nb.y - nd.y);
      });
      if (visitedOpts.length === 0) break; // fully blocked / restricted dead end
      cand.push(visitedOpts[0]);
      invalid++;
      void prev;
    }
    const inputs: Float32Array[] = [];
    for (const c of cand) {
      buildCandidateInput(ctx, node, c.v, c.e, c.relaxed, candBuf);
      inputs.push(candBuf.slice());
    }
    const scores = inputs.map((x) => agent.actor.forward(x, 0).s);
    const probs = softmax(scores.map((s) => s * 3)); // sharpen for inference
    let action = probs.indexOf(Math.max(...probs));
    if (rng !== Math.random) {
      // deterministic mode uses argmax; sampling mode uses rng
      let rr = rng();
      action = probs.length - 1;
      for (let i = 0; i < probs.length; i++) {
        rr -= probs[i];
        if (rr <= 0) {
          action = i;
          break;
        }
      }
    }
    const chosen = cand[action];
    edgeIds.push(chosen.e);
    nodePath.push(chosen.v);
    node = chosen.v;
    visited.add(node);
  }
  return { nodePath, edgeIds, steps, invalidActionCount: invalid, reached: node === ctx.dest };
}

/** maxDist helper shared with the route manager. */
export function graphMaxDist(graph: RoadGraph): number {
  return Math.max(
    graph.bounds.maxX - graph.bounds.minX,
    graph.bounds.maxY - graph.bounds.minY,
    1,
  );
}

void trafficSettings;
