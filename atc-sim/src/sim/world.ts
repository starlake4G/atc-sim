/**
 * 世界模型 —— 唯一真值源
 *
 * 定步长 20 Hz，渲染帧率与逻辑解耦；时间倍速只改变累积器的消耗速度。
 * 所有视图层从这里读快照，绝不回写。
 */

import type { Airport, Aircraft, Command, ConflictPair, FlightPhase, Runway } from './types';
import { findRunway, reciprocalIdent } from './airport';
import { describeCommand, issueCommand, updateAircraft, type SimContext, type Wind } from './aircraft';
import { detectConflicts, DEFAULT_THRESHOLDS } from './conflict';
import { createWeather, updateWeather, inStorm, type WeatherState } from './weather';
import { capacityFor, createScoreState, penalize, PENALTY, ratesFor, scoreDeparture, scoreLanding, type ScoreState } from './score';
import { createTrafficState, makeRng, spawnArrival, spawnDeparture, updateTraffic, type TrafficState } from './traffic';
import { angleDiff, ft2m, m2nm } from './units';
import { hdist3 } from './vec';

/** 逻辑步长频率 */
export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;
/** 单帧最多推进的逻辑步数，防止卡顿后螺旋 */
const MAX_STEPS_PER_FRAME = 40;
/** 航迹拖尾采样间隔（秒） */
const TRAIL_INTERVAL = 5;
/** 航迹拖尾保留时长（秒） */
const TRAIL_LIFETIME = 120;
/** 落地后多久移除飞机（视为脱离跑道，秒） */
const LANDED_REMOVE_DELAY = 25;
/**
 * 生成上限相对容量的余量。容量是"能同时管几架"的难度旋钮，不是硬闸：
 * 卡死在 capacity 会让开局预置交通正好占满名额、生成累积器永远攒不到阈值，
 * 场地从此静止。
 */
const SPAWN_HEADROOM = 2;

/**
 * 电台记录的类别：
 *   atc   —— 管制员指令（玩家下发）
 *   pilot —— 飞行员复诵 / 请求
 *   其余为系统事件
 */
export type LogKind = 'atc' | 'pilot' | 'info' | 'good' | 'bad';

export interface LogEntry {
  t: number;
  text: string;
  kind: LogKind;
}

export interface World {
  airport: Airport;
  time: number;
  accumulator: number;
  /** 时间倍速：1 / 2 / 4 */
  timeScale: number;
  paused: boolean;
  aircraft: Aircraft[];
  conflicts: ConflictPair[];
  weather: WeatherState;
  score: ScoreState;
  traffic: TrafficState;
  rand: () => number;
  selectedId: number | null;
  log: LogEntry[];
  /** 当前容量（可同时管制架数） */
  capacity: number;
  /** 冲突告警去重键 */
  conflictKeys: Set<string>;
  /** 上一帧各机阶段，用于捕捉状态跃迁 */
  prevPhase: Map<number, FlightPhase>;
}

export interface WorldOptions {
  airport: Airport;
  seed?: number;
  /** 初始风 */
  windDirection?: number;
  windSpeed?: number;
  /** 是否启用雷暴 */
  storm?: boolean;
}

