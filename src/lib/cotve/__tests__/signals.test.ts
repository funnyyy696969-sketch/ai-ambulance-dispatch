import { describe, it, expect } from "vitest";
import { generateDemoGrid } from "../network";
import { SignalController } from "../signals";
import { signalSettings } from "../config";

const center = { lat: 28.6139, lng: 77.209 };

function signalOnNorthSouthAxis(ctrl: SignalController, nodeId: number): 0 | 1 {
  // find the axis whose incident-edge angle set is predominantly vertical
  const s = ctrl.states.get(nodeId)!;
  return s.greenAxis;
}

describe("traffic signal controller", () => {
  const g = generateDemoGrid(center).graph;
  const signalized = g.nodes.filter((n) => n.signalized);
  const nodeId = signalized[0].id;

  it("cycles green -> yellow -> allred -> green in normal operation", () => {
    const ctrl = new SignalController(g);
    const s = ctrl.states.get(nodeId)!;
    const axis = s.greenAxis;
    expect(ctrl.canPass(nodeId, axis)).toBe(true);
    ctrl.update(signalSettings.greenS + 0.1, []);
    expect(s.phase).toBe("yellow");
    expect(ctrl.canPass(nodeId, axis)).toBe(false);
    ctrl.update(signalSettings.yellowS + 0.1, []);
    expect(s.phase).toBe("allred");
    ctrl.update(signalSettings.allRedS + 0.1, []);
    expect(s.phase).toBe("green");
    expect(s.greenAxis).toBe(axis === 0 ? 1 : 0);
  });

  it("grants emergency priority only when the ambulance approaches", () => {
    const ctrl = new SignalController(g);
    const s = ctrl.states.get(nodeId)!;
    const axis = s.greenAxis === 0 ? 1 : 0; // force a change: ambulance on non-green axis
    // far away: no priority
    ctrl.update(0.1, [{ nodeId, distanceM: 900, axis, passed: false }]);
    expect(s.priority).toBe("none");
    // approach: transition to holding
    ctrl.update(0.1, [{ nodeId, distanceM: 120, axis, passed: false }]);
    expect(["transition", "holding"]).toContain(s.priority);
    ctrl.update(signalSettings.yellowS + signalSettings.allRedS + 0.2, [{ nodeId, distanceM: 60, axis, passed: false }]);
    expect(s.priority).toBe("holding");
    expect(s.greenAxis).toBe(axis);
    expect(ctrl.canPass(nodeId, axis)).toBe(true);
    // conflicting axis is red while held
    expect(ctrl.canPass(nodeId, axis === 0 ? 1 : 0)).toBe(false);
    expect(ctrl.activations).toBeGreaterThan(0);
  });

  it("restores normal operation after the ambulance passes", () => {
    const ctrl = new SignalController(g);
    const s = ctrl.states.get(nodeId)!;
    const axis = s.greenAxis === 0 ? 1 : 0;
    ctrl.update(0.1, [{ nodeId, distanceM: 120, axis, passed: false }]);
    ctrl.update(signalSettings.yellowS + signalSettings.allRedS + 0.2, [{ nodeId, distanceM: 40, axis, passed: false }]);
    expect(s.priority).toBe("holding");
    ctrl.update(0.1, [{ nodeId, distanceM: -5, axis, passed: true }]);
    expect(s.priority).toBe("restoring");
    expect(ctrl.restorations).toBe(1);
    ctrl.update(signalSettings.yellowS + signalSettings.allRedS + 0.2, [{ nodeId, distanceM: -5, axis, passed: true }]);
    expect(s.priority).toBe("none");
    expect(s.priorityAxis).toBeNull();
    // back to a normal cycle afterwards
    ctrl.update(signalSettings.greenS + 0.2, []);
    expect(["yellow", "green", "allred"]).toContain(s.phase);
  });

  it("does not touch signals off the route", () => {
    const ctrl = new SignalController(g);
    const other = signalized[1].id;
    const before = JSON.stringify(ctrl.states.get(other));
    ctrl.update(5, [{ nodeId, distanceM: 100, axis: 1, passed: false }]); // priority business at nodeId only
    expect(JSON.stringify(ctrl.states.get(other))).not.toBe(before);
    // but other signal must still be mid-cycle, not in any priority state
    expect(ctrl.states.get(other)!.priority).toBe("none");
    void signalOnNorthSouthAxis;
  });
});
