import type { ControlMode, LevelDef, SimState } from "./types";

export function rateShift(score: SimState["score"], level: LevelDef, mode: ControlMode = "standard"): { grade: string; note: string } {
  const movements = score.landings + score.takeoffs;
  const complete = movements >= level.targetMovements;
  const averageDelay = movements ? score.totalDelaySec / movements : 0;
  const allServiced = score.serviced >= level.flights.filter((flight) => flight.kind === "arr").length;
  const allTransferred = mode === "assisted" || score.departuresTransferred >= score.takeoffs;
  if (score.violations >= 3) return { grade: "C", note: "需要改善安全间隔，先稳住流量" };
  if (complete && score.violations === 0 && allServiced && allTransferred && averageDelay <= 120) return { grade: "S", note: "安全、高效，进离场流程完整" };
  if (complete && score.violations <= 1 && allServiced && allTransferred) return { grade: "A", note: "完成本班任务，仍有优化空间" };
  if (movements >= Math.ceil(level.targetMovements * .8)) return { grade: "B", note: !allTransferred ? "起降量达标，仍有离场移交未完成" : allServiced ? "基本完成，继续改善安全与效率" : "起降量达标，仍有航班尚未滑入" };
  return { grade: "C", note: "班次未达标，再试一种调度顺序" };
}
