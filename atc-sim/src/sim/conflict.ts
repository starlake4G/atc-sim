/**
 * 冲突探测 —— 最接近点（CPA）解析解
 *
 * 思路来自 BlueSky 的 asas/statebased.py：不做数值迭代，直接解相对运动的
 * 二次方程得到 tcpa / dcpa，再分别求水平与垂直的"进入/脱离保护区"时刻区间，
 * 两者取交集即为冲突发生的预测窗口。
 *
 * 我们的默认标准采用终端区雷达间隔：水平 3 NM、垂直 1000 ft、前瞻 5 分钟。
 */

import type { Aircraft, ConflictPair, ConflictSeverity } from './types';
import { groundSpeedVec, type Wind } from './aircraft';
import { ft2m, nm2m } from './units';

export interface ConflictThresholds {
  /** 水平保护区半径（米） */
  horizontal: number;
  /** 垂直保护区半高（米） */
  vertical: number;
  /** 前瞻时间（秒） */
  lookahead: number;
  /** 危级判定：预测发生时间小于该值即为 CRITICAL（秒） */
  criticalWindow: number;
}

export const DEFAULT_THRESHOLDS: ConflictThresholds = {
  horizontal: nm2m(3.0),
  vertical: ft2m(1000),
  lookahead: 300,
  criticalWindow: 60,
};

/** 是否参与空中间隔探测：地面等待与落地滑跑都不算 */
function isAirborne(ac: Aircraft): boolean {
  return ac.phase !== 'GROUND' && ac.phase !== 'LANDED';
}

/** 单对飞机的冲突判定 */
export function evaluatePair(
  a: Aircraft,
  b: Aircraft,
  wind: Wind,
  th: ConflictThresholds,
): ConflictPair | null {
  // 空中间隔只对"都在空中"的飞机成立。两条跑道头各停一架等待机时，
  // 它们水平相距不到 3 NM、高差为 0，参与判定就是必然的"失去间隔"红牌，
  // 而玩家此刻没有任何手段避免 —— 跑道占用属于 P2 地面域，不在这里判。
  if (!isAirborne(a) || !isAirborne(b)) return null;

  const dx = b.pos.x - a.pos.x;
  const dy = b.pos.y - a.pos.y;
  const dz = b.pos.z - a.pos.z;

  const va = groundSpeedVec(a, wind);
  const vb = groundSpeedVec(b, wind);
  const du = vb.x - va.x;
  const dv = vb.y - va.y;
  const dw = b.vs - a.vs;

  const distH2 = dx * dx + dy * dy;
  const v2 = Math.max(du * du + dv * dv, 1e-6); // 下限防除零
  const vrel = Math.sqrt(v2);

  // ---- 水平 ----
  const tcpa = -(du * dx + dv * dy) / v2;
  const dcpa2 = Math.max(distH2 - tcpa * tcpa * v2, 0);
  const dcpa = Math.sqrt(dcpa2);

  const rpz = th.horizontal;
  const hpz = th.vertical;

  let tinH = Infinity;
  let toutH = -Infinity;
  const horizontalConflict = dcpa < rpz;
  if (horizontalConflict) {
    const dtin = Math.sqrt(Math.max(rpz * rpz - dcpa2, 0)) / vrel;
    tinH = tcpa - dtin;
    toutH = tcpa + dtin;
  }

  // ---- 垂直 ----
  let tinV = -Infinity;
  let toutV = Infinity;
  if (Math.abs(dw) > 1e-6) {
    const t1 = (dz + hpz) / -dw;
    const t2 = (dz - hpz) / -dw;
    tinV = Math.min(t1, t2);
    toutV = Math.max(t1, t2);
  } else if (Math.abs(dz) >= hpz) {
    // 垂直无重叠
    tinV = Infinity;
    toutV = -Infinity;
  }

  // ---- 合判 ----
  const tin = Math.max(tinH, tinV);
  const tout = Math.min(toutH, toutV);
  const predicted = horizontalConflict && tin <= tout && tout > 0 && tin < th.lookahead;

  const hdistNow = Math.sqrt(distH2);
  const vdistNow = Math.abs(dz);
  const loss = hdistNow < rpz && vdistNow < hpz;

  if (!predicted && !loss) return null;

  let severity: ConflictSeverity;
  if (loss) severity = 'LOSS';
  else if (tout <= th.criticalWindow) severity = 'CRITICAL';
  else severity = 'PREDICTED';

  return {
    a: a.id,
    b: b.id,
    hdist: hdistNow,
    vdist: vdistNow,
    dcpa,
    tcpa: Math.max(tcpa, 0),
    severity,
  };
}

const SEVERITY_ORDER: Record<ConflictSeverity, number> = {
  LOSS: 0,
  CRITICAL: 1,
  PREDICTED: 2,
};

/** 全对全扫描 —— 飞机数在百架量级，O(n²) 完全够用 */
export function detectConflicts(
  aircraft: Aircraft[],
  wind: Wind,
  th: ConflictThresholds = DEFAULT_THRESHOLDS,
): ConflictPair[] {
  const out: ConflictPair[] = [];
  for (let i = 0; i < aircraft.length; i++) {
    for (let j = i + 1; j < aircraft.length; j++) {
      const pair = evaluatePair(aircraft[i], aircraft[j], wind, th);
      if (pair) out.push(pair);
    }
  }
  out.sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity]);
  return out;
}

/**
 * 尾流间隔标准（起飞/落地序列用），返回米。参考 FAA 矩阵的精简版。
 */
export function wakeSeparation(lead: string, trail: string): number {
  const order: Record<string, number> = { J: 4, H: 3, M: 2, L: 1 };
  const l = order[lead] ?? 2;
  const t = order[trail] ?? 2;
  if (l >= 4) return nm2m(t >= 3 ? 6 : 8); // SUPER 在前
  if (l === 3) return nm2m(t >= 3 ? 4 : 5); // HEAVY 在前
  if (t === 1) return nm2m(4); // 轻型在重型后
  return nm2m(3);
}
