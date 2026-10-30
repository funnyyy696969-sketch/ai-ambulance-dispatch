import { Fragment, useEffect, useRef } from "react";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { projector, useFlowStore, type FlowFrame, type FlowScenario } from "@/lib/cotve/backend";

/** Dark basemap that matches the console. Falls back to the flat panel colour
 *  underneath when tiles are unavailable (offline demo). */
const TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

const KIND_COLOR: Record<string, string> = {
  car: "#cbd5e1",
  bus: "#f59e0b",
  truck: "#a78bfa",
  emergency: "#22d3ee",
  other: "#94a3b8",
  ambulance: "#ef4444",
};

function signalColor(sig: FlowFrame["signals"][number]): string {
  if (sig.priority) return "#f0abfc";
  const values = Object.values(sig.approaches ?? {});
  if (values.includes("yellow")) return "#facc15";
  if (values.length > 0 && values.every((v) => v === "red")) return "#ef4444";
  return "#22c55e";
}

/* --------------------------------------------------------------------- */
/* canvas overlay: every fast-moving object (vehicles + signal heads)     */
/* --------------------------------------------------------------------- */

function paint(
  canvas: HTMLCanvasElement,
  map: L.Map,
  scenario: FlowScenario | null,
  frame: FlowFrame | null,
) {
  const size = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(size.x));
  const h = Math.max(1, Math.round(size.y));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!scenario || !frame) return;

  const project = projector(scenario.origin);
  const at = (x: number, y: number) => {
    const [lat, lng] = project(x, y);
    return map.latLngToContainerPoint([lat, lng]);
  };

  // signal heads
  for (const sig of frame.signals) {
    const p = at(sig.x, sig.y);
    const color = signalColor(sig);
    ctx.beginPath();
    ctx.arc(p.x, p.y, sig.priority ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (sig.priority) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
    }
  }

  const box = (x: number, y: number, heading: number, color: string, len: number, wid: number) => {
    const p = at(x, y);
    if (p.x < -20 || p.y < -20 || p.x > w + 20 || p.y > h + 20) return;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-heading);
    ctx.fillStyle = color;
    ctx.fillRect(-len / 2, -wid / 2, len, wid);
    ctx.strokeStyle = "rgba(2,6,23,0.75)";
    ctx.lineWidth = 1;
    ctx.strokeRect(-len / 2, -wid / 2, len, wid);
    ctx.restore();
  };

  for (const v of frame.vehicles) {
    box(v.x, v.y, v.h, KIND_COLOR[v.k] ?? KIND_COLOR.other, 8, 4);
  }
  for (const a of frame.ambulanceVehicles) {
    const p = at(a.x, a.y);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(-a.h);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(-6, -3, 12, 6);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.4;
    ctx.strokeRect(-6, -3, 12, 6);
    ctx.restore();
  }
}

function VehicleLayer() {
  const map = useMap();
  const frame = useFlowStore((s) => s.frame);
  const scenario = useFlowStore((s) => s.scenario);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const latest = useRef({ scenario, frame });
  useEffect(() => {
    latest.current = { scenario, frame };
  }, [scenario, frame]);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "550";
    map.getContainer().appendChild(canvas);
    canvasRef.current = canvas;
    const redraw = () =>
      paint(canvas, map, latest.current.scenario, latest.current.frame);
    map.on("move zoom resize viewreset", redraw);
    redraw();
    return () => {
      map.off("move zoom resize viewreset", redraw);
      canvas.remove();
      canvasRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (canvasRef.current) paint(canvasRef.current, map, scenario, frame);
  }, [map, scenario, frame]);

  return null;
}

/* --------------------------------------------------------------------- */
/* map helpers                                                            */
/* --------------------------------------------------------------------- */