export function createWorld(opts: WorldOptions): World {
  const seed = opts.seed ?? Date.now();
  const storm = opts.storm
    ? { pos: { x: 0, y: 0 }, radius: 1, intensity: 1 }
    : null;
  const world: World = {
    airport: opts.airport,
    time: 0,
    accumulator: 0,
    timeScale: 1,
    paused: false,
    aircraft: [],
    conflicts: [],
    weather: createWeather(opts.windDirection ?? 195, opts.windSpeed ?? 8, storm),
    score: createScoreState(),
    traffic: createTrafficState(),
    rand: makeRng(seed),
    selectedId: null,
    log: [],
    capacity: capacityFor(0),
    conflictKeys: new Set<string>(),
    prevPhase: new Map<number, FlightPhase>(),
  };
  pushLog(world, 'Aurora 进近开放，雷达管制开始', 'info');

  // 预置初始交通：按流率算第一批飞机要几分钟后才到，开局空场体验很差
  const starNames = Object.keys(opts.airport.stars);
  for (let i = 0; i < 2 && starNames.length > 0; i++) {
    const star = starNames[Math.floor(world.rand() * starNames.length)];
    const ac = spawnArrival(world.traffic.nextId, opts.airport, star, 0, world.rand);
    if (ac) {
      world.aircraft.push(ac);
      world.traffic.nextId++;
      pushLog(world, `[${ac.callsign}]>[${stationOf(ac)}] ${star} 进场进入雷达管制，请求引导`, 'pilot');
    }
  }

  // 再放一架离场航班在跑道头等着，开局就有事可做
  const sidNames = Object.keys(opts.airport.sids);
  if (opts.airport.runways.length > 0 && sidNames.length > 0) {
    const rw = opts.airport.runways[0];
    const dep = spawnDeparture(
      world.traffic.nextId,
      opts.airport,
      rw.ident,
      sidNames[0],
      0,
      world.rand,
    );
    if (dep) {
      world.aircraft.push(dep);
      world.traffic.nextId++;
      pushLog(world, `[${dep.callsign}]>[TWR] 跑道${rw.ident}外等待，请求起飞`, 'pilot');
    }
  }

  return world;
}

export function pushLog(world: World, text: string, kind: LogEntry['kind'] = 'info'): void {
  world.log.push({ t: world.time, text, kind });
  if (world.log.length > 120) world.log.splice(0, world.log.length - 120);
}

export function findAircraft(world: World, id: number): Aircraft | undefined {
  return world.aircraft.find((a) => a.id === id);
}

/**
 * 该机当前所属管制席位。
 *
 * 只有一个塔台席位：进近席位没有移交玩法，只是把同一批指令换个标签，
 * 徒增无线电噪声和"我是不是管错段"的困惑。P2 地面管制域再引入 GND。
 */
export function stationOf(_ac: Aircraft): 'TWR' {
  return 'TWR';
}

export function selectedAircraft(world: World): Aircraft | null {
  if (world.selectedId === null) return null;
  return findAircraft(world, world.selectedId) ?? null;
}

