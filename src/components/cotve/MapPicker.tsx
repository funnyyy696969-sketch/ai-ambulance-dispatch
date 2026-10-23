import { useEffect, useMemo } from "react";
import { MapContainer, TileLayer, CircleMarker, Polyline, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { useSimStore } from "@/lib/cotve/store";
import { getController } from "@/lib/cotve/simulation";

function ClickHandler({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/** Fly the map to the patient when a dispatch starts. */
function FollowPatient({ patient }: { patient: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (patient) map.flyTo(patient, Math.max(map.getZoom(), 14), { duration: 0.8 });
  }, [patient?.[0], patient?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export default function MapPicker() {
  const patient = useSimStore((s) => s.patient);
  const hospitals = useSimStore((s) => s.hospitals);
  const selected = useSimStore((s) => s.selectedHospital);
  const depot = useSimStore((s) => s.depotLatLng);
  const route = useSimStore((s) => s.routeLatLngs);
  const setStatus = useSimStore((s) => s.set);

  const onPick = (lat: number, lng: number) => {
    setStatus({ patient: { lat, lng } });
  };

  const routeLine = useMemo(() => route, [route]);

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border border-border">
      <MapContainer
        center={[28.6139, 77.209]}
        zoom={14}
        className="h-full w-full"
        style={{ background: "#0b1120" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />
        <ClickHandler onPick={onPick} />
        <FollowPatient patient={patient ? [patient.lat, patient.lng] : null} />

        {patient && (
          <>
            <CircleMarker
              center={[patient.lat, patient.lng]}
              radius={9}
              pathOptions={{ color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.9, weight: 2 }}
            />
            <CircleMarker
              center={[patient.lat, patient.lng]}
              radius={16}
              pathOptions={{ color: "#ef4444", fillOpacity: 0.15, weight: 1 }}
            />
          </>
        )}

        {hospitals.map((h) => (
          <CircleMarker
            key={h.id}
            center={[h.lat, h.lng]}
            radius={selected?.id === h.id ? 8 : 5}
            pathOptions={{
              color: selected?.id === h.id ? "#38bdf8" : "#94a3b8",
              fillColor: selected?.id === h.id ? "#38bdf8" : "#64748b",
              fillOpacity: 0.85,
              weight: 2,
            }}
          />
        ))}

        {depot && (
          <CircleMarker
            center={[depot.lat, depot.lng]}
            radius={6}
            pathOptions={{ color: "#22c55e", fillColor: "#22c55e", fillOpacity: 0.9, weight: 2 }}
          />
        )}

        {routeLine.length > 1 && (
          <Polyline positions={routeLine} pathOptions={{ color: "#f59e0b", weight: 4, opacity: 0.9 }} />
        )}
      </MapContainer>

      <div className="pointer-events-none absolute bottom-2 left-2 z-[500] rounded-md bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow">
        Click the map to place the patient · route in orange
        {getController().graph?.source === "demo-grid" ? " · demo road grid active" : ""}
      </div>
    </div>
  );
}
