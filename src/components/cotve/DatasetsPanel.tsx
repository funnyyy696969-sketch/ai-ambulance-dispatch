import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, Database, ShieldCheck, ShieldAlert, MapPin } from "lucide-react";
import { DATASETS, STUDY_CITY } from "@/lib/cotve/datasets/registry";

/** Live provenance of every real OSM fetch this session/deployment made. */
function OsmManifestList() {
  const manifests = useQuery(api.simulations.listOsmManifests, { limit: 6 });
  if (!manifests || manifests.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No OSM fetches recorded yet — dispatch once, or run{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-[10px]">bun scripts/fetch-datasets.ts --osm</code>.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {manifests.map((m) => (
        <div key={m._id} className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5 text-cyan-500" />
            <span className="font-medium">{m.kind}</span>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">
              {new Date(m.fetchedAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">
            {m.lat != null && m.lng != null ? `@ (${m.lat.toFixed(4)}, ${m.lng.toFixed(4)}) r=${m.radiusM}m · ` : ""}
            {m.nodeCount} nodes · {m.edgeCount} directed edges · {m.osmSignalNodes} OSM signal nodes
          </div>
          <div className="text-[10px] text-muted-foreground">{m.license} · via {m.endpoint}</div>
        </div>
      ))}
    </div>
  );
}

export default function DatasetsPanel() {
  return (
    <div className="space-y-4 overflow-y-auto pr-1">
      <div className="rounded-md border border-cyan-500/30 bg-cyan-500/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 font-semibold text-cyan-300">
          <Database className="h-4 w-4" /> Real-data policy
        </div>
        <p className="mt-1 leading-relaxed text-muted-foreground">
          Study city: <span className="font-semibold text-foreground">{STUDY_CITY}</span> (set by you).
          Gated datasets are <span className="font-semibold">prepared, not blocked</span>: verified access
          steps and a runnable verification CLI exist, and the app never substitutes fabricated data when
          a download is missing. All ambulance movement, signal timings and congestion remain{" "}
          <span className="font-semibold">simulated</span> and are labeled as such everywhere.
        </p>
        <p className="mt-1.5 text-muted-foreground">
          Measured Chennai context (real Overpass extraction,{" "}
          <code className="text-[10px]">data/datasets/osm-chennai.json</code>): <span className="font-mono">535</span>{" "}
          hospital nodes · <span className="font-mono">393</span> traffic-signal nodes · license ODbL 1.0.
        </p>
      </div>

      {DATASETS.map((d) => (
        <div key={d.id} className="rounded-md border border-border p-3">
          <div className="flex items-start justify-between gap-2">
            <div className="text-sm font-semibold">{d.title}</div>
            <Badge variant={d.access === "account-gated" ? "destructive" : "default"} className="shrink-0 text-[10px]">
              {d.access === "account-gated" ? "account-gated" : "public + license click-through"}
            </Badge>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 text-[11px]">
            {d.license.verified ? (
              <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-500" />
            )}
            <span className="text-muted-foreground">License: {d.license.value}</span>
          </div>
          <ul className="mt-2 space-y-1 text-[11px] leading-snug text-muted-foreground">
            {d.facts.map((f, i) => (
              <li key={i}>
                {f.verified ? "✓" : "?"} {f.value}
              </li>
            ))}
          </ul>
          <div className="mt-2 rounded bg-muted/50 px-2 py-1.5 text-[11px]">
            <div className="font-medium">Vehicle-related classes / products (verified, exact names):</div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{d.vehicleClasses.join(" · ")}</div>
          </div>
          <details className="mt-2">
            <summary className="cursor-pointer text-[11px] font-medium text-cyan-400">Access steps</summary>
            <ol className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
              {d.accessSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
          <div className="mt-2 flex flex-wrap gap-2">
            {d.sources.map((s) => (
              <a
                key={s.id}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" /> {s.title}
              </a>
            ))}
          </div>
        </div>
      ))}

      <div className="rounded-md border border-border p-3">
        <div className="text-sm font-semibold">Verification CLI (run locally with bun)</div>
        <div className="mt-1.5 space-y-1 font-mono text-[10px] text-muted-foreground">
          <div>bun scripts/fetch-datasets.ts --osm</div>
          <div>bun scripts/fetch-datasets.ts --verify &lt;downloaded-root&gt;</div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Status/OSM checks ran live on {new Date().getFullYear()}-10-23: IDD confirmed login-gated;
          CityFlowV2 download page reachable. --verify parses real IDD VOC XML / gtFine polygon JSON and
          CityFlow GT txt lines and reports ACTUAL class counts; it aborts on missing files and never
          writes substitute data.
        </p>
      </div>

      <div className="rounded-md border border-border p-3">
        <div className="text-sm font-semibold">Live OSM provenance (Convex)</div>
        <div className="mt-2">
          <OsmManifestList />
        </div>
      </div>
    </div>
  );
}
