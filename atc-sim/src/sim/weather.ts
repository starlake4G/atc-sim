/**
 * 风与天气
 *
 * 中等拟真的做法：风用多周期正弦叠加缓慢漂移，加阵风；不做真实气象模型。
 * 风影响两件事——地速（逆风/顺风）、跑道构型（顺风起降要扣分）。
 */

import type { Airport, Runway } from './types';
import type { Wind } from './aircraft';
import { findRunway } from './airport';
import { nm2m } from './units';
import type { Vec2 } from './vec';

export interface ThunderstormCell {
  pos: Vec2;
  radius: number;
  intensity: number;
}

export interface WeatherState {
  wind: Wind;
  /** 基准风向（度，来向） */
  baseDirection: number;
  /** 基准风速 m/s */
  baseSpeed: number;
  /** 阵风幅度 m/s */
  gustAmplitude: number;
  /** 能见度 m */
  visibility: number;
  /** 雷暴单体，null 表示晴空 */
  storm: ThunderstormCell | null;
}

export function createWeather(baseDirection = 200, baseSpeed = 8, storm: ThunderstormCell | null = null): WeatherState {
  return {
    wind: { direction: baseDirection, speed: baseSpeed },
    baseDirection,
    baseSpeed,
    gustAmplitude: 2.5,
    visibility: storm ? 5000 : 10000,
    storm,
  };
}

/** 风缓慢漂移 —— 两个互质周期叠加，看起来随机但可复现 */
export function updateWeather(w: WeatherState, time: number): void {
  const t = time / 60; // 分钟
  const dirDrift = 22 * Math.sin(t * 0.0131) + 9 * Math.sin(t * 0.0417);
  const spdDrift = 1 + 0.25 * Math.sin(t * 0.021) + 0.08 * Math.sin(t * 0.063);
  const gust = w.gustAmplitude * Math.sin(t * 0.37);

  w.wind.direction = (w.baseDirection + dirDrift + 360) % 360;
  w.wind.speed = Math.max(0, w.baseSpeed * spdDrift + gust);
}

/** 逆风分量（m/s）：正值表示逆风（有利） */
export function headwindComponent(runwayHeading: number, wind: Wind): number {
  // 风向为来向；逆风 = 风的来向与跑道方向一致
  const diff = ((wind.direction - runwayHeading + 540) % 360) - 180;
  const cos = Math.cos((diff * Math.PI) / 180);
  return wind.speed * cos;
}

/** 侧风分量（m/s）：绝对值越大越难 */
export function crosswindComponent(runwayHeading: number, wind: Wind): number {
  const diff = ((wind.direction - runwayHeading + 540) % 360) - 180;
  return Math.abs(wind.speed * Math.sin((diff * Math.PI) / 180));
}

/**
 * 推荐跑道构型：选逆风分量最大的方向。
 * 返回的 Runway 已按风向翻转（可能是反向跑道）。
 */
export function recommendRunway(airport: Airport, wind: Wind): Runway | null {
  let best: Runway | null = null;
  let bestScore = -Infinity;

  for (const r of airport.runways) {
    // 两个方向都试
    for (const hdg of [r.heading, (r.heading + 180) % 360]) {
      const hw = headwindComponent(hdg, wind);
      const xw = crosswindComponent(hdg, wind);
      // 逆风优先，侧风惩罚
      const score = hw - xw * 0.6;
      if (score > bestScore) {
        bestScore = score;
        if (hdg === r.heading) {
          best = r;
        } else {
          // 反向跑道
          best = {
            ...r,
            ident: reciprocal(r.ident),
            heading: hdg,
            threshold: {
              x: r.threshold.x + Math.sin((r.heading * Math.PI) / 180) * r.length,
              y: r.threshold.y + Math.cos((r.heading * Math.PI) / 180) * r.length,
            },
          };
        }
      }
    }
  }
  return best;
}

function reciprocal(ident: string): string {
  const m = /^(\d{2})([LCR]?)$/.exec(ident.trim().toUpperCase());
  if (!m) return ident;
  const num = ((parseInt(m[1], 10) + 18 - 1) % 36) + 1;
  const sides: Record<string, string> = { L: 'R', R: 'L', C: 'C', '': '' };
  return `${String(num).padStart(2, '0')}${sides[m[2]] ?? ''}`;
}

/** 是否处于雷暴区内 */
export function inStorm(w: WeatherState, x: number, y: number): boolean {
  if (!w.storm) return false;
  const dx = x - w.storm.pos.x;
  const dy = y - w.storm.pos.y;
  return Math.hypot(dx, dy) < w.storm.radius;
}

/** 生成一个默认的雷暴单体（放在机场一侧） */
export function makeStorm(airport: Airport, bearingDeg: number, distanceNm: number, radiusNm = 8): ThunderstormCell {
  const r = (bearingDeg * Math.PI) / 180;
  return {
    pos: {
      x: airport.waypoints.length && !airport.waypoints[0].pos.x ? 0 : Math.sin(r) * nm2m(distanceNm),
      y: Math.cos(r) * nm2m(distanceNm),
    },
    radius: nm2m(radiusNm),
    intensity: 0.8,
  };
}

/** 反过来：从识别号找跑道（供 UI 显示用） */
export function resolveRunway(airport: Airport, ident: string): Runway | null {
  return findRunway(airport, ident);
}
