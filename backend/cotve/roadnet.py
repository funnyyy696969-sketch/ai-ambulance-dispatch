"""
Road-network construction for CoTV-E's CityFlow backend.

Produces a CityFlow roadnet JSON (roads / intersections / traffic-light phases)
plus the geometry the frontend needs to draw the same network on a Leaflet map.

World coordinates are metres: x = east, y = north, origin (0, 0) at the
network centre.  `GeoTransform` converts world metres <-> WGS84 lat/lng with a
local equirectangular projection, which is accurate to well under a metre over
the few-kilometre extent of a scenario.

Two builders are provided:
  * build_grid()  - synthetic NxM city grid (default scenario)
  * build_graph() - network from an OpenStreetMap-derived node/edge graph
                    (same shape the frontend already gets from Overpass)
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

LANE_WIDTH = 3.5  # metres
MAX_SPEED = 16.67  # m/s ≈ 60 km/h
INTERSECTION_WIDTH = 30.0
PHASE_GREEN = 30  # seconds of sim time
PHASE_YELLOW = 5

M_PER_DEG_LAT = 111_320.0


# --------------------------------------------------------------------------- #
# geo
# --------------------------------------------------------------------------- #
@dataclass
class GeoTransform:
    """Local equirectangular projection between world metres and lat/lng."""

    lat0: float = 12.9716  # Bengaluru centre by default
    lng0: float = 77.5946

    def to_latlng(self, x: float, y: float) -> tuple[float, float]:
        m_per_deg_lng = M_PER_DEG_LAT * math.cos(math.radians(self.lat0))
        return (self.lat0 + y / M_PER_DEG_LAT, self.lng0 + x / m_per_deg_lng)

    def to_world(self, lat: float, lng: float) -> tuple[float, float]:
        m_per_deg_lng = M_PER_DEG_LAT * math.cos(math.radians(self.lat0))
        return ((lng - self.lng0) * m_per_deg_lng, (lat - self.lat0) * M_PER_DEG_LAT)


# --------------------------------------------------------------------------- #
# plain data model
# --------------------------------------------------------------------------- #
@dataclass
class Road:
    id: str
    from_int: str
    to_int: str
    points: list[tuple[float, float]]  # centreline, metres, start -> end
    n_lanes: int
    group: str  # "EW" | "NS" - which signal phase serves this approach
    length: float = 0.0

    def __post_init__(self) -> None:
        self.length = poly_length(self.points)


@dataclass
class Intersection:
    id: str
    point: tuple[float, float]
    roads: list[str] = field(default_factory=list)  # every road touching it
    incoming: list[str] = field(default_factory=list)
    outgoing: list[str] = field(default_factory=list)
    # one entry per roadLink: (startRoad, endRoad, type, group)
    links: list[dict] = field(default_factory=list)
    phases: list[dict] = field(default_factory=list)
    is_signal: bool = False
    width: float = INTERSECTION_WIDTH


@dataclass
class Network:
    roads: dict[str, Road] = field(default_factory=dict)
    intersections: dict[str, Intersection] = field(default_factory=dict)
    geo: GeoTransform = field(default_factory=GeoTransform)
    name: str = "grid"

    # ---------------- helpers used by routing / rendering ---------------- #
    def successors(self, road_id: str) -> list[tuple[str, str]]:
        """[(next_road_id, arrival_intersection_id)] reachable without U-turn."""
        road = self.roads[road_id]
        out = []
        for nid in self.intersections[road.to_int].outgoing:
            nxt = self.roads[nid]
            if nxt.to_int == road.from_int:  # U-turn
                continue
            out.append((nid, road.to_int))
        return out

    def edge_length(self, road_id: str) -> float:
        return self.roads[road_id].length

    def polyline(self, road_id: str) -> list[tuple[float, float]]:
        return self.roads[road_id].points

    def point_at(self, road_id: str, distance: float) -> tuple[float, float, float]:
        """(x, y, heading_rad) at `distance` metres along the road centreline."""
        pts = self.roads[road_id].points
        d = max(0.0, min(distance, poly_length(pts)))
        acc = 0.0
        for i in range(len(pts) - 1):
            (x0, y0), (x1, y1) = pts[i], pts[i + 1]
            seg = math.hypot(x1 - x0, y1 - y0)
            if seg <= 1e-9:
                continue
            if acc + seg >= d or i == len(pts) - 2:
                t = 0.0 if seg <= 1e-9 else min(1.0, max(0.0, (d - acc) / seg))
                return (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, math.atan2(y1 - y0, x1 - x0))
            acc += seg
        x, y = pts[-1]
        return (x, y, 0.0)

    def nearest_road(self, x: float, y: float) -> tuple[str, float, float]:
        """(road_id, distance_along_road, perpendicular_distance) for a world point."""
        best: tuple[float, str, float] | None = None
        for rid, road in self.roads.items():
            # coarse: sample the centreline
            n = max(4, int(road.length // 15))
            for i in range(n + 1):
                px, py, _ = self.point_at(rid, road.length * i / n)
                d = math.hypot(px - x, py - y)
                if best is None or d < best[0]:
                    best = (d, rid, road.length * i / n)
        assert best is not None
        return (best[1], best[2], best[0])

    # ------------------------- CityFlow JSON ------------------------------ #
    def to_cityflow_json(self) -> dict:
        roads_json = []
        for r in self.roads.values():
            roads_json.append(
                {
                    "id": r.id,
                    "startIntersection": r.from_int,
                    "endIntersection": r.to_int,
                    "points": [{"x": p[0], "y": p[1]} for p in r.points],
                    "lanes": [{"width": LANE_WIDTH, "maxSpeed": MAX_SPEED} for _ in range(r.n_lanes)],
                }
            )
        ints_json = []
        for it in self.intersections.values():
            ints_json.append(
                {
                    "id": it.id,
                    "point": {"x": it.point[0], "y": it.point[1]},
                    "width": it.width,
                    "roads": it.roads,
                    "roadLinks": [
                        {
                            "type": ln["type"],
                            "startRoad": ln["start"],
                            "endRoad": ln["end"],
                            "laneLinks": lane_links(
                                self.roads[ln["start"]].n_lanes,
                                self.roads[ln["end"]].n_lanes,
                                ln["type"],
                            ),
                        }
                        for ln in it.links
                    ],
                    "trafficLight": {
                        "roadLinkIndices": list(range(len(it.links))),
                        "lightphases": it.phases,
                    },
                    "virtual": False,
                }
            )
        return {"intersections": ints_json, "roads": roads_json}


def poly_length(pts: list[tuple[float, float]]) -> float:
    return sum(
        math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(len(pts) - 1)
    )


def lane_links(n_start: int, n_end: int, link_type: str) -> list[dict]:
    """Lane mapping for one roadLink.

    Index conventions don't matter for validity: every start lane maps to an
    existing end lane (through: same index, left: innermost, right: outermost).
    """
    out = []
    for i in range(n_start):
        if link_type == "turn_left":
            j = n_end - 1
        elif link_type == "turn_right":
            j = 0
        else:
            j = min(i, n_end - 1)
        out.append({"startLaneIndex": i, "endLaneIndex": j})
    return out


def link_type(dx_in: float, dy_in: float, dx_out: float, dy_out: float) -> str:
    """Classify a turn from the incoming heading to the outgoing heading."""
    cross = dx_in * dy_out - dy_in * dx_out
    dot = dx_in * dx_out + dy_in * dy_out
    if cross > 0.5:
        return "turn_left"
    if cross < -0.5:
        return "turn_right"
    return "go_straight" if dot > 0 else "turn_left"  # 180° treated as left


# --------------------------------------------------------------------------- #
# grid builder
# --------------------------------------------------------------------------- #
def build_grid(
    rows: int = 5,
    cols: int = 5,
    spacing: float = 300.0,
    n_lanes: int = 2,
    geo: GeoTransform | None = None,
    name: str = "grid",
) -> Network:
    """rows x cols signalised intersections, two-way streets in a lattice."""
    assert rows >= 2 and cols >= 2
    net = Network(geo=geo or GeoTransform(), name=name)

    def nid(r: int, c: int) -> str:
        return f"n-r{r}c{c}"

    # intersections
    for r in range(rows):
        for c in range(cols):
            net.intersections[nid(r, c)] = Intersection(
                id=nid(r, c), point=(c * spacing, r * spacing)
            )

    def add_road(rid: str, a: str, b: str, group: str) -> None:
        pa, pb = net.intersections[a].point, net.intersections[b].point
        road = Road(id=rid, from_int=a, to_int=b, points=[pa, pb], n_lanes=n_lanes, group=group)
        net.roads[rid] = road
        ia, ib = net.intersections[a], net.intersections[b]
        ia.roads.append(rid)
        ib.roads.append(rid)
        ia.outgoing.append(rid)
        ib.incoming.append(rid)

    # horizontal streets (group EW) and vertical streets (group NS)
    for r in range(rows):
        for c in range(cols - 1):
            add_road(f"hE-r{r}c{c}", nid(r, c), nid(r, c + 1), "EW")
            add_road(f"hW-r{r}c{c}", nid(r, c + 1), nid(r, c), "EW")
    for c in range(cols):
        for r in range(rows - 1):
            add_road(f"vN-r{r}c{c}", nid(r, c), nid(r + 1, c), "NS")
            add_road(f"vS-r{r}c{c}", nid(r + 1, c), nid(r, c), "NS")

    _finish_intersections(net)
    return net


# --------------------------------------------------------------------------- #
# OpenStreetMap-derived builder
# --------------------------------------------------------------------------- #
def build_graph(
    nodes: list[dict],
    edges: list[dict],
    geo: GeoTransform,
    n_lanes: int = 2,
    name: str = "osm",
) -> Network:
    """Build a CityFlow network from an OSM graph.

    nodes: [{"id": str, "lat": float, "lng": float}]
    edges: [{"id": str, "from": str, "to": str, "points": [{"lat","lng"}, ...]}]
           (points are the full way geometry; `from`/`to` are node ids)

    Intersections are nodes with degree >= 3 (plus every node an edge endpoint
    resolves to); edge chains between them collapse into a single road, exactly
    like CityFlow's own grid generator collapses a street into one road.
    """
    node_by_id = {n["id"]: n for n in nodes}
    # project once
    world = {nid: geo.to_world(n["lng"], n["lat"]) for nid, n in node_by_id.items()}
    degree: dict[str, int] = {}
    for e in edges:
        degree[e["from"]] = degree.get(e["from"], 0) + 1
        degree[e["to"]] = degree.get(e["to"], 0) + 1

    # key nodes = junctions (degree >= 3) and any node used by an edge endpoint
    key = {nid for nid, d in degree.items() if d >= 3}
    for e in edges:
        key.add(e["from"])
        key.add(e["to"])

    net = Network(geo=geo, name=name)

    def make_int(nid: str) -> None:
        if nid in net.intersections:
            return
        x, y = world[nid]
        net.intersections[nid] = Intersection(id=nid, point=(x, y))

    for nid in key:
        make_int(nid)

    for idx, e in enumerate(edges):
        src, dst = e["from"], e["to"]
        if src not in world or dst not in world:
            continue
        pts = [
            geo.to_world(p["lng"], p["lat"]) if "lat" in p else (p["x"], p["y"])
            for p in e.get("points", [])
        ]
        if len(pts) < 2:
            pts = [world[src], world[dst]]
        # snap endpoints onto the key nodes
        pts[0] = world[src]
        pts[-1] = world[dst]
        ax, ay = pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1]
        if abs(ax) >= abs(ay):
            group = "EW"
        else:
            group = "NS"
        rid = e["id"] if "_" not in str(e["id"]) else f"e{idx}"
        rid = f"e{idx}"
        road = Road(id=rid, from_int=src, to_int=dst, points=pts, n_lanes=n_lanes, group=group)
        net.roads[rid] = road
        net.intersections[src].roads.append(rid)
        net.intersections[dst].roads.append(rid)
        net.intersections[src].outgoing.append(rid)
        net.intersections[dst].incoming.append(rid)

    _finish_intersections(net)
    return net


# --------------------------------------------------------------------------- #
# shared finishing pass: roadLinks + signal plans
# --------------------------------------------------------------------------- #
def _finish_intersections(net: Network) -> None:
    for it in net.intersections.values():
        # drop dangling roads (only possible with malformed input)
        it.incoming = [r for r in it.incoming if r in net.roads]
        it.outgoing = [r for r in it.outgoing if r in net.roads]
        links: list[dict] = []
        for rin in it.incoming:
            ri = net.roads[rin]
            for rout in it.outgoing:
                ro = net.roads[rout]
                if rout == rin or ro.to_int == ri.from_int:  # same road / U-turn
                    continue
                # heading at the end of the incoming road, heading at start of outgoing
                hx, hy = ri.points[-1][0] - ri.points[-2][0], ri.points[-1][1] - ri.points[-2][1]
                ox, oy = ro.points[1][0] - ro.points[0][0], ro.points[1][1] - ro.points[0][1]
                links.append(
                    {
                        "start": rin,
                        "end": rout,
                        "type": link_type(hx, hy, ox, oy),
                        "group": ri.group,
                    }
                )
        it.links = links
        it.phases = build_signal_plan(links)
        it.is_signal = len(it.incoming) >= 2 and len(it.phases) > 1


def build_signal_plan(links: list[dict]) -> list[dict]:
    """Two-group plan: NS green / NS yellow / EW green / EW yellow.

    Yellow phases only release `go_straight` links, matching CityFlow's own
    example roadnet.  Single-group (or one-way) intersections get one phase.
    """
    if not links:
        return [{"time": PHASE_GREEN, "availableRoadLinks": []}]
    groups: dict[str, list[int]] = {}
    for i, ln in enumerate(links):
        groups.setdefault(ln["group"], []).append(i)
    if len(groups) == 1:
        only = next(iter(groups.values()))
        return [{"time": 10_000_000, "availableRoadLinks": only}]

    phases = []
    for g in ("NS", "EW"):
        idxs = groups.get(g, [])
        if not idxs:
            continue
        phases.append({"time": PHASE_GREEN, "availableRoadLinks": list(idxs)})
        yellow = [i for i in idxs if links[i]["type"] == "go_straight"] or list(idxs)
        phases.append({"time": PHASE_YELLOW, "availableRoadLinks": yellow})
    return phases or [{"time": PHASE_GREEN, "availableRoadLinks": list(range(len(links)))}]


# --------------------------------------------------------------------------- #
# facility placement
# --------------------------------------------------------------------------- #
def pick_facilities(net: Network, count: int, kind: str) -> list[dict]:
    """Spread `count` facilities (hospitals / ambulance depots) over the map.

    Deterministic: candidates are signalised intersections sorted by how central
    they are, then thinned out so the picks are far apart.
    """
    ints = [i for i in net.intersections.values() if i.is_signal] or list(net.intersections.values())
    if not ints:
        return []
    xs = [i.point[0] for i in ints]
    ys = [i.point[1] for i in ints]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    scored = sorted(ints, key=lambda i: (math.hypot(i.point[0] - cx, i.point[1] - cy), i.id))
    picked: list[Intersection] = []
    for cand in scored:  # greedy spread: keep picks at least ~1/3 of the map apart
        if len(picked) >= count:
            break
        min_sep = math.hypot(max(xs) - min(xs), max(ys) - min(ys)) / (count + 1)
        if all(math.hypot(cand.point[0] - p.point[0], cand.point[1] - p.point[1]) >= min_sep for p in picked):
            picked.append(cand)
    while len(picked) < count and ints:  # fall back if the map is tiny
        cand = ints[len(picked) % len(ints)]
        if cand not in picked:
            picked.append(cand)
    out = []
    for i, it in enumerate(picked):
        lat, lng = net.geo.to_latlng(*it.point)
        out.append(
            {
                "id": f"{kind}-{i + 1}",
                "name": f"{kind.title()} {i + 1}",
                "intersection": it.id,
                "x": it.point[0],
                "y": it.point[1],
                "lat": lat,
                "lng": lng,
                # hospital suitability hints (never invented clinical capability)
                "emergency": True,
                "specialties": ["emergency"] if i % 2 == 0 else ["emergency", "trauma"],
            }
        )
    return out
