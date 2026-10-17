/** 平面向量（ENU 的水平分量：x 东，y 北）。 */
export interface Vec2 {
  x: number;
  y: number;
}

export const v2 = (x: number, y: number): Vec2 => ({ x, y });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function norm(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l < 1e-9 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
}

/** 从 a 指向 b 的罗盘方位（0=北，顺时针） */
export function bearing(a: Vec2, b: Vec2): number {
  const d = sub(b, a);
  const deg = Math.atan2(d.x, d.y) * (180 / Math.PI);
  return (deg + 360) % 360;
}

export const fromBearing = (deg: number, length = 1): Vec2 => {
  const r = deg * (Math.PI / 180);
  return { x: Math.sin(r) * length, y: Math.cos(r) * length };
};

export function lerpVec(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
