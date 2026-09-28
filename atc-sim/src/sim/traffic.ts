/**
 * 交通生成
 *
 * 进场航班在雷达范围之外沿着某条 STAR 的入口方向生成，飞进扇区；
 * 离场航班停在跑道头等待起飞许可。
 *
 * 流量用"架/小时 → 每秒概率"的累积器控制（做法来自 BlueSky trafgen 的
 * chances 公式），好处是流率可以任意调而不用改生成逻辑。
 */

import type { Aircraft, Airport, Waypoint } from './types';
import { createAircraft } from './aircraft';
import { findRunway } from './airport';
import { along, bearing, type Vec2 } from './vec';
import { ft2m, kt2ms, nm2m, norm360 } from './units';

// ---------------------------------------------------------------------------
// 可复现随机数（mulberry32）
// ---------------------------------------------------------------------------

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 航空公司呼号
// ---------------------------------------------------------------------------

interface AirlineDef {
  code: string;
  name: string;
  kind: 'pax' | 'cargo';
  weight: number;
}

const AIRLINES: AirlineDef[] = [
  { code: 'CCA', name: 'Air China', kind: 'pax', weight: 14 },
  { code: 'CSN', name: 'China Southern', kind: 'pax', weight: 14 },
  { code: 'CES', name: 'China Eastern', kind: 'pax', weight: 12 },
  { code: 'CSZ', name: 'Shenzhen Airlines', kind: 'pax', weight: 6 },
  { code: 'CHH', name: 'Hainan Airlines', kind: 'pax', weight: 7 },
  { code: 'CXA', name: 'Xiamen Air', kind: 'pax', weight: 6 },
  { code: 'CQH', name: 'Spring Airlines', kind: 'pax', weight: 5 },
  { code: 'DKH', name: 'Juneyao Air', kind: 'pax', weight: 5 },
  { code: 'CKK', name: 'SF Airlines', kind: 'cargo', weight: 4 },
  { code: 'CPA', name: 'Cathay Pacific', kind: 'pax', weight: 5 },
  { code: 'SIA', name: 'Singapore Airlines', kind: 'pax', weight: 4 },
  { code: 'JAL', name: 'Japan Airlines', kind: 'pax', weight: 4 },
  { code: 'ANA', name: 'All Nippon Airways', kind: 'pax', weight: 4 },
  { code: 'BAW', name: 'British Airways', kind: 'pax', weight: 3 },
  { code: 'DLH', name: 'Lufthansa', kind: 'pax', weight: 3 },
  { code: 'KLM', name: 'KLM', kind: 'pax', weight: 3 },
  { code: 'UAL', name: 'United Airlines', kind: 'pax', weight: 3 },
  { code: 'FDX', name: 'FedEx', kind: 'cargo', weight: 3 },
];

const AIRLINE_TOTAL = AIRLINES.reduce((s, a) => s + a.weight, 0);

function pickAirline(kind: 'pax' | 'cargo' | 'any', rand: () => number): AirlineDef {
  const pool = kind === 'any' ? AIRLINES : AIRLINES.filter((a) => a.kind === kind);
  const total = kind === 'any' ? AIRLINE_TOTAL : pool.reduce((s, a) => s + a.weight, 0);
  let r = rand() * total;
  for (const a of pool) {
    r -= a.weight;
    if (r <= 0) return a;
  }
  return pool[0];
}

export function makeCallsign(kind: 'pax' | 'cargo' | 'any', rand: () => number): string {
  const air = pickAirline(kind, rand);
  const num = Math.floor(rand() * 9000) + 100;
  return `${air.code}${num}`;
}

// ---------------------------------------------------------------------------
// 交通流状态
// ---------------------------------------------------------------------------

export interface TrafficState {
  arrivalAcc: number;
  departureAcc: number;
  nextId: number;
  /** 已生成的航班计数（用于统计） */
  spawned: number;
}

export interface TrafficRates {
  /** 进场流率，架/小时 */
  arrivals: number;
  /** 离场流率，架/小时 */
  departures: number;
}

export function createTrafficState(): TrafficState {
  return { arrivalAcc: 0, departureAcc: 0, nextId: 1, spawned: 0 };
}

// ---------------------------------------------------------------------------
// 航路点查找
// ---------------------------------------------------------------------------

export function waypointByName(airport: Airport, name: string): Waypoint | null {
  const want = name.trim().toUpperCase();
  return airport.waypoints.find((w) => w.name.toUpperCase() === want) ?? null;
}

