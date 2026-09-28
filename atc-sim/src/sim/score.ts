/**
 * 计分与自适应难度
 *
 * 核心设计借自 Endless ATC：技能分不只是分数，它直接决定"你能同时管几架"。
 * 分数涨 → 容量涨 → 流量涨；犯错 → 分数掉 → 容量跟着掉。难度自动贴合玩家。
 */

import type { Aircraft, ScoreEvent } from './types';
import { clamp } from './units';
import type { TrafficRates } from './traffic';

export interface ScoreState {
  score: number;
  events: ScoreEvent[];
  landed: number;
  departed: number;
  violations: number;
  /** 黄牌：一般违规（冲突告警、复飞、出界等） */
  yellow: number;
  /** 红牌：严重违规（失去间隔、落错跑道） */
  red: number;
  /** 连续无违规落地数（任何扣分清零），给落地加成连击奖励 */
  streak: number;
  bestStreak: number;
  /** 已成功落地的呼号，供复盘 */
  history: { callsign: string; type: string; at: number }[];
}

export function createScoreState(): ScoreState {
  return { score: 0, events: [], landed: 0, departed: 0, violations: 0, yellow: 0, red: 0, streak: 0, bestStreak: 0, history: [] };
}

/** 扣分表（预测级冲突只提示不扣分，见 world.ts） */
export const PENALTY = {
  critical: 5,
  loss: 15,
  goAround: 4,
  outOfBounds: 8,
  wrongRunway: 5,
} as const;

/** 加分表 */
export const REWARD = {
  land: 12,
  /** 落对跑道额外奖励 */
  landOnAssigned: 6,
  depart: 6,
  /** 连击：每架加 3 分，最多 5 档 */
  streakStep: 3,
  streakMax: 5,
} as const;

/** 记一笔分 */
export function addScore(
  state: ScoreState,
  delta: number,
  reason: string,
  t: number,
  callsign?: string,
): void {
  state.score += delta;
  state.events.push({ t, delta, reason, callsign });
  // 只保留最近 200 条，避免长时间运行内存膨胀
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
}

/**
 * 技能分 → 可同时管制的飞机数上限。
 * 4 架起步，每 12 分涨 1 架，封顶 18 架。
 */
export function capacityFor(score: number): number {
  const s = Math.max(0, score);
  return clamp(4 + Math.floor(s / 12), 4, 18);
}

/**
 * 容量 → 交通流率（架/小时）。
 *
 * 故意给得比"管得过来"更满：真正的节流阀是在场飞机上限（world.ts 的
 * capacity + 余量），流率只决定"一空下来立刻补一架"的紧凑度。
 * 流率太低时开局几分钟无事可做，对浏览器游戏是致命的。
 */
export function ratesFor(capacity: number): TrafficRates {
  return {
    arrivals: Math.round(capacity * 6),
    departures: Math.round(capacity * 3.5),
  };
}

/** 落地结算 */
export function scoreLanding(
  state: ScoreState,
  ac: Aircraft,
  assignedRunway: string | null,
  actualRunway: string | null,
  t: number,
): void {
  state.landed++;
  state.streak++;
  state.bestStreak = Math.max(state.bestStreak, state.streak);
  state.history.push({ callsign: ac.callsign, type: ac.type, at: t });
  const clean = assignedRunway !== null && assignedRunway === actualRunway;
  const streakBonus = Math.min(REWARD.streakMax, state.streak - 1) * REWARD.streakStep;
  addScore(
    state,
    REWARD.land + (clean ? REWARD.landOnAssigned : 0) + streakBonus,
    `落地 ${actualRunway ?? ''}`,
    t,
    ac.callsign,
  );
  if (!clean && assignedRunway !== null) {
    state.violations++;
    state.red++;
    state.streak = 0;
    addScore(state, -PENALTY.wrongRunway, '落错跑道', t, ac.callsign);
  }
}

/** 起飞结算 */
export function scoreDeparture(state: ScoreState, ac: Aircraft, t: number): void {
  state.departed++;
  addScore(state, REWARD.depart, '起飞', t, ac.callsign);
}

/** 违规扣分（带去重标记，同一架飞机同一类事件只扣一次） */
export function penalize(
  state: ScoreState,
  ac: Aircraft,
  flag: string,
  amount: number,
  reason: string,
  t: number,
  level: 'yellow' | 'red' = 'yellow',
): void {
  if (ac.penaltyFlags.has(flag)) return;
  ac.penaltyFlags.add(flag);
  state.violations++;
  // 连击只奖励"没出错的这一段"，任何一次违规都归零
  state.streak = 0;
  if (level === 'red') state.red++;
  else state.yellow++;
  addScore(state, -amount, reason, t, ac.callsign);
}

/** 当前等级的简要描述，用于 HUD */
export function rankLabel(score: number): string {
  if (score < 0) return 'TRAINEE';
  if (score < 40) return 'JUNIOR';
  if (score < 100) return 'CONTROLLER';
  if (score < 200) return 'SENIOR';
  if (score < 350) return 'SUPERVISOR';
  return 'MAESTRO';
}
