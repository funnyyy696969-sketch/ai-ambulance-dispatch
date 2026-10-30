import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { api, useFlowStore, type EvalResult } from "@/lib/cotve/backend";

const METHODS = ["dijkstra", "astar", "ppo"] as const;
const METHOD_COLOR: Record<string, string> = {
  dijkstra: "#94a3b8",
  astar: "#38bdf8",
  ppo: "#34d399",
};

const ROWS: { key: string; label: string; unit: string; lowerIsBetter: boolean }[] = [
  { key: "responseTime", label: "Response time", unit: "s", lowerIsBetter: true },
  { key: "hospitalTravelTime", label: "Accident → hospital", unit: "s", lowerIsBetter: true },
  { key: "totalEmergencyTime", label: "Total emergency time", unit: "s", lowerIsBetter: true },
  { key: "routeDistance", label: "Total route distance", unit: "m", lowerIsBetter: true },
  { key: "avgWaitingTime", label: "Avg vehicle waiting", unit: "s", lowerIsBetter: true },
  { key: "congestion", label: "Traffic congestion", unit: "ratio", lowerIsBetter: true },
  { key: "avgSpeed", label: "Avg vehicle speed", unit: "m/s", lowerIsBetter: false },
  { key: "routingEfficiency", label: "Routing efficiency", unit: "ratio", lowerIsBetter: false },
];

const TIMING_KEYS = ["responseTime", "hospitalTravelTime", "totalEmergencyTime"];

function chartData(ev: EvalResult, keys: string[]) {
  return keys.map((key) => {
    const row: Record<string, string | number> = {
      metric: ROWS.find((r) => r.key === key)?.label ?? key,
    };
    for (const res of ev.results) row[res.method] = res.metrics[key] ?? 0;
    return row;
  });
}

