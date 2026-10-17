import { alongRunway, distanceToThreshold } from "./airport";
import type { World } from "./world";
import { kt } from "./units";

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

    if (ac.phase === "parked" && ac.kind === "dep") {
      world.issue(ac.id, { kind: "pushback", hdg: 180 });
      continue;
    }

    if (ac.phase === "hold_short") {
      if (!shortFinal) world.issue(ac.id, { kind: "takeoff" });
      continue;
    }

    if (ac.phase === "arrival") {
      if (ac.targetGs > kt(225)) world.issue(ac.id, { kind: "speed", kt: 220 });
      if (d < 26000 && alongRunway(world.idx, ac.pos) < -2000) world.issue(ac.id, { kind: "approach", runwayId: world.idx.runway.id });
      continue;
    }

    if (ac.phase === "approach") {
      if (!ac.landCleared && d < 9000) world.issue(ac.id, { kind: "land" });
      continue;
    }

    if (ac.phase === "landing" && ac.exitNodeId === null) {
      const exit = world.idx.exitsByDistance[Math.min(1, world.idx.exitsByDistance.length - 1)];
      if (exit) world.issue(ac.id, { kind: "exit", nodeId: exit.node });
    }
  }
}
