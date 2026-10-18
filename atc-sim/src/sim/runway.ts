import { getType } from "../data/aircraft-types";
import { distanceToThreshold } from "./airport";
import type { SimEnv } from "./env";
import type { Aircraft } from "./types";
import { ft, kt, nm } from "./units";
import { dist } from "./vec";

export interface RunwayUse { callsign: string; typeId: string; at: number }

/** Tunable game margins, not an operational aviation separation table. */
export function wakeSeparationSec(leaderTypeId: string, followerTypeId: string): number {
  const leader = getType(leaderTypeId).wake, follower = getType(followerTypeId).wake;
  return leader === "H" ? follower === "L" ? 120 : 90 : leader === "M" && follower === "L" ? 45 : 0;
}

export function wakeRemaining(env: SimEnv, ac: Aircraft): number {
  const previous = env.lastRunwayUse;
  if (!previous) return 0;
  const interval = wakeSeparationSec(previous.typeId, ac.typeId);
  return Math.max(0, interval - (env.time - previous.at));
}

export interface DepartureWindow {
  aircraftId: string;
  callsign: string;
  arrivalInSec: number;
  requiredSec: number;
}

export interface DepartureWindowEstimate extends DepartureWindow {
  preparationSec: number;
  releaseSec: number;
  bufferSec: number;
  marginSec: number;
}

/** The same conservative margins used by permissions, also exposed when the window is positive. */
export function departureWindowEstimates(env: SimEnv, ac: Aircraft): DepartureWindowEstimate[] {
  if (ac.kind !== "dep" || ac.phase !== "hold_short" && ac.phase !== "lineup") return [];
  const preparationSec = departurePreparationSec(env, ac);
  const releaseSec = 100 / (ft(getType(ac.typeId).climbFpm) / 60);
  return env.aircraftList().filter((other) => other.id !== ac.id && other.kind === "arr" && other.phase === "approach")
    .map((other) => {
      const arrivalInSec = approachRunwayETA(env, other);
      const arrivalSpeed = Math.max(other.gs, kt(getType(other.typeId).vappKt)) + kt(env.windKt);
      const bufferSec = nm(2) / Math.max(1, arrivalSpeed) + 5;
      const requiredSec = preparationSec + releaseSec + bufferSec;
      return { aircraftId: other.id, callsign: other.callsign, arrivalInSec, requiredSec, preparationSec, releaseSec, bufferSec, marginSec: arrivalInSec - requiredSec };
    }).sort((a, b) => a.marginSec - b.marginSec || a.arrivalInSec - b.arrivalInSec);
}

/** Remaining game-model time from permission to rotation, including lineup acceleration. */
export function departurePreparationSec(env: SimEnv, ac: Aircraft): number {
  const lineDistance = ac.phase === "lineup"
    ? ac.route?.remaining(ac.pos) ?? 0
    : ac.phase === "takeoff" ? 0
      : dist(env.idx.nodes.get(env.idx.holdingNode)!.pos, env.idx.nodes.get(env.idx.lineupNode)!.pos);
  const lineup = lineDistance / kt(8) + (lineDistance > 0 ? Math.max(0, kt(8) - ac.gs) / .8 / 2 + 2 : 0);
  const rotation = Math.max(0, kt(getType(ac.typeId).rotationKt) - (ac.phase === "takeoff" ? ac.gs : 0)) / kt(3.6);
  return lineup + rotation;
}

/** Earliest plausible threshold arrival at the present approach speed, including tailwind. */
export function approachRunwayETA(env: SimEnv, ac: Aircraft): number {
  const speed = Math.max(ac.gs, kt(getType(ac.typeId).vappKt)) + kt(env.windKt);
  return distanceToThreshold(env.idx, ac.pos) / Math.max(1, speed);
}

/**
 * Permission must leave room for the whole departure, not merely an empty runway now.
 * These are conservative game margins: release height plus a 2 NM approach buffer.
 */
export function departureWindow(env: SimEnv, ac: Aircraft): DepartureWindow | null {
  // Keep the existing nearest insufficient approach as the rejection message.
  return departureWindowEstimates(env, ac).filter((window) => window.marginSec < 0).sort((a, b) => a.arrivalInSec - b.arrivalInSec)[0] ?? null;
}

export function runwayBlockReason(env: SimEnv, ac: Aircraft): string | undefined {
  const operation = env.operations?.blockReason(env, ac);
  if (operation) return operation;
  const other = env.aircraftList().find((a) => a.id !== ac.id &&
    (a.id === env.runwayOccupantId || a.phase === "approach" && a.landCleared));
  if (other) return `跑道 ${env.idx.runway.id} 已由 ${other.callsign} 占用或获准落地`;
  const wake = wakeRemaining(env, ac);
  if (wake > 0) return `前机 ${env.lastRunwayUse!.callsign} 的尾流间隔还需 ${Math.ceil(wake)} 游戏秒`;
  const window = departureWindow(env, ac);
  if (window) return `${window.callsign} 约 ${Math.ceil(window.arrivalInSec)} 游戏秒到达；起飞窗口需 ${Math.ceil(window.requiredSec)} 秒，${ac.phase === "lineup" ? "请先引导来机等待或复飞" : "请先安排其落地"}`;
  return env.runwayPlan?.blockReason(env, ac);
}
