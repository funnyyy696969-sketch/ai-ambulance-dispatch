"""Background traffic generation: turns a Network into a CityFlow flow file.

Flow files are static routes that CityFlow re-emits every `interval` seconds.
Vehicle ids are assigned by the engine as ``flow_<flowIndex>_<counter>`` and the
index is stable, so the backend can map every id back to its kind (car / bus /
truck) and route without extra bookkeeping.
"""

from __future__ import annotations

import math
import random

from .roadnet import Network

# per-kind physical parameters (meters / m/s) - CityFlow vehicle template
KINDS: dict[str, dict] = {
    "car": {
        "length": 4.5, "width": 1.9, "maxPosAcc": 2.0, "maxNegAcc": 4.5,
        "usualPosAcc": 2.0, "usualNegAcc": 4.5, "minGap": 2.5,
        "maxSpeed": 16.67, "headwayTime": 1.4,
    },
    "bus": {
        "length": 12.0, "width": 2.5, "maxPosAcc": 1.4, "maxNegAcc": 3.5,
        "usualPosAcc": 1.2, "usualNegAcc": 3.0, "minGap": 3.0,
        "maxSpeed": 12.5, "headwayTime": 1.8,
    },
    "truck": {
        "length": 8.0, "width": 2.4, "maxPosAcc": 1.5, "maxNegAcc": 3.8,
        "usualPosAcc": 1.3, "usualNegAcc": 3.2, "minGap": 3.0,
        "maxSpeed": 13.5, "headwayTime": 1.7,
    },
    "emergency": {  # ambulances are pushed manually, never emitted by a flow
        "length": 5.5, "width": 2.1, "maxPosAcc": 2.6, "maxNegAcc": 5.5,
        "usualPosAcc": 2.4, "usualNegAcc": 5.0, "minGap": 2.0,
        "maxSpeed": 22.0, "headwayTime": 1.0,
    },
}

_KIND_CYCLE = ["car", "car", "bus", "car", "truck", "car", "bus", "car", "truck", "car"]


def _heading(road_points: list[tuple[float, float]]) -> tuple[float, float]:
    (x0, y0), (x1, y1) = road_points[0], road_points[-1]
    return (x1 - x0, y1 - y0)


def _best_successor(net: Network, road_id: str, rng: random.Random, turn_bias: float) -> str | None:
    """Prefer continuing straight; occasionally turn, never U-turn."""
    opts = net.successors(road_id)
    if not opts:
        return None
    hx, hy = _heading(net.roads[road_id].points)
    if rng.random() < turn_bias:
        return rng.choice(opts)[0]
    hnorm = math.hypot(hx, hy) + 1e-9
    best, best_dot = None, -2.0
    for nid, _ in opts:
        ox, oy = _heading(net.roads[nid].points)
        dot = (hx * ox + hy * oy) / (hnorm * (math.hypot(ox, oy) + 1e-9))
        if dot > best_dot:
            best, best_dot = nid, dot
    return best or opts[0][0]


def generate_flows(
    net: Network,
    seed: int = 7,
    n_flows: int | None = None,
    interval: float = 7.0,
    max_roads: int = 14,
    turn_bias: float = 0.18,
) -> tuple[list[dict], list[dict]]:
    """Return (flowFile JSON, per-flow metadata with kind + route)."""
    rng = random.Random(seed)
    roads = sorted(net.roads.keys())
    if not roads:
        return [], []
    if n_flows is None:
        n_flows = max(12, len(roads) // 2)

    flows: list[dict] = []
    meta: list[dict] = []
    seen: set[tuple[str, ...]] = set()

    attempts = 0
    while len(flows) < n_flows and attempts < n_flows * 40:
        attempts += 1
        start = rng.choice(roads)
        route = [start]
        cur = start
        for _ in range(rng.randint(4, max_roads)):
            nxt = _best_successor(net, cur, rng, turn_bias)
            if nxt is None:
                break
            route.append(nxt)
            cur = nxt
        if len(route) < 3:
            continue
        key = tuple(route)
        if key in seen:
            continue
        seen.add(key)

        kind = _KIND_CYCLE[len(flows) % len(_KIND_CYCLE)]
        template = dict(KINDS[kind])
        flows.append(
            {
                "vehicle": template,
                "route": route,
                "interval": interval * rng.uniform(0.85, 1.35),
                "startTime": 0,
                "endTime": -1,
            }
        )
        meta.append({"kind": kind, "route": route, "index": len(flows) - 1})

    return flows, meta


def ambulance_template() -> dict:
    return dict(KINDS["emergency"])