/** 把程序（航路点名称序列）展开成坐标序列，忽略缺失的点 */
export function expandProcedure(airport: Airport, names: string[]): Vec2[] {
  const out: Vec2[] = [];
  for (const n of names) {
    const w = waypointByName(airport, n);
    if (w) out.push(w.pos);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成进场航班
// ---------------------------------------------------------------------------

/** 生成点再往外延伸的距离范围（海里），保证从雷达范围外飞进来 */
const ENTRY_EXTRA_MIN = 8;
const ENTRY_EXTRA_MAX = 14;

export function spawnArrival(
  id: number,
  airport: Airport,
  starName: string,
  now: number,
  rand: () => number,
): Aircraft | null {
  const star = airport.stars[starName];
  if (!star || star.length === 0) return null;

  const firstWp = waypointByName(airport, star[0]);
  if (!firstWp) return null;

  // 从机场中心指向首点的方向继续外推
  const outward = norm360(bearing({ x: 0, y: 0 }, firstWp.pos));
  const extra = nm2m(ENTRY_EXTRA_MIN + rand() * (ENTRY_EXTRA_MAX - ENTRY_EXTRA_MIN));
  const spawnPos = along(firstWp.pos, outward, extra);

  // 航向指向入口 fix 本身（朝第二个点打会先偏出去一段，进扇区就变成一次大转弯）
  const heading = norm360(outward + 180);

  const type = pickArrivalType(rand);
  const altFt = 20000 + Math.floor(rand() * 9) * 1000; // FL200–FL280
  const spdKt = 250 + Math.floor(rand() * 6) * 5; // 250–275 kt

  const ac = createAircraft(
    {
      id,
      callsign: makeCallsign('any', rand),
      type,
      pos: { x: spawnPos.x, y: spawnPos.y, z: ft2m(altFt) },
      heading,
      ias: kt2ms(spdKt),
      isDeparture: false,
      phase: 'CRUISE',
    },
    now,
  );

  // 沿着 STAR 剩下的航路点飞
  ac.route = expandProcedure(airport, star);
  ac.routeIndex = 0;
  ac.intent.altitude = ft2m(altFt);
  ac.intent.speed = kt2ms(spdKt);
  ac.lastInstruction = `${starName} 进场`;
  return ac;
}

function pickArrivalType(rand: () => number): string {
  // 进场以窄体为主，偶尔重型
  const r = rand();
  if (r < 0.5) return rand() < 0.5 ? 'A320' : 'B738';
  if (r < 0.62) return 'A321';
  if (r < 0.72) return 'E190';
  if (r < 0.8) return 'AT72';
  if (r < 0.9) return 'A333';
  if (r < 0.96) return 'B77W';
  return 'A388';
}

// ---------------------------------------------------------------------------
// 生成离场航班
// ---------------------------------------------------------------------------

export function spawnDeparture(
  id: number,
  airport: Airport,
  runwayIdent: string,
  sidName: string,
  now: number,
  rand: () => number,
): Aircraft | null {
  const rw = findRunway(airport, runwayIdent);
  if (!rw) return null;

  const sid = airport.sids[sidName] ?? [];

  const ac = createAircraft(
    {
      id,
      callsign: makeCallsign(rand() < 0.15 ? 'cargo' : 'pax', rand),
      type: pickDepartureType(rand),
      pos: { x: rw.threshold.x, y: rw.threshold.y, z: rw.elevation },
      heading: rw.heading,
      ias: 0,
      isDeparture: true,
      phase: 'GROUND',
    },
    now,
  );

  ac.route = expandProcedure(airport, sid);
  ac.routeIndex = 0;
  ac.intent.altitude = rw.elevation;
  ac.intent.speed = 0;
  ac.lastInstruction = `跑道${rw.ident}外等待`;
  return ac;
}

function pickDepartureType(rand: () => number): string {
  const r = rand();
  if (r < 0.45) return rand() < 0.5 ? 'A320' : 'B738';
  if (r < 0.6) return 'A321';
  if (r < 0.7) return 'B739';
  if (r < 0.78) return 'E190';
  if (r < 0.86) return 'A333';
  if (r < 0.93) return 'B77W';
  if (r < 0.97) return 'C560';
  return 'A388';
}

// ---------------------------------------------------------------------------
// 流率驱动
// ---------------------------------------------------------------------------

/**
 * 按流率推进生成累积器。返回值是本步新生成的飞机（可能为空数组）。
 */
export function updateTraffic(
  state: TrafficState,
  rates: TrafficRates,
  dt: number,
  now: number,
  airport: Airport,
  rand: () => number,
  activeCount: number,
  maxActive: number,
): Aircraft[] {
  const out: Aircraft[] = [];
  if (activeCount >= maxActive) return out;

  const starNames = Object.keys(airport.stars);
  const sidNames = Object.keys(airport.sids);
  const baseRunways = airport.runways;

  // ---- 进场 ----
  state.arrivalAcc += (rates.arrivals / 3600) * dt;
  while (state.arrivalAcc >= 1) {
    state.arrivalAcc -= 1;
    if (starNames.length === 0) break;
    const star = starNames[Math.floor(rand() * starNames.length)];
    const ac = spawnArrival(state.nextId, airport, star, now, rand);
    if (ac) {
      state.nextId++;
      state.spawned++;
      out.push(ac);
    }
  }

  // ---- 离场 ----
  state.departureAcc += (rates.departures / 3600) * dt;
  while (state.departureAcc >= 1) {
    state.departureAcc -= 1;
    if (baseRunways.length === 0 || sidNames.length === 0) break;
    const rw = baseRunways[Math.floor(rand() * baseRunways.length)];
    const sid = sidNames[Math.floor(rand() * sidNames.length)];
    const ac = spawnDeparture(state.nextId, airport, rw.ident, sid, now, rand);
    if (ac) {
      state.nextId++;
      state.spawned++;
      out.push(ac);
    }
  }

  return out;
}
