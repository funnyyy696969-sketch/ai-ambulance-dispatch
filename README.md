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
   - Road network is fetched from **OpenStreetMap (Overpass)** around the patient (~900 m).
     If unavailable/too dense, a **demonstration grid network** is generated and clearly
     labeled.
   - Nearby **hospitals** are discovered from OSM (`amenity=hospital/clinic`), scored and
     ranked on the *actual road graph* (verified specialties, emergency tag, road ETA, data
     completeness). Unknown capabilities are shown as **unknown**, never invented. If OSM is
     unreachable, clearly-labeled demo hospitals are used.
   - The nearest **simulated ambulance depot** is selected by road-network travel time.
   - The **GNN** embeds the road network; the **PPO agent** is quick-trained in the browser
     (demonstration scale) and plans the route leg-by-leg with **masked, connected actions**.
   - **Dijkstra and A\*** run as comparison baselines on the same network & congestion.
5. The journey runs through the shared simulation controller:
   **ambulance → patient → simulated pickup → hospital**, with **route-specific emergency
   signal priority** (only intersections on the active route are preempted; normal cycling
   is restored after the ambulance passes).
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
│   ├── network.ts          # road graph (OSM parse + demo-grid fallback), signals, depots, buildings
│   ├── baselines.ts        # dijkstra.ts + astar.ts equivalents
│   ├── gnn.ts              # GNN model (graph_features folded in)
│   ├── ppo.ts              # ppo_agent + ppo_trainer (rollouts, clipped PPO update, quick-train)
│   ├── routeManager.ts     # route_manager + route_validation (PPO planning, A* safe fallback)
│   ├── hospitalDiscovery.ts# hospital discovery, parsing, honest scoring/ranking
│   ├── signals.ts          # traffic_signal + emergency_priority (route-specific)
│   ├── traffic.ts          # traffic_simulator (vehicles, congestion feedback)
│   ├── simulation.ts       # simulation_controller (phases, metrics, shared clock)
│   ├── dispatchFlow.ts     # full dispatch pipeline orchestration
│   ├── store.ts            # UI snapshot store
│   └── __tests__/          # vitest suites (network, routing, PPO, signals, journey)
├── components/cotve/       # MapPicker, DispatchPanel, DashboardPanel, CityScene, two 3D views
├── pages/                  # Landing.tsx, Dispatch.tsx (console), Auth.tsx
└── convex/                 # osm.ts (Overpass actions), simulations.ts (history), schema.ts
```

## 4. Running it

```bash
bun install                 # install dependencies
bun run dev                 # start the app (Freebuff manages the dev server & Convex)
bun run test                # run the 23 automated tests (vitest, no network needed)
bun convex dev --once       # push Convex functions + regenerate types
bun tsc -b --noEmit         # typecheck
bun run lint                # eslint
```

No API keys are required: OpenStreetMap data is fetched anonymously through the public
Overpass API. If Overpass is unreachable the app keeps working on clearly-labeled demo data.

## 5. Configuration (`src/lib/cotve/config.ts`)

- `settings` — network radius, node caps, demo grid size, pickup duration, PPO train budget,
  recalibration interval, reproducible `seed`.
- `emergencyRules` — emergency type → verified-tag keywords for specialty matching.
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

## 7. Traffic signal priority (route-specific)

Only intersections **on the active ambulance route** and only while the ambulance is within
the approach distance receive priority. A request never jumps conflicting traffic to red:
the current phase runs out through **yellow → all-red clearance**, then the ambulance axis
is held on green; after the ambulance passes, the signal **restores** normal cycling. Off-
route signals keep their normal green/yellow/all-red cycle and are never touched (verified
by tests).

## 8. Metrics & evaluation

Collected live and shown at trip end: response time, (simulated) pickup duration, transport
time, total journey time, distance, signal wait, priority requests/activations/restorations,
relevant intersections, route recalculations, PPO episodes & reward curve, and the Dijkstra/
A* baseline comparison (evaluated on the initial congestion snapshot — **not** re-simulated;
this is stated in the UI). Metrics export to CSV and completed trips persist to Convex.

**No results are fabricated.** If an experiment hasn't run, the UI shows unavailable.

## 9. Known limitations (deliberate, documented)

1. **Everything traffic-related is simulated** — vehicles, congestion, signal phases,
   ambulance availability, patient pickup. Nothing here dispatches a real ambulance.
2. **Hospital capability data is only as good as OSM tags.** Capacity, beds and staffing are
   never inferred; missing tags are shown as *unknown* and treated as neutral in ranking.
3. **GNN embeddings are untrained** (see §6); the PPO policy is quick-trained at
   demonstration scale in the browser, not a production training run.
4. **OSM networks are capped** (~400 nodes). Denser urban extractions fall back to the
   demonstration grid rather than slowing the engine — the fallback is announced in the UI
   and event log.
5. **Baselines are not re-simulated**: Dijkstra/A* rows compare *estimated* times under the
   initial congestion snapshot against the PPO leg's *simulated* actual time.
6. Edge geometry between OSM intersections is straight-lined (node-to-node), so 3D roads
   approximate curvature.

## 10. Future improvements

- Server-side (Convex action) PPO training on larger graphs with persisted checkpoints.
- Real OSM feature training data for the GNN (e.g. congestion datasets mapped onto networks).
- Traffic-light phase inference from OSM `traffic_signals:*` tags.
- Multi-ambulance fleet simulation and stochastic Monte-Carlo scenario evaluation.
