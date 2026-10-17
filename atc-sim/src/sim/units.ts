/** 单位换算。全部常量只在 sim 边界与 format 层使用；sim 内部一律 SI。 */
export const KT = 0.514444; // 1 kt -> m/s
export const NM = 1852; // 1 NM -> m
export const FT = 0.3048; // 1 ft -> m
export const FPM = 0.00508; // 1 ft/min -> m/s

export const kt = (v: number) => v * KT;
export const toKt = (v: number) => v / KT;
export const nm = (v: number) => v * NM;
export const toNm = (v: number) => v / NM;
export const ft = (v: number) => v * FT;
export const toFt = (v: number) => v / FT;
export const fpm = (v: number) => v * FPM;
export const toFpm = (v: number) => v / FPM;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** 归一到 [0, 360) */
export function norm360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** 有符号角差 a-b，结果落在 (-180, 180] */
export function angleDiff(a: number, b: number): number {
  let d = norm360(a - b);
  if (d > 180) d -= 360;
  return d;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 三度下滑角对应的下降梯度（米/米） */
export const GLIDE_SLOPE = Math.tan(3 * DEG);
