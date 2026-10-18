import { getType } from "../data/aircraft-types";
import { alongRunway, distanceToThreshold, findTaxiPath, lateralOffset, pickExit } from "./airport";
import type { SimEnv } from "./env";
import { departurePreparationSec, departureWindow, wakeSeparationSec } from "./runway";
import type { Aircraft } from "./types";
import { ft, kt } from "./units";
import { dist } from "./vec";

export type PlanChangeResult = { ok: true } | { ok: false; reason: string };

export interface RunwayPlanEntry {
  aircraftId: string;
  callsign: string;
  kind: "arr" | "dep";
  position: number;
  /** All times are absolute game seconds. Null means an explicit hold needs resolving. */
  readyAt: number | null;
  occupyAt: number | null;
  useAt: number | null;
  clearAt: number | null;
  delaySec: number | null;
  waitReason: string;
  committed: boolean;
}

export interface RunwayPlanEstimate {
  totalDelaySec: number | null;
  lastClearAt: number | null;
  known: number;
  total: number;
  waitReason: string | null;
}

/** Never rank incomplete forecasts by treating a held or blocked flight as zero delay. */
export function summarizePlan(entries: RunwayPlanEntry[]): RunwayPlanEstimate {
  const known = entries.filter((entry) => entry.useAt !== null && entry.clearAt !== null && entry.delaySec !== null);
  const complete = entries.length > 0 && known.length === entries.length;
  return { totalDelaySec: complete ? known.reduce((sum, entry) => sum + entry.delaySec!, 0) : null,
    lastClearAt: complete ? Math.max(...known.map((entry) => entry.clearAt!)) : null,
    known: known.length, total: entries.length,
    waitReason: complete ? null : entries.find((entry) => entry.useAt === null || entry.clearAt === null || entry.delaySec === null)?.waitReason ?? "先加入航班，再比较顺序" };
}

/** A completed runway movement is removed even if the aircraft remains in the sector. */
export function isRunwayCandidate(ac: Aircraft): boolean {
  if (ac.kind === "arr") return !ac.scored.landed && (ac.phase === "arrival" || ac.phase === "approach");
  return !ac.scored.departed && ["parked", "pushback", "taxi_ready", "taxi_out", "hold_short", "lineup", "takeoff"].includes(ac.phase);
}

function committed(ac: Aircraft): boolean {
  return ac.phase === "lineup" || ac.phase === "takeoff" || ac.phase === "approach" && ac.landCleared;
}

function pendingReason(ac: Aircraft, env: SimEnv): string {
  if (ac.airHolding) return "等待解除空中等待，直飞后可重新估时";
  if (ac.holding) return "等待继续滑行";
  if (ac.blockedBy) return ac.blockedBy;
  if (committed(ac)) return ac.kind === "arr" ? "已获落地许可，顺序已锁定" : "已进入跑道，顺序已锁定";
  if (ac.phase === "parked") return "等待推出与滑行";
  if (ac.phase === "pushback") return "推出中，随后申请滑行";
  if (ac.phase === "taxi_ready") return "等待滑行许可";
  if (ac.phase === "taxi_out") return "滑向跑道外等待点";
  if (ac.phase === "hold_short") return env.mode === "standard" && ac.controller !== "TWR" ? "等待联系塔台" : "等待起飞许可";
  if (ac.phase === "arrival") return "等待引导与进近许可";
  if (!ac.approach?.established) return "等待建立进近";
  return env.mode === "standard" && ac.controller !== "TWR" ? "等待联系塔台" : "等待落地许可";
}

