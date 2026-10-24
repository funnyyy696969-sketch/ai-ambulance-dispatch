import { describe, it, expect } from "vitest";
import { buildGraph, generateDemoGrid, validateNetwork, type RawOsmNetwork } from "../network";
import { countVocClasses, parseCityFlowLine } from "../datasets/parsers";
import { IDD, CITYFLOW_V2, DATASETS, STUDY_CITY } from "../datasets/registry";

describe("real OSM traffic-signal locations", () => {
  it("marks nodes carrying a real highway=traffic_signals tag as signalized with source 'osm'", () => {
    const center = { lat: 13.0827, lng: 80.2707 }; // Chennai
    const p = (lat: number, lng: number, id: number) => ({ id, lat, lng });
    const raw: RawOsmNetwork = {
      ways: [
        { id: 1, nodes: [p(center.lat, center.lng, 1), p(center.lat, center.lng + 0.002, 2)], oneway: false, type: "primary", maxspeed: 16, lanes: null },
        { id: 2, nodes: [p(center.lat, center.lng, 1), p(center.lat + 0.002, center.lng, 3)], oneway: false, type: "primary", maxspeed: 16, lanes: null },
        { id: 3, nodes: [p(center.lat, center.lng + 0.002, 2), p(center.lat + 0.002, center.lng + 0.002, 4)], oneway: false, type: "residential", maxspeed: 8, lanes: null },
        { id: 4, nodes: [p(center.lat + 0.002, center.lng, 3), p(center.lat + 0.002, center.lng + 0.002, 4)], oneway: false, type: "residential", maxspeed: 8, lanes: null },
      ],
      signals: [{ lat: center.lat, lng: center.lng }],
      restrictions: [],
      source: "osm",
    };
    const { graph } = buildGraph(raw, center);
    const sig = graph.nodes.find((n) => n.signalSource === "osm")!;
    expect(sig).toBeDefined();
    expect(sig.signalized).toBe(true);
    const others = graph.nodes.filter((n) => n.id !== sig.id);
    for (const n of others) expect(n.signalSource).not.toBe("osm");
    expect(validateNetwork(graph).ok).toBe(true);
  });

  it("demo grids still produce inferred signals, labeled as inferred", () => {
    const g = generateDemoGrid({ lat: 13.0827, lng: 80.2707 }).graph;
    const sig = g.nodes.filter((n) => n.signalized);
    expect(sig.length).toBeGreaterThan(0);
    for (const n of sig) expect(n.signalSource).toBe("inferred");
  });
});

describe("IDD VOC detection parser (verified format)", () => {
  it("counts real object classes from Pascal-VOC-like XML", () => {
    // parser fixture in the VERIFIED IDD format (VOC-like XML per AutoNUE docs)
    const xml = `<annotation>
  <object><name>car</name><bndbox><xmin>1</xmin></bndbox></object>
  <object><name>car</name><bndbox><xmin>2</xmin></bndbox></object>
  <object><name>autorickshaw</name><bndbox><xmin>3</xmin></bndbox></object>
  <object><name>motorcycle</name><bndbox><xmin>4</xmin></bndbox></object>
</annotation>`;
    const counts = countVocClasses(xml);
    expect(counts.get("car")).toBe(2);
    expect(counts.get("autorickshaw")).toBe(1);
    expect(counts.get("motorcycle")).toBe(1);
    expect([...counts.keys()].every((k) => IDD.vehicleClasses.includes(k))).toBe(true);
  });
});

describe("CityFlowV2 GT line parser (submission schema; GT layout verified on disk)", () => {
  it("parses the officially documented 9-field submission format", () => {
    const r = parseCityFlowLine("3 120 54 817 211 55 91 13.06 80.27");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.camId).toBe("3");
      expect(r.value.objId).toBe("120");
      expect(r.value.frameId).toBe(54);
      expect(r.value.world).toEqual([13.06, 80.27]);
    }
  });

  it("accepts 6-field lines (released GT may omit world coords) and rejects malformed ones", () => {
    const ok = parseCityFlowLine("120 54 817 211 55 91");
    expect(ok.ok).toBe(true);
    const bad = parseCityFlowLine("not a track line");
    expect(bad.ok).toBe(false);
    const tooFew = parseCityFlowLine("1 2 3");
    expect(tooFew.ok).toBe(false);
  });
});

describe("dataset registry honesty", () => {
  it("keeps gated access and unverified licenses marked as such", () => {
    expect(IDD.access).toBe("account-gated");
    expect(IDD.license.verified).toBe(false);
    expect(CITYFLOW_V2.license.verified).toBe(true);
    expect(CITYFLOW_V2.vehicleClasses.join(" ").toLowerCase()).toContain("identity");
  });
  it("records the user-selected study city", () => {
    expect(STUDY_CITY).toContain("Chennai");
    expect(DATASETS.length).toBe(2);
  });
});
