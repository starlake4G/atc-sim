/**
 * 单位与坐标约定
 * ---------------------------------------------------------------------------
 * 内部一律 SI：长度米、速度米每秒、时间秒、角度度。
 * 航空单位（英尺 / 节 / 海里）**只在显示层**转换，绝不进入仿真内部。
 *
 * 坐标系：局部 ENU 平面（忽略地球曲率——雷达管制本来就是平面投影）
 *   x = 东 (m)
 *   y = 北 (m)
 *   z = 高度 (m)
 *
 * 航向：度，0 = 正北，顺时针增加。
 */

export const M_PER_NM = 1852;
export const M_PER_FT = 0.3048;
export const MS_PER_KT = 0.514444;
export const G0 = 9.80665;

/** 海里 → 米 */
export const nm2m = (v: number): number => v * M_PER_NM;
/** 米 → 海里 */
export const m2nm = (v: number): number => v / M_PER_NM;
/** 英尺 → 米 */
export const ft2m = (v: number): number => v * M_PER_FT;
/** 米 → 英尺 */
export const m2ft = (v: number): number => v / M_PER_FT;
/** 节 → 米每秒 */
export const kt2ms = (v: number): number => v * MS_PER_KT;
/** 米每秒 → 节 */
export const ms2kt = (v: number): number => v / MS_PER_KT;
/** 英尺每分钟 → 米每秒 */
export const fpm2ms = (v: number): number => (v * M_PER_FT) / 60;
/** 米每秒 → 英尺每分钟 */
export const ms2fpm = (v: number): number => (v * 60) / M_PER_FT;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const deg2rad = (d: number): number => d * DEG;
export const rad2deg = (r: number): number => r * RAD;

/** 归一到 [0, 360) */
export function norm360(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/** 两个航向之间的最短有向差，结果在 (-180, 180]，正数表示需要右转 */
export function angleDiff(target: number, current: number): number {
  let d = norm360(target - current);
  if (d > 180) d -= 360;
  return d;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 显式接近：每步最多移动 maxDelta */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** 把米制高度格式化为飞行高度层显示，如 3000ft → "FL030" / "3000" */
export function formatAltitude(meters: number, flightLevel = false): string {
  const feet = Math.round(m2ft(meters) / 100) * 100;
  if (flightLevel && feet >= 10000) return `FL${String(Math.round(feet / 100)).padStart(3, '0')}`;
  return String(feet);
}

/** 把米制距离格式化为海里，保留一位小数 */
export function formatNm(meters: number): string {
  return (m2nm(meters)).toFixed(1);
}
