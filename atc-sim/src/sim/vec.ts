/**
 * 平面向量运算（ENU 局部坐标）
 * x = 东，y = 北，z = 高度（米）
 */

import { deg2rad, norm360 } from './units';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale2 = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len2 = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** 水平距离：带高度差的三维距离 */
export const dist3 = (a: Vec3, b: Vec3): number =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** 水平距离（忽略高度） */
export const hdist3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * 航向（度）转单位向量。0° = 正北(+y)，90° = 正东(+x)
 */
export function headingToVec(headingDeg: number): Vec2 {
  const r = deg2rad(headingDeg);
  return { x: Math.sin(r), y: Math.cos(r) };
}

/**
 * 由位移求航向（度，0-360）
 */
export function vecToHeading(v: Vec2): number {
  return norm360((Math.atan2(v.x, v.y) * 180) / Math.PI);
}

/** 从 a 指向 b 的方位角（度） */
export function bearing(a: Vec2, b: Vec2): number {
  return vecToHeading(sub2(b, a));
}

/** 沿航向移动距离 */
export function along(pos: Vec2, headingDeg: number, distance: number): Vec2 {
  const u = headingToVec(headingDeg);
  return { x: pos.x + u.x * distance, y: pos.y + u.y * distance };
}

/** 点是否在多边形内（射线法） */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    const intersect =
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 圆的边界点（用于生成扇区/等待航线） */
export function circlePoints(center: Vec2, radius: number, count: number): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2;
    pts.push({ x: center.x + Math.sin(ang) * radius, y: center.y + Math.cos(ang) * radius });
  }
  return pts;
}
