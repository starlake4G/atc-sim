import type { Aircraft, Controller } from "./types";
import type { SimEnv } from "./env";
import { ft } from "./units";

/** Deterministic transmission length in simulation seconds, independent of frame rate. */
export function transmissionSeconds(text: string): number {
  return Math.max(2, Math.min(7, 1 + text.replace(/[\s，。·、]/g, "").length * .14));
}

export function handoffReady(ac: Aircraft, target: Controller, env: SimEnv): boolean {
  if (target === "DEP") return ac.phase === "departure" && ac.altM - env.idx.def.elevationM >= ft(1500);
  if (target === "TWR") return ac.kind === "arr" ? ac.phase === "approach" : ["hold_short", "lineup", "takeoff"].includes(ac.phase);
  return target === "GND" && ac.kind === "arr" && ["landing", "taxi_in", "taxi_ready", "parked"].includes(ac.phase);
}

export function completeHandoff(ac: Aircraft, env: SimEnv): void {
  const pending = ac.pendingHandoff;
  if (!pending || !handoffReady(ac, pending.controller, env)) return;
  ac.controller = pending.controller;
  ac.pendingHandoff = null;
  env.countHandoff(ac);
}
