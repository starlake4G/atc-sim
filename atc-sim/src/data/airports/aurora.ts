/**
 * Aurora International (ZZAU) —— 虚构机场
 *
 * 双平行跑道向南运行（18L / 18R），36 方向由 reciprocalIdent 自动派生。
 * 坐标原点在机场中心，x 东 / y 北，单位米。
 */

import type { Airport, Runway, Sector, Waypoint } from '../../sim/types';
import { along, circlePoints, type Vec2 } from '../../sim/vec';
import { deg2rad, nm2m } from '../../sim/units';

/** 极坐标转局部平面坐标：方位角（度）+ 距离（海里） */
const P = (bearingDeg: number, distNm: number): Vec2 => {
  const r = deg2rad(bearingDeg);
  return { x: Math.sin(r) * nm2m(distNm), y: Math.cos(r) * nm2m(distNm) };
};

// ---------------------------------------------------------------------------
// 跑道：两条平行跑道，间隔 1200 m，向南运行
// ---------------------------------------------------------------------------

const RWY_18L: Runway = {
  ident: '18L',
  heading: 180,
  threshold: { x: -380, y: 1500 },
  length: 3000,
  width: 45,
  ils: true,
  glideslope: 3,
  elevation: 12,
};

const RWY_18R: Runway = {
  ident: '18R',
  heading: 180,
  threshold: { x: 380, y: 1500 },
  length: 3200,
  width: 45,
  ils: true,
  glideslope: 3,
  elevation: 12,
};

const RUNWAYS: Runway[] = [RWY_18L, RWY_18R];

// ---------------------------------------------------------------------------
// 航路点
// ---------------------------------------------------------------------------

/** 进场走廊入口（距离单位：海里） */
const ENROUTE: Waypoint[] = [
  { name: 'AKIRA', pos: P(350, 42), type: 'FIX' },
  { name: 'BRAVO', pos: P(335, 28), type: 'FIX' },
  { name: 'CEDAR', pos: P(20, 40), type: 'FIX' },
  { name: 'DELTA', pos: P(10, 26), type: 'FIX' },
  { name: 'EAGLE', pos: P(85, 38), type: 'FIX' },
  { name: 'FLINT', pos: P(70, 22), type: 'FIX' },
  { name: 'GOLDA', pos: P(175, 40), type: 'FIX' },
  { name: 'HAZEL', pos: P(190, 26), type: 'FIX' },
  { name: 'IRONS', pos: P(265, 36), type: 'FIX' },
  { name: 'JUNIP', pos: P(280, 22), type: 'FIX' },
];

/** 为跑道生成初始进近定位点（IAF）与最后进近定位点（FAF） */
function buildApproachFixes(rw: Runway): Waypoint[] {
  const back = (rw.heading + 180) % 360;
  return [
    { name: `${rw.ident}IAF`, pos: along(rw.threshold, back, nm2m(15)), type: 'IAF' },
    { name: `${rw.ident}FAF`, pos: along(rw.threshold, back, nm2m(6)), type: 'FAF' },
  ];
}

const APPROACH_FIXES: Waypoint[] = [...buildApproachFixes(RWY_18L), ...buildApproachFixes(RWY_18R)];

const WAYPOINTS: Waypoint[] = [...ENROUTE, ...APPROACH_FIXES];

/** 按名称取航路点坐标 */
const WP = (name: string): Vec2 => {
  const w = WAYPOINTS.find((x) => x.name === name);
  if (!w) throw new Error(`未定义航路点: ${name}`);
  return w.pos;
};
// 触发一次校验，数据写错时立刻报错而不是运行时静默失败
WP('AKIRA');

// ---------------------------------------------------------------------------
// 扇区：雷达管制区，半径 45 NM
// ---------------------------------------------------------------------------

const SECTOR_BOUNDARY = circlePoints({ x: 0, y: 0 }, nm2m(45), 32);

const SECTORS: Sector[] = [
  {
    name: 'AURORA APPROACH',
    boundary: SECTOR_BOUNDARY,
    floorAlt: 0,
    ceilingAlt: 12500, // FL410 上限
  },
];

// ---------------------------------------------------------------------------
// 标准仪表进场程序（STAR）：航路点名称序列，终点接到 IAF/FAF
// ---------------------------------------------------------------------------

const STARS: Record<string, string[]> = {
  // 西北走廊 → 18L
  AURORA1A: ['AKIRA', 'BRAVO', '18LIAF', '18LFAF'],
  // 东北走廊 → 18R
  AURORA1B: ['CEDAR', 'DELTA', '18RIAF', '18RFAF'],
  // 东侧走廊 → 18R
  AURORA2A: ['EAGLE', 'FLINT', '18RIAF', '18RFAF'],
  // 南侧绕行 → 18L
  AURORA3A: ['GOLDA', 'HAZEL', '18LIAF', '18LFAF'],
};

/** 各 STAR 对应的落地跑道（供交通生成选跑道用） */
export const STAR_RUNWAY: Record<string, string> = {
  AURORA1A: '18L',
  AURORA1B: '18R',
  AURORA2A: '18R',
  AURORA3A: '18L',
};

// ---------------------------------------------------------------------------
// 标准仪表离场程序（SID）：从跑道末端起飞后飞向的离场点
// ---------------------------------------------------------------------------

const SIDS: Record<string, string[]> = {
  AURORA1D: ['JUNIP', 'IRONS'],
  AURORA2D: ['FLINT', 'EAGLE'],
  AURORA3D: ['BRAVO', 'AKIRA'],
};

export const AIRPORT: Airport = {
  icao: 'ZZAU',
  name: 'Aurora International',
  elevation: 12,
  radarRange: nm2m(48),
  runways: RUNWAYS,
  waypoints: WAYPOINTS,
  sectors: SECTORS,
  stars: STARS,
  sids: SIDS,
};

export const STAR_NAMES = Object.keys(STARS);
export const SID_NAMES = Object.keys(SIDS);

/** 跑道列表（仅原始方向） */
export const BASE_RUNWAYS = RUNWAYS;
