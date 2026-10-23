import { motion } from "framer-motion";
import { Link } from "react-router";
import {
  Siren, BrainCircuit, MapPinned, TrafficCone, MonitorPlay, Gauge, ArrowRight, Hospital, ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.5 },
};

const steps = [
  { icon: MapPinned, title: "Click the map", text: "The patient's coordinates are captured from the mouse click — no typing lat/lng, no hospital names." },
  { icon: Hospital, title: "Hospitals auto-discovered", text: "Nearby facilities are pulled from OpenStreetMap and ranked by verified specialties, road travel time and accessibility." },
  { icon: BrainCircuit, title: "GNN + PPO route the ambulance", text: "A graph neural network encodes the live road network; a PPO agent picks every intersection turn under masked, connected actions." },
  { icon: TrafficCone, title: "Route-specific signal priority", text: "Only intersections on the active route get emergency preemption — green via yellow → all-red clearance, then restored." },
  { icon: MonitorPlay, title: "Two synchronized 3D screens", text: "A follow camera on the ambulance and a signal camera on the next priority intersection share one simulation clock." },
];

const features = [
  { icon: BrainCircuit, title: "GNN road encoding", text: "Lightweight 2-layer message passing turns intersections + segments into node embeddings for the policy." },
  { icon: Gauge, title: "PPO-only RL routing", text: "Clipped-surrogate actor–critic with action masking, entropy regularization and in-browser quick-training. Dijkstra & A* run strictly as baselines." },
  { icon: TrafficCone, title: "Emergency signal controller", text: "Red / yellow / green / emergency-priority states with minimum green, yellow clearance and all-red safety gaps." },
  { icon: MonitorPlay, title: "Live traffic & metrics", text: "Simulated vehicles create congestion the router reacts to; trip metrics, baseline comparison and CSV export at the end." },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* hero */}
      <div className="relative overflow-hidden border-b border-border">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(#1e293b 1px, transparent 1px), linear-gradient(90deg, #1e293b 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse 80% 70% at 50% 30%, black, transparent)",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-4 py-24 text-center">
          <motion.div {...fadeUp}>
            <Badge variant="outline" className="mb-5 border-red-500/40 bg-red-500/10 px-3 py-1 text-red-400">
              <Siren className="mr-1.5 h-3.5 w-3.5" /> AI emergency response simulation
            </Badge>
          </motion.div>
          <motion.h1
            {...fadeUp}
            className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight sm:text-6xl"
          >
            CoTV-E
            <span className="block bg-gradient-to-r from-red-500 via-orange-400 to-amber-300 bg-clip-text text-transparent">
              Ambulance dispatch, routed by AI
            </span>
          </motion.h1>
          <motion.p {...fadeUp} className="mx-auto mt-5 max-w-2xl text-balance text-muted-foreground">
            Pick the patient's location on a map and type the emergency. CoTV-E discovers hospitals
            from OpenStreetMap, assigns the nearest simulated ambulance, learns a route with a
            Graph Neural Network + PPO policy, preempts only the traffic signals it will actually
            cross, and replays the whole journey in two synchronized 3D views.
          </motion.p>
          <motion.div {...fadeUp} className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg" className="bg-red-600 text-white hover:bg-red-500">
              <Link to="/dispatch">
                Open Dispatch Console <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/dispatch#how">See how it works</Link>
            </Button>
          </motion.div>
          <motion.p {...fadeUp} className="mt-6 text-xs text-muted-foreground">
            Everything is a simulation: hospitals, ambulance availability, traffic and pickups are
            derived from open geographic data or clearly-labeled demo data — no real dispatch.
          </motion.p>
        </div>
      </div>

      {/* pipeline */}
      <section id="how" className="mx-auto max-w-6xl px-4 py-20">
        <motion.h2 {...fadeUp} className="text-center text-2xl font-bold sm:text-3xl">
          One click. The system does the rest.
        </motion.h2>
        <div className="mt-12 grid gap-4 md:grid-cols-5">
          {steps.map((s, i) => (
            <motion.div key={s.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: i * 0.07 }}>
              <Card className="h-full border-border/70 bg-card/60">
                <CardContent className="p-4">
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                    <s.icon className="h-5 w-5" />
                  </div>
                  <div className="text-sm font-semibold">
                    {i + 1}. {s.title}
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{s.text}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      {/* features */}
      <section className="border-y border-border bg-card/30">
        <div className="mx-auto max-w-6xl px-4 py-20">
          <motion.h2 {...fadeUp} className="text-center text-2xl font-bold sm:text-3xl">
            Built for honest, lightweight intelligence
          </motion.h2>
          <div className="mt-12 grid gap-4 sm:grid-cols-2">
            {features.map((f) => (
              <motion.div key={f.title} {...fadeUp}>
                <Card className="h-full">
                  <CardContent className="flex gap-4 p-5">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400">
                      <f.icon className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="font-semibold">{f.title}</div>
                      <p className="mt-1 text-sm text-muted-foreground">{f.text}</p>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* honesty + CTA */}
      <section className="mx-auto max-w-4xl px-4 py-20 text-center">
        <motion.div {...fadeUp}>
          <ShieldAlert className="mx-auto mb-4 h-8 w-8 text-amber-400" />
          <h2 className="text-2xl font-bold">What this system does not do</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            It does not diagnose disease, does not claim real ambulance availability, and never
            invents hospital beds or specialties: unknown capabilities are shown as unknown. The
            GNN embeddings are untrained demonstrations and the PPO policy is quick-trained in your
            browser at demonstration scale — when the policy can't produce a valid route, a safe A*
            fallback takes over and says so. All performance numbers come from the synthetic
            simulation, never from real-world claims.
          </p>
          <Button asChild size="lg" className="mt-8 bg-red-600 text-white hover:bg-red-500">
            <Link to="/dispatch">
              Launch a simulation <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </motion.div>
      </section>

      <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground">
        CoTV-E — GNN + PPO emergency routing academic project · Map data © OpenStreetMap contributors
      </footer>
    </div>
  );
}
