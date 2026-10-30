# CoTV-E · CityFlow backend

Python service that owns the **CityFlow** microscopic traffic simulation and the
**GNN + PPO** emergency routing stack. The React dashboard talks to it over REST
(`/api/*`) and a live WebSocket (`/ws`).

```
backend/
  requirements.txt
  cotve/
    roadnet.py      road network (grid builder + OSM graphs), GeoTransform, facility placement
    flows.py        background traffic demand (car / bus / truck)
    signals.py      traffic-signal plans + emergency priority (set_tl_phase)
    routing.py      live / free-flow edge costs, Dijkstra, A*
    gnn.py          numpy GNN over the live network (full backprop, no random embeddings)
    ppo.py          PPO agent (masked categorical policy) + policy-guided path search
    session.py      SimSession: engine loop, ambulance state machine, metrics, frames
    evaluation.py   real Dijkstra vs A* vs GNN+PPO experiments on a fresh engine
    server.py       FastAPI app (REST + WebSocket)
```

---

## 1. Install on Windows

Prerequisites

* **Python 3.10 – 3.12** (64-bit, from python.org — leave *“py launcher”* and
  *“pip”* enabled; the standard installer already ships the headers CityFlow needs).
* **Microsoft C++ Build Tools** — Visual Studio Build Tools 2022 with the
  *“Desktop development with C++”* workload. CityFlow is a C++ extension, so a
  compiler is mandatory.
* **Git** for Windows (used to fetch CityFlow sources).

```bat
cd backend

:: one isolated environment
py -3.10 -m venv .venv
.venv\Scripts\activate

:: python dependencies
pip install -r requirements.txt

:: CMake must stay below 4.0 — CityFlow's CMakeLists still declares VERSION 3.0
pip install "cmake<4" setuptools wheel

:: fetch CityFlow + its submodules (pybind11, rapidjson) and build it
git clone --recursive https://github.com/cityflow-project/CityFlow.git %TEMP%\CityFlow
cd /d %TEMP%\CityFlow
pip install .
cd - 

:: verify
python -c "import cityflow, cotve; print('cityflow ok')"
```

If `pip install .` fails, re-run it from `%TEMP%\CityFlow` and read the first
compiler error — almost always it is the MSVC workload or a CMake ≥ 4 install.

---

## 2. Install on macOS / Linux

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install "cmake<4" setuptools wheel

git clone --recursive https://github.com/cityflow-project/CityFlow.git /tmp/CityFlow
pip install /tmp/CityFlow          # needs g++ / clang and python3-dev
python -c "import cityflow, cotve; print('cityflow ok')"
```

---

## 3. Run

**Backend** (terminal 1):

```bat
.venv\Scripts\activate        # Windows
python -m cotve.server        # http://127.0.0.1:8000
```

**Frontend** (terminal 2):

```bash
bun install
bun run dev                   # http://localhost:5173 → /dispatch
```

The dashboard points at `http://127.0.0.1:8000` by default. To use another
host/port, set `VITE_COTVE_BACKEND` before starting Vite:

```bash
VITE_COTVE_BACKEND=http://192.168.1.20:8000 bun run dev
```

### Environment variables (backend)

| Variable          | Default              | Meaning                                   |
| ----------------- | -------------------- | ----------------------------------------- |
| `COTVE_HOST`      | `127.0.0.1`          | bind address                              |
| `COTVE_PORT`      | `8000`               | port                                      |
| `COTVE_WORKDIR`   | `/tmp/cotve-cityflow`| where roadnet.json / flow.json are written (use a Windows path such as `%TEMP%\cotve` if you like) |

---

## 4. API

| Method & path              | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `GET  /api/health`         | engine availability                                            |
| `GET  /api/scenario`       | roads, intersections, hospitals, depots, bounds (lat/lng)      |
| `POST /api/scenario`       | rebuild the scenario (rows, cols, spacing, seed, demand, …)    |
| `GET  /api/state`          | one full frame: sim clock, stats, vehicles, routes, signals    |
| `POST /api/sim`            | `start · pause · resume · stop · reset · speed · step`         |
| `POST /api/accidents`      | report an accident (lat/lng or x/y + severity + emergency)     |
| `DELETE /api/accidents/{id}` | remove an unattended accident                                |
| `POST /api/dispatch`       | assign an ambulance, `method: ppo | astar | dijkstra`          |
| `POST /api/train`          | run PPO/GNN training episodes (real rollouts)                  |
| `POST /api/evaluation`     | Dijkstra vs A* vs GNN+PPO comparison (blocking, ~10–40 s)      |
| `WS   /ws?hz=5`            | streaming frames; falls back to `GET /api/state` polling       |

---

## 5. How the AI parts stay honest

* **GNN** — node features are measured from CityFlow every step (density,
  vehicle count, average speed, congestion); edge features are road length,
  lane capacity and *observed* traversal times. The embeddings come from a
  trained message-passing network with a real backward pass — never random.
* **PPO** — the actor scores each connected successor road from the GNN
  embeddings plus goal/progress features; the search that turns those scores
  into a path is guaranteed to reach the goal, and when it cannot it reports
  `fallback: true` instead of pretending.
* **Comparison** — every number comes from a fresh engine run with the same
  seed, traffic and accident location. Nothing is simulated analytically.
