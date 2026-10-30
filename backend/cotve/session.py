"""The CoTV-E CityFlow session: one running microscopic simulation.

Everything the dashboard shows comes from here:
  * CityFlow stepping + background traffic (cars / buses / trucks)
  * ambulances pushed into the same engine and driven along planned routes
  * accidents and hospital selection
  * live network features -> GNN embeddings -> PPO routing
  * emergency signal priority through ``set_tl_phase``
  * the metrics panel values (they are measured, never invented)
"""

from __future__ import annotations

import json
import math
import os
import random
import threading
import time
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from .flows import ambulance_template, generate_flows
from .gnn import GNN
from .ppo import PPOAgent, plan_ppo, quick_train
from .roadnet import MAX_SPEED, GeoTransform, Network, build_graph, build_grid, pick_facilities
from .routing import astar, dijkstra, freeflow_cost, live_cost, path_distance, path_time
from .signals import SignalController

INTERVAL = 0.2  # seconds of simulated time per engine step
BASE_HZ = 5.0  # steps per wall-second at 1x speed (=> 1x == real time)
PICKUP_S = 45.0  # on-scene patient loading time (sim seconds)
PRIORITY_TRIGGER_M = 80.0  # metres before an intersection where priority kicks in
AMB_COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#f59e0b", "#a855f7", "#06b6d4"]
METHODS = ("ppo", "dijkstra", "astar")


@dataclass
class Ambulance:
    id: str
    color: str
    depot_road: str
    status: str = "idle"  # idle | assigned | to-accident | loading | to-hospital | completed | failed
    cityflow_id: str | None = None
    route: list[str] = field(default_factory=list)
    accident_id: str | None = None
    hospital_id: str | None = None
    method: str = "ppo"
    fallback: bool = False
    dispatch_t: float = 0.0
    arrived_t: float | None = None
    pickup_done_t: float | None = None
    hospital_t: float | None = None
    dwell_until: float | None = None
    last_road: str | None = None
    last_dist: float = 0.0
    last_t: float = 0.0
    last_xy: tuple[float, float] | None = None
    speed: float = 0.0
    pending: bool = False
    spawned: bool = False
    watch_road: str | None = None  # road the accident / hospital sits on
    saw_watch: bool = False
    passed_target: bool = False
    error: str | None = None
    eta_s: float | None = None


@dataclass
class Accident:
    id: str
    x: float
    y: float
    lat: float
    lng: float
    road: str
    dist: float
    severity: str
    emergency: str
    status: str = "reported"  # reported | assigned | picked-up | resolved
    ambulance: str | None = None
    hospital: str | None = None
    reported_t: float = 0.0
    ambulance_arrived_t: float | None = None
    pickup_t: float | None = None
    hospital_arrived_t: float | None = None
    patient: str = "waiting"


