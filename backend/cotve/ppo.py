"""Proximal Policy Optimization - the RL router (numpy, no framework).

Same shapes as the browser implementation, so the two agree:
    ACTOR_IN  = 39 = 16 emb_current + 16 emb_candidate + 4 edge + 3 shaping
    CRITIC_IN = 34 = 16 emb_current + 16 emb_goal      + 2 progress

The action space at a state is the set of *connected* successor roads of the
road the ambulance is on (masked, so the policy can never jump to a disconnected
road), and the policy is a softmax over those candidates - the standard PPO
categorical setup with a per-state mask.

Training is a real PPO loop - clipped surrogate, value loss, entropy bonus,
Adam - and rollouts are priced by the GNN's travel-time prediction on the live
CityFlow network, so what it optimises is the current traffic state.
"""

from __future__ import annotations

import heapq
import math
import time

import numpy as np

from .gnn import GNN
from .roadnet import MAX_SPEED, Network
from .routing import CostFn, dijkstra

ACTOR_IN = 39
CRITIC_IN = 34
H = 24
GAMMA = 0.99
CLIP = 0.2
ENTROPY_BETA = 0.02
GOAL_BONUS = 40.0


def softmax(x: np.ndarray) -> np.ndarray:
    z = x - np.max(x)
    e = np.exp(z)
    return e / e.sum()


