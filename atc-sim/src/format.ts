import type { Aircraft, Phase } from "./sim/types";
import { NM, toFt, toKt } from "./sim/units";

export const fmtClock = (min: number): string => {
  const h = Math.floor(min / 60) % 24;
  const m = Math.floor(min % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

export const fmtAlt = (m: number): string => {
  const f = toFt(m);
  if (f >= 10000) return `FL${String(Math.round(f / 100)).padStart(3, "0")}`;
  return `${Math.round(f / 100) * 100}ft`;
};

export const fmtAltFt = (m: number): string => `${Math.round(toFt(m) / 100) * 100}`;

export const fmtSpd = (mps: number): string => `${Math.round(toKt(mps))}`;

export const fmtDist = (m: number): string => `${(m / NM).toFixed(1)}NM`;

export const fmtHdg = (deg: number): string => String(Math.round(deg) % 360).padStart(3, "0");

export const PHASE_LABEL: Record<Phase, string> = {
  parked: "停靠",
  pushback: "推出中",
  taxi_ready: "等待滑行许可",
  taxi_out: "滑出",
  hold_short: "跑道外等待",
  lineup: "进跑道",
  takeoff: "起飞滑跑",
  departure: "离场",
  arrival: "进场",
  approach: "进近",
  landing: "落地滑跑",
  taxi_in: "滑入",
  done: "结束",
};

export const phaseLabel = (ac: Aircraft): string => {
  if (ac.airHolding) return "空中等待";
  if (ac.blockedBy && ac.phase !== "taxi_ready") return "等前机通过";
  if (ac.holding && (ac.phase === "taxi_out" || ac.phase === "taxi_in")) return "等待中";
  return PHASE_LABEL[ac.phase];
};

export const STATUS_COLOR: Partial<Record<Phase, string>> = {
  hold_short: "#e0b34a",
  lineup: "#e0b34a",
  takeoff: "#7fe3e0",
  approach: "#7fe3e0",
  landing: "#e0b34a",
};

export function gradeFor(movements: number, target: number, violations: number): { grade: string; note: string } {
  const done = movements >= target;
  if (done && violations === 0) return { grade: "S", note: "零违规，完美班次" };
  if (done && violations <= 1) return { grade: "A", note: "完成目标，几乎无误" };
  if (movements >= Math.ceil(target * 0.8)) return { grade: "B", note: "基本完成，但有效率损失" };
  return { grade: "C", note: "班次未达标" };
}
