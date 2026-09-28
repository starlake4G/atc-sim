/**
 * Sim Core 共享类型定义
 * 这一层不允许 import three —— 保持仿真内核可独立单测、可无头运行。
 */

import type { Vec2, Vec3 } from './vec';

/** 飞行阶段 */
export type FlightPhase =
  | 'GROUND'
  | 'TAKEOFF'
  | 'CLIMB'
  | 'CRUISE'
  | 'DESCENT'
  | 'APPROACH'
  | 'LANDED'
  | 'GO_AROUND';

/** 尾流类别 —— 决定间隔标准 */
export type WakeCategory = 'L' | 'M' | 'H' | 'J';

export const WAKE_LABEL: Record<WakeCategory, string> = {
  L: 'LIGHT',
  M: 'MEDIUM',
  H: 'HEAVY',
  J: 'SUPER',
};

/** 飞机性能包线（中等拟真：不建模气动，只约束变化率） */
export interface AircraftPerformance {
  /** 最大爬升率 m/s */
  climbRate: number;
  /** 最大下降率 m/s */
  descentRate: number;
  /** 加速度 m/s^2 */
  accel: number;
  /** 减速度 m/s^2 */
  decel: number;
  /** 最小指示空速 m/s */
  minSpeed: number;
  /** 最大指示空速 m/s */
  maxSpeed: number;
  /** 最大转弯坡度（度）—— 决定转弯率 */
  maxBank: number;
  /** 进近参考速度 m/s */
  approachSpeed: number;
}

/** 进近许可 */
export interface ApproachClearance {
  runway: string;
  /** 已截获下滑道 */
  established: boolean;
  /** 已截获航向道 */
  localizerCaptured: boolean;
  /**
   * 已在下滑道截获窗口内、由 sim 接管垂直剖面。
   * 与 established（横向建立的迟滞标志）分开，玩家在此前仍需自己下高度。
   */
  slopeCaptured: boolean;
  /** 复飞计数 */
  goArounds: number;
}

/**
 * 等待航线段。用"航向驱动"而非"路径点驱动"实现标准跑道形等待：
 * 直线段飞固定航向，两端的 180° 半圆让飞机以自身最大转弯率转过去。
 */
export type HoldingSegment = 'INBOUND' | 'TURN1' | 'OUTBOUND' | 'TURN2';

/** 等待航线 */
export interface HoldingPattern {
  fix: string;
  /** 等待点坐标 */
  center: Vec2;
  /** 入航航向（度） */
  inboundCourse: number;
  /** 转弯方向 */
  turnDirection: 'L' | 'R';
  /** 腿长 m */
  legLength: number;
  /** 已进入等待 */
  entered: boolean;
  /** 当前处于哪一段 */
  segment: HoldingSegment;
}

/** 飞机当前被赋予的意图（由指令写入） */
export interface AircraftIntent {
  /** 雷达引导目标航向；null 表示沿航路 */
  heading: number | null;
  /** 目标高度 m */
  altitude: number;
  /** 目标指示空速 m/s */
  speed: number;
  /** 是否保持当前速度（不自动调速） */
  speedLocked: boolean;
}

/** 指令判别联合 */
export type Command =
  | { kind: 'heading'; value: number }
  | { kind: 'turnLeft'; value: number }
  | { kind: 'turnRight'; value: number }
  | { kind: 'altitude'; value: number }
  | { kind: 'speed'; value: number }
  | { kind: 'direct'; waypoint: string }
  | { kind: 'clearedApproach'; runway: string }
  | { kind: 'goAround' }
  | { kind: 'hold'; fix: string }
  | { kind: 'expedite' }
  | { kind: 'resumeNormalSpeed' }
  | { kind: 'takeoff' };

/** 待执行的指令（模拟飞行员复诵与执行延迟） */
export interface PendingCommand {
  /** 仿真时间戳，到点执行 */
  executeAt: number;
  command: Command;
  /** 飞行员已复诵 */
  readback: boolean;
}

/** 航迹拖尾采样点 */
export interface TrailPoint {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** 飞机实体 */
export interface Aircraft {
  id: number;
  callsign: string;
  type: string;
  wake: WakeCategory;
  /** 是否为本场离场航班 */
  isDeparture: boolean;

  // ---- 运动状态 ----
  /** 位置：x 东 / y 北 / z 高度，单位米 */
  pos: Vec3;
  /** 航向（度） */
  heading: number;
  /** 指示空速 m/s */
  ias: number;
  /** 垂直速度 m/s */
  vs: number;
  /** 转弯率 deg/s（由坡度推出，用于渲染倾斜） */
  turnRate: number;

  phase: FlightPhase;
  perf: AircraftPerformance;

  // ---- 指令 ----
  intent: AircraftIntent;
  pending: PendingCommand[];
  /** 最近的指令文字，用于 HUD */
  lastInstruction: string;

  // ---- 航路 ----
  /** 待飞航路点（局部坐标） */
  route: Vec2[];
  routeIndex: number;

  // ---- 进近 ----
  approach: ApproachClearance | null;
  /** 指定落地跑道（未清进近时为 null） */
  assignedRunway: string | null;
  holding: HoldingPattern | null;

  // ---- 记录 ----
  trail: TrailPoint[];
  lastTrailTime: number;
  /** 已存活时长 s */
  age: number;
  /** 已被玩家指令过的飞机才有资格计分 */
  hasBeenControlled: boolean;
  /** 该机已触发的扣分事件（避免重复扣） */
  penaltyFlags: Set<string>;
  /** 接地时刻（仿真时间），null 表示尚未落地 */
  landedAt: number | null;
}

/** 冲突告警级别 */
export type ConflictSeverity = 'PREDICTED' | 'CRITICAL' | 'LOSS';

/** 冲突对 */
export interface ConflictPair {
  a: number;
  b: number;
  /** 当前水平距离 m */
  hdist: number;
  /** 当前垂直间隔 m */
  vdist: number;
  /** 最近接近距离 m */
  dcpa: number;
  /** 距离最近点的时间 s */
  tcpa: number;
  severity: ConflictSeverity;
}

/** 计分事件 */
export interface ScoreEvent {
  t: number;
  delta: number;
  reason: string;
  callsign?: string;
}

/** 机场跑道 */
export interface Runway {
  /** 跑道识别号，如 18L */
  ident: string;
  /** 起飞/进近方向磁航向（度） */
  heading: number;
  /** 入口（着陆端）坐标 */
  threshold: Vec2;
  /** 全长 m */
  length: number;
  /** 宽度 m */
  width: number;
  /** 是否有 ILS */
  ils: boolean;
  /** 3° 下滑道 */
  glideslope: number;
  /** 场地标高 m */
  elevation: number;
}

/** 航路点 */
export interface Waypoint {
  name: string;
  pos: Vec2;
  type: 'FIX' | 'VOR' | 'NDB' | 'IAF' | 'FAF';
}

/** 管制扇区 */
export interface Sector {
  name: string;
  boundary: Vec2[];
  floorAlt: number;
  ceilingAlt: number;
}

/** 机场定义 */
export interface Airport {
  icao: string;
  name: string;
  elevation: number;
  /** 雷达管制半径 m */
  radarRange: number;
  runways: Runway[];
  waypoints: Waypoint[];
  sectors: Sector[];
  /** STAR 进场程序：名称 → 航路点序列 */
  stars: Record<string, string[]>;
  /** SID 离场程序 */
  sids: Record<string, string[]>;
}
