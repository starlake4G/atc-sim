import { getType } from "../data/aircraft-types";
import { alongRunway, distanceToThreshold, lateralOffset } from "./airport";
import type { SimEnv } from "./env";
import type { Aircraft } from "./types";
import { ft, kt, nm } from "./units";
import { dist } from "./vec";
import { lineupRoute } from "./ground";

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

/**
 * 空速 → 跑道方向上的地速。`Aircraft.gs` 已经是地速（含风），
 * 所以任何拿"真空速/进近速度"做下限的地方都必须先做这一步转换，不能直接在结果上再加一次风。
 */
export function groundSpeedFor(env: SimEnv, airspeedMps: number, headingDeg = env.idx.runway.hdg): number {
  const wind = kt(env.windKt) * Math.cos((env.windDirDeg + 180 - headingDeg) * Math.PI / 180);
  return Math.max(0, airspeedMps + wind);
}

/** The same conservative margins used by permissions, also exposed when the window is positive. */
export function departureWindowEstimates(env: SimEnv, ac: Aircraft): DepartureWindowEstimate[] {
  if (ac.kind !== "dep" || ac.phase !== "hold_short" && ac.phase !== "lineup") return [];
  const preparationSec = departurePreparationSec(env, ac);
  const releaseSec = 100 / (ft(getType(ac.typeId).climbFpm) / 60);
  return env.aircraftList().filter((other) => other.id !== ac.id && other.kind === "arr" && other.phase === "approach")
    .map((other) => {
      const arrivalInSec = approachRunwayETA(env, other);
      const arrivalSpeed = Math.max(other.gs, groundSpeedFor(env, kt(getType(other.typeId).vappKt)));
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
      : lineupRoute(env, ac).total;
  const lineup = lineDistance / kt(8) + (lineDistance > 0 ? Math.max(0, kt(8) - ac.gs) / .8 / 2 + 2 : 0);
  const rotation = Math.max(0, groundSpeedFor(env, kt(getType(ac.typeId).rotationKt)) - (ac.phase === "takeoff" ? ac.gs : 0)) / kt(3.6);
  return lineup + rotation + (ac.pendingClearance ? Math.max(0, ac.pendingClearance.commitAt - env.time) : 7);
}

/** Earliest plausible threshold arrival: 当前地速与该机型进近速度（换算成地速）取大。 */
export function approachRunwayETA(env: SimEnv, ac: Aircraft): number {
  const speed = Math.max(ac.gs, groundSpeedFor(env, kt(getType(ac.typeId).vappKt)));
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

/** Actual runway traffic; a landing clearance alone is only a reservation. */
export function runwayTraffic(env: SimEnv): Aircraft[] {
  return env.aircraftList().filter((a) => a.id === env.runwayOccupantId ||
    ["lineup", "takeoff", "landing", "taxi_in", "departure"].includes(a.phase) &&
    a.altM - env.idx.def.elevationM < 100 &&
    Math.abs(lateralOffset(env.idx, a.pos)) < env.idx.runway.widthM / 2 + a.lengthM &&
    alongRunway(env.idx, a.pos) >= 0 && alongRunway(env.idx, a.pos) <= env.idx.runway.lengthM + a.lengthM);
}

/** Advisory margins are deliberately separate from immediate physical danger. */
export function runwayWarning(env: SimEnv, ac: Aircraft): string | undefined {
  const operation = env.operations?.blockReason(env, ac);
  if (operation) return operation;
  const traffic = runwayTraffic(env);
  const other = env.aircraftList().find((a) => a.id !== ac.id &&
    (traffic.includes(a) || a.phase === "approach" && a.landCleared));
  if (other) return `跑道 ${env.idx.runway.id} 已由 ${other.callsign} 占用或获准落地`;
  const wake = wakeRemaining(env, ac);
  if (wake > 0) return `前机 ${env.lastRunwayUse!.callsign} 的尾流间隔还需 ${Math.ceil(wake)} 游戏秒`;
  const window = departureWindow(env, ac);
  if (window) return `${window.callsign} 约 ${Math.ceil(window.arrivalInSec)} 游戏秒到达；起飞窗口需 ${Math.ceil(window.requiredSec)} 秒，${ac.phase === "lineup" ? "请先引导来机等待或复飞" : "请先安排其落地"}`;
  return env.runwayPlan?.blockReason(env, ac);
}

/** Game safety envelope: proximity / seconds to conflict, never plan order or weather. */
export function runwayErrorReason(env: SimEnv, ac: Aircraft): string | undefined {
  const landing = ac.phase === "approach";
  const eta = landing ? approachRunwayETA(env, ac) : 0;
  const origin = landing ? { x: env.idx.runway.threshold.x + env.idx.dir.x * 250, y: env.idx.runway.threshold.y + env.idx.dir.y * 250 }
    : ac.phase === "hold_short" ? env.idx.nodes.get(env.idx.lineupNode)!.pos : ac.pos;
  const other = runwayTraffic(env).find((a) => a.id !== ac.id &&
    (!landing || eta < 18) && dist(origin, a.pos) < Math.max(250, (ac.lengthM + a.lengthM) / 2 + (landing ? ac.gs : Math.max(kt(8), ac.gs)) * 8));
  if (other) return `危险：与 ${other.callsign} 的跑道距离过近，等待实际间隔扩大`;
  if (!landing) {
    const final = env.aircraftList().find((a) => a.id !== ac.id && a.phase === "approach" && approachRunwayETA(env, a) < 18);
    if (final) return `危险：${final.callsign} 已进入短五边，距跑道不足 18 秒`;
  }
  return undefined;
}

export function permissionError(env: SimEnv, ac: Aircraft): string | undefined {
  return env.safetyMode === "consequence" ? undefined : runwayErrorReason(env, ac) ?? runwayWarning(env, ac);
}

/** Kept as the conservative advisory API for scheduling and historical reports. */
export const runwayBlockReason = runwayWarning;

export function runwayCollisionAhead(env: SimEnv, ac: Aircraft): Aircraft | undefined {
  const s = alongRunway(env.idx, ac.pos);
  return runwayTraffic(env).find((a) => a.id !== ac.id &&
    Math.abs(lateralOffset(env.idx, a.pos)) < env.idx.runway.widthM / 2 + a.lengthM / 2 &&
    alongRunway(env.idx, a.pos) > s &&
    alongRunway(env.idx, a.pos) - s < (ac.lengthM + a.lengthM) / 2 + 30 + ac.gs * ac.gs / (2 * 4.5));
}
