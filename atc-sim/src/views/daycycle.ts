/**
 * 昼夜循环 —— 纯表现层，不进 sim core
 *
 * 节奏设计：1 现实分钟 = 1 游戏小时（全天 24 分钟，1× 倍速下 10 分钟的
 * 对局正好经历 早→午→黄昏→夜 的大半轮），倍速加快时天空同步加快。
 * 起始时刻取清晨，让玩家开局先见到日光，夜晚作为对局后段的氛围变化。
 *
 * 输出一份 SkyState 快照供场景每帧应用：太阳/月亮方向、天空双色、
 * 雾色、光强、星空透明度、场内灯光强度。
 */

import * as THREE from 'three';
import { dayHour } from '../sim/clock';

export interface SkyState {
  /** 当前时刻 0–24 */
  hour: number;
  /** 太阳方向（单位向量，three 空间：x 东 / y 上 / z 南） */
  sunDir: THREE.Vector3;
  /** 月亮方向 */
  moonDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  moonIntensity: number;
  ambientColor: THREE.Color;
  ambientIntensity: number;
  /** 天顶色 / 地平色 */
  zenith: THREE.Color;
  horizon: THREE.Color;
  /** 雾色（接近地平色但更沉） */
  fog: THREE.Color;
  /** 星空透明度 0..1 */
  starOpacity: number;
  /** 场内灯光强度 0..1（白天暗、夜晚亮） */
  airportLights: number;
}

interface Palette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  fog: THREE.Color;
  sun: THREE.Color;
  sunI: number;
  amb: THREE.Color;
  ambI: number;
}

const DAY: Palette = {
  zenith: new THREE.Color(0x4a8ac2),
  horizon: new THREE.Color(0xb9d3e2),
  fog: new THREE.Color(0xa5bfce),
  sun: new THREE.Color(0xfff2dd),
  sunI: 3.7,
  amb: new THREE.Color(0x9db8cc),
  ambI: 2.9,
};

const DUSK: Palette = {
  zenith: new THREE.Color(0x25345a),
  horizon: new THREE.Color(0xdd8a54),
  fog: new THREE.Color(0x8e6350),
  sun: new THREE.Color(0xff9550),
  sunI: 1.6,
  amb: new THREE.Color(0x6a6a8c),
  ambI: 1.3,
};

const NIGHT: Palette = {
  zenith: new THREE.Color(0x04070e),
  horizon: new THREE.Color(0x0b1424),
  fog: new THREE.Color(0x070d18),
  sun: new THREE.Color(0x000000),
  sunI: 0,
  amb: new THREE.Color(0x27384f),
  ambI: 0.55,
};

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 时刻 → 太阳高度（-1..1，正为在地平线上） */
const sunElevationAt = (hour: number): number => Math.sin(((hour - 6) / 12) * Math.PI);

/** 天体方位：hour=6 日出于东（+x），12 在南（+z），18 落于西（-x） */
const bodyDir = (hour: number, elevSin: number, out: THREE.Vector3): THREE.Vector3 => {
  const az = ((hour - 6) / 12) * Math.PI; // 0..π 走过天空
  const e = Math.asin(Math.min(1, Math.max(-1, elevSin)));
  const horiz = Math.cos(e);
  return out.set(Math.cos(az) * horiz, elevSin, Math.sin(az) * horiz).normalize();
};

const scratchB = new THREE.Color();

/** 用 dst 把 a、b 按 t 混合 */
const blendColor = (dst: THREE.Color, a: THREE.Color, b: THREE.Color, t: number): THREE.Color =>
  dst.copy(a).lerp(b, t);

export function skyAt(timeSec: number, storm: boolean, dst?: SkyState): SkyState {
  const hour = dayHour(timeSec);
  const elev = sunElevationAt(hour);

  // 三个光照 regime 的权重：白天 / 晨昏 / 夜
  const dayF = smoothstep(0.14, 0.38, elev);
  const nightF = smoothstep(-0.03, -0.14, elev);
  const duskF = Math.max(0, 1 - dayF - nightF);

  const s: SkyState = dst ?? {
    hour: 0,
    sunDir: new THREE.Vector3(),
    moonDir: new THREE.Vector3(),
    sunColor: new THREE.Color(),
    sunIntensity: 0,
    moonIntensity: 0,
    ambientColor: new THREE.Color(),
    ambientIntensity: 0,
    zenith: new THREE.Color(),
    horizon: new THREE.Color(),
    fog: new THREE.Color(),
    starOpacity: 0,
    airportLights: 0,
  };
  s.hour = hour;

  // 夜 → 晨昏 → 白天 顺序混色（先混 NIGHT/DUSK，再向 DAY 过渡）
  blendColor(s.zenith, NIGHT.zenith, DUSK.zenith, duskF);
  blendColor(s.zenith, s.zenith, DAY.zenith, dayF);
  blendColor(s.horizon, NIGHT.horizon, DUSK.horizon, duskF);
  blendColor(s.horizon, s.horizon, DAY.horizon, dayF);
  blendColor(s.fog, NIGHT.fog, DUSK.fog, duskF);
  blendColor(s.fog, s.fog, DAY.fog, dayF);

  s.sunIntensity = NIGHT.sunI + (DUSK.sunI - NIGHT.sunI) * duskF;
  s.sunIntensity += (DAY.sunI - s.sunIntensity) * dayF;
  s.sunColor.copy(NIGHT.sun).lerp(DUSK.sun, duskF).lerp(DAY.sun, dayF);

  s.ambientIntensity = NIGHT.ambI + (DUSK.ambI - NIGHT.ambI) * duskF;
  s.ambientIntensity += (DAY.ambI - s.ambientIntensity) * dayF;
  blendColor(s.ambientColor, NIGHT.amb, DUSK.amb, duskF);
  blendColor(s.ambientColor, s.ambientColor, DAY.amb, dayF);

  bodyDir(hour, elev, s.sunDir);
  // 月亮走反相：太阳落下去它升起来
  const moonElev = -elev;
  bodyDir((hour + 12) % 24, moonElev, s.moonDir);
  s.moonIntensity = 0.9 * smoothstep(0.05, 0.3, moonElev);

  s.starOpacity = nightF;
  // 场内灯光：晨昏点亮，夜晚全开，白天保留基础亮度
  s.airportLights = Math.min(1, 0.3 + 0.45 * duskF + 0.55 * nightF);

  // 雷暴：整体压暗、雾色发灰
  if (storm) {
    s.zenith.multiplyScalar(0.55);
    s.horizon.multiplyScalar(0.6);
    s.fog.lerp(scratchB.set(0x3d4850), 0.6);
    s.sunIntensity *= 0.35;
    s.ambientIntensity *= 0.75;
    s.airportLights = Math.min(1, s.airportLights + 0.25);
  }
  return s;
}
