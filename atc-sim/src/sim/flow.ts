import { distanceToThreshold } from "./airport";
import type { Aircraft, CommandOption } from "./types";
import type { World } from "./world";

/** Only explicit workflow permissions; speed and vectors remain player choices. */
export function recommendedCommand(world: World, ac: Aircraft): CommandOption | null {
  if (world.status !== "running") return null;
  const choices = world.commandOptions(ac).filter((option) => !option.disabledReason);
  const key = ac.airHolding ? "direct-iaf" : ac.phase === "parked" ? "push-180" :
    ac.phase === "taxi_ready" ? choices.some((option) => option.key === "contact-gnd") ? "contact-gnd" : "taxi-main" :
    ac.phase === "hold_short" ? choices.some((option) => option.key === "contact-twr") ? "contact-twr" : "takeoff" :
    ac.phase === "lineup" ? ac.takeoffPending ? null : "takeoff" :
    ac.phase === "arrival" ? "ils" : ac.phase === "approach" ? choices.some((option) => option.key === "contact-twr") ? "contact-twr" : "land" :
    ac.phase === "departure" ? "contact-dep" : ac.holding ? "hold" : null;
  return choices.find((option) => option.key === key) ?? null;
}

export function decisionFlights(world: World): Aircraft[] {
  return world.aircraftList().filter((ac) => !ac.airHolding && !ac.holding && recommendedCommand(world, ac) ||
    ac.phase === "approach" && !ac.landCleared && distanceToThreshold(world.idx, ac.pos) < 4000 ||
    world.conflicts.some((pair) => pair.split("|").includes(ac.id)))
    .sort((a, b) => Number(b.phase === "approach") - Number(a.phase === "approach") || a.scheduledMovementAt - b.scheduledMovementAt);
}

/** Advances simulation only. Stops before a new permission or urgent safety decision. */
export function advanceToDecision(world: World, maxSeconds = 300): { advanced: number; aircraftId: string | null; operationChanged: boolean } {
  const start = world.time;
  const revision = world.operations.revision;
  let decision = decisionFlights(world)[0];
  if (!decision && world.status === "running") {
    const limit = Math.min(300, Math.max(0, Number.isFinite(maxSeconds) ? maxSeconds : 0));
    while (world.status === "running" && world.time - start < limit - 1e-6) {
      world.step();
      decision = decisionFlights(world)[0];
      if (decision || world.operations.revision !== revision) break;
    }
  }
  return { advanced: world.time - start, aircraftId: decision?.id ?? null, operationChanged: world.operations.revision !== revision };
}

export function flightProgress(ac: Aircraft): { labels: string[]; index: number } {
  if (ac.kind === "dep") return { labels: ["推出", "滑行", "塔台", "起飞", "移交"], index:
    ac.phase === "parked" || ac.phase === "pushback" ? 0 : ac.phase === "taxi_ready" || ac.phase === "taxi_out" ? 1 :
    ac.phase === "hold_short" ? 2 : ac.phase === "lineup" || ac.phase === "takeoff" ? 3 : ac.controller === "DEP" ? 5 : 4 };
  return { labels: ["进近", "塔台", "落地", "脱离", "入位"], index:
    ac.phase === "arrival" ? 0 : ac.phase === "approach" ? ac.landCleared ? 2 : 1 : ac.phase === "landing" ? 3 : ac.phase === "parked" ? 5 : 4 };
}
