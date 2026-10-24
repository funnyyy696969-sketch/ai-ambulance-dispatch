# CoTV-E — AI Emergency Ambulance Dispatch with GNN + PPO Routing

**CoTV-E** is an advanced AI-based emergency ambulance dispatch system: the user provides
**only** a patient location (mouse click on a map) and a disease/emergency type. Everything
else — hospital discovery & selection, ambulance assignment, road-network routing, traffic
signal priority, and the dual-view 3D journey simulation — is computed automatically and
visualized in two synchronized 3D screens.

> **Web port note.** The original specification targeted a Python/Panda3D desktop build.
> This implementation is the web adaptation of the same architecture: TypeScript instead of
> Python modules, React Three Fisher (Three.js) instead of Panda3D, OpenStreetMap data via
> the Overpass API through Convex actions instead of OSMnx, and an in-browser PPO
> implementation with hand-written gradients instead of PyTorch. All honesty rules from the
> specification are enforced: nothing is claimed to be real that isn't.

---

## 1. What the system does (user flow)

1. Open the **Dispatch Console** (`/dispatch`).
2. **Click the map** to place the patient marker (zoom/pan freely; coordinates are captured
   internally — never typed).
3. Enter the **disease / emergency type** (free text, e.g. "Heart emergency"). The system
   does **not** diagnose disease; text only steers hospital specialty matching.
4. Press **DISPATCH AMBULANCE**:
   - The free-text emergency is first **classified** (critical / non-critical / uncertain) by
     a documented, configurable keyword policy — **not** a clinical diagnosis (see §7a).
   - Road network is fetched from **OpenStreetMap (Overpass)** around the patient (~900 m),
     split at real junctions so every edge keeps its **true OSM geometry (curved polylines)**.
     If the fetch is unavailable **or fails connectivity validation**, a **demonstration grid
     network** is generated and clearly labeled.
   - Nearby **hospitals** are discovered from OSM (`amenity=hospital/clinic`), scored and
     ranked on the *actual road graph* (verified specialties, emergency tag, road ETA, data
     completeness). Unknown capabilities are shown as **unknown**, never invented. If OSM is
     unreachable, clearly-labeled demo hospitals are used.
   - **Hospital-based dispatch**: the ambulance departs from the **nearest suitable hospital**
     (by road-network travel time) and transports the patient to the **best-matching treatment
     hospital** for the emergency — these may be the same or two different hospitals (see §8).
   - Real **OSM building footprints** are fetched and extruded into colorful 3D buildings that
     keep their true geographic position (see §3.5).
   - The **GNN** embeds the road network; the **PPO agent** is quick-trained in the browser
     (demonstration scale) and plans the route leg-by-leg with **masked, connected actions**.
   - **Dijkstra and A\*** run as comparison baselines on the same network & congestion.
   - **Accident response**: the user may select a *simulated* accident blockage (or a real
     accident record only if one is actually loaded — none is fabricated), which closes the
     affected segment(s) and forces a **connected reroute** (see §7b).
5. The journey runs through the shared simulation controller as **two legs**:
   **dispatch hospital → patient → simulated pickup → treatment hospital**, with
   **route-specific emergency signal priority** (only intersections on the active route are
   preempted; normal cycling is restored after the ambulance passes).
6. **Screen 1** is a follow camera on the ambulance (follow / elevated / top-down, scroll to
   zoom). **Screen 2** auto-focuses the next priority intersection and shows the live signal
   state. Both read **one shared simulation state** — one clock, one ambulance, one route.
7. On arrival the dashboard shows the **trip summary, metrics, baseline comparison, PPO
   reward curve**, a downloadable **CSV**, and completed trips are stored in **Convex**.

## 2. Technology

| Layer | Choice |
|---|---|
| Frontend | React 19 + Vite + TypeScript + Tailwind + shadcn/ui |
| Map | Leaflet + OpenStreetMap tiles (mouse-based patient selection) |
| 3D | Three.js via `@react-three/fiber` (instanced meshes, no shadows, low DPR — integrated-graphics friendly) |
| Backend | Convex actions (Overpass API fetches), Convex tables (trip history) |
| AI | Hand-written GNN (2-layer message passing, hidden 16) + PPO actor–critic MLPs with hand-rolled gradients, clipped surrogate objective, action masking, entropy bonus |
| Baselines | Dijkstra and A* over live-congestion travel times |
| State | One `SimulationController` singleton + zustand snapshot at 4 Hz (the 3D views read the live frame imperatively every animation frame) |

## 3. Project layout (mapping to the original spec)

