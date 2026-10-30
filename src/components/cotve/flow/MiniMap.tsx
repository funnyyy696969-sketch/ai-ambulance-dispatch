import { useMemo } from "react";
import { useFlowStore } from "@/lib/cotve/backend";

const W = 168;
const H = 128;
const PAD = 8;

/** Bottom-right overview map: the whole road network, facilities, live
 *  ambulances/routes plus a scale bar and north arrow. */
export default function MiniMap() {
  const scenario = useFlowStore((s) => s.scenario);
  const frame = useFlowStore((s) => s.frame);

  const view = useMemo(() => {
    if (!scenario) return null;
    const [[minLat, minLng], [maxLat, maxLng]] = scenario.bounds;
    const dLat = Math.max(1e-6, maxLat - minLat);
    const dLng = Math.max(1e-6, maxLng - minLng);
    const proj = (lat: number, lng: number): [number, number] => [
      PAD + ((lng - minLng) / dLng) * (W - 2 * PAD),
      PAD + ((maxLat - lat) / dLat) * (H - 2 * PAD),
    ];
    // ground width in metres for the scale bar
    const mPerDegLng = 111_320 * Math.cos((minLat * Math.PI) / 180);
    const widthM = dLng * mPerDegLng;
    const choices = [50, 100, 200, 500, 1000];
    const target = widthM / 3.5;
    const barM = choices.find((c) => c >= target) ?? choices[choices.length - 1];
    const barPx = (barM / widthM) * (W - 2 * PAD);
    return { proj, barM, barPx };
  }, [scenario]);

  if (!scenario || !view) return null;

  const { proj, barM, barPx } = view;

  return (
    <div className="pointer-events-none rounded-lg border border-slate-700/80 bg-slate-950/92 p-1.5 shadow-xl backdrop-blur">
      <svg width={W} height={H} className="block">
        <rect x={0} y={0} width={W} height={H} rx={6} fill="#0b1120" />
        <g stroke="#233044" strokeWidth={1.2} fill="none" strokeLinecap="round">
          {scenario.roads.map((r) => (
            <polyline
              key={r.id}
              points={r.points.map(([lat, lng]) => proj(lat, lng).join(",")).join(" ")}
            />
          ))}
        </g>

        {/* active routes */}
        {frame?.routes.map((r) => (
          <polyline
            key={r.id}
            points={r.points.map(([lat, lng]) => proj(lat, lng).join(",")).join(" ")}
            fill="none"
            stroke={r.color}
            strokeWidth={2}
            opacity={0.95}
          />
        ))}

        {/* facilities */}
        {scenario.hospitals.map((h) => {
          const [x, y] = proj(h.lat, h.lng);
          return <rect key={h.id} x={x - 3} y={y - 3} width={6} height={6} fill="#3b82f6" />;
        })}
        {scenario.depots.map((d) => {
          const [x, y] = proj(d.lat, d.lng);
          return <rect key={d.id} x={x - 2.5} y={y - 2.5} width={5} height={5} fill="#64748b" />;
        })}

        {/* accidents */}
        {(frame?.accidents ?? []).map((a) => {
          const [x, y] = proj(a.lat, a.lng);
          return <circle key={a.id} cx={x} cy={y} r={4} fill="#f97316" stroke="#fff" strokeWidth={1} />;
        })}

        {/* ambulances */}
        {(frame?.ambulances ?? [])
          .filter((a) => a.x != null && a.y != null)
          .map((a) => {
            const [lat, lng] = [
              scenario.origin.lat + (a.y as number) / 111_320,
              scenario.origin.lng +
                (a.x as number) / (111_320 * Math.cos((scenario.origin.lat * Math.PI) / 180)),
            ];
            const [x, y] = proj(lat, lng);
            return <circle key={a.id} cx={x} cy={y} r={3.5} fill={a.color} stroke="#fff" strokeWidth={1} />;
          })}

        {/* scale bar */}
        <g transform={`translate(${PAD}, ${H - PAD - 6})`}>
          <line x1={0} y1={0} x2={barPx} y2={0} stroke="#cbd5e1" strokeWidth={1.5} />
          <line x1={0} y1={-3} x2={0} y2={3} stroke="#cbd5e1" strokeWidth={1.5} />
          <line x1={barPx} y1={-3} x2={barPx} y2={3} stroke="#cbd5e1" strokeWidth={1.5} />
          <text x={barPx + 5} y={3} fill="#cbd5e1" fontSize={8} fontFamily="monospace">
            {barM} m
          </text>
        </g>

        {/* north arrow */}
        <g transform={`translate(${W - PAD - 6}, ${PAD + 8})`}>
          <path d="M0,-7 L4,5 L0,2 L-4,5 Z" fill="#e2e8f0" />
          <text x={0} y={14} fill="#e2e8f0" fontSize={8} textAnchor="middle" fontFamily="monospace">
            N
          </text>
        </g>
      </svg>
    </div>
  );
}
