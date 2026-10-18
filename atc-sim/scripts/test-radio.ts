import type { Command, CommandResult } from "../src/sim/types";
import type { World } from "../src/sim/world";

/** Command tests observe the result after the same transmission ticks used by the game. */
export function confirmed(world: World, id: string, command: Command): CommandResult {
  const result = world.issue(id, command);
  if (result.ok) {
    const limit = world.time + 90;
    while (world.aircraft.get(id)?.pendingClearance && world.status === "running" && world.time < limit) world.step();
  }
  return result;
}
