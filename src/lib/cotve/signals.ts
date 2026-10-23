import { signalSettings } from "./config";
import type { RoadGraph, SignalState } from "./types";

/**
 * Traffic signal controller.
 *
 * Normal operation: each signalized intersection alternates green between
 * two axes (NS / EW) with yellow + all-red clearance. Axes are derived from
 * the geometry of incident edges (angle clustering).
 *
 * Emergency priority is ROUTE-SPECIFIC: only intersections on the active
 * ambulance route, and only when the ambulance is approaching, request
 * priority. A request does not jump conflicting traffic straight to red —
 * it runs the current phase down through yellow -> all-red, then holds the
 * ambulance axis on green. After the ambulance passes, the signal returns
 * to normal cycling (restoration event). Signals off the route are never
 * touched.
 */

export class SignalController {
  states = new Map<number, SignalState>();
  requests = 0;
  activations = 0;
  restorations = 0;
  private graph: RoadGraph;

  constructor(graph: RoadGraph) {
    this.graph = graph;
    for (const n of graph.nodes) {
      if (n.signalized) {
        this.states.set(n.id, {
          nodeId: n.id,
          greenAxis: 0,
          phase: "green",
          tInPhase: 0,
          priority: "none",
          priorityAxis: null,
          passedAt: null,
        });
      }
    }
  }

  /** Which axis (0=NS, 1=EW) does an incoming edge belong to at node `n`? */
  axisFor(nodeId: number, fromEdgeAngleDeg: number): 0 | 1 {
    const isNS = Math.abs(Math.abs(fromEdgeAngleDeg) - 90) < 35;
    return isNS ? 0 : 1;
  }

  /** angle (deg) of the edge the ambulance will arrive on, relative to the
   * intersection. */
  arrivalAxis(nodeId: number, prevNodeId: number): 0 | 1 {
    const n = this.graph.nodesById.get(nodeId)!;
    const p = this.graph.nodesById.get(prevNodeId)!;
    const ang = (Math.atan2(n.y - p.y, n.x - p.x) * 180) / Math.PI;
    return this.axisFor(nodeId, ang);
  }

  /** true when the ambulance axis currently shows green (incl. priority). */
  canPass(nodeId: number, axis: 0 | 1): boolean {
    const s = this.states.get(nodeId);
    if (!s) return true; // unsignalized intersection
    if (s.priority === "holding" && s.priorityAxis === axis) return s.phase === "green";
    if (s.priority === "transition" || s.priority === "restoring") return false;
    return s.phase === "green" && s.greenAxis === axis;
  }

  /** Normal phase tick for signals with no active emergency business.
   * Sequential (non else-if) so a large dt can advance several clearances. */
  private tickNormal(s: SignalState, dt: number) {
    s.tInPhase += dt;
    if (s.phase === "green" && s.tInPhase >= signalSettings.greenS) {
      s.phase = "yellow";
      s.tInPhase -= signalSettings.greenS;
    }
    if (s.phase === "yellow" && s.tInPhase >= signalSettings.yellowS) {
      s.phase = "allred";
      s.tInPhase -= signalSettings.yellowS;
    }
    if (s.phase === "allred" && s.tInPhase >= signalSettings.allRedS) {
      s.phase = "green";
      s.greenAxis = s.greenAxis === 0 ? 1 : 0;
      s.tInPhase = 0;
    }
  }

  /**
   * Route-specific priority logic, called by the simulation controller with
   * the list of upcoming route intersections: {nodeId, distanceM}.
   * priorityAxis = axis the ambulance will use to enter.
   */
  update(
    dt: number,
    approaching: { nodeId: number; distanceM: number; axis: 0 | 1; passed: boolean }[],
  ) {
    const approachingIds = new Set(approaching.map((a) => a.nodeId));
    for (const s of this.states.values()) {
      const app = approaching.find((a) => a.nodeId === s.nodeId);
      switch (s.priority) {
        case "none": {
          if (app && !app.passed && app.distanceM <= signalSettings.priorityApproachM) {
            this.requests++;
            if (s.phase === "green" && s.greenAxis === app.axis) {
              // already green for the ambulance — no change needed, just hold
              s.priority = "holding";
              s.priorityAxis = app.axis;
              s.tInPhase = Math.min(s.tInPhase, signalSettings.greenS - 2);
              this.activations++;
            } else {
              s.priority = "transition";
              s.priorityAxis = app.axis;
              if (s.phase === "green") {
                s.phase = "yellow";
                s.tInPhase = 0;
              } else if (s.phase === "yellow") {
                // let yellow finish, all-red next
              } else {
                s.phase = "green";
                s.greenAxis = app.axis;
                s.tInPhase = 0;
                s.priority = "holding";
                this.activations++;
              }
            }
          } else {
            this.tickNormal(s, dt);
          }
          break;
        }
        case "transition": {
          s.tInPhase += dt;
          if (s.phase === "yellow" && s.tInPhase >= signalSettings.yellowS) {
            s.phase = "allred";
            s.tInPhase -= signalSettings.yellowS;
          }
          if (s.phase === "allred" && s.tInPhase >= signalSettings.allRedS) {
            s.phase = "green";
            s.greenAxis = s.priorityAxis ?? 0;
            s.tInPhase = 0;
            s.priority = "holding";
            this.activations++;
          }
          break;
        }
        case "holding": {
          if (app?.passed) {
            // ambulance passed: restore normal operation
            s.priority = "restoring";
            s.phase = "yellow";
            s.tInPhase = 0;
            s.passedAt = null;
            this.restorations++;
          } else {
            // hold green until min green elapses, then keep holding while
            // the ambulance is in range (handled by passed flag)
            s.tInPhase += dt;
          }
          break;
        }
        case "restoring": {
          s.tInPhase += dt;
          if (s.phase === "yellow" && s.tInPhase >= signalSettings.yellowS) {
            s.phase = "allred";
            s.tInPhase -= signalSettings.yellowS;
          }
          if (s.phase === "allred" && s.tInPhase >= signalSettings.allRedS) {
            s.priority = "none";
            s.priorityAxis = null;
            s.tInPhase = 0;
          }
          break;
        }
      }
      // NOTE: 'restoring' -> allred handled above; after that the signal
      // resumes normal cycling from next tick.
    }
    void approachingIds;
  }

  colorOf(s: SignalState, axis: 0 | 1): "red" | "yellow" | "green" {
    if (s.priority === "holding" || s.priority === "transition" || s.priority === "restoring") {
      if (axis === s.priorityAxis) {
        return s.phase === "green" ? "green" : s.phase === "yellow" ? "yellow" : "red";
      }
      return s.phase === "green" ? "red" : s.phase === "yellow" ? "yellow" : "red";
    }
    if (s.phase === "allred") return "red";
    return s.greenAxis === axis ? (s.phase === "green" ? "green" : "yellow") : "red";
  }
}
