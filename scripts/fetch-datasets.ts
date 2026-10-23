#!/usr/bin/env bun
/**
 * CoTV-E real-dataset acquisition + verification CLI.
 *
 * Run:  bun scripts/fetch-datasets.ts [--verify <downloaded-root>] [--osm]
 *
 * What this does — and deliberately does not do:
 *  - Reports LIVE access status of the two gated/semi-open datasets from
 *    their official endpoints (no scraping of gated content).
 *  - VERIFIES actually-downloaded IDD / CityFlowV2 data on disk: real files,
 *    real structure checks, real counts. Missing required files abort
 *    verification with a clear report — no substitute files are generated.
 *  - With --osm, performs a REAL Overpass query for Chennai-wide hospitals
 *    and traffic-signal nodes and writes a manifest with live counts.
 *  - Writes data/datasets/manifest.json recording everything above.
 *
 * Exit codes: 0 = manifest written (may include "gated/missing" statuses),
 * 1 = verification of on-disk data failed (missing/invalid required files),
 * 2 = network layer failed for a check that should have succeeded.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DATASETS, IDD, CITYFLOW_V2, STUDY_CITY, STUDY_CITY_CENTER } from "../src/lib/cotve/datasets/registry";
import { countVocClasses, parseCityFlowLine } from "../src/lib/cotve/datasets/parsers";

const OVERPASS = "https://overpass-api.de/api/interpreter";
const OUT_DIR = path.join(process.cwd(), "data", "datasets");

interface StatusEntry {
  id: string;
  title: string;
  url: string;
  checkedAt: string;
  httpStatus: number | null;
  result: string;
}

async function checkAccess(): Promise<StatusEntry[]> {
  const entries: StatusEntry[] = [];
  // IDD download endpoint: expected to redirect to login (account-gated)
  try {
    const res = await fetch(IDD.accessSteps[2].match(/https:\/\/\S+/)![0].replace(/\/$/, ""), { redirect: "follow" });
    const text = await res.text();
    const loginGated = res.url.includes("login") || /log\s?in/i.test(text.slice(0, 4000));
    entries.push({
      id: "idd",
      title: IDD.title,
      url: res.url,
      checkedAt: new Date().toISOString(),
      httpStatus: res.status,
      result: loginGated
        ? "ACCOUNT-GATED confirmed live: download endpoint requires registration/login — run the manual steps in the registry"
        : "UNEXPECTED: download endpoint did not present a login wall — re-verify manually before downloading",
    });
  } catch (e) {
    entries.push({ id: "idd", title: IDD.title, url: IDD.accessSteps[2], checkedAt: new Date().toISOString(), httpStatus: null, result: `network failure: ${String(e)}` });
  }
  // CityFlowV2 Track 1 download page: expected reachable, public with license click-through
  try {
    const res = await fetch(CITYFLOW_V2.sources[1].url);
    const text = await res.text();
    const hasLink = /href=["']https?:\/\/[^"']+\.(zip|tar|7z|rar)/i.test(text) || /download/i.test(text);
    entries.push({
      id: "cityflow-v2",
      title: CITYFLOW_V2.title,
      url: CITYFLOW_V2.sources[1].url,
      checkedAt: new Date().toISOString(),
      httpStatus: res.status,
      result: res.ok && hasLink
        ? "PUBLIC DOWNLOAD page reachable: click-through license applies; open the page and download manually (link lives on the page)"
        : res.ok
          ? "Page reachable but no direct file link visible in static HTML — open in a browser and follow the download link"
          : `unexpected HTTP ${res.status}`,
    });
  } catch (e) {
    entries.push({ id: "cityflow-v2", title: CITYFLOW_V2.title, url: CITYFLOW_V2.sources[1].url, checkedAt: new Date().toISOString(), httpStatus: null, result: `network failure: ${String(e)}` });
  }
  return entries;
}

// ---------------- verification of on-disk datasets ----------------

async function walkFiles(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 4) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(p, depth + 1, out);
    else out.push(p);
  }
  return out;
}

async function verifyIdd(root: string, report: string[]): Promise<boolean> {
  const jpegDir = path.join(root, "JPEGImages");
  const annDir = path.join(root, "Annotations");
  const gtFine = path.join(root, "gtFine");
  const leftImg = path.join(root, "leftImg8bit");
  let ok = true;

  if (existsSync(annDir) && existsSync(jpegDir)) {
    report.push(`[IDD-detection] found Annotations/ + JPEGImages/ under ${root}`);
    const xmls = (await walkFiles(annDir)).filter((f) => f.endsWith(".xml"));
    if (xmls.length === 0) {
      report.push("[IDD-detection] FAIL: no .xml annotation files found — download is incomplete");
      return false;
    }
    const classCounts = new Map<string, number>();
    let images = 0;
    for (const f of xmls.slice(0, 5000)) {
      const xml = await readFile(f, "utf8");
      images++;
      for (const [k, v] of countVocClasses(xml)) classCounts.set(k, (classCounts.get(k) ?? 0) + v);
    }
    report.push(`[IDD-detection] parsed ${images} VOC XML files (capped at 5,000): ACTUAL class counts:`);
    for (const [k, v] of [...classCounts.entries()].sort((a, b) => v2(a) - v2(b))) {
      const known = IDD.vehicleClasses.includes(k);
      report.push(`  - ${k}: ${v}${known ? "" : "  (not in verified label table — reported as found, not invented)"}`);
    }
    const splits = (await readdir(annDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    report.push(`[IDD-detection] split folders present: ${splits.join(", ") || "(none — single-folder release)"}`);
  } else {
    report.push("[IDD-detection] not present (JPEGImages/Annotations) — expected: it is account-gated");
  }

  if (existsSync(gtFine) && existsSync(leftImg)) {
    report.push(`[IDD-segmentation] found gtFine/ + leftImg8bit/ under ${root}`);
    const splits = (await readdir(gtFine, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    report.push(`[IDD-segmentation] splits: ${splits.join(", ")}`);
    for (const split of splits) {
      const jsons = (await walkFiles(path.join(gtFine, split))).filter((f) => f.endsWith("_gtFine_polygons.json")).slice(0, 2000);
      const labelCounts = new Map<string, number>();
      let parsed = 0;
      for (const f of jsons) {
        try {
          const j = JSON.parse(await readFile(f, "utf8")) as { objects?: { label: string }[] };
          parsed++;
          for (const o of j.objects ?? []) labelCounts.set(o.label, (labelCounts.get(o.label) ?? 0) + 1);
        } catch {
          report.push(`[IDD-segmentation] FAIL: invalid JSON: ${f}`);
          ok = false;
        }
      }
      report.push(`[IDD-segmentation/${split}] parsed ${parsed} polygon files; top labels: ${[...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
  } else {
    report.push("[IDD-segmentation] not present (gtFine/leftImg8bit) — expected: it is account-gated");
  }
  return ok;
}

const v2 = (k: string) => k;

async function verifyCityFlow(root: string, report: string[]): Promise<boolean> {
  let ok = true;
  const entries = await readdir(root, { withFileTypes: true });
  const scenarios = entries.filter((d) => d.isDirectory() && /^S\d+/i.test(d.name)).map((d) => d.name);
  if (scenarios.length === 0) {
    report.push(`[CityFlowV2] FAIL: no scenario folders (S01…) found under ${root} — release incomplete or wrong directory`);
    return false;
  }
  report.push(`[CityFlowV2] scenarios found: ${scenarios.join(", ")} (official: 6 = 3 train / 2 val / 1 test)`);
  let totalBoxes = 0;
  const identities = new Set<string>();
  for (const sc of scenarios) {
    const cams = (await readdir(path.join(root, sc), { withFileTypes: true })).filter((d) => d.isDirectory() && /^c\d+$/i.test(d.name)).map((d) => d.name);
    if (cams.length === 0) {
      report.push(`[CityFlowV2/${sc}] FAIL: no camera folders (c001…) — download incomplete`);
      ok = false;
      continue;
    }
    report.push(`[CityFlowV2/${sc}] cameras: ${cams.length} (${cams[0]}…${cams[cams.length - 1]})`);
    for (const cam of cams) {
      const camDir = path.join(root, sc, cam);
      const has = await readdir(camDir, { withFileTypes: true });
      const hasGt = has.some((d) => d.isDirectory() && d.name === "gt");
      const hasImg = has.some((d) => d.isDirectory() && d.name === "img1");
      if (!hasImg) {
        report.push(`[CityFlowV2/${sc}/${cam}] missing img1/ — required for tracking verification`);
        ok = false;
        continue;
      }
      if (!hasGt) {
        report.push(`[CityFlowV2/${sc}/${cam}] no gt/ folder (test scenarios may legitimately omit GT)`);
        continue;
      }      const gts = (await walkFiles(path.join(camDir, "gt"))).filter((f) => f.endsWith(".txt"));
        for (const gt of gts) {
          const lines = (await readFile(gt, "utf8")).split(/\r?\n/).filter((l) => l.trim().length > 0);
          for (const line of lines) {
            const parsed = parseCityFlowLine(line);
            if (!parsed.ok) {
              report.push(`[CityFlowV2/${sc}/${cam}] FAIL: ${parsed.error}`);
              ok = false;
              continue;
            }
            // report the schema actually observed (official pages document only
            // the submission format; the released GT layout is verified on disk)
            totalBoxes++;
            identities.add(`${cam}:${parsed.value.objId}`);
          }
        }
    }
  }
  report.push(`[CityFlowV2] parsed totals: ${totalBoxes} boxes, ${identities.size} camera-local track ids (official release: 313,931 boxes / 880 identities across all scenarios)`);
  return ok;
}

// ---------------- real Overpass: Chennai citywide context ----------------

async function fetchChennaiContext(): Promise<Record<string, unknown> | null> {
  // try several REAL query variants in order; accept a variant only when it
  // returns a plausible number of elements (>50) — an empty successful
  // response is treated as a failed variant, not as a zero result.
  const variants: [string, string][] = [
    // exact Chennai district/city boundary (any admin level)
    ["city-boundary", `[out:json][timeout:90];area["name"="Chennai"]["boundary"="administrative"]->.a;
( node["amenity"="hospital"](area.a); node["highway"="traffic_signals"](area.a); );
out body;`],
    // Chennai corporation bounding box
    ["bbox-fallback", `[out:json][timeout:90];
( node["amenity"="hospital"](12.95,80.10,13.30,80.40); node["highway"="traffic_signals"](12.95,80.10,13.30,80.40); );
out body;`],
  ];
  let data: { elements: { type: string; id: number; lat: number; lon: number; tags?: Record<string, string> }[] } | null = null;
  let queryUsed = "none";
  let lastStatus: number | null = null;
  for (const [name, q] of variants) {
    const res = await fetch(OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `data=${encodeURIComponent(q)}`,
    });
    lastStatus = res.status;
    if (!res.ok) continue;
    const parsed = (await res.json()) as { elements: { type: string; id: number; lat: number; lon: number; tags?: Record<string, string> }[] };
    if (parsed.elements.length > 50) {
      data = parsed;
      queryUsed = name;
      break;
    }
  }
  if (!data) throw new Error(`all Overpass variants failed or returned empty results (last HTTP ${lastStatus})`);
  const hospitals = data.elements.filter((e) => e.tags?.amenity === "hospital");
  const signals = data.elements.filter((e) => e.tags?.highway === "traffic_signals");
  return {
    city: STUDY_CITY,
    center: STUDY_CITY_CENTER,
    fetchedAt: new Date().toISOString(),
    source: OVERPASS,
    queryUsed,
    license: "OpenStreetMap data © OpenStreetMap contributors, ODbL 1.0 (verified: osm.org/copyright)",
    counts: { hospitals: hospitals.length, trafficSignals: signals.length },
    hospitals: hospitals.map((e) => ({ id: e.id, lat: e.lat, lng: e.lon, name: e.tags?.name ?? null, emergency: e.tags?.emergency ?? null })),
    trafficSignals: signals.map((e) => ({ id: e.id, lat: e.lat, lng: e.lon })),
  };
}

// ---------------- main ----------------

async function main() {
  const args = process.argv.slice(2);
  const verifyRootIdx = args.indexOf("--verify");
  const runOsm = args.includes("--osm");
  await mkdir(OUT_DIR, { recursive: true });

  const manifest: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    studyCity: STUDY_CITY,
    datasets: DATASETS.map((d) => ({ id: d.id, title: d.title, access: d.access, license: d.license, officialSite: d.officialSite, sources: d.sources })),
    accessStatus: [],
    verification: [],
    osm: null,
  };

  console.log("=== CoTV-E dataset status ===");
  manifest.accessStatus = await checkAccess();
  for (const s of manifest.accessStatus as StatusEntry[]) {
    console.log(`\n[${s.id}] ${s.result}\n  checked: ${s.url}`);
  }

  if (verifyRootIdx >= 0) {
    const root = args[verifyRootIdx + 1];
    console.log(`\n=== Verifying downloaded data under ${root} ===`);
    if (!existsSync(root)) {
      console.error(`Directory not found: ${root}\nAborting verification (no substitutes generated).`);
      process.exit(1);
    }
    const report: string[] = [];
    const iddOk = await verifyIdd(root, report);
    const cfOk = await verifyCityFlow(root, report);
    for (const line of report) console.log(line);
    (manifest.verification as string[]) = report;
    if (!iddOk || !cfOk) {
      console.error("\nVerification FAILED for at least one dataset — fix the download, do not fabricate data.");
      await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
      process.exit(1);
    }
  }

  if (runOsm) {
    console.log(`\n=== Real OSM context for ${STUDY_CITY} (Overpass, live) ===`);
    try {
      const ctx = await fetchChennaiContext();
      manifest.osm = ctx;
      console.log(`hospitals: ${ctx.counts.hospitals}, traffic signals: ${ctx.counts.trafficSignals}`);
      await writeFile(path.join(OUT_DIR, "osm-chennai.json"), JSON.stringify(ctx, null, 2));
    } catch (e) {
      console.error(`OSM fetch FAILED: ${String(e)} — manifest records the failure, no fabricated counts.`);
      manifest.osm = { error: String(e), fetchedAt: new Date().toISOString() };
    }
  }

  await writeFile(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`\nManifest written: ${path.join(OUT_DIR, "manifest.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