/** 给指定飞机下指令 */
export function commandAircraft(world: World, id: number, cmd: Command): boolean {
  const ac = findAircraft(world, id);
  if (!ac) return false;
  if (ac.phase === 'LANDED') return false;
  issueCommand(ac, cmd, world.time);
  ac.hasBeenControlled = true;
  pushLog(world, `[${stationOf(ac)}]>[${ac.callsign}] ${describeCommand(cmd)}`, 'atc');
  return true;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

/**
 * 用真实经过时间推进世界。内部按固定步长消费累积器。
 */
export function stepWorld(world: World, realDt: number): void {
  if (world.paused) return;
  // 夹住单帧时间，避免切标签页回来后瞬移
  const clamped = Math.min(realDt, 0.25);
  world.accumulator += clamped * world.timeScale;

  let steps = 0;
  while (world.accumulator >= TICK_DT && steps < MAX_STEPS_PER_FRAME) {
    world.accumulator -= TICK_DT;
    simulateTick(world, TICK_DT);
    steps++;
  }
  // 追不上就丢弃，宁可跳时间也不要卡死
  if (steps >= MAX_STEPS_PER_FRAME) world.accumulator = 0;
}

function simulateTick(world: World, dt: number): void {
  world.time += dt;
  updateWeather(world.weather, world.time);

  const ctx: SimContext = {
    time: world.time,
    dt,
    airport: world.airport,
    wind: world.weather.wind,
    // 指令到期生效时记录飞行员复诵（与下发之间隔着 2.5s 复诵延迟）
    onExecuted: (ac, cmd) => {
      pushLog(world, `[${ac.callsign}]>[${stationOf(ac)}] ${describeCommand(cmd)}，${ac.callsign}`, 'pilot');
    },
  };

  // ---- 1. 推进所有飞机 ----
  for (const ac of world.aircraft) {
    updateAircraft(ac, ctx);
    sampleTrail(world, ac);
  }

  // ---- 2. 生成交通 ----
  world.capacity = capacityFor(world.score.score);
  const rates = ratesFor(world.capacity);
  const spawned = updateTraffic(
    world.traffic,
    rates,
    dt,
    world.time,
    world.airport,
    world.rand,
    world.aircraft.length,
    world.capacity + SPAWN_HEADROOM,
  );
  for (const ac of spawned) {
    world.aircraft.push(ac);
    world.prevPhase.set(ac.id, ac.phase);
    pushLog(world, `[${ac.callsign}]>[${stationOf(ac)}] 进入雷达管制`, 'pilot');
  }

  // ---- 3. 事件判定 ----
  for (const ac of world.aircraft) handleEvents(world, ac);

  // ---- 4. 冲突探测 ----
  updateConflicts(world);

  // ---- 5. 清场 ----
  pruneAircraft(world);

  // 刷新阶段快照
  for (const ac of world.aircraft) world.prevPhase.set(ac.id, ac.phase);
}

function sampleTrail(world: World, ac: Aircraft): void {
  if (world.time - ac.lastTrailTime < TRAIL_INTERVAL) return;
  ac.lastTrailTime = world.time;
  ac.trail.push({ t: world.time, x: ac.pos.x, y: ac.pos.y, z: ac.pos.z });
  while (ac.trail.length > 0 && world.time - ac.trail[0].t > TRAIL_LIFETIME) {
    ac.trail.shift();
  }
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

function handleEvents(world: World, ac: Aircraft): void {
  const prev = world.prevPhase.get(ac.id);

  // ---- 落地 ----
  if (ac.phase === 'LANDED' && ac.landedAt === null) {
    ac.landedAt = world.time;
    const actual = nearestRunwayIdent(world.airport, ac);
    scoreLanding(world.score, ac, ac.approach?.runway ?? null, actual, world.time);
    pushLog(world, `${ac.callsign} 落地${actual ? `，跑道 ${actual}` : ''}`, 'good');
  }

  // ---- 起飞 ----
  if (ac.isDeparture && ac.phase === 'CLIMB' && !ac.penaltyFlags.has('evt-departed')) {
    ac.penaltyFlags.add('evt-departed');
    scoreDeparture(world.score, ac, world.time);
    pushLog(world, `${ac.callsign} 离地，沿 SID 爬升`, 'good');
  }

  // ---- 复飞 ----
  if (prev === 'APPROACH' && ac.phase === 'GO_AROUND') {
    penalize(world.score, ac, 'evt-goaround', PENALTY.goAround, 'Go around', world.time);
    pushLog(world, `${ac.callsign} 复飞！`, 'bad');
  }

  // ---- 穿越雷暴 ----
  if (world.weather.storm && inStorm(world.weather, ac.pos.x, ac.pos.y) && ac.pos.z < ft2m(30000)) {
    penalize(world.score, ac, 'evt-storm', 4, 'Entered thunderstorm', world.time);
    pushLog(world, `${ac.callsign} 误入雷暴！`, 'bad');
  }

  // ---- 飞出管制区 ----
  const dist = Math.hypot(ac.pos.x, ac.pos.y);
  if (dist > world.airport.radarRange * 1.2) {
    if (!ac.isDeparture && ac.phase !== 'LANDED') {
      penalize(world.score, ac, 'evt-out', PENALTY.outOfBounds, 'Left control area', world.time);
      pushLog(world, `${ac.callsign} 已飞出管制区`, 'bad');
    } else if (ac.isDeparture) {
      pushLog(world, `${ac.callsign} 移交区调，再见`, 'info');
    }
    ac.penaltyFlags.add('evt-remove');
  }
}

function pruneAircraft(world: World): void {
  const keep: Aircraft[] = [];
  for (const ac of world.aircraft) {
    if (ac.penaltyFlags.has('evt-remove')) continue;
    if (
      ac.phase === 'LANDED' &&
      ac.landedAt !== null &&
      world.time - ac.landedAt > LANDED_REMOVE_DELAY
    ) {
      continue;
    }
    keep.push(ac);
  }
  if (keep.length !== world.aircraft.length) {
    world.aircraft = keep;
    if (world.selectedId !== null && !keep.some((a) => a.id === world.selectedId)) {
      world.selectedId = null;
    }
  }
}

/** 找飞机实际落地的跑道（按距离与航向匹配） */
function nearestRunwayIdent(airport: Airport, ac: Aircraft): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const r of airport.runways) {
    for (const ident of [r.ident, reciprocalIdent(r.ident)]) {
      const rw: Runway | null = findRunway(airport, ident);
      if (!rw) continue;
      const d = hdist3(ac.pos, { x: rw.threshold.x, y: rw.threshold.y, z: ac.pos.z });
      const headingDiff = Math.abs(angleDiff(ac.heading, rw.heading));
      if (headingDiff > 60) continue;
      const score = d + headingDiff * 120;
      if (score < bestScore) {
        bestScore = score;
        best = ident;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

function updateConflicts(world: World): void {
  const pairs = detectConflicts(world.aircraft, world.weather.wind, DEFAULT_THRESHOLDS);
  world.conflicts = pairs;

  const currentKeys = new Set<string>();
  for (const p of pairs) {
    const lo = Math.min(p.a, p.b);
    const hi = Math.max(p.a, p.b);
    const key = `${lo}-${hi}-${p.severity}`;
    currentKeys.add(key);
    if (world.conflictKeys.has(key)) continue;
    world.conflictKeys.add(key);

    const acA = findAircraft(world, p.a);
    const acB = findAircraft(world, p.b);
    if (!acA || !acB) continue;
    const callsigns = `${acA.callsign} / ${acB.callsign}`;

    switch (p.severity) {
      case 'LOSS':
        penalize(world.score, acA, `loss-${key}`, PENALTY.loss, 'Loss of separation', world.time, 'red');
        penalize(world.score, acB, `loss-${key}`, PENALTY.loss, 'Loss of separation', world.time, 'red');
        pushLog(world, `失去间隔：${callsigns}！`, 'bad');
        break;
      case 'CRITICAL':
        penalize(world.score, acA, `crit-${key}`, PENALTY.critical, 'Critical conflict', world.time);
        pushLog(world, `严重冲突：${callsigns}`, 'bad');
        break;
      default:
        // 预测级只提示不扣分：300 s 前瞻下的"将来可能太近"不是违规，
        // 为消警去做无意义绕飞才是坏玩法
        pushLog(world, `间隔提醒：${callsigns}`, 'info');
        break;
    }
  }

  // 不再存在的告警键要清掉，否则同一对飞机再次冲突不会重新提示
  for (const k of world.conflictKeys) {
    if (!currentKeys.has(k)) world.conflictKeys.delete(k);
  }
}

// ---------------------------------------------------------------------------
// 统计辅助（供 UI）
// ---------------------------------------------------------------------------

export interface WorldStats {
  time: number;
  airborne: number;
  onGround: number;
  arrivals: number;
  departures: number;
  landings: number;
  departuresDone: number;
  conflicts: number;
  worstConflict: ConflictPair['severity'] | null;
  windDir: number;
  windSpeedKt: number;
  visibilityNm: number;
  capacity: number;
  /** 实际生成上限（容量 + 余量），供 HUD 显示"在场/上限" */
  spawnCeiling: number;
  score: number;
  /** 黄牌 / 红牌计数 */
  yellow: number;
  red: number;
  trafficLoaded: number;
}

export function worldStats(world: World): WorldStats {
  const airborne = world.aircraft.filter((a) => a.phase !== 'GROUND' && a.phase !== 'LANDED').length;
  const onGround = world.aircraft.length - airborne;
  const arrivals = world.aircraft.filter((a) => !a.isDeparture).length;
  const departures = world.aircraft.filter((a) => a.isDeparture).length;
  const worst = world.conflicts.length > 0 ? world.conflicts[0].severity : null;

  return {
    time: world.time,
    airborne,
    onGround,
    arrivals,
    departures,
    landings: world.score.landed,
    departuresDone: world.score.departed,
    conflicts: world.conflicts.length,
    worstConflict: worst,
    windDir: world.weather.wind.direction,
    windSpeedKt: (world.weather.wind.speed / 0.514444),
    visibilityNm: m2nm(world.weather.visibility),
    capacity: world.capacity,
    spawnCeiling: world.capacity + SPAWN_HEADROOM,
    score: world.score.score,
    yellow: world.score.yellow,
    red: world.score.red,
    trafficLoaded: world.aircraft.length,
  };
}

/** 便于外部按需构造风 */
export function currentWind(world: World): Wind {
  return world.weather.wind;
}
