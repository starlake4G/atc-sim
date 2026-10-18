import type { Aircraft, MovementReport, SimState } from "./types";

export const DELAY_LABELS = { traffic: "地面 / 容量等待", permission: "许可等待", runway: "跑道 / 排序等待", flight: "空中引导", taxi: "滑行执行" } as const;
export type DelayReason = keyof typeof DELAY_LABELS;
export const emptyDelays = () => ({ traffic: 0, permission: 0, runway: 0, flight: 0, taxi: 0 });
export function delayReason(ac: Aircraft | undefined, runwayBlocked: boolean): DelayReason {
  if (!ac) return "traffic";
  if (ac.holding) return "permission";
  if (ac.blockedBy) return "traffic";
  if (ac.phase === "lineup" || ac.phase === "takeoff") return "runway";
  if (ac.phase === "hold_short") return runwayBlocked ? "runway" : "permission";
  if (ac.phase === "parked" || ac.phase === "taxi_ready" || ac.holding) return "permission";
  if (ac.kind === "dep") return "taxi";
  if (ac.phase === "approach" && !ac.landCleared) return runwayBlocked ? "runway" : "permission";
  return "flight";
}

export function shiftObjectives(snap: SimState, arrivals: number) {
  const movements = snap.score.landings + snap.score.takeoffs;
  return [
    { label: "安全值班", value: snap.score.violations ? `${snap.score.violations} 次事件` : "保持零违规", progress: snap.score.violations ? 0 : 1, good: snap.score.violations === 0 },
    { label: "完成起降", value: `${movements} / ${snap.movementsTarget}`, progress: Math.min(1, movements / Math.max(1, snap.movementsTarget)), good: movements >= snap.movementsTarget },
    { label: "完整服务", value: `${snap.score.serviced} / ${arrivals} 入位`, progress: arrivals ? snap.score.serviced / arrivals : 1, good: snap.score.serviced >= arrivals },
  ];
}

export function aggregateDelays(reports: MovementReport[]) {
  const result = emptyDelays();
  for (const report of reports) for (const key of Object.keys(result) as DelayReason[]) result[key] += report.delays[key];
  return result;
}