```
src/
├── lib/cotve/
│   ├── types.ts            # core data model
│   ├── config.ts           # settings.yaml / emergency_rules.yaml / traffic_settings.yaml equivalents
│   ├── geo.ts              # lat/lng <-> local meters projection
│   ├── network.ts          # road graph (OSM parse + demo-grid fallback), signals, depots
│   ├── buildings.ts        # real OSM building footprints -> local extruded polygons, honest heights
│   ├── baselines.ts        # dijkstra.ts + astar.ts equivalents
│   ├── gnn.ts              # GNN model (graph_features folded in)
│   ├── ppo.ts              # ppo_agent + ppo_trainer (rollouts, clipped PPO update, quick-train)
│   ├── routeManager.ts     # route_manager + route_validation (PPO planning, A* safe fallback)
│   ├── hospitalDiscovery.ts# hospital discovery, parsing, honest scoring/ranking
│   ├── accidents.ts        # real-accident CSV loader (validated) + labeled simulated blockages
│   ├── signals.ts          # traffic_signal + emergency_priority (route-specific, critical-only)
│   ├── traffic.ts          # traffic_simulator (vehicles, congestion feedback)
│   ├── simulation.ts       # simulation_controller (phases, metrics, shared clock, rerouting)
│   ├── dispatchFlow.ts     # full dispatch pipeline orchestration
│   ├── store.ts            # UI snapshot store
│   ├── datasets/           # registry.ts + parsers.ts (verified real-dataset facts)
│   └── __tests__/          # 6 vitest suites incl. the 14-case routing-correctness suite (§10)
├── components/cotve/       # MapPicker, DispatchPanel, DashboardPanel, CityScene, two 3D views
├── pages/                  # Landing.tsx, Dispatch.tsx (console), Auth.tsx
└── convex/                 # osm.ts (Overpass actions incl. buildings), simulations.ts (history), schema.ts
```

## 4. Running it

```bash
bun install                 # install dependencies
bun run dev                 # start the app (Freebuff manages the dev server & Convex)
bun run test                # run the 52 automated tests (vitest, no network needed)
bun convex dev --once       # push Convex functions + regenerate types
bun tsc -b --noEmit         # typecheck
bun run lint                # eslint
```

No API keys are required: OpenStreetMap data is fetched anonymously through the public
Overpass API. If Overpass is unreachable the app keeps working on clearly-labeled demo data.

## 5. Configuration (`src/lib/cotve/config.ts`)

`settings` — network radius, demo grid size, pickup duration, PPO train budget,
  recalibration interval, reproducible `seed`.
- `criticalityConfig` / `criticalityRules` — the configurable **emergency-classification**
  policy (critical / non-critical / uncertain) and its escalation switch (see §7a).
- `emergencyRules` — emergency type → verified-tag keywords for specialty matching.
- `buildingSettings` / `buildingPalette` — real-building height estimation rules + the controlled
  colorful city palette (see §3.5). `vehicleKinds` defines the vehicle type/colour mix.
- `trafficSettings` — vehicle count, congestion model, ambulance speed factors, gaps.
- `signalSettings` — green/yellow/all-red timings, priority approach distance, hold times.

## 6. AI details

- **GNN**: node features (degree, signalized, position, distances to patient/hospital),
  edge features (length, travel time, density, speed). Two message-passing layers with mean
  aggregation produce 16-dim node embeddings.
  **Honest status: untrained/demonstration embeddings** — there is no real road-embedding
  training data; the embeddings are a fixed random projection of the raw features. The
  hand-crafted decision features drive route quality.
- **PPO** (the only RL method): actor/critic are tiny MLPs with manual backprop; actions are
  scored per outgoing edge and masked to connected road segments (no jumping, no driving
  through buildings); the update uses the clipped surrogate + value MSE + entropy bonus with
  gradient-norm clipping. `quickTrain` runs a few hundred episodes in the browser under a
  wall-clock budget and reports the reward curve.
  **Honest status: demonstration-scale training.** If the policy fails to reach the
  destination within the step budget, the route manager falls back to **A\*** and labels the
  route `fallback-astar` — it never claims PPO produced it.
- **Routing mode is always displayed**: `GNN+PPO`, `GNN+PPO (quick-trained)`, `A* fallback`,
  `Dijkstra`, `A*`.

## 7a. Critical-emergency classification (critical-only priority)

Every dispatch first classifies the free-text emergency via a **documented, configurable
keyword policy** into one of three classes:

- **critical** — a configured critical phrase matched (e.g. cardiac arrest, severe road
  accident, stroke, major bleeding): dispatch, route, and **route-specific signal priority**
  are activated.
- **non-critical** — a configured minor phrase matched: dispatch proceeds but **signal
  priority stays OFF**; the classification result is shown.