export default function ComparisonPanel() {
  const evaluation = useFlowStore((s) => s.evaluation);
  const evaluating = useFlowStore((s) => s.evaluating);
  const setStore = useFlowStore((s) => s.set);
  const [runs, setRuns] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setStore({ evaluating: true });
    setError(null);
    try {
      const out = await api.evaluate({ runs: Number(runs), emergency: "trauma" });
      setStore({ evaluation: out });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setStore({ evaluating: false });
    }
  };

  const best = (key: string, lower: boolean) => {
    if (!evaluation) return null;
    const vals = evaluation.results
      .map((r) => r.metrics[key])
      .filter((v): v is number => v != null);
    if (vals.length < 2) return null;
    return lower ? Math.min(...vals) : Math.max(...vals);
  };

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/95 shadow-xl">
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-700 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">
          Planner comparison · Dijkstra vs A* vs GNN + PPO
        </h2>
        <Badge variant="outline" className="text-[10px] text-slate-400">
          measured on a fresh CityFlow run per method
        </Badge>
        <div className="ml-auto flex items-center gap-2">
          <Select value={runs} onValueChange={setRuns}>
            <SelectTrigger className="h-8 w-[130px] bg-slate-950 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 scenario</SelectItem>
              <SelectItem value="2">2 scenarios</SelectItem>
              <SelectItem value="3">3 scenarios</SelectItem>
              <SelectItem value="4">4 scenarios</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            className="h-8 bg-emerald-600 text-xs hover:bg-emerald-500"
            onClick={run}
            disabled={evaluating}
          >
            {evaluating ? (
              <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            {evaluating ? "Running experiments…" : "Run comparison"}
          </Button>
        </div>
      </div>

      <div className="p-4">
        {error && <p className="mb-3 text-xs text-red-400">Evaluation failed: {error}</p>}

        {!evaluation && !evaluating && (
          <p className="text-xs text-slate-400">
            Runs every planner on the identical scenario (same seed, same traffic, same accident
            location) and reports what CityFlow actually measured — response time, hospital leg,
            route distance, congestion and efficiency. Nothing here is simulated analytically.
          </p>
        )}

        {evaluating && !evaluation && (
          <p className="text-xs text-slate-400">
            Running the missions… each planner drives a complete emergency run in CityFlow.
          </p>
        )}

        {evaluation && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
              <span>
                Accidents at:{" "}
                <span className="font-mono text-slate-200">
                  {evaluation.scenarios.map(([x, y]) => `(${x}, ${y})`).join(", ")}
                </span>
              </span>
              <span>
                Wall time <span className="font-mono text-slate-200">{evaluation.wallMs} ms</span>
              </span>
              {evaluation.results.map((r) => (
                <span key={r.method} className="flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ background: METHOD_COLOR[r.method] ?? "#64748b" }}
                  />
                  {r.label}: {r.runsOk}/{r.runs} runs
                  {r.fallback ? " (used fallback)" : ""}
                </span>
              ))}
            </div>

            {/* table */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-[10px] uppercase tracking-wider text-slate-400">
                    <th className="py-2 pr-3">Metric</th>
                    {evaluation.results.map((r) => (
                      <th key={r.method} className="py-2 pr-3 text-right">
                        <span
                          className="inline-block h-2 w-2 rounded-full align-middle"
                          style={{ background: METHOD_COLOR[r.method] ?? "#64748b" }}
                        />{" "}
                        {r.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row) => {
                    const b = best(row.key, row.lowerIsBetter);
                    return (
                      <tr key={row.key} className="border-b border-slate-800/80">
                        <td className="py-1.5 pr-3 text-slate-300">
                          {row.label}{" "}
                          <span className="text-slate-600">({row.unit})</span>
                        </td>
                        {evaluation.results.map((r) => {
                          const v = r.metrics[row.key];
                          const isBest = v != null && b != null && Math.abs(v - b) < 1e-9;
                          return (
                            <td
                              key={r.method}
                              className={`py-1.5 pr-3 text-right font-mono tabular-nums ${
                                isBest ? "font-semibold text-emerald-300" : "text-slate-200"
                              }`}
                            >
                              {v == null ? "—" : Number(v).toFixed(row.key === "routingEfficiency" || row.key === "congestion" ? 3 : 1)}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* charts */}
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-slate-400">
                  Emergency timing (sim seconds)
                </h3>
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart data={chartData(evaluation, TIMING_KEYS)} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis dataKey="metric" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={0} />
                    <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid #334155",
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {METHODS.map((m) => (
                      <Bar key={m} dataKey={m} fill={METHOD_COLOR[m]} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <h3 className="mb-2 text-[11px] uppercase tracking-wider text-slate-400">
                  Network effect (waiting s · speed m/s)
                </h3>
                <ResponsiveContainer width="100%" height={230}>
                  <BarChart
                    data={chartData(evaluation, ["avgWaitingTime", "avgSpeed"])}
                    margin={{ top: 4, right: 8, left: -14, bottom: 0 }}
                  >
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis dataKey="metric" tick={{ fill: "#94a3b8", fontSize: 10 }} interval={0} />
                    <YAxis tick={{ fill: "#94a3b8", fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{
                        background: "#0f172a",
                        border: "1px solid #334155",
                        borderRadius: 8,
                        fontSize: 11,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {METHODS.map((m) => (
                      <Bar key={m} dataKey={m} fill={METHOD_COLOR[m]} radius={[3, 3, 0, 0]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* definitions */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-[11px] leading-relaxed text-slate-400">
              <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-slate-500">
                What each planner does
              </h3>
              <ul className="mb-2 space-y-0.5">
                {Object.entries(evaluation.methods).map(([k, v]) => (
                  <li key={k}>
                    <span className="text-slate-300">{k}</span> — {v}
                  </li>
                ))}
              </ul>
              <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-slate-500">
                Metric definitions
              </h3>
              <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 md:grid-cols-2">
                {Object.entries(evaluation.definitions).map(([k, v]) => (
                  <li key={k}>
                    <span className="text-slate-300">{k}</span> — {v}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