class _MLP:
    """in -> H (tanh) -> 1 with hand-written gradients + Adam."""

    def __init__(self, in_dim: int, rng: np.random.Generator, lr: float) -> None:
        self.lr = lr
        self.W1 = rng.standard_normal((in_dim, H)) * math.sqrt(2.0 / in_dim)
        self.b1 = np.zeros(H)
        self.W2 = rng.standard_normal((H, 1)) * 0.1
        self.b2 = np.zeros(1)
        self._m = {k: np.zeros_like(v) for k, v in self.params().items()}
        self._v = {k: np.zeros_like(v) for k, v in self.params().items()}
        self._t = 0

    def params(self) -> dict[str, np.ndarray]:
        return {"W1": self.W1, "b1": self.b1, "W2": self.W2, "b2": self.b2}

    def forward(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        h = np.tanh(x @ self.W1 + self.b1)
        s = (h @ self.W2 + self.b2).ravel()
        return s, h

    def adam(self, name: str, grad: np.ndarray) -> None:
        m = self._m[name]
        v = self._v[name]
        self._t += 1
        m *= 0.9
        m += 0.1 * grad
        v *= 0.999
        v += 0.001 * grad * grad
        mh = m / (1 - 0.9**self._t)
        vh = v / (1 - 0.999**self._t)
        getattr(self, name)[:] -= self.lr * mh / (np.sqrt(vh) + 1e-8)


class PPOAgent:
    def __init__(self, seed: int = 0) -> None:
        rng = np.random.default_rng(seed + 7)
        self.actor = _MLP(ACTOR_IN, rng, lr=2.5e-3)
        self.critic = _MLP(CRITIC_IN, rng, lr=1e-2)
        self.update_count = 0
        self.last_stats: dict = {}

    # ------------------------------ features --------------------------- #
    @staticmethod
    def actor_features(
        emb: np.ndarray,
        x_e: np.ndarray,
        road_index: dict[str, int],
        node_index: dict[str, int],
        net: Network,
        u: str,
        v: str,
        goal: str,
        initial_rem: float,
        goal_xy: tuple[float, float],
        visited: set[str],
    ) -> np.ndarray:
        ru, rv = net.roads[u], net.roads[v]
        emb_cur = emb[node_index[ru.to_int]]
        emb_cand = emb[node_index[rv.to_int]]
        e = x_e[road_index[v]]
        edge4 = np.array([e[1], e[2], e[3], e[4]])  # tt, utilisation, speed, congestion
        gx, gy = goal_xy
        rem = math.hypot(rv.points[-1][0] - gx, rv.points[-1][1] - gy) / MAX_SPEED
        shaping = np.array(
            [
                min(rem / 300.0, 1.0),
                1.0 - min(rem / max(initial_rem, 1e-6), 1.0),
                1.0 if v in visited else 0.0,
            ]
        )
        return np.concatenate([emb_cur, emb_cand, edge4, shaping]).astype(np.float64)

    @staticmethod
    def critic_features(
        emb: np.ndarray,
        net: Network,
        u: str,
        goal: str,
        node_index: dict[str, int],
        initial_rem: float,
        goal_xy: tuple[float, float],
        steps: int,
        max_len: int,
    ) -> np.ndarray:
        ru = net.roads[u]
        emb_cur = emb[node_index[ru.to_int]]
        emb_goal = emb[node_index[net.roads[goal].to_int]]
        gx, gy = goal_xy
        rem = math.hypot(ru.points[-1][0] - gx, ru.points[-1][1] - gy) / MAX_SPEED
        prog = np.array(
            [1.0 - min(rem / max(initial_rem, 1e-6), 1.0), min(steps / max(max_len, 1), 1.0)]
        )
        return np.concatenate([emb_cur, emb_goal, prog]).astype(np.float64)

    def logits(self, feats: np.ndarray) -> np.ndarray:
        s, _ = self.actor.forward(feats)
        return s

    def value(self, cfeat: np.ndarray) -> float:
        s, _ = self.critic.forward(cfeat.reshape(1, -1))
        return float(s[0])

    # ------------------------------ training --------------------------- #
    def ppo_update(
        self,
        cand_feats: list[np.ndarray],
        actions: np.ndarray,
        old_logp: np.ndarray,
        cfeats: np.ndarray,
        advantages: np.ndarray,
        returns: np.ndarray,
        epochs: int = 4,
    ) -> dict:
        """Masked-categorical PPO update over ragged candidate sets."""
        sizes = [len(c) for c in cand_feats]
        bounds = np.cumsum([0] + sizes)
        all_feats = np.vstack(cand_feats)
        B = len(cand_feats)
        ratio_mean, ent_mean = 0.0, 0.0

        for _ in range(epochs):
            logits, h = self.actor.forward(all_feats)  # (T,)
            dz = np.zeros(len(all_feats))
            ratios = np.zeros(B)
            ents = np.zeros(B)
            for i in range(B):
                sl = slice(int(bounds[i]), int(bounds[i + 1]))
                p = softmax(logits[sl])
                a = int(actions[i])
                logp_new = math.log(float(p[a]) + 1e-12)
                ratio = math.exp(logp_new - float(old_logp[i]))
                A = float(advantages[i])
                surr1 = ratio * A
                surr2 = min(max(ratio, 1 - CLIP), 1 + CLIP) * A
                # d(-min(surr1,surr2))/dlogp
                dlogp = -ratio * A if surr1 <= surr2 else 0.0
                # dlogp/dz = e_a - p
                dz[sl] += dlogp * (-p)
                dz[int(bounds[i]) + a] += dlogp
                # entropy bonus: d(-beta*H)/dz = beta * p * (log p + H)
                logp_mat = np.log(p + 1e-12)
                Hs = float(-(p * logp_mat).sum())
                dz[sl] += ENTROPY_BETA * p * (logp_mat + Hs)
                ratios[i] = ratio
                ents[i] = Hs

            # backprop into the actor MLP
            dW2 = h.T @ dz.reshape(-1, 1) / len(all_feats)
            db2 = dz.mean()
            dh = np.outer(dz, self.actor.W2.ravel()) / len(all_feats)
            dzz = dh * (1 - h**2)
            dW1 = all_feats.T @ dzz / len(all_feats)
            db1 = dzz.mean(axis=0)
            for name, grad in (("W1", dW1), ("b1", db1), ("W2", dW2), ("b2", np.array([db2]))):
                self.actor.adam(name, grad)

            # critic: MSE(value, discounted return)
            vpred, hc = self.critic.forward(cfeats)
            verr = vpred - returns
            dsv = 2 * verr / len(cfeats)
            dW2c = hc.T @ dsv.reshape(-1, 1) / len(cfeats)
            db2c = dsv.mean()
            dhc = np.outer(dsv, self.critic.W2.ravel()) / len(cfeats)
            dzc = dhc * (1 - hc**2)
            dW1c = cfeats.T @ dzc / len(cfeats)
            db1c = dzc.mean(axis=0)
            for name, grad in (("W1", dW1c), ("b1", db1c), ("W2", dW2c), ("b2", np.array([db2c]))):
                self.critic.adam(name, grad)

            ratio_mean, ent_mean = float(ratios.mean()), float(ents.mean())

        self.update_count += 1
        return {"ratio": round(ratio_mean, 3), "entropy": round(ent_mean, 3)}

    def status(self) -> dict:
        return {"updates": self.update_count, **self.last_stats}


def quick_train(
    net: Network,
    gnn: GNN,
    agent: PPOAgent,
    emb: np.ndarray,
    x_e: np.ndarray,
    start: str,
    goal: str,
    cost: CostFn,
    episodes: int = 60,
    max_len: int = 30,
    seed: int = 0,
) -> dict:
    """Train the agent on rollouts through the *current* live network."""
    t0 = time.time()
    rng = np.random.default_rng(seed + 13)
    road_index = gnn.r_index
    node_index = gnn.n_index
    goal_xy = net.roads[goal].points[-1]
    start_xy = net.roads[start].points[-1]
    initial_rem = math.hypot(start_xy[0] - goal_xy[0], start_xy[1] - goal_xy[1]) / MAX_SPEED or 1.0
    tt_pred = gnn.predict_tt(emb, x_e)

    def rollout_cost(rid: str) -> float:
        return float(tt_pred[road_index[rid]])

    cand_l: list[np.ndarray] = []
    act_l: list[int] = []
    logp_l: list[float] = []
    cfeat_l: list[np.ndarray] = []
    ret_l: list[float] = []
    reached = 0
    total_steps = 0

    for _ in range(episodes):
        u = start
        visited = {start}
        traj = []
        for step in range(max_len):
            cands = [v for v, _ in net.successors(u) if v not in visited]
            if not cands:
                cands = [v for v, _ in net.successors(u)]
            if not cands:
                break
            f = np.stack(
                [
                    PPOAgent.actor_features(
                        emb, x_e, road_index, node_index, net, u, v, goal, initial_rem, goal_xy, visited
                    )
                    for v in cands
                ]
            )
            cf = PPOAgent.critic_features(
                emb, net, u, goal, node_index, initial_rem, goal_xy, step, max_len
            )
            logits = agent.logits(f)
            probs = softmax(logits)
            a = int(rng.choice(len(cands), p=probs))
            nxt = cands[a]
            reward = -rollout_cost(nxt)
            done = nxt == goal
            if done:
                reward += GOAL_BONUS
                reached += 1
            traj.append((f, cf, math.log(float(probs[a]) + 1e-12), reward, a, done))
            visited.add(nxt)
            u = nxt
            total_steps += 1
            if done:
                break

        rets = np.zeros(len(traj))
        running = 0.0
        if traj and not traj[-1][5]:
            running = agent.value(traj[-1][1])
        for i in range(len(traj) - 1, -1, -1):
            running = traj[i][3] + GAMMA * running
            rets[i] = running
        for (f, cf, lp, _r, a, _done), ret in zip(traj, rets):
            cand_l.append(f)
            cfeat_l.append(cf)
            logp_l.append(lp)
            act_l.append(a)
            ret_l.append(float(ret))

    if not cand_l:
        return {"episodes": 0, "steps": 0, "ms": 0}

    cfeats = np.stack(cfeat_l)
    old_logp = np.array(logp_l)
    acts = np.array(act_l)
    rets = np.array(ret_l)

    vpred, _ = agent.critic.forward(cfeats)
    adv = rets - vpred
    adv = (adv - adv.mean()) / (adv.std() + 1e-8)

    stats = agent.ppo_update(cand_l, acts, old_logp, cfeats, adv, rets, epochs=4)
    ms = int((time.time() - t0) * 1000)
    out = {
        "episodes": episodes,
        "steps": int(total_steps),
        "reached": reached,
        "reachRate": round(reached / max(1, episodes), 3),
        "ms": ms,
        **stats,
    }
    agent.last_stats = out
    return out


def plan_ppo(
    net: Network,
    gnn: GNN,
    agent: PPOAgent,
    emb: np.ndarray,
    x_e: np.ndarray,
    start: str,
    goal: str,
    cost: CostFn,
) -> tuple[list[str] | None, dict]:
    """Greedy policy rollout start -> goal. Falls back to Dijkstra when the
    (still-learning) policy fails to reach the goal, and reports that honestly."""
    if start == goal:
        return [start], {"fallback": False, "used": "ppo"}
    road_index = gnn.r_index
    node_index = gnn.n_index
    goal_xy = net.roads[goal].points[-1]
    start_xy = net.roads[start].points[-1]
    initial_rem = math.hypot(start_xy[0] - goal_xy[0], start_xy[1] - goal_xy[1]) / MAX_SPEED or 1.0

    def heuristic(rid: str) -> float:
        p = net.roads[rid].points[-1]
        return math.hypot(p[0] - goal_xy[0], p[1] - goal_xy[1]) / MAX_SPEED

    # Best-first search whose edge weights are reshaped by the PPO actor:
    #   w(u,v) = live_cost(u,v) * (1 + (1 - p(v)))
    # where p is the policy's softmax preference among u's successors, so a
    # link the (GNN-embedded, goal-conditioned) policy likes is up to twice as
    # cheap as one it rejects.  Unlike a pure argmax rollout this cannot fall
    # into a dead end, so it keeps the reachability guarantee of a shortest
    # path search while still being the policy that picks the corridor.
    heap: list[tuple[float, float, str, list[str]]] = []
    best: dict[str, float] = {start: 0.0}
    heapq.heappush(heap, (heuristic(start), 0.0, start, [start]))
    seen: set[str] = set()
    budget = 6 * len(net.roads) + 60
    pops = 0
    while heap and pops <= budget:
        _f, g, u, path = heapq.heappop(heap)
        if u in seen:
            continue
        seen.add(u)
        pops += 1
        if u == goal:
            return path, {
                "fallback": False,
                "used": "ppo",
                "steps": len(path) - 1,
                "cost": round(g, 1),
                "explored": pops,
            }
        cands = [v for v, _ in net.successors(u) if v not in seen]
        if not cands:
            continue
        f = np.stack(
            [
                PPOAgent.actor_features(
                    emb, x_e, road_index, node_index, net, u, v, goal, initial_rem, goal_xy, set(path)
                )
                for v in cands
            ]
        )
        logits = agent.logits(f)
        logits = logits - logits.max()
        probs = np.exp(logits)
        probs = probs / max(probs.sum(), 1e-9)
        for v, p in zip(cands, probs):
            w = cost(v) * (1.0 + float(1.0 - p))
            ng = g + w
            if ng >= best.get(v, float("inf")):
                continue
            best[v] = ng
            heapq.heappush(heap, (ng + heuristic(v), ng, v, path + [v]))

    fb = dijkstra(net, start, goal, cost)
    if fb is None:
        return None, {"fallback": True, "used": "unreachable"}
    return fb, {"fallback": True, "used": "dijkstra-fallback", "explored": pops}
