"""Graph Neural Network over the *live* CityFlow road network (numpy).

Graph definition (matches the project spec):
    nodes = intersections, edges = road segments

Node features   : traffic density, vehicle count, average speed, congestion
Edge features   : road length, travel time, vehicle count, capacity utilisation,
                  traffic condition (speed ratio)

The GNN does two things:
  1. embeds the network with 2 message-passing layers (mean aggregation + tanh)
  2. predicts each edge's travel time from those embeddings, and is trained
     online on *observed* traversals from the running simulation
     (sample = "a vehicle needed X seconds to cross road R at speed V")

Both the travel-time head *and* the message-passing weights receive gradients
every training step - a full backward pass through both layers - so the
embeddings are learned from real simulation data rather than being a fixed
random projection.  Targets are travel time in minutes, which keeps the loss
scale stable.
"""

from __future__ import annotations

import numpy as np

from .roadnet import MAX_SPEED, Network

NODE_IN = 4
EDGE_IN = 5
HIDDEN = 16


def _cap(road_len: float, lanes: int) -> float:
    return max(1.0, (road_len * lanes) / 14.0)  # ~14 m per vehicle incl. gap


class GNN:
    def __init__(self, net: Network, seed: int = 0, lr: float = 3e-3) -> None:
        self.net = net
        self.lr = lr
        self.rng = np.random.default_rng(seed)

        self.road_ids = sorted(net.roads.keys())
        self.node_ids = sorted(net.intersections.keys())
        self.r_index = {r: i for i, r in enumerate(self.road_ids)}
        self.n_index = {n: i for i, n in enumerate(self.node_ids)}
        self.M = len(self.road_ids)
        self.N = len(self.node_ids)

        self.src = np.array([self.n_index[net.roads[r].from_int] for r in self.road_ids])
        self.dst = np.array([self.n_index[net.roads[r].to_int] for r in self.road_ids])

        self.incident: list[list[int]] = [[] for _ in range(self.N)]
        for e in range(self.M):
            self.incident[self.src[e]].append(e)
            if self.dst[e] != self.src[e]:
                self.incident[self.dst[e]].append(e)

        rng = np.random.default_rng(seed + 11)

        def w(a: int, b: int) -> np.ndarray:
            return (rng.standard_normal((a, b)) * np.sqrt(2.0 / a)).astype(np.float64)

        # layer 1 (node + edge encoders)
        self.W1 = w(NODE_IN, HIDDEN)
        self.b1 = np.zeros(HIDDEN)
        self.We = w(EDGE_IN, HIDDEN)
        self.be = np.zeros(HIDDEN)
        # layer 2 (message passing)
        self.Ws = w(HIDDEN, HIDDEN)
        self.Wn = w(HIDDEN, HIDDEN)
        self.Wm = w(HIDDEN, HIDDEN)
        self.b2 = np.zeros(HIDDEN)
        # travel-time head: [emb_src, emb_dst, edge] -> 1
        self.Wh1 = w(HIDDEN * 2 + EDGE_IN, HIDDEN)
        self.bh1 = np.zeros(HIDDEN)
        self.Wh2 = w(HIDDEN, 1)
        self.bh2 = np.zeros(1)

        self._names = [
            "W1", "b1", "We", "be", "Ws", "b2", "Wn", "Wm", "Wh1", "bh1", "Wh2", "bh2",
        ]
        self._m = {n: np.zeros_like(getattr(self, n)) for n in self._names}
        self._v = {n: np.zeros_like(getattr(self, n)) for n in self._names}
        self._t = 0
        self.loss_ema: float | None = None
        self.train_steps = 0
        self.n_samples = 0

    # ------------------------------------------------------------------ #
    def features(self, speeds: dict[str, float], counts: dict[str, int]) -> tuple[np.ndarray, np.ndarray]:
        x_e = np.zeros((self.M, EDGE_IN))
        for i, rid in enumerate(self.road_ids):
            road = self.net.roads[rid]
            v = speeds.get(rid) or MAX_SPEED
            v = float(min(max(v, 1.0), MAX_SPEED))
            cap = _cap(road.length, road.n_lanes)
            n = float(counts.get(rid, 0))
            tt = road.length / v
            x_e[i] = [
                min(road.length, 800.0) / 800.0,   # length
                min(tt, 120.0) / 120.0,            # travel time (live)
                min(n / cap, 2.0) / 2.0,           # vehicle count / capacity
                v / MAX_SPEED,                     # average speed ratio
                min(n / cap, 1.0),                 # congestion
            ]
        x_n = np.zeros((self.N, NODE_IN))
        for j in range(self.N):
            inc = self.incident[j]
            if not inc:
                continue
            arr = x_e[inc]
            x_n[j] = [
                arr[:, 4].mean(),                  # density
                min(arr[:, 2].sum(), 4.0) / 4.0,   # vehicle count
                arr[:, 3].mean(),                  # average speed
                arr[:, 4].mean(),                  # congestion
            ]
        return x_n, x_e

    def _forward(self, x_n: np.ndarray, x_e: np.ndarray) -> dict:
        h1 = np.tanh(x_n @ self.W1 + self.b1)
        e = np.tanh(x_e @ self.We + self.be)
        agg = np.zeros_like(h1)
        deg = np.zeros((self.N, 1))
        for j in range(self.N):
            inc = self.incident[j]
            if not inc:
                continue
            agg[j] = (h1[self.src[inc]] @ self.Wn + e[inc] @ self.Wm).mean(axis=0)
            deg[j] = len(inc)
        h1a = h1 + agg / np.maximum(deg, 1.0)
        h2 = np.tanh(h1a @ self.Ws + self.b2)
        xs = np.concatenate([h2[self.src], h2[self.dst], x_e], axis=1)
        hh = np.tanh(xs @ self.Wh1 + self.bh1)
        pred_min = np.maximum(hh @ self.Wh2 + self.bh2, 0.05).ravel()
        return {"h1": h1, "e": e, "agg": agg, "deg": deg, "h1a": h1a, "h2": h2,
                "xs": xs, "hh": hh, "pred_min": pred_min}

    def embed(self, x_n: np.ndarray, x_e: np.ndarray) -> np.ndarray:
        """(N, HIDDEN) node embeddings from the current live features."""
        return self._forward(x_n, x_e)["h2"]

    def predict_tt(self, emb: np.ndarray | None = None, x_e: np.ndarray | None = None) -> np.ndarray:
        """Predicted travel time in **seconds** per edge."""
        if emb is None:
            x_n, x_e = self._last_features
            emb = self.embed(x_n, x_e)
        inp = np.concatenate([emb[self.src], emb[self.dst], x_e], axis=1)
        h = np.tanh(inp @ self.Wh1 + self.bh1)
        pred_min = np.maximum(h @ self.Wh2 + self.bh2, 0.05).ravel()
        return pred_min * 60.0

    # ------------------------------------------------------------------ #
    def _adam(self, name: str, grad: np.ndarray) -> None:
        lr = self.lr
        m = self._m[name]
        v = self._v[name]
        self._t += 1
        m *= 0.9
        m += 0.1 * grad
        v *= 0.999
        v += 0.001 * grad * grad
        mh = m / (1 - 0.9**self._t)
        vh = v / (1 - 0.999**self._t)
        getattr(self, name)[:] -= lr * mh / (np.sqrt(vh) + 1e-8)

    def train_step(self, edge_idx: np.ndarray, target_tt: np.ndarray) -> float:
        """One Adam step on (edge, observed travel time seconds) samples.

        Full backward pass: travel-time head -> message-passing layer ->
        node/edge encoders.
        """
        x_n, x_e = self._last_features
        f = self._forward(x_n, x_e)
        H = HIDDEN

        target_min = np.maximum(target_tt / 60.0, 0.05)
        pred_min = f["pred_min"]
        err = np.zeros(self.M)
        err[edge_idx] = pred_min[edge_idx] - target_min
        err = np.where(pred_min > 0.0501, err, 0.0)  # ReLU floor
        loss = float(np.mean(err[edge_idx] ** 2)) if len(edge_idx) else 0.0
        d_pred = np.zeros(self.M)
        d_pred[edge_idx] = (2.0 / max(1, len(edge_idx))) * err[edge_idx]

        # ---- head ----
        hh, xs = f["hh"], f["xs"]
        dW_h2 = hh.T @ d_pred.reshape(-1, 1)
        db_h2 = d_pred.sum()
        d_hh = np.outer(d_pred, self.Wh2.ravel()) * (1 - hh**2)
        dW_h1 = xs.T @ d_hh
        db_h1 = d_hh.sum(axis=0)
        d_xs = d_hh @ self.Wh1.T

        d_h2 = np.zeros_like(f["h2"])
        np.add.at(d_h2, self.src, d_xs[:, :H])
        np.add.at(d_h2, self.dst, d_xs[:, H : 2 * H])
        # d_xs[:, 2H:] is the gradient w.r.t. the raw edge features (input data)

        # ---- layer 2 ----
        d_h2_pre = d_h2 * (1 - f["h2"] ** 2)
        dW_s = f["h1a"].T @ d_h2_pre
        db_2 = d_h2_pre.sum(axis=0)
        d_h1a = d_h2_pre @ self.Ws.T
        d_deg_term = d_h1a  # h1a = h1 + agg/deg
        d_h1 = d_h1a.copy()
        d_agg = d_h1a / np.maximum(f["deg"], 1.0)

        # messages: agg[j] = mean over incident edges of (h1[src] @ Wn + e @ Wm)
        d_msg = np.zeros_like(f["e"])
        for j in range(self.N):
            inc = self.incident[j]
            if not inc:
                continue
            g = d_agg[j]
            for e_i in inc:
                d_msg[e_i] += g
        d_h1 = d_h1  # (direct)
        np.add.at(d_h1, self.src, d_msg @ self.Wn.T)
        d_e = d_msg @ self.Wm.T
        dW_n = f["h1"][self.src].T @ d_msg
        dW_m = f["e"].T @ d_msg
        _ = d_deg_term

        # ---- layer 1 ----
        d_h1_pre = d_h1 * (1 - f["h1"] ** 2)
        dW_1 = x_n.T @ d_h1_pre
        db_1 = d_h1_pre.sum(axis=0)
        d_e_pre = d_e * (1 - f["e"] ** 2)
        dW_e = x_e.T @ d_e_pre
        db_e = d_e_pre.sum(axis=0)

        for name, grad in (
            ("Wh2", dW_h2), ("bh2", np.array([db_h2])),
            ("Wh1", dW_h1), ("bh1", db_h1),
            ("Ws", dW_s), ("b2", db_2),
            ("Wn", dW_n), ("Wm", dW_m),
            ("W1", dW_1), ("b1", db_1),
            ("We", dW_e), ("be", db_e),
        ):
            self._adam(name, grad)

        self.train_steps += 1
        self.n_samples += len(edge_idx)
        self.loss_ema = loss if self.loss_ema is None else 0.95 * self.loss_ema + 0.05 * loss
        return loss

    def remember(self, x_n: np.ndarray, x_e: np.ndarray) -> None:
        self._last_features = (x_n, x_e)

    def status(self) -> dict:
        return {
            "trainSteps": self.train_steps,
            "samples": self.n_samples,
            # loss is MSE in minutes^2 of observed vs predicted travel time
            "loss": None if self.loss_ema is None else round(self.loss_ema, 4),
            "hidden": HIDDEN,
            "layers": 2,
        }