class SimSession:
    """Owns one CityFlow engine plus the AI/control layers around it."""

    # ------------------------------------------------------------------ #
    def __init__(
        self,
        rows: int = 5,
        cols: int = 5,
        spacing: float = 300.0,
        seed: int = 7,
        demand: float = 0.75,
        lanes: int = 2,
        n_ambulances: int = 2,
        n_hospitals: int = 3,
        origin: tuple[float, float] = (12.9716, 77.5946),
        graph: dict | None = None,
        workdir: str = "/tmp/cotve-cityflow",
        pickup_s: float = PICKUP_S,
    ) -> None:
        self.workdir = workdir
        os.makedirs(workdir, exist_ok=True)
        self.seed = seed
        self.demand = demand
        self.pickup_s = pickup_s
        self.origin = origin
        self.params = dict(
            rows=rows, cols=cols, spacing=spacing, seed=seed, demand=demand,
            lanes=lanes, n_ambulances=n_ambulances, n_hospitals=n_hospitals,
            graph=graph,
        )
        self.geo = GeoTransform(*origin)

        if graph:
            self.net: Network = build_graph(graph["nodes"], graph["edges"], self.geo)
            self.scenario_name = graph.get("name", "osm")
        else:
            self.net = build_grid(rows=rows, cols=cols, spacing=spacing, n_lanes=lanes, geo=self.geo)
            self.scenario_name = "grid"

        self.hospitals = pick_facilities(self.net, n_hospitals, "hospital")
        self.depots = pick_facilities(self.net, max(2, n_ambulances), "depot")

        self.signals = SignalController(self.net)
        self.gnn = GNN(self.net, seed=seed)
        self.agent = PPOAgent(seed=seed)

        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._running = False
        self.paused = True
        self.speed = 1.0
        self.step_count = 0

        # live network state (updated every step)
        self.road_speed: dict[str, float] = {}
        self.road_count: dict[str, int] = {}
        self.avg_speed = 0.0
        self.stopped = 0
        self.wait_time: dict[str, float] = {}
        self.avg_waiting = 0.0
        self.density = 0.0

        # simulation objects
        self.ambulances: dict[str, Ambulance] = {}
        self.accidents: dict[str, Accident] = {}
        self._pending_push: list[str] = []
        self._vehicle_pos: dict[str, dict] = {}
        self._veh_track: dict[str, tuple[str, float, float]] = {}
        self._tt_samples: list[tuple[str, float]] = []
        self.events: list[dict] = []
        self.last_training: dict | None = None
        self._acc_seq = 0
        self._route_cache: dict[str, tuple] = {}

        self._build_engine()
        for i in range(n_ambulances):
            depot = self.depots[i % len(self.depots)] if self.depots else None
            road = self._road_at(depot["x"], depot["y"]) if depot else sorted(self.net.roads)[0]
            amb = Ambulance(id=f"amb-{i + 1}", color=AMB_COLORS[i % len(AMB_COLORS)], depot_road=road)
            self.ambulances[amb.id] = amb

    # ------------------------------ setup -------------------------------- #
    def _road_at(self, x: float, y: float) -> str:
        rid, _d, _perp = self.net.nearest_road(x, y)
        return rid

    def _build_engine(self) -> None:
        flows, self.flow_meta = generate_flows(
            self.net,
            seed=self.seed,
            n_flows=max(8, len(self.net.roads) // 4),
            interval=25.0 / max(0.1, self.demand),
        )
        roadnet = self.net.to_cityflow_json()
        with open(os.path.join(self.workdir, "roadnet.json"), "w") as f:
            json.dump(roadnet, f)
        with open(os.path.join(self.workdir, "flow.json"), "w") as f:
            json.dump(flows, f)
        cfg = {
            "interval": INTERVAL,
            "seed": self.seed,
            "dir": self.workdir.rstrip("/") + "/",
            "roadnetFile": "roadnet.json",
            "flowFile": "flow.json",
            "rlTrafficLight": True,  # required for set_tl_phase / priority
            "saveReplay": False,
        }
        cfg_path = os.path.join(self.workdir, "config.json")
        with open(cfg_path, "w") as f:
            json.dump(cfg, f)

        import cityflow  # imported lazily so the module can be imported without the engine

        self._cityflow = cityflow
        self.eng = cityflow.Engine(cfg_path, thread_num=1)
        self.signals.reset(0.0)
        self.signals.apply_initial(self.eng)
        self.step_count = 0
        x_n, x_e = self.gnn.features(self.road_speed, self.road_count)
        self.gnn.remember(x_n, x_e)
        self.emb = self.gnn.embed(x_n, x_e)
        self.x_e = x_e

    def reset(self) -> None:
        with self._lock:
            self._running = False
            self.eng = None
            self._build_engine()
            self.paused = True
            self.speed = 1.0
            self.ambulances = {}
            self.accidents = {}
            self._pending_push = []
            self._vehicle_pos = {}
            self._veh_track = {}
            self._tt_samples = []
            self._route_cache = {}
            self.wait_time = {}
            self.events = []
            self._acc_seq = 0
            for i in range(self.params["n_ambulances"]):
                depot = self.depots[i % len(self.depots)] if self.depots else None
                road = self._road_at(depot["x"], depot["y"]) if depot else sorted(self.net.roads)[0]
                amb = Ambulance(id=f"amb-{i + 1}", color=AMB_COLORS[i % len(AMB_COLORS)], depot_road=road)
                self.ambulances[amb.id] = amb

    # --------------------------- time control ---------------------------- #
    def start(self) -> None:
        with self._lock:
            self.paused = False
            self._running = True
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, daemon=True)
                self._thread.start()

    def pause(self) -> None:
        with self._lock:
            self.paused = True

    def resume(self) -> None:
        with self._lock:
            self.paused = False
            self.start()

    def stop(self) -> None:
        with self._lock:
            self.paused = True
            self._running = False

    def set_speed(self, speed: float) -> None:
        self.speed = max(0.25, min(float(speed), 10.0))

    def _loop(self) -> None:
        while self._running:
            if self.paused:
                time.sleep(0.05)
                continue
            t0 = time.time()
            try:
                self.step(1)
            except Exception as exc:  # keep the service alive; surface it in events
                self.events.append({"t": time.time(), "kind": "error", "message": str(exc)})
                self.paused = True
                break
            period = (1.0 / (BASE_HZ * self.speed)) - (time.time() - t0)
            if period > 0:
                time.sleep(period)

    def step_sync(self, n: int = 1) -> None:
        """Advance n steps regardless of pause (the 'step' control)."""
        for _ in range(n):
            self.step(1)

    # ------------------------------ stepping ----------------------------- #
    def step(self, n: int = 1) -> None:
        with self._lock:
            for _ in range(n):
                self._step_once()

    def _step_once(self) -> None:
        eng = self.eng
        # register vehicles that were pushed since the last step
        before = set(eng.get_vehicles())
        eng.next_step()
        after = set(eng.get_vehicles())
        self.step_count += 1
        t = eng.get_current_time()

        if self._pending_push:
            # only claim vehicles we pushed - never a flow vehicle
            new_manual = sorted(i for i in (after - before) if i.startswith("manually_pushed"))
            for amb_id in list(self._pending_push):
                amb = self.ambulances.get(amb_id)
                if not amb:
                    self._pending_push.remove(amb_id)
                    continue
                if new_manual:
                    amb.cityflow_id = new_manual.pop(0)
                    amb.pending = False
                    amb.spawned = True
                    self._pending_push.remove(amb_id)
                elif amb.dispatch_t and t - amb.dispatch_t > 10.0:
                    amb.status = "failed"
                    amb.error = "CityFlow rejected the ambulance route (vehicle never spawned)"
                    amb.pending = False
                    self._pending_push.remove(amb_id)

        self._scan_vehicles(t)
        self._update_ambulances(t)
        self._update_priority(t)
        self.signals.update(t, eng)
        self._maybe_train(t)

    # --------------------------- live measurements ----------------------- #
    def _scan_vehicles(self, t: float) -> None:
        eng = self.eng
        lane_counts: dict[str, int] = eng.get_lane_vehicle_count()
        road_counts: dict[str, int] = {}
        for lane, n in lane_counts.items():
            road = lane.rsplit("_", 1)[0]
            road_counts[road] = road_counts.get(road, 0) + n
        self.road_count = road_counts

        speeds: dict[str, list[float]] = {}
        total_speed = 0.0
        stopped = 0
        new_pos: dict[str, dict] = {}
        for vid in eng.get_vehicles():
            info = eng.get_vehicle_info(vid)
            if "road" not in info:
                continue
            road = info["road"]
            dist = float(info["distance"])
            spd = float(info["speed"])
            speeds.setdefault(road, []).append(spd)
            total_speed += spd
            if spd < 0.1:
                stopped += 1
                self.wait_time[vid] = self.wait_time.get(vid, 0.0) + INTERVAL
            else:
                self.wait_time.pop(vid, None)
            lane = info.get("drivable", "")
            lane_idx = 0
            if "_" in lane:
                try:
                    lane_idx = int(lane.rsplit("_", 1)[1])
                except ValueError:
                    lane_idx = 0
            x, y, heading = self.net.point_at(road, dist) if road in self.net.roads else (0.0, 0.0, 0.0)
            # lateral offset so lanes don't overlap visually
            nx, ny = -math.sin(heading), math.cos(heading)
            off = (lane_idx + 0.5) * 3.5 - (self.net.roads[road].n_lanes * 3.5) / 2 if road in self.net.roads else 0
            kind = self._kind_of(vid)
            new_pos[vid] = {
                "id": vid,
                "kind": kind,
                "road": road,
                "x": x + nx * off,
                "y": y + ny * off,
                "h": heading,
                "speed": spd,
            }
            self._observe_traversal(vid, road, dist, t)

        self._vehicle_pos = new_pos
        for road, vals in speeds.items():
            mean = sum(vals) / len(vals)
            self.road_speed[road] = 0.7 * self.road_speed.get(road, mean) + 0.3 * mean

        n = len(new_pos)
        self.avg_speed = total_speed / n if n else 0.0
        self.stopped = stopped
        waits = list(self.wait_time.values())
        self.avg_waiting = sum(waits) / len(waits) if waits else 0.0
        cap = sum((r.length * r.n_lanes) / 14.0 for r in self.net.roads.values())
        self.density = (n / cap) if cap else 0.0

        # drop per-vehicle wait bookkeeping for vehicles that left
        for vid in list(self.wait_time):
            if vid not in new_pos:
                self.wait_time.pop(vid, None)

    def _kind_of(self, vid: str) -> str:
        if vid.startswith("manually_pushed") or vid.startswith("amb"):
            return "ambulance" if vid in self._amb_ids() else "emergency"
        if vid.startswith("flow_"):
            try:
                idx = int(vid.split("_")[1])
                return self.flow_meta[idx]["kind"] if idx < len(self.flow_meta) else "car"
            except (IndexError, ValueError):
                return "car"
        return "car"

    def _amb_ids(self) -> set[str]:
        return {a.cityflow_id for a in self.ambulances.values() if a.cityflow_id}

    def _observe_traversal(self, vid: str, road: str, dist: float, t: float) -> None:
        """Record (road, observed traversal seconds) samples for GNN training."""
        prev = self._veh_track.get(vid)
        if prev is None:
            self._veh_track[vid] = (road, dist, t)
            return
        p_road, p_dist, p_t = prev
        if p_road == road:
            self._veh_track[vid] = (road, p_dist, p_t)
            return
        dt = t - p_t
        dd = dist - p_dist if road == p_road else self.net.roads[p_road].length - p_dist + dist if p_road in self.net.roads else 0.0
        self._veh_track[vid] = (road, dist, t)
        if dt < 2.0 or dd < 5.0:
            return
        speed = dd / dt
        if speed <= 0.2:
            return
        length = self.net.roads[p_road].length if p_road in self.net.roads else 0.0
        if length <= 0:
            return
        tt = min(length / speed, 600.0)
        self._tt_samples.append((p_road, tt))
        if len(self._tt_samples) > 6000:
            del self._tt_samples[:3000]

    def _maybe_train(self, t: float) -> None:
        """Refresh GNN embeddings from live features and train on new samples."""
        x_n, x_e = self.gnn.features(self.road_speed, self.road_count)
        self.gnn.remember(x_n, x_e)
        self.emb = self.gnn.embed(x_n, x_e)
        self.x_e = x_e
        if self.step_count % 25 == 0 and self._tt_samples:
            batch = random.Random(self.seed + self.step_count).sample(
                self._tt_samples, min(32, len(self._tt_samples))
            )
            idx = np.array([self.gnn.r_index[r] for r, _ in batch if r in self.gnn.r_index])
            vals = np.array([tt for r, tt in batch if r in self.gnn.r_index], dtype=float)
            if len(idx):
                self.gnn.train_step(idx, vals)

    # ----------------------------- ambulance ----------------------------- #
    def _cost(self):
        return live_cost(self.net, self.road_speed, self.road_count)

    def _plan(self, method: str, start: str, goal: str) -> tuple[list[str] | None, dict]:
        # three genuinely different planners: Dijkstra on static free-flow cost
        # (what a non-adaptive navigator does), A* on the live cost with an
        # admissible heuristic, and GNN+PPO where the learned policy reshapes
        # the live cost of every link
        if method == "dijkstra":
            return dijkstra(self.net, start, goal, freeflow_cost(self.net)), {
                "fallback": False, "used": "dijkstra"
            }
        if method == "astar":
            # A* runs on the live cost with an admissible heuristic: a
            # stronger, still classical baseline than plain Dijkstra
            return astar(self.net, start, goal, self._cost()), {
                "fallback": False, "used": "astar"
            }
        cost = self._cost()
        path, info = plan_ppo(self.net, self.gnn, self.agent, self.emb, self.x_e, start, goal, cost)
        return path, info

    def _pad_route(self, route: list[str]) -> list[str]:
        """CityFlow silently refuses to insert (or re-route) a vehicle whose
        route is a single road - verified experimentally: push_vehicle and
        set_vehicle_route both no-op on a 1-road route.  A plan is one road
        long whenever the ambulance's depot already *is* the target road, so
        append one successor road in that case."""
        if not route or len(route) >= 2:
            return route
        succ = [v for v, _ in self.net.successors(route[0])]
        if not succ:
            return route
        return [route[0], succ[0]]

    def _apply_route(self, amb: Ambulance, route: list[str]) -> None:
        route = self._pad_route(route)
        amb.route = route
        amb.pending = False
        if amb.cityflow_id and amb.cityflow_id in self.eng.get_vehicles():
            # set_vehicle_route takes the route *excluding* the current road
            rest = route[1:] if route and route[0] == (amb.last_road or route[0]) else route
            try:
                ok = self.eng.set_vehicle_route(amb.cityflow_id, rest)
            except RuntimeError as exc:
                amb.error = str(exc)
                ok = False
            if not ok:
                # engine refused: re-push from the first road of the plan
                self._push(amb, route)
        else:
            self._push(amb, route)

    def _push(self, amb: Ambulance, route: list[str]) -> None:
        amb.cityflow_id = None
        self.eng.push_vehicle(ambulance_template(), route)
        amb.pending = True
        amb.last_road = route[0] if route else None
        amb.last_dist = 0.0
        amb.last_t = eng_now(self.eng)
        self._pending_push.append(amb.id)

    def dispatch(self, accident_id: str, ambulance_id: str | None = None, method: str = "ppo") -> dict:
        with self._lock:
            acc = self.accidents.get(accident_id)
            if acc is None:
                return {"ok": False, "error": "unknown accident"}
            if method not in METHODS:
                method = "ppo"
            if acc.ambulance:
                return {"ok": False, "error": "accident already has an assigned ambulance"}

            idle = [
                a
                for a in self.ambulances.values()
                if a.status in ("idle", "completed") and not a.pending
            ]
            if ambulance_id:
                idle = [a for a in idle if a.id == ambulance_id]
            if not idle:
                return {"ok": False, "error": "no idle ambulance available"}

            t = eng_now(self.eng)
            if self.agent.update_count == 0:
                # first dispatch of this session: warm the policy up for real
                self._run_training(40)
            cost = self._cost()
            scored = []
            for amb in idle:
                start = amb.last_road if amb.last_road and amb.cityflow_id else amb.depot_road
                path, info = self._plan(method, start, acc.road)
                if not path:
                    continue
                scored.append((path_time(path, cost), amb, path, info))
            if not scored:
                return {"ok": False, "error": "no reachable route to the accident"}
            scored.sort(key=lambda s: s[0])
            eta, amb, path, info = scored[0]

            amb.status = "to-accident"
            amb.accident_id = acc.id
            amb.method = method
            amb.fallback = bool(info.get("fallback"))
            amb.dispatch_t = t
            amb.arrived_t = None
            amb.pickup_done_t = None
            amb.hospital_t = None
            amb.dwell_until = None
            amb.eta_s = eta
            amb.error = None
            amb.last_road = path[0] if path else amb.depot_road
            amb.watch_road = acc.road
            amb.saw_watch = False
            amb.passed_target = False
            self._apply_route(amb, path)
            acc.ambulance = amb.id
            acc.status = "assigned"
            self.events.append(
                {"t": t, "kind": "dispatch", "message": f"{amb.id} -> accident {acc.id} via {method}"}
            )
            return {
                "ok": True,
                "ambulance": amb.id,
                "method": method,
                "route": path,
                "eta": round(eta, 1),
                "info": info,
                "candidates": [
                    {"ambulance": a.id, "eta": round(e, 1)} for e, a, _p, _i in scored
                ],
            }

    def rank_hospitals(self, accident_id: str, emergency: str = "") -> list[dict]:
        acc = self.accidents.get(accident_id)
        if not acc:
            return []
        cost = self._cost()
        out = []
        for h in self.hospitals:
            road = self._road_at(h["x"], h["y"])
            path = dijkstra(self.net, acc.road, road, cost)
            if not path:
                continue
            tt = path_time(path, cost)
            dist = path_distance(self.net, path)
            # suitability: verified specialty tag only (never invented capability)
            specs = h.get("specialties", [])
            suit = 1.0 if ("trauma" in specs and "trauma" in emergency.lower()) or "emergency" in specs else 0.6
            score = 0.55 * (tt / 600.0) + 0.25 * (dist / 4000.0) + 0.30 * suit
            out.append(
                {
                    "id": h["id"],
                    "name": h["name"],
                    "road": road,
                    "eta": round(tt, 1),
                    "distance": round(dist, 1),
                    "suitability": round(suit, 2),
                    "score": round(score, 4),
                }
            )
        out.sort(key=lambda r: r["score"])
        return out

    def _update_ambulances(self, t: float) -> None:
        for amb in self.ambulances.values():
            info = None
            if amb.cityflow_id:
                info = self._vehicle_pos.get(amb.cityflow_id)
            if info:
                amb.last_road = info["road"]
                amb.last_dist = 0.0
                amb.speed = info["speed"]
                amb.last_xy = (info["x"], info["y"])
                amb.last_t = t
            elif amb.cityflow_id and amb.cityflow_id not in self.eng.get_vehicles():
                # the engine removed it: it reached the end of its route
                amb.cityflow_id = None

            # CityFlow reports `distance` relative to whatever drivable the
            # vehicle is on, so inside an intersection the number resets and a
            # pure distance threshold can be missed.  Track whether the
            # ambulance has actually driven off the road it was aiming at:
            # leaving it means it passed the point it was aiming for.
            if (
                amb.watch_road
                and amb.status in ("to-accident", "to-hospital")
                and not amb.pending
            ):
                if info and info["road"] == amb.watch_road:
                    amb.saw_watch = True
                elif amb.saw_watch and (info is not None or amb.cityflow_id is None):
                    amb.passed_target = True

            if amb.status == "to-accident":
                acc = self.accidents.get(amb.accident_id or "")
                if acc is None:
                    continue
                arrived = False
                if amb.last_road == acc.road:
                    d = self._dist_on_road(amb, acc.road)
                    if d is not None:
                        arrived = d >= max(0.0, acc.dist - 15.0)
                    elif amb.spawned and not amb.pending and amb.cityflow_id is None:
                        # engine removed it: it finished the route on that road
                        arrived = True
                if amb.passed_target:
                    arrived = True
                if arrived:
                    amb.arrived_t = t
                    amb.status = "loading"
                    amb.dwell_until = t + self.pickup_s
                    acc.ambulance_arrived_t = t
                    amb.eta_s = 0.0
                    # keep it moving around the block while the patient is loaded
                    hold = holding_route(self.net, acc.road)
                    if hold and amb.cityflow_id:
                        try:
                            self.eng.set_vehicle_route(amb.cityflow_id, hold)
                            amb.route = [acc.road] + hold
                        except RuntimeError:
                            pass
                    self.events.append(
                        {"t": t, "kind": "arrival", "message": f"{amb.id} reached accident {acc.id}"}
                    )

            elif amb.status == "loading":
                if amb.dwell_until is not None and t >= amb.dwell_until:
                    acc = self.accidents.get(amb.accident_id or "")
                    if acc is None:
                        amb.status = "failed"
                        continue
                    ranked = self.rank_hospitals(acc.id, acc.emergency)
                    if not ranked:
                        amb.status = "failed"
                        amb.error = "no reachable hospital"
                        continue
                    hosp = ranked[0]
                    acc.hospital = hosp["id"]
                    amb.hospital_id = hosp["id"]
                    start = amb.last_road or acc.road
                    path, info = self._plan(amb.method, start, hosp["road"])
                    if not path:
                        amb.status = "failed"
                        amb.error = "no route to hospital"
                        continue
                    acc.status = "picked-up"
                    acc.patient = "onboard"
                    acc.pickup_t = t
                    amb.pickup_done_t = t
                    amb.status = "to-hospital"
                    amb.watch_road = hosp["road"]
                    amb.saw_watch = False
                    amb.passed_target = False
                    amb.fallback = amb.fallback or bool(info.get("fallback"))
                    amb.eta_s = path_time(path, self._cost())
                    self._apply_route(amb, path)
                    self.events.append(
                        {"t": t, "kind": "hospital", "message": f"{amb.id} -> {hosp['name']}"}
                    )

            elif amb.status == "to-hospital":
                acc = self.accidents.get(amb.accident_id or "")
                hosp = next((h for h in self.hospitals if h["id"] == amb.hospital_id), None)
                if hosp is None or acc is None:
                    continue
                road = hosp.get("road") or self._road_at(hosp["x"], hosp["y"])
                road_len = self.net.roads[road].length if road in self.net.roads else 0.0
                done = False
                if amb.last_road == road:
                    d = self._dist_on_road(amb, road)
                    if d is not None:
                        # hospital sits at the end of that road
                        done = d >= max(0.0, road_len - 25.0)
                    elif amb.spawned and not amb.pending and amb.cityflow_id is None:
                        done = True
                if amb.passed_target:
                    done = True
                if done:
                    amb.hospital_t = t
                    amb.status = "completed"
                    amb.eta_s = 0.0
                    acc.status = "resolved"
                    acc.hospital_arrived_t = t
                    acc.patient = "delivered"
                    self.events.append(
                        {"t": t, "kind": "complete", "message": f"{amb.id} delivered to {hosp['name']}"}
                    )
                elif amb.last_road and amb.route and amb.last_road in amb.route:
                    amb.eta_s = path_time(amb.route[amb.route.index(amb.last_road):], self._cost())

            if amb.route and amb.last_road and amb.last_road in amb.route and amb.status in ("to-accident", "to-hospital"):
                idx = amb.route.index(amb.last_road)
                amb.eta_s = path_time(amb.route[idx:], self._cost())

    def _dist_on_road(self, amb: Ambulance, road: str) -> float | None:
        if amb.cityflow_id is None:
            return None
        info = self.eng.get_vehicle_info(amb.cityflow_id) if amb.cityflow_id in self.eng.get_vehicles() else None
        if not info or info.get("road") != road:
            return None
        return float(info["distance"])

    # --------------------------- signal priority ------------------------- #
    def _update_priority(self, t: float) -> None:
        wanted: dict[str, tuple[str, str]] = {}  # intersection -> (road, amb id)
        for amb in self.ambulances.values():
            amb_priority = amb.status in ("to-accident", "to-hospital")
            if not amb_priority or not amb.cityflow_id or not amb.last_road:
                continue
            road = amb.last_road
            if road not in self.net.roads:
                continue
            r = self.net.roads[road]
            d = self._dist_on_road(amb, road)
            if d is None:
                continue
            to_end = r.length - d
            if to_end <= PRIORITY_TRIGGER_M and r.to_int in self.signals.ids:
                wanted[r.to_int] = (road, amb.id)

        for iid in self.signals.ids:
            cur = self.signals.held_by[iid]
            if cur and iid not in wanted:
                self.signals.release(iid)
        for iid, (road, amb_id) in wanted.items():
            self.signals.request_priority(iid, road, amb_id, t)

    # ------------------------------- frame -------------------------------- #
    def scenario_payload(self) -> dict:
        net = self.net
        roads = []
        for r in net.roads.values():
            pts = [net.geo.to_latlng(x, y) for x, y in r.points]
            roads.append(
                {
                    "id": r.id,
                    "points": [[round(p[0], 7), round(p[1], 7)] for p in pts],
                    "m": [[round(x, 1), round(y, 1)] for x, y in r.points],
                    "group": r.group,
                    "lanes": r.n_lanes,
                    "length": round(r.length, 1),
                    "speed": round(MAX_SPEED * 3.6, 1),
                }
            )
        ints = [
            {
                "id": i.id,
                "lat": round(net.geo.to_latlng(*i.point)[0], 7),
                "lng": round(net.geo.to_latlng(*i.point)[1], 7),
                "x": round(i.point[0], 1),
                "y": round(i.point[1], 1),
                "signal": i.is_signal,
            }
            for i in net.intersections.values()
        ]
        all_pts = [p for r in net.roads.values() for p in r.points]
        xs = [p[0] for p in all_pts]
        ys = [p[1] for p in all_pts]
        minlat, minlng = net.geo.to_latlng(min(xs), min(ys))
        maxlat, maxlng = net.geo.to_latlng(max(xs), max(ys))
        return {
            "name": self.scenario_name,
            "interval": INTERVAL,
            "origin": {"lat": self.geo.lat0, "lng": self.geo.lng0},
            "bounds": [[minlat, minlng], [maxlat, maxlng]],
            "roads": roads,
            "intersections": ints,
            "hospitals": self.hospitals,
            "depots": self.depots,
            "ambulances": [
                {"id": a.id, "color": a.color, "depot": a.depot_road, "status": a.status}
                for a in self.ambulances.values()
            ],
            "accidents": [self.accident_dict(a) for a in self.accidents.values()],
            "params": {k: v for k, v in self.params.items() if k != "graph"},
        }

    def accident_dict(self, a: Accident) -> dict:
        return {
            "id": a.id, "lat": round(a.lat, 7), "lng": round(a.lng, 7),
            "x": round(a.x, 1), "y": round(a.y, 1), "road": a.road, "dist": round(a.dist, 1),
            "severity": a.severity, "emergency": a.emergency, "status": a.status,
            "ambulance": a.ambulance, "hospital": a.hospital,
            "reportedT": a.reported_t, "ambulanceArrivedT": a.ambulance_arrived_t,
            "pickupT": a.pickup_t, "hospitalArrivedT": a.hospital_arrived_t,
            "patient": a.patient,
        }

    def route_points(self, amb: Ambulance) -> list[list[float]]:
        pts: list[list[float]] = []
        for rid in amb.route:
            for x, y in self.net.roads[rid].points:
                lat, lng = self.net.geo.to_latlng(x, y)
                p = [round(lat, 7), round(lng, 7)]
                if not pts or pts[-1] != p:
                    pts.append(p)
        return pts

    def frame(self) -> dict:
        with self._lock:
            t = eng_now(self.eng)
            vehicles = [
                v for v in self._vehicle_pos.values() if v["id"] not in self._amb_ids()
            ]
            ambulances = []
            routes = []
            for amb in self.ambulances.values():
                pos = self._vehicle_pos.get(amb.cityflow_id or "")
                ambulances.append(
                    {
                        "id": amb.id,
                        "color": amb.color,
                        "status": amb.status,
                        "road": amb.last_road,
                        "x": round(pos["x"], 1) if pos else None,
                        "y": round(pos["y"], 1) if pos else None,
                        "h": round(pos["h"], 3) if pos else None,
                        "speed": round(amb.speed, 2),
                        "speedKmh": round(amb.speed * 3.6, 1),
                        "eta": None if amb.eta_s is None else round(amb.eta_s, 1),
                        "accident": amb.accident_id,
                        "hospital": amb.hospital_id,
                        "method": amb.method,
                        "fallback": amb.fallback,
                        "error": amb.error,
                        "dispatchT": amb.dispatch_t,
                        "arrivedT": amb.arrived_t,
                        "pickupT": amb.pickup_done_t,
                        "hospitalT": amb.hospital_t,
                        "colorLabel": "Ambulance " + amb.id.split("-")[-1],
                    }
                )
                if amb.route and amb.status in ("to-accident", "to-hospital", "loading"):
                    routes.append(
                        {
                            "id": amb.id,
                            "color": amb.color,
                            "status": amb.status,
                            "points": self.route_points(amb),
                            "eta": None if amb.eta_s is None else round(amb.eta_s, 1),
                            "hospital": amb.hospital_id,
                            "accident": amb.accident_id,
                        }
                    )
            amb_vehicles = [
                self._vehicle_pos[a.cityflow_id]
                for a in self.ambulances.values()
                if a.cityflow_id and a.cityflow_id in self._vehicle_pos
            ]
            return {
                "sim": {
                    "engine": "cityflow",
                    "step": self.step_count,
                    "time": round(t, 2),
                    "interval": INTERVAL,
                    "paused": self.paused,
                    "running": self._running and not self.paused,
                    "speed": self.speed,
                    "scenario": self.scenario_name,
                },
                "stats": {
                    "totalVehicles": len(self._vehicle_pos),
                    "ambulances": len(self.ambulances),
                    "accidents": len(self.accidents),
                    "hospitals": len(self.hospitals),
                    "density": round(self.density, 4),
                    "avgSpeed": round(self.avg_speed, 2),
                    "avgSpeedKmh": round(self.avg_speed * 3.6, 1),
                    "stopped": self.stopped,
                    "avgWaiting": round(self.avg_waiting, 2),
                },
                "vehicles": [
                    {
                        "x": round(v["x"], 1),
                        "y": round(v["y"], 1),
                        "h": round(v["h"], 3),
                        "k": v["kind"],
                        "s": round(v["speed"], 1),
                    }
                    for v in vehicles
                ],
                "ambulanceVehicles": [
                    {
                        "x": round(v["x"], 1),
                        "y": round(v["y"], 1),
                        "h": round(v["h"], 3),
                        "s": round(v["speed"], 1),
                        "id": v["id"],
                    }
                    for v in amb_vehicles
                ],
                "ambulances": ambulances,
                "routes": routes,
                "signals": self.signals.frame(t),
                "accidents": [self.accident_dict(a) for a in self.accidents.values()],
                "hospitals": self.hospitals,
                "events": self.events[-12:],
                "gnn": self.gnn.status(),
                "ppo": self.agent.status(),
                "training": self.last_training,
            }

    # ------------------------------ commands ----------------------------- #
    def add_accident(
        self,
        lat: float | None = None,
        lng: float | None = None,
        x: float | None = None,
        y: float | None = None,
        severity: str = "major",
        emergency: str = "trauma",
    ) -> dict:
        with self._lock:
            if x is None or y is None:
                if lat is None or lng is None:
                    return {"ok": False, "error": "provide lat/lng or x/y"}
                x, y = self.geo.to_world(lat, lng)
            rid, dist, perp = self.net.nearest_road(x, y)
            if perp > 250:
                return {"ok": False, "error": "chosen point is too far from the road network"}
            road = self.net.roads[rid]
            # snap onto the road centreline for rendering
            sx, sy, _ = self.net.point_at(rid, dist)
            la, ln = self.net.geo.to_latlng(sx, sy)
            self._acc_seq += 1
            acc = Accident(
                id=f"acc-{self._acc_seq}",
                x=sx, y=sy, lat=la, lng=ln, road=rid, dist=dist,
                severity=severity, emergency=emergency,
                reported_t=eng_now(self.eng),
            )
            self.accidents[acc.id] = acc
            self.events.append(
                {"t": acc.reported_t, "kind": "accident", "message": f"accident {acc.id} on {rid}"}
            )
            return {"ok": True, "accident": self.accident_dict(acc), "offsetFromCentre": round(perp, 1)}

    def _run_training(self, episodes: int = 60) -> dict:
        """PPO quick-train on rollouts priced by the live GNN cost model."""
        cost = self._cost()
        roads = sorted(self.net.roads.keys())
        rng = random.Random(self.seed + 5)
        start = rng.choice(roads)
        goal = rng.choice([r for r in roads if r != start] or roads)
        res = quick_train(
            self.net, self.gnn, self.agent, self.emb, self.x_e,
            start, goal, cost, episodes=episodes, seed=self.seed,
        )
        self.last_training = res
        return res

    def train(self, episodes: int = 60) -> dict:
        with self._lock:
            return self._run_training(episodes)


def eng_now(eng) -> float:
    try:
        return float(eng.get_current_time())
    except Exception:
        return 0.0


def holding_route(net: Network, road: str) -> list[str] | None:
    """Short loop that starts from `road` and comes back to it (used while a
    patient is being loaded, so the ambulance keeps moving visibly)."""
    succs = [v for v, _ in net.successors(road)]
    if not succs:
        return None
    q = deque([(s, [s]) for s in succs])
    seen = {road}
    while q:
        cur, path = q.popleft()
        if len(path) > 10:
            continue
        if net.roads[cur].to_int == net.roads[road].from_int and cur != road:
            return path
        for nxt, _ in net.successors(cur):
            if nxt in seen:
                continue
            seen.add(nxt)
            q.append((nxt, path + [nxt]))
    return None