function taxiRemainingSec(ac: Aircraft, env: SimEnv): number | null {
  if (ac.holding) return null;
  if (ac.phase === "hold_short" || ac.phase === "lineup" || ac.phase === "takeoff") return 0;
  if (ac.phase === "taxi_out" && ac.route) return ac.route.remaining(ac.pos) / kt(15);
  const from = ac.groundNodeId ?? env.idx.stands.get(ac.standId ?? "")?.node;
  if (!from) return null;
  const path = findTaxiPath(env.idx, from, env.idx.holdingNode, "dep");
  if (!path) return null;
  let seconds = 0;
  for (let i = 1; i < path.length; i++) {
    const a = env.idx.nodes.get(path[i - 1]!)!, b = env.idx.nodes.get(path[i]!)!;
    const edge = env.idx.adjacency.get(a.id)?.find((item) => item.to === b.id);
    const speed = a.kind === "stand" ? 5 : edge?.kt ?? 15;
    seconds += dist(a.pos, b.pos) / kt(speed);
  }
  if (ac.phase === "pushback" && ac.route) {
    // Path starts at the last cleared node; subtract already completed pushback travel.
    seconds = Math.max(0, seconds - Math.max(0, ac.route.total - ac.route.remaining(ac.pos)) / kt(5));
  }
  return seconds;
}

function arrivalRemainingSec(ac: Aircraft, env: SimEnv): number | null {
  if (ac.airHolding) return null;
  const speed = Math.max(kt(getType(ac.typeId).vappKt), Math.min(ac.gs, kt(180)));
  let distance = distanceToThreshold(env.idx, ac.pos);
  if (ac.phase === "arrival" && ac.route?.points.length) {
    distance = ac.route.remaining(ac.pos) + dist(ac.route.points[ac.route.points.length - 1]!, env.idx.runway.threshold);
  }
  return distance / speed;
}

/** Game-model occupancy estimate; physical runway release remains authoritative. */
function arrivalClearanceSec(ac: Aircraft, env: SimEnv): number {
  const type = getType(ac.typeId);
  const along = ac.phase === "landing" ? Math.max(0, alongRunway(env.idx, ac.pos)) : 0;
  const speed = ac.phase === "landing" ? ac.gs : Math.min(kt(type.vappKt), kt(140));
  const exit = env.idx.exitsByDistance.find((item) => item.node === ac.exitNodeId) ?? pickExit(env.idx, along, speed) ?? env.idx.exitsByDistance.at(-1)!;
  const distance = Math.max(0, exit.atM - along), minimum = kt(10), decel = 2.2;
  const brakingTime = Math.max(0, speed - minimum) / decel;
  const brakingDistance = Math.max(0, speed * speed - minimum * minimum) / (2 * decel);
  const roll = distance <= brakingDistance
    ? (speed - Math.sqrt(Math.max(minimum * minimum, speed * speed - 2 * decel * distance))) / decel
    : brakingTime + (distance - brakingDistance) / minimum;
  return Math.max(0, roll) + (env.idx.runway.widthM / 2 + ac.lengthM + 4) / kt(12);
}

function occupantClearAt(env: SimEnv): number | null {
  const ac = env.aircraftList().find((item) => item.id === env.runwayOccupantId);
  if (!ac) return env.time;
  if (ac.phase === "taxi_in" && (ac.holding || ac.blockedBy)) return null;
  if (ac.phase === "landing") return env.time + arrivalClearanceSec(ac, env);
  if (ac.phase === "taxi_in") return env.time + Math.max(0, env.idx.runway.widthM / 2 + ac.lengthM - Math.abs(lateralOffset(env.idx, ac.pos))) / kt(12);
  if (ac.phase === "departure") return env.time + Math.max(0, 100 - (ac.altM - env.idx.def.elevationM)) / (ft(getType(ac.typeId).climbFpm) / 60);
  // Lineup and takeoff are represented by their locked queue entry instead.
  return env.time;
}

/**
 * Player-owned runway intent. An empty plan leaves normal clearance checks unchanged.
 * A nonempty plan gives its first flight priority over every uncommitted flight.
 * It never grants a clearance or changes any aircraft's route, speed or phase.
 */
export class RunwayPlanner {
  private order: string[] = [];
  private observed = new Map<string, { phase: Aircraft["phase"]; missed: boolean }>();