- **uncertain** — no configured rule matched: an **uncertainty warning** is shown and priority
  is **not** silently enabled. A configurable escalation policy (`uncertainAsCritical`) can
  opt in to treating uncertain as critical, and is labeled when active.

This is a keyword policy for traffic-priority routing research — it is **not** a clinical
diagnosis, and the UI says so. Priority affects **only** the intersections on the active
route (see §7).

## 7. Traffic signal priority (route-specific)

Only for a **critical** emergency (§7a), and only at intersections **on the active ambulance
route** while the ambulance is within the approach distance, is priority requested. A request never jumps conflicting traffic to red:
the current phase runs out through **yellow → all-red clearance**, then the ambulance axis
is held on green; after the ambulance passes, the signal **restores** normal cycling. Off-
route signals keep their normal green/yellow/all-red cycle and are never touched (verified
by tests).

## 7b. Accident integration & blockage rerouting

Accidents are integrated in two strictly-separated ways:

- **Real accident records** — loadable only from a genuinely-provided CSV via
  `accidents.ts` (`loadRealAccidents`). Records are **validated** (finite coordinates, no
  relocation, source + license recorded). India's official accident sources publish
  **aggregate statistics, not per-crash coordinates**, so no real per-crash dataset ships
  with the app; when none is supplied the UI states that plainly rather than inventing one.
- **Simulated blockages** — clearly-labeled scenario events that close a road segment.

When a segment is blocked (`SimulationController.blockEdge`), both directions close as a
physical closure would, the affected edges are marked `blocked`, the route-integrity check
fires, and the ambulance **reroutes from its next connected junction** (never teleporting,
never entering the blocked road). If the blockage severs the only access, the app reports an
honest **"route unavailable"** message instead of fabricating a path.

## 7c. Hospital-based ambulance dispatch

The ambulance **never starts from an arbitrary depot**. Two roles are chosen automatically
from the discovered hospital candidates (the user never picks or types a hospital):

- **Dispatch hospital** — the **nearest suitable** hospital to the patient, measured by
  **road-network travel time** (directed A\* from each candidate's road-access node to the
  patient access node). This is where the ambulance departs from.
- **Treatment hospital** — the **best-scoring** candidate for the selected emergency
  (verified specialty match, emergency tag, road ETA, data completeness).

They may be the same hospital or two different ones; the dashboard labels both. Journey 1 is
**dispatch hospital → patient**; Journey 2 is **patient → treatment hospital**. Both legs are
road-aligned and use the shared simulation clock. Straight-line distance is never used to
pick a hospital.

## 7d. Realistic map-aligned 3D infrastructure

The real geographical map is the single source of truth — every road, building, signal,
vehicle, hospital and the ambulance share **one projection** (`geo.ts`):

- **Buildings** are **real OSM footprints** (`way[building]`, fetched via the Convex
  `fetchBuildings` action), triangulated and extruded to their height. They render in a
  controlled, muted **city palette** (creams, beiges, greys, terracotta, pastels) — not neon,
  not uniform. Heights come from the OSM `height` tag (**measured**, `heightSource: "osm"`);
  when absent, `building:levels` or a documented per-type estimate is used and clearly labeled
  **`estimated`** — never claimed as measured. On the demo grid (no OSM), the scene shows
  roads only rather than fabricating buildings.
- **Traffic signals** are real 3D signal heads (housing + stacked red/amber/green lenses) on a
  pole, placed on the **approach** of each signalized junction and facing oncoming traffic —
  only where OSM actually tags `highway=traffic_signals` (or labeled "inferred" on the demo
  grid). The active lens lights up from the shared signal controller.
- **Vehicles** follow real edge geometry in a realistic mix (cars, two-wheelers,
  auto-rickshaws, buses, trucks) with per-kind sizes and colors — simulated traffic, labeled
  as such.
- **The ambulance** follows the actual road geometry (arc-length interpolation, tangent
  heading) with a light bar, red cross and wheels; it can never leave the road corridor or
  drive through buildings.

## 8. Metrics & evaluation

Collected live and shown at trip end: response time, (simulated) pickup duration, transport
time, total journey time, distance, signal wait, priority requests/activations/restorations,
relevant intersections, route recalculations, PPO episodes & reward curve, and the Dijkstra/
A* baseline comparison (evaluated on the initial congestion snapshot — **not** re-simulated;
this is stated in the UI). Metrics export to CSV and completed trips persist to Convex.

**No results are fabricated.** If an experiment hasn't run, the UI shows unavailable.

## 9. Real datasets (verified sources, prepare-not-block)

**Study city: Chennai, India** (user-selected; never invented). The pipeline uses real,
verifiable datasets and strictly separates real observations from simulated experiments.

