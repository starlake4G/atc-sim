import { alongRunway, distanceToThreshold } from "./airport";
import type { World } from "./world";
import { angleDiff, ft, kt } from "./units";

/**
 * 简易管制员：只用于无头测试与回归，不参与游戏。
 * 目标是"能把一局跑完且不出事"，不追求效率。
 */
export function botTick(world: World): void {
  const list = world.aircraftList();

  let shortFinal = false;
  for (const ac of list) {
    if (ac.phase === "approach" && distanceToThreshold(world.idx, ac.pos) < 7000) shortFinal = true;
  }

  for (const ac of list) {
    const d = distanceToThreshold(world.idx, ac.pos);
    if (ac.controller === "DEP") continue;
    if (ac.phase === "taxi_ready") {
      if (ac.kind === "arr" && ac.controller !== "GND") world.issue(ac.id, { kind: "handoff", controller: "GND" });
      world.issue(ac.id, { kind: "taxi", route: "main" });
      continue;
    }
    if (ac.phase === "departure" && world.mode === "standard" && ac.altM - world.idx.def.elevationM >= ft(1500)) {
      world.issue(ac.id, { kind: "handoff", controller: "DEP" }); continue;
    }

    if (ac.phase === "parked" && ac.kind === "dep") {
      world.issue(ac.id, { kind: "pushback", hdg: 180 });
      continue;
    }

    if (ac.phase === "hold_short") {
      if (world.mode === "standard" && ac.controller !== "TWR") world.issue(ac.id, { kind: "handoff", controller: "TWR" });
      if (!shortFinal) world.issue(ac.id, { kind: "takeoff" });
      continue;
    }

    if (ac.phase === "arrival") {
      if (ac.targetGs > kt(225)) world.issue(ac.id, { kind: "speed", kt: 220 });
      if (d < 26000 && alongRunway(world.idx, ac.pos) < -2500 && Math.abs(angleDiff(ac.hdg, world.idx.runway.hdg)) < 65) world.issue(ac.id, { kind: "approach", runwayId: world.idx.runway.id });
      continue;
    }

    if (ac.phase === "approach") {
      if (world.mode === "standard" && ac.controller !== "TWR" && ac.approach?.established) world.issue(ac.id, { kind: "handoff", controller: "TWR" });
      if (!ac.landCleared && d < 9000) world.issue(ac.id, { kind: "land" });
      continue;
    }

    if (ac.phase === "landing" && ac.exitNodeId === null) {
      const exit = world.idx.exitsByDistance[Math.min(1, world.idx.exitsByDistance.length - 1)];
      if (exit) world.issue(ac.id, { kind: "exit", nodeId: exit.node });
    }
  }
}