  sync(env: SimEnv): void {
    const aircraft = env.aircraftList(), byId = new Map(aircraft.map((ac) => [ac.id, ac]));
    this.order = this.order.filter((id) => {
      const ac = byId.get(id), previous = this.observed.get(id);
      if (!ac || !isRunwayCandidate(ac)) return false;
      // A missed approach abandons the previous slot. Adding the recovered flight
      // later records its current flag, so it can be planned again immediately.
      return !(ac.phase === "arrival" && ac.missedApproachNotified && previous && (!previous.missed || previous.phase === "approach"));
    });
    if (this.order.length) {
      const locked = aircraft.filter((ac) => isRunwayCandidate(ac) && committed(ac)).map((ac) => ac.id);
      this.order = [...locked, ...this.order.filter((id) => !locked.includes(id))];
    }
    this.observed = new Map(this.order.map((id) => {
      const ac = byId.get(id)!;
      return [id, { phase: ac.phase, missed: ac.missedApproachNotified }];
    }));
  }

  contains(env: SimEnv, aircraftId: string): boolean {
    this.sync(env);
    return this.order.includes(aircraftId);
  }

  add(env: SimEnv, aircraftId: string): PlanChangeResult {
    this.sync(env);
    const ac = env.aircraftList().find((item) => item.id === aircraftId);
    if (!ac || !isRunwayCandidate(ac)) return { ok: false, reason: "只有尚未使用跑道的进离场飞机可加入计划" };
    if (this.order.includes(aircraftId)) return { ok: false, reason: `${ac.callsign} 已在跑道计划中` };
    this.order.push(aircraftId);
    this.observed.set(aircraftId, { phase: ac.phase, missed: ac.missedApproachNotified });
    this.sync(env);
    return { ok: true };
  }

  remove(env: SimEnv, aircraftId: string): PlanChangeResult {
    this.sync(env);
    const ac = env.aircraftList().find((item) => item.id === aircraftId);
    if (!this.order.includes(aircraftId)) return { ok: false, reason: "飞机未在跑道计划中" };
    if (ac && committed(ac)) return { ok: false, reason: `${ac.callsign} 已获许可，先取消落地许可或完成跑道使用` };
    this.order = this.order.filter((id) => id !== aircraftId);
    this.observed.delete(aircraftId);
    return { ok: true };
  }

  move(env: SimEnv, aircraftId: string, direction: -1 | 1): PlanChangeResult {
    this.sync(env);
    const index = this.order.indexOf(aircraftId), target = index + direction;
    if (direction !== -1 && direction !== 1) return { ok: false, reason: "计划只能前移或后移一位" };
    if (index < 0) return { ok: false, reason: "飞机未在跑道计划中" };
    if (target < 0 || target >= this.order.length) return { ok: false, reason: "已到计划边界" };
    const byId = new Map(env.aircraftList().map((ac) => [ac.id, ac]));
    if (committed(byId.get(aircraftId)!) || committed(byId.get(this.order[target]!)!)) {
      return { ok: false, reason: "已获落地许可或进入跑道的飞机顺序已锁定" };
    }
    [this.order[index], this.order[target]] = [this.order[target]!, this.order[index]!];
    return { ok: true };
  }

  /** Forecast an adjacent edit on a private copy. No clearance, event or journal is changed. */
  previewMove(env: SimEnv, aircraftId: string, direction: -1 | 1): { ok: true; entries: RunwayPlanEntry[] } | { ok: false; reason: string } {
    const draft = new RunwayPlanner();
    draft.order = [...this.order];
    draft.observed = new Map([...this.observed].map(([id, value]) => [id, { ...value }]));
    const result = draft.move(env, aircraftId, direction);
    return result.ok ? { ok: true, entries: draft.snapshot(env) } : result;
  }

  blockReason(env: SimEnv, ac: Aircraft): string | undefined {
    this.sync(env);
    if (committed(ac) || !this.order.length || this.order[0] === ac.id) return undefined;
    const first = env.aircraftList().find((item) => item.id === this.order[0])!;
    return this.order.includes(ac.id)
      ? `跑道计划先安排 ${first.callsign}，请等待或调整顺序`
      : `跑道计划先安排 ${first.callsign}，请先加入计划并调整顺序`;
  }