function ClickCapture({
  placeMode,
  onPick,
}: {
  placeMode: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (placeMode) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitScenario({ scenario }: { scenario: FlowScenario | null }) {
  const map = useMap();
  useEffect(() => {
    if (!scenario) return;
    const [[minLat, minLng], [maxLat, maxLng]] = scenario.bounds;
    map.fitBounds(
      [
        [minLat, minLng],
        [maxLat, maxLng],
      ],
      { padding: [40, 40] },
    );
    // refit only when a new scenario arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.name, scenario?.bounds?.[0]?.[0]]);
  return null;
}

const hospitalIcon = L.divIcon({
  className: "",
  html: `<div style="width:22px;height:22px;border-radius:5px;background:#3b82f6;color:#fff;font:700 13px/22px system-ui;text-align:center;border:2px solid #dbeafe;box-shadow:0 2px 6px rgba(0,0,0,.5)">H</div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

const depotIcon = L.divIcon({
  className: "",
  html: `<div style="width:18px;height:18px;border-radius:4px;background:#475569;color:#e2e8f0;font:700 11px/18px system-ui;text-align:center;border:2px solid #94a3b8">D</div>`,
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

const accidentIcon = (severity: string) =>
  L.divIcon({
    className: "",
    html: `<div style="position:relative;width:18px;height:18px">
        <span style="position:absolute;inset:-6px;border-radius:9999px;background:${
          severity === "critical" ? "#ef4444" : "#f97316"
        };opacity:.35;animation:cf-pulse 1.4s ease-out infinite"></span>
        <span style="position:absolute;inset:0;border-radius:9999px;background:#ef4444;border:2px solid #fee2e2;display:flex;align-items:center;justify-content:center;color:#fff;font:700 11px system-ui">!</span>
      </div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });

/* --------------------------------------------------------------------- */

export default function CityFlowMap({
  placeMode,
  onPick,
}: {
  placeMode: boolean;
  onPick: (lat: number, lng: number) => void;
}) {
  const scenario = useFlowStore((s) => s.scenario);
  const frame = useFlowStore((s) => s.frame);
  const origin = scenario?.origin ?? { lat: 12.9716, lng: 77.5946 };

  const centre: [number, number] = [origin.lat, origin.lng];

  return (
    <MapContainer
      center={centre}
      zoom={15}
      zoomControl
      attributionControl={false}
      className="h-full w-full bg-[#0b1120]"
      style={{ background: "#0b1120" }}
    >
      <TileLayer url={TILES} subdomains={["a", "b", "c", "d"]} maxZoom={19} />
      <FitScenario scenario={scenario} />
      <ClickCapture placeMode={placeMode} onPick={onPick} />
      <VehicleLayer />

      {/* ---- static network ---- */}
      {scenario?.roads.map((r) => (
        <Polyline
          key={r.id}
          positions={r.points}
          pathOptions={{
            color: r.group === "h" || r.group === "v" ? "#64748b" : "#3b465e",
            weight: Math.max(2, r.lanes * 1.6),
            opacity: 0.9,
            lineCap: "round",
          }}
        />
      ))}
      {scenario?.intersections.map((i) => (
        <CircleMarker
          key={i.id}
          center={[i.lat, i.lng]}
          radius={i.signal ? 4 : 3}
          pathOptions={{
            color: i.signal ? "#94a3b8" : "#64748b",
            fillColor: i.signal ? "#cbd5e1" : "#475569",
            fillOpacity: 0.9,
            weight: 1,
          }}
        />
      ))}

      {/* ---- facilities ---- */}
      {scenario?.hospitals.map((h) => (
        <Marker key={h.id} position={[h.lat, h.lng]} icon={hospitalIcon} />
      ))}
      {scenario?.depots.map((d) => (
        <Marker key={d.id} position={[d.lat, d.lng]} icon={depotIcon} />
      ))}

      {/* ---- accidents ---- */}
      {(frame?.accidents ?? scenario?.accidents ?? []).map((a) => (
        <Marker key={a.id} position={[a.lat, a.lng]} icon={accidentIcon(a.severity)} />
      ))}

      {/* ---- planned ambulance routes ---- */}
      {frame?.routes.map((r) => (
        <Fragment key={r.id}>
          <Polyline
            positions={r.points}
            pathOptions={{ color: "#020617", weight: 8, opacity: 0.55, lineCap: "round" }}
          />
          <Polyline
            positions={r.points}
            pathOptions={{
              color: r.color,
              weight: 4,
              opacity: 0.95,
              dashArray: r.status === "to-hospital" ? "10 6" : undefined,
              lineCap: "round",
            }}
          />
        </Fragment>
      ))}
    </MapContainer>
  );
}
