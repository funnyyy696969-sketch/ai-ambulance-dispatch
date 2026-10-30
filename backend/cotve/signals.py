"""Emergency traffic-signal control for CoTV-E.

CityFlow has no built-in emergency-priority API (``set_tl_phase(intersection_id,
phase_id)`` is the only control hook, and it only works with
``rlTrafficLight: true``), so the whole signal plan is driven from here:

  * normal operation  - the generated green/yellow plan advances on sim time
  * priority          - an approaching ambulance freezes the plan and forces the
                        phase that serves its approach, then releases it
"""

from __future__ import annotations

from .roadnet import Network, PHASE_YELLOW

GREEN = "green"
YELLOW = "yellow"
RED = "red"


class SignalController:
    def __init__(self, net: Network) -> None:
        self.net = net
        self.signals = [i for i in net.intersections.values() if i.is_signal and i.phases]
        self.ids = [i.id for i in self.signals]
        self.phase: dict[str, int] = {i.id: 0 for i in self.signals}
        self.phase_start: dict[str, float] = {i.id: 0.0 for i in self.signals}
        self.held_by: dict[str, str | None] = {i.id: None for i in self.signals}
        # road -> [phase indices that release it]
        self.road_phases: dict[str, dict[str, list[int]]] = {}
        for it in self.signals:
            m: dict[str, list[int]] = {}
            for pi, ph in enumerate(it.phases):
                for li in ph["availableRoadLinks"]:
                    m.setdefault(it.links[li]["start"], []).append(pi)
            self.road_phases[it.id] = m

    # ------------------------------------------------------------------ #
    def reset(self, t: float = 0.0) -> None:
        for iid in self.ids:
            self.phase[iid] = 0
            self.phase_start[iid] = t
            self.held_by[iid] = None

    def apply_initial(self, eng) -> None:
        for iid in self.ids:
            eng.set_tl_phase(iid, self.phase[iid])

    def green_phase_for(self, iid: str, road: str) -> int | None:
        it = self.net.intersections.get(iid)
        if it is None:
            return None
        cands = self.road_phases.get(iid, {}).get(road, [])
        if not cands:
            return None
        greens = [p for p in cands if it.phases[p]["time"] >= PHASE_YELLOW]
        return (greens or cands)[0]

    def request_priority(self, iid: str, approach_road: str, ambulance_id: str, t: float) -> bool:
        """Force the phase serving `approach_road` and hold it for the ambulance."""
        ph = self.green_phase_for(iid, approach_road)
        if ph is None:
            return False
        if self.phase[iid] != ph:
            self.phase[iid] = ph
            self.phase_start[iid] = t
        self.held_by[iid] = ambulance_id
        return True

    def release(self, iid: str) -> None:
        self.held_by[iid] = None

    def update(self, t: float, eng) -> None:
        """Advance the normal plan everywhere an ambulance is not holding it."""
        for it in self.signals:
            iid = it.id
            if self.held_by[iid]:
                eng.set_tl_phase(iid, self.phase[iid])  # keep forcing it
                continue
            ph = it.phases[self.phase[iid]]
            if ph["time"] >= 10_000_000:  # single-phase (non-signalled flow)
                continue
            if t - self.phase_start[iid] >= ph["time"]:
                self.phase[iid] = (self.phase[iid] + 1) % len(it.phases)
                self.phase_start[iid] = t
                eng.set_tl_phase(iid, self.phase[iid])

    # ------------------------------------------------------------------ #
    def approach_colors(self, iid: str) -> dict[str, str]:
        """{incoming_road_id: red|yellow|green} for rendering."""
        it = self.net.intersections.get(iid)
        if it is None:
            return {}
        pi = self.phase[iid]
        ph = it.phases[pi]
        yellow = ph["time"] < PHASE_YELLOW
        served = {it.links[li]["start"] for li in ph["availableRoadLinks"]}
        out: dict[str, str] = {}
        for r in it.incoming:
            if r in served:
                out[r] = YELLOW if yellow else GREEN
            else:
                out[r] = RED
        return out

    def frame(self, now: float) -> list[dict]:
        out = []
        for it in self.signals:
            iid = it.id
            ph = it.phases[self.phase[iid]]
            out.append(
                {
                    "id": iid,
                    "x": it.point[0],
                    "y": it.point[1],
                    "phase": self.phase[iid],
                    "nPhases": len(it.phases),
                    "phaseProgress": min(
                        1.0, (now - self.phase_start[iid]) / max(1e-6, ph["time"])
                    ),
                    "priority": self.held_by[iid] is not None,
                    "heldBy": self.held_by[iid],
                    "approaches": self.approach_colors(iid),
                }
            )
        return out