### Verified registry (`src/lib/cotve/datasets/registry.ts` — shown in the app's **Datasets** tab)

| Dataset | Access (verified) | Key verified facts |
|---|---|---|
| **IDD** (India Driving Dataset, IIIT-H) | **Account-gated**: register → login → download; no public URL exists | Detection: 46,588 images (31,569/10,225/4,794), VOC-like XML under `Annotations/` + `JPEGImages/`. Segmentation: polygon JSON under `gtFine/`, 10,003 images. Exact vehicle labels: `motorcycle, bicycle, autorickshaw, car, truck, bus, caravan, trailer, train, vehicle fallback`. License: **not publicly verifiable** — shown only inside the logged-in download flow |
| **CityFlowV2** (AI City Challenge 2022 Track 1) | **Public download** with click-through license (no request form/password per the current access page) | 46 cameras, 16 intersections, 3.58 h, 6 scenarios (3 train/2 val/1 test), 313,931 boxes, 880 identities. Ranking metric **IDF1**. Submission lines: `cam obj frame x y w h xworld yworld`. **Turning-movement ratios / demand matrices: verified absent from documentation.** Released-GT line schema not documented — verified on disk after download |
| **OpenStreetMap** (Chennai) | Public Overpass API | License **ODbL 1.0** (verified). Measured live (2026-10-23, exact city boundary): **535 hospital nodes, 393 traffic-signal nodes** — see `data/datasets/osm-chennai.json` |

### What is automated vs. manual

- `bun scripts/fetch-datasets.ts` — **ran live here**: confirms IDD's login wall and
  CityFlowV2's public download page from the official endpoints, and extracted the real
  Chennai counts above. `--osm` refreshes them; `--verify <dir>` verifies an actual
  downloaded dataset (real files, real structure checks, ACTUAL class counts for IDD VOC
  XML and gtFine polygons, GT line-schema report for CityFlow). Missing files abort
  verification with a clear report — **no substitute files are ever generated**.
- **IDD cannot be automated** (login-gated): register at idd.insaan.iiit.ac.in, download
  manually, then run `bun scripts/fetch-datasets.ts --verify ./idd-detection`.
- **CityFlowV2**: open the official 2022 Track 1 download page, click the link (that click
  accepts the license), download manually, then run the same `--verify`.
- **In-app**: every dispatch's real OSM fetch (roads, real `highway=traffic_signals` nodes,
  hospitals) is recorded as a provenance manifest in Convex and shown in the Datasets tab.

### Real-vs-simulated boundaries enforced in code

- Road topology, hospital locations and **traffic-signal locations** are real OSM data
  (signal nodes carry `signalSource: "osm"` and the dashboard labels them "OSM-verified").
- Signal **timings/phases**, ambulance availability, patient pickup and congestion are
  simulated and labeled simulated; turning ratios and demand matrices are stated as absent
  from the gated distributions' documentation rather than fabricated.
- Once you download IDD/CityFlow and run `--verify`, the manifest records actual class
  counts and GT schema — perception/tracking metrics then report against real annotations.

## 10. Known limitations (deliberate, documented)

1. **Everything traffic-related is simulated** — vehicles, congestion, signal phases,
   ambulance availability, patient pickup. Nothing here dispatches a real ambulance.
2. **Hospital capability data is only as good as OSM tags.** Capacity, beds and staffing are
   never inferred; missing tags are shown as *unknown* and treated as neutral in ranking.
3. **GNN embeddings are untrained** (see §6); the PPO policy is quick-trained at
   demonstration scale in the browser, not a production training run.
4. **OSM networks are radius-bounded** (~900 m around the patient). The network is built
   only if it passes connectivity validation; otherwise the app falls back to the clearly
   labeled demonstration grid. There is no hard node-count cap in the current engine.
5. **Baselines are not re-simulated**: Dijkstra/A* rows compare *estimated* times under the
   initial congestion snapshot against the PPO leg's *simulated* actual time.
6. **Roads are split at real junctions and keep their full OSM geometry** (curved polylines),
   so routing, simulation, and 3D rendering all share the same geometry-true road layout.
   Hospitals are selected only if they snap onto a road inside the built network; real OSM
   hospitals that fall outside are excluded and reported (never silently substituted).

## 11. Future improvements

- Server-side (Convex action) PPO training on larger graphs with persisted checkpoints.
- Real OSM feature training data for the GNN (e.g. congestion datasets mapped onto networks).
- Traffic-light phase inference from OSM `traffic_signals:*` tags.
- Multi-ambulance fleet simulation and stochastic Monte-Carlo scenario evaluation.