  snapshot(env: SimEnv): RunwayPlanEntry[] {
    this.sync(env);
    const byId = new Map(env.aircraftList().map((ac) => [ac.id, ac]));
    let previousClearAt: number | null = occupantClearAt(env);
    // A due inspection starts after the already committed movement physically clears.
    // Keep this bound separate from queued forecasts, so the closure is not postponed again for every row.
    const committedClearAt = previousClearAt === null ? null : Math.max(previousClearAt, ...env.aircraftList().filter(committed).map((ac) => env.time +
      (ac.kind === "arr" ? (arrivalRemainingSec(ac, env) ?? 0) + arrivalClearanceSec(ac, env) : departurePreparationSec(env, ac) + 100 / (ft(getType(ac.typeId).climbFpm) / 60))));
    const inspectionStarts = env.operations?.forecastInspections(env, committedClearAt ?? env.time);
    const stoppedOccupant = env.aircraftList().find((ac) => ac.id === env.runwayOccupantId && (ac.holding || ac.blockedBy));
    let previousUse = env.lastRunwayUse;
    let previousCallsign: string | null = null;
    return this.order.map((id, index) => {
      const ac = byId.get(id)!;
      const remaining = ac.kind === "arr" ? arrivalRemainingSec(ac, env) : taxiRemainingSec(ac, env);
      const readyAt = remaining === null ? null : env.time + remaining;
      let occupyAt: number | null = null, useAt: number | null = null, clearAt: number | null = null;
      const ownLocked = committed(ac);
      let reason = pendingReason(ac, env);
      const window = departureWindow(env, ac);
      if (index && !ownLocked) reason = `等待计划前机 ${previousCallsign} · ${reason}`;
      if (window && index === 0) {
        reason = `${window.callsign} 即将到达，起飞窗口不足；${ac.phase === "lineup" ? "先引导来机等待或复飞" : "先安排来机落地或引导其等待"}`;
      } else if (readyAt !== null && previousClearAt !== null) {
        const wakeAt = previousUse ? previousUse.at + wakeSeparationSec(previousUse.typeId, ac.typeId) : env.time;
        const baseRunwayAt = Math.max(readyAt, previousClearAt, wakeAt);
        const operational = env.operations?.nextAvailable(env, ac, baseRunwayAt, committedClearAt ?? env.time, inspectionStarts);
        const runwayAt = operational?.at ?? baseRunwayAt;
        if (index === 0 && runwayAt > readyAt + .5 && !ownLocked) {
          reason = wakeAt > Math.max(readyAt, previousClearAt)
            ? `等待 ${previousUse!.callsign} 尾流间隔 · ${reason}`
            : `等待当前飞机脱离跑道 · ${reason}`;
        }
        if (operational?.reason) reason = operational.reason + reason;
        occupyAt = runwayAt;
        useAt = runwayAt + (ac.kind === "dep" ? departurePreparationSec(env, ac) : 0);
        clearAt = useAt + (ac.kind === "arr" ? arrivalClearanceSec(ac, env) : 100 / (ft(getType(ac.typeId).climbFpm) / 60));
        if (inspectionStarts) env.operations?.deferForecastInspections(env, inspectionStarts, occupyAt, clearAt);
      } else if (previousClearAt === null && stoppedOccupant) {
        reason = `等待 ${stoppedOccupant.callsign} ${stoppedOccupant.holding ? "继续脱离" : "解除地面阻塞"}；跑道释放时间待定`;
      }
      previousClearAt = clearAt;
      previousUse = useAt === null ? null : { callsign: ac.callsign, typeId: ac.typeId, at: useAt };
      previousCallsign = ac.callsign;
      return { aircraftId: id, callsign: ac.callsign, kind: ac.kind, position: index + 1, readyAt, occupyAt, useAt, clearAt,
        delaySec: useAt === null ? null : Math.max(0, useAt - ac.scheduledMovementAt), waitReason: reason, committed: ownLocked };
    });
  }
}
