import { getType } from "../data/aircraft-types";
import { distanceToThreshold, type AirportIndex } from "./airport";
import type { Aircraft, ControlMode } from "./types";
import { ft, kt, nm } from "./units";
import { dist, fromBearing } from "./vec";

export function arrivalETA(ac: Aircraft, idx: AirportIndex): number | null {
  if (ac.kind !== "arr" || !["arrival", "approach"].includes(ac.phase) || ac.airHolding) return null;
  const speed = Math.max(kt(getType(ac.typeId).vappKt), Math.min(ac.gs, kt(180)));
  const last = ac.route?.points.at(-1);
  const distance = ac.phase === "arrival" && ac.route && last ? ac.route.remaining(ac.pos) + dist(last, idx.runway.threshold) : distanceToThreshold(idx, ac.pos);
  return distance / speed;
}

export function attentionFor(ac: Aircraft, idx: AirportIndex, mode: ControlMode = "standard"): { priority: number; text: string } {
  if (ac.pendingClearance) return { priority: 10, text: "通话中 · 待复诵确认" };
  if (ac.pendingHandoff) return { priority: 5, text: `已确认 → ${ac.pendingHandoff.controller} · 等待生效` };
  if (ac.phase === "approach" && !ac.landCleared) return { priority: 100 - Math.min(50, distanceToThreshold(idx, ac.pos) / 500), text: ac.approach?.established ? mode === "standard" && ac.controller === "APP" ? "待联系塔台" : "待落地许可" : "正在截获" };
  if (ac.blockedBy) return { priority: 45, text: ac.blockedBy };
  if (ac.phase === "hold_short") return { priority: 60, text: mode === "standard" && ac.controller === "GND" ? "待联系塔台" : "待起飞许可" };
  if (ac.phase === "taxi_ready") return { priority: 65, text: mode === "standard" && ac.kind === "arr" && ac.controller !== "GND" ? "待联系地面" : !ac.standId && ac.kind === "arr" ? "等待空机位" : "待滑行许可" };
  if (ac.phase === "parked" && ac.kind === "dep") return { priority: 40, text: "请求推出" };
  if (mode === "standard" && ac.phase === "departure" && ac.controller !== "DEP" && ac.altM - idx.def.elevationM >= ft(1500)) return { priority: 55, text: "待移交离场" };
  if (ac.airHolding) return { priority: 35, text: "等待排序 · 可直飞恢复" };
  return { priority: 0, text: "按许可执行" };
}

export interface Prediction { a: string; b: string; inSec: number }

/** A short linear look-ahead is advisory only; observed separation remains the scoring authority. */
export function predictConflicts(aircraft: Aircraft[], _windDir: number, _windKt: number): Prediction[] {
  const air = aircraft.filter((a) => ["arrival", "approach", "departure"].includes(a.phase) && a.altM > 50);
  const result: Prediction[] = [];
  const velocity = (a: Aircraft) => fromBearing(a.hdg, Math.max(0, a.gs));
  for (let i = 0; i < air.length; i++) for (let j = i + 1; j < air.length; j++) {
    const a = air[i]!, b = air[j]!;
    const av = velocity(a), bv = velocity(b);
    const rx = b.pos.x - a.pos.x, ry = b.pos.y - a.pos.y;
    const vx = bv.x - av.x, vy = bv.y - av.y;
    const vv = vx * vx + vy * vy;
    if (vv < .01) continue;
    const t = -(rx * vx + ry * vy) / vv;
    if (t < 5 || t > 120) continue;
    if (Math.hypot(rx + vx * t, ry + vy * t) < nm(3) && Math.abs((b.altM - a.altM) + (b.vs - a.vs) * t) < ft(1000)) result.push({ a: a.id, b: b.id, inSec: t });
  }
  return result.sort((a, b) => a.inSec - b.inSec);
}
