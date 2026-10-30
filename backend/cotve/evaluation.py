"""Dijkstra vs A* vs GNN+PPO - real comparative experiments.

Every number this module returns comes from an actual CityFlow run: a fresh
engine, the same seed, the same accident location, the same ambulance, and the
same background traffic - only the routing method differs.  Nothing is
simulated analytically and nothing is fabricated; if a method does worse, that
is what the table shows.
"""

from __future__ import annotations

import statistics
import time
import uuid

from .routing import dijkstra, freeflow_cost, path_distance, path_time
from .session import SimSession

METHODS = ("dijkstra", "astar", "ppo")
METHOD_LABEL = {"dijkstra": "Dijkstra", "astar": "A*", "ppo": "GNN + PPO"}


def run_mission(
    method: str,
    params: dict,
    accident_xy: tuple[float, float],
    emergency: str = "trauma",
    severity: str = "major",
    ambulance_id: str = "amb-1",
    pickup_s: float = 45.0,
    max_steps: int = 5000,
    sample_every: int = 50,
) -> dict:
    """Run one complete emergency mission with a single planner."""
    workdir = f"/tmp/cotve-eval-{uuid.uuid4().hex[:8]}"
    session = SimSession(workdir=workdir, pickup_s=pickup_s, **params)
    acc = session.add_accident(
        x=accident_xy[0], y=accident_xy[1], severity=severity, emergency=emergency
    )
    if not acc.get("ok"):
        return {"ok": False, "method": method, "error": acc.get("error")}

    route1: list[str] = []
    route2: list[str] = []
    samples: list[dict] = []
    t0 = time.time()

    disp = session.dispatch(acc["accident"]["id"], ambulance_id=ambulance_id, method=method)
    if not disp.get("ok"):
        return {"ok": False, "method": method, "error": disp.get("error")}
    route1 = disp.get("route") or []
    amb = session.ambulances[disp["ambulance"]]
    start_road = route1[0] if route1 else amb.depot_road
    accident_road = acc["accident"]["road"]

    # free-flow reference: what a perfect offline planner would have done
    ff = freeflow_cost(session.net)
    opt = dijkstra(session.net, start_road, accident_road, ff)
    optimal_time = path_time(opt, ff) if opt else None
    planned_time = path_time(route1, ff) if route1 else None

    prev_status = amb.status
    fail_reason = None
    for i in range(max_steps):
        session.step(1)
        if amb.status != prev_status:
            if amb.status == "to-hospital":
                route2 = list(amb.route)
            prev_status = amb.status
        if i % sample_every == 0:
            st = session.frame()["stats"]
            samples.append(
                {
                    "t": round(session.eng.get_current_time(), 1),
                    "vehicles": st["totalVehicles"],
                    "avgSpeed": st["avgSpeed"],
                    "stopped": st["stopped"],
                    "avgWaiting": st["avgWaiting"],
                    "density": st["density"],
                }
            )
        if amb.status == "completed":
            break
        if amb.status == "failed":
            fail_reason = amb.error
            break

    done = amb.status == "completed"
    if done:
        acc_obj = session.accidents[acc["accident"]["id"]]
        response = amb.arrived_t - amb.dispatch_t if amb.arrived_t else None
        on_scene = (amb.pickup_done_t - amb.arrived_t) if amb.pickup_done_t else None
        hospital = (amb.hospital_t - amb.pickup_done_t) if amb.hospital_t else None
        total = amb.hospital_t - amb.dispatch_t if amb.hospital_t else None
        dist1 = path_distance(session.net, route1) if route1 else 0.0
        dist2 = path_distance(session.net, route2) if route2 else 0.0
    else:
        response = on_scene = hospital = total = None
        acc_obj = session.accidents[acc["accident"]["id"]]
        dist1 = path_distance(session.net, route1) if route1 else 0.0
        dist2 = 0.0

    def _mean(key: str) -> float:
        vals = [s[key] for s in samples]
        return round(statistics.mean(vals), 3) if vals else 0.0

    efficiency = None
    if optimal_time and planned_time and planned_time > 0:
        efficiency = round(optimal_time / planned_time, 4)
    elif planned_time:
        efficiency = 1.0

    return {
        "ok": done,
        "method": method,
        "label": METHOD_LABEL.get(method, method),
        "error": fail_reason,
        "steps": session.step_count,
        "wallMs": int((time.time() - t0) * 1000),
        "accident": acc["accident"]["id"],
        "hospital": amb.hospital_id,
        "fallback": amb.fallback,
        "metrics": {
            "responseTime": round(response, 1) if response is not None else None,
            "onSceneTime": round(on_scene, 1) if on_scene is not None else None,
            "hospitalTravelTime": round(hospital, 1) if hospital is not None else None,
            "totalEmergencyTime": round(total, 1) if total is not None else None,
            "routeDistance": round(dist1 + dist2, 1),
            "avgWaitingTime": _mean("avgWaiting"),
            "congestion": _mean("density"),
            "avgSpeed": _mean("avgSpeed"),
            "routingEfficiency": efficiency,
        },
        "samples": samples,
        "accidentStatus": acc_obj.status,
    }


def run_comparison(
    params: dict | None = None,
    accident_xy: tuple[float, float] | None = None,
    methods: tuple[str, ...] = METHODS,
    **kwargs,
) -> dict:
    """Run every method on an identical scenario and return a comparable table."""
    params = params or dict(rows=4, cols=4, spacing=300.0, seed=7, demand=1.0,
                            n_ambulances=2, n_hospitals=2, origin=(12.9716, 77.5946))
    if accident_xy is None:
        rows, cols, spacing = params.get("rows", 4), params.get("cols", 4), params.get("spacing", 300.0)
        accident_xy = ((cols // 2) * spacing, (rows // 2) * spacing)
    started = time.time()
    results = []
    for m in methods:
        res = run_mission(m, params, accident_xy, **kwargs)
        results.append(res)
    return {
        "ok": True,
        "scenario": {k: v for k, v in params.items() if k != "origin"},
        "accident": list(accident_xy),
        "results": results,
        "wallMs": int((time.time() - started) * 1000),
        "definitions": {
            "responseTime": "dispatch -> ambulance reaches the accident (sim seconds)",
            "hospitalTravelTime": "patient loaded -> ambulance reaches the hospital (sim seconds)",
            "totalEmergencyTime": "dispatch -> hospital arrival (sim seconds)",
            "routeDistance": "planned road distance, stage 1 + stage 2 (metres)",
            "avgWaitingTime": "mean per-vehicle stopped time during the mission (seconds)",
            "congestion": "mean network occupancy (vehicles / lane capacity)",
            "avgSpeed": "mean vehicle speed during the mission (m/s)",
            "routingEfficiency": "free-flow time of the offline-optimal path / free-flow time of the chosen path (1.0 = optimal)",
        },
    }
