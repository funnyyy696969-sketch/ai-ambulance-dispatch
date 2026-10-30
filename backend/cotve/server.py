"""CoTV-E CityFlow backend - REST + WebSocket service (FastAPI).

Run it with:      python -m cotve.server   (or: uvicorn cotve.server:app --port 8000)
The frontend connects to the WebSocket for live frames and falls back to plain
REST polling when sockets are unavailable.
"""

from __future__ import annotations

import asyncio
import os
import threading
from typing import Any

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .evaluation import run_comparison
from .session import SimSession

WORKDIR = os.environ.get("COTVE_WORKDIR", "/tmp/cotve-cityflow")

app = FastAPI(title="CoTV-E CityFlow Backend", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_lock = threading.Lock()
_session: SimSession | None = None


def session() -> SimSession:
    global _session
    with _lock:
        if _session is None:
            _session = SimSession(workdir=WORKDIR)
        return _session


class ScenarioIn(BaseModel):
    rows: int = 5
    cols: int = 5
    spacing: float = 300.0
    seed: int = 7
    demand: float = 1.0
    nAmbulances: int = 2
    nHospitals: int = 3
    originLat: float = 12.9716
    originLng: float = 77.5946
    graph: dict[str, Any] | None = None


class ControlIn(BaseModel):
    action: str  # start | pause | resume | stop | reset | speed | step
    value: float | int | None = None


class AccidentIn(BaseModel):
    lat: float | None = None
    lng: float | None = None
    x: float | None = None
    y: float | None = None
    severity: str = "major"
    emergency: str = "trauma"


class DispatchIn(BaseModel):
    accidentId: str
    ambulanceId: str | None = None
    method: str = "ppo"


class EvaluationIn(BaseModel):
    methods: list[str] | None = None
    accidentX: float | None = None
    accidentY: float | None = None
    emergency: str = "trauma"
    runs: int = 1


# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health() -> dict:
    try:
        import cityflow  # noqa: F401

        cf = True
    except Exception:
        cf = False
    s = _session
    return {
        "ok": True,
        "cityflow": cf,
        "session": s is not None,
        "scenario": s.scenario_name if s else None,
    }


@app.get("/api/scenario")
def get_scenario() -> dict:
    return session().scenario_payload()


@app.post("/api/scenario")
def set_scenario(body: ScenarioIn) -> dict:
    global _session
    with _lock:
        old = _session
        if old is not None:
            old.stop()
        _session = SimSession(
            rows=body.rows,
            cols=body.cols,
            spacing=body.spacing,
            seed=body.seed,
            demand=body.demand,
            n_ambulances=body.nAmbulances,
            n_hospitals=body.nHospitals,
            origin=(body.originLat, body.originLng),
            graph=body.graph,
            workdir=WORKDIR,
        )
        return _session.scenario_payload()


@app.get("/api/state")
def get_state() -> dict:
    return session().frame()


@app.post("/api/sim")
def sim_control(body: ControlIn) -> dict:
    s = session()
    a = body.action.lower()
    if a == "start" or a == "play":
        s.start()
    elif a == "pause":
        s.pause()
    elif a == "resume":
        s.resume()
    elif a == "stop":
        s.stop()
    elif a == "reset":
        s.stop()
        s.reset()
        s.start()
    elif a == "speed":
        s.set_speed(float(body.value or 1))
    elif a == "step":
        s.step_sync(int(body.value or 1))
    else:
        return {"ok": False, "error": f"unknown action {body.action}"}
    return {"ok": True, "sim": s.frame()["sim"]}


@app.post("/api/accidents")
def add_accident(body: AccidentIn) -> dict:
    return session().add_accident(
        lat=body.lat, lng=body.lng, x=body.x, y=body.y,
        severity=body.severity, emergency=body.emergency,
    )


@app.delete("/api/accidents/{accident_id}")
def remove_accident(accident_id: str) -> dict:
    s = session()
    with s._lock:
        if accident_id not in s.accidents:
            return {"ok": False, "error": "unknown accident"}
        acc = s.accidents[accident_id]
        if acc.ambulance:
            amb = s.ambulances.get(acc.ambulance)
            if amb and amb.status not in ("idle", "completed", "failed"):
                return {"ok": False, "error": "accident is being responded to"}
        s.accidents.pop(accident_id, None)
        return {"ok": True}


@app.post("/api/dispatch")
def dispatch(body: DispatchIn) -> dict:
    return session().dispatch(body.accidentId, body.ambulanceId, body.method)


@app.get("/api/ambulances")
def ambulances() -> dict:
    f = session().frame()
    return {"ambulances": f["ambulances"]}


@app.get("/api/hospitals")
def hospitals(accidentId: str | None = Query(default=None), emergency: str = Query(default="")) -> dict:
    s = session()
    if accidentId:
        return {"hospitals": s.rank_hospitals(accidentId, emergency)}
    return {"hospitals": s.hospitals}


@app.post("/api/train")
def train(episodes: int = Query(default=60)) -> dict:
    return session().train(episodes)


@app.post("/api/evaluation")
def evaluate(body: EvaluationIn) -> dict:
    """Runs the comparison experiments (blocking - takes tens of seconds)."""
    s = session()
    methods = tuple(body.methods) if body.methods else ("dijkstra", "astar", "ppo")
    params = dict(s.params)
    params["origin"] = s.origin
    params.pop("graph", None)
    xy = (body.accidentX, body.accidentY) if body.accidentX is not None else None
    out = run_comparison(
        params=params, accident_xy=xy, methods=methods, emergency=body.emergency
    )
    return out


# --------------------------------------------------------------------------- #
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, hz: float = Query(default=5.0)) -> None:
    await ws.accept()
    s = session()
    period = 1.0 / max(0.5, min(hz, 30.0))
    try:
        while True:
            frame = await asyncio.get_running_loop().run_in_executor(None, s.frame)
            await ws.send_json(frame)
            await asyncio.sleep(period)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await ws.close()
        except Exception:
            pass


def main() -> None:  # python -m cotve.server
    import uvicorn

    host = os.environ.get("COTVE_HOST", "127.0.0.1")
    port = int(os.environ.get("COTVE_PORT", "8000"))
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
