/**
 * 机场几何辅助 —— 跑道 / 下滑道 / 航向道 / 扇区判定的纯几何计算
 */

import type { Airport, Runway, Sector, Waypoint } from './types';
import { bearing, along, headingToVec, pointInPolygon, type Vec2, type Vec3 } from './vec';
import { angleDiff, deg2rad, ft2m, nm2m } from './units';

export { type Airport, type Runway, type Sector, type Waypoint };

/** 跑道末端（起飞端）坐标 */
export function runwayEnd(r: Runway): Vec2 {
  return along(r.threshold, r.heading, r.length);
}

/** 跑道中心点 */
export function runwayCenter(r: Runway): Vec2 {
  return along(r.threshold, r.heading, r.length / 2);
}

/** 反向跑道识别号，18L → 36R */
export function reciprocalIdent(ident: string): string {
  const m = /^(\d{2})([LCR]?)$/.exec(ident.trim().toUpperCase());
  if (!m) return ident;
  const num = ((parseInt(m[1], 10) + 18 - 1) % 36) + 1;
  const sideMap: Record<string, string> = { L: 'R', R: 'L', C: 'C', '': '' };
  return `${String(num).padStart(2, '0')}${sideMap[m[2]] ?? ''}`;
}

/**
 * 下滑道高度：距接地点距离 → 该处应有的高度（米）
 * 3° 下滑角近似：每海里下降约 318 ft，这里用正切精算。
 */
export function glidePathAltitude(runway: Runway, distanceFromThreshold: number): number {
  const gs = deg2rad(runway.glideslope);
  return runway.elevation + distanceFromThreshold * Math.tan(gs);
}

/** 距接地点多远时处于某个高度（下滑道反解） */
export function distanceForAltitude(runway: Runway, altitude: number): number {
  const gs = deg2rad(runway.glideslope);
  const agl = Math.max(0, altitude - runway.elevation);
  return agl / Math.tan(gs);
}

/**
 * 是否已截获航向道：
 * 1) 与跑道中心线延长线的横向偏离在容差内
 * 2) 位于接地点之前（进近侧）
 * 3) 航向与跑道航向夹角在限制内（真实约 30°，游戏中放宽到 45°）
 */
export function localizerCapture(
  pos: Vec3,
  heading: number,
  runway: Runway,
  lateralToleranceM = nm2m(1.0),
  maxInterceptAngle = 45,
): { captured: boolean; lateral: number; lateralSigned: number; distance: number; angle: number } {
  const u = headingToVec(runway.heading);
  // 从接地点指向飞机
  const dx = pos.x - runway.threshold.x;
  const dy = pos.y - runway.threshold.y;
  // 沿跑道方向的投影（负数 = 在接地点之前，即进近侧）
  const axial = dx * u.x + dy * u.y;
  // 横向偏移（带符号，正 = 位于中心线右侧）
  const lateralSigned = dx * -u.y + dy * u.x;
  const lateral = Math.abs(lateralSigned);

  // 航向与跑道方向的夹角（0–180°）
  const angle = Math.abs(angleDiff(heading, runway.heading));

  const before = axial < 0;
  const captured = before && lateral <= lateralToleranceM && angle <= maxInterceptAngle;
  return { captured, lateral, lateralSigned, distance: Math.hypot(dx, dy), angle };
}

/**
 * 在一个机场内按识别号找跑道（支持传入 18L / 36R 两个方向）
 */
export function findRunway(airport: Airport, ident: string): Runway | null {
  const want = ident.trim().toUpperCase();
  for (const r of airport.runways) {
    if (r.ident.toUpperCase() === want) return r;
    if (reciprocalIdent(r.ident).toUpperCase() === want) {
      // 反向：构造一条镜像跑道
      return {
        ...r,
        ident: reciprocalIdent(r.ident),
        heading: (r.heading + 180) % 360,
        threshold: runwayEnd(r),
      };
    }
  }
  return null;
}

export function findWaypoint(airport: Airport, name: string): Waypoint | null {
  const want = name.trim().toUpperCase();
  return airport.waypoints.find((w) => w.name.toUpperCase() === want) ?? null;
}

/** 飞机所在扇区（返回第一个匹配） */
export function sectorAt(airport: Airport, pos: Vec3): Sector | null {
  for (const s of airport.sectors) {
    if (pos.z < s.floorAlt || pos.z > s.ceilingAlt) continue;
    if (pointInPolygon({ x: pos.x, y: pos.y }, s.boundary)) return s;
  }
  return null;
}

/** 距机场中心距离（局部坐标原点即机场中心，用于判断是否飞出管制区） */
export function distanceFromField(pos: Vec2): number {
  return Math.hypot(pos.x, pos.y);
}

/**
 * 生成把飞机引导到跑道延长线所需的建议切入航向（用于 HUD 提示）
 */
export function interceptHeading(pos: Vec2, runway: Runway): number {
  // 目标点：接地点外 10nm
  const aim = along(runway.threshold, (runway.heading + 180) % 360, nm2m(10));
  return bearing(pos, aim);
}

/** 高度层校验：中国民航 RVSM 以上（8900m/29100ft）东单西双 */
export function validCruiseLevel(altitudeM: number, headingDeg: number): boolean {
  if (altitudeM < ft2m(29100)) return true;
  const fl = Math.round(altitudeM / ft2m(100));
  const eastbound = headingDeg >= 0 && headingDeg < 180;
  return eastbound ? fl % 2 === 1 : fl % 2 === 0;
}
