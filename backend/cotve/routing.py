"""Route planning: Dijkstra, A*, and live-cost helpers.

All three compared planners work on the same graph (intersections = nodes,
roads = edges) and the same *live* cost function fed by CityFlow, so the only
difference between them is the search strategy:

  * Dijkstra - uniform-cost search over live edge costs
  * A*       - same costs + Euclidean lower bound to the goal
  * GNN+PPO  - learned policy picks the next road (see ppo.py)
"""

from __future__ import annotations

import heapq
import math
from typing import Callable

from .roadnet import MAX_SPEED, Network

CostFn = Callable[[str], float]

# fixed mean delay at a signalised intersection (half a cycle) - applied to
# every planner so the comparison stays fair
SIGNAL_DELAY_S = 12.0


def freeflow_cost(net: Network) -> CostFn:
    def cost(rid: str) -> float:
        road = net.roads[rid]
        c = road.length / MAX_SPEED
        if net.intersections[road.to_int].is_signal:
            c += SIGNAL_DELAY_S
        return c

    return cost


def live_cost(net: Network, speeds: dict[str, float], counts: dict[str, int]) -> CostFn:
    """Travel time estimate from *current* CityFlow state (seconds)."""

    def cost(rid: str) -> float:
        road = net.roads[rid]
        v = speeds.get(rid) or MAX_SPEED
        # floor the speed so a fully stopped link cannot make the cost explode
        v = max(4.0, min(v, MAX_SPEED))
        base = road.length / v
        cap = max(1.0, (road.length * road.n_lanes) / 14.0)
        queue = min(counts.get(rid, 0) / cap, 1.0)
        base += queue * (road.length / v) * 0.5  # stop-and-go penalty
        if net.intersections[road.to_int].is_signal:
            base += SIGNAL_DELAY_S * (1.0 + 0.5 * queue)
        return min(base, 180.0)

    return cost


def _neighbors(net: Network, rid: str) -> list[tuple[str, str]]:
    return net.successors(rid)


def shortest_path(
    net: Network,
    start: str,
    goal: str,
    cost: CostFn,
    heuristic: Callable[[str], float] | None = None,
    max_nodes: int = 200_000,
) -> list[str] | None:
    """Least-cost road sequence start -> goal (both road ids inclusive)."""
    if start not in net.roads or goal not in net.roads:
        return None
    if start == goal:
        return [start]
    h = heuristic or (lambda _r: 0.0)
    dist: dict[str, float] = {start: 0.0}
    prev: dict[str, str] = {}
    pq: list[tuple[float, str]] = [(h(start), start)]
    seen: set[str] = set()
    expanded = 0
    while pq:
        _, u = heapq.heappop(pq)
        if u in seen:
            continue
        seen.add(u)
        expanded += 1
        if expanded > max_nodes:
            break
        if u == goal:
            break
        for v, _inter in _neighbors(net, u):
            nd = dist[u] + cost(v)
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd + h(v), v))
    if goal not in dist and goal != start:
        return None
    path = [goal]
    while path[-1] != start:
        p = prev.get(path[-1])
        if p is None:
            return None
        path.append(p)
    path.reverse()
    return path


def dijkstra(net: Network, start: str, goal: str, cost: CostFn) -> list[str] | None:
    return shortest_path(net, start, goal, cost)


def _heuristic(net: Network, goal: str) -> Callable[[str], float]:
    gx, gy = net.roads[goal].points[-1]

    def h(rid: str) -> float:
        x, y = net.roads[rid].points[-1]
        return math.hypot(x - gx, y - gy) / MAX_SPEED

    return h


def astar(net: Network, start: str, goal: str, cost: CostFn) -> list[str] | None:
    return shortest_path(net, start, goal, cost, _heuristic(net, goal))


def path_distance(net: Network, path: list[str]) -> float:
    return sum(net.roads[r].length for r in path)


def path_time(path: list[str], cost: CostFn) -> float:
    return sum(cost(r) for r in path)


def edge_costs(net: Network, cost: CostFn) -> dict[str, float]:
    return {rid: cost(rid) for rid in net.roads}


def road_point_ratio(net: Network, road_id: str, x: float, y: float) -> float:
    """Fraction along a road closest to (x, y) - used for accident placement."""
    road = net.roads[road_id]
    best, best_d, best_t = 0.0, math.inf, 0.0
    n = max(4, int(road.length // 10))
    for i in range(n + 1):
        t = i / n
        px, py, _ = net.point_at(road_id, road.length * t)
        d = math.hypot(px - x, py - y)
        if d < best_d:
            best, best_d, best_t = road.length * t, d, t
    _ = best
    return best_t
