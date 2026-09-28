/**
 * 飞机实体：性能包线、指令执行、运动学推进、阶段状态机
 *
 * 中等拟真的取舍：不做气动/失速/配平，只约束"变化率"——
 * 转弯率由坡度推出、爬升/下降受机型包线限制、加减速有惯性。
 * 结果是不瞬移、不瞬转，玩家能预判，但不需要懂飞行力学。
 */

import type { Airport } from './airport';
import { findRunway, glidePathAltitude, localizerCapture } from './airport';
import type {
  Aircraft,
  AircraftIntent,
  AircraftPerformance,
  Command,
  FlightPhase,
  PendingCommand,
  WakeCategory,
} from './types';
import {
  angleDiff,
  clamp,
  deg2rad,
  fpm2ms,
  ft2m,
  G0,
  kt2ms,
  m2ft,
  ms2kt,
  nm2m,
  norm360,
  rad2deg,
} from './units';
import {
  add2,
  along,
  bearing,
  dist2,
  dot2,
  headingToVec,
  len2,
  scale2,
  sub2,
  type Vec2,
  type Vec3,
} from './vec';

/** 飞行员复诵 + 开始执行的平均延迟（秒） */
export const READBACK_DELAY = 2.5;
/** 高度死区（米），约 2 ft */
export const ALT_DEADBAND = 0.6;
/** 速度死区（米/秒），约 5 kt */
export const SPD_DEADBAND = 2.5;
/** 转弯率上限（度/秒）—— 防止低速时转弯过快 */
export const MAX_TURN_RATE = 4.0;
/** 下滑道截获窗口（米，高于剖面多少仍算"可截获"） */
const SLOPE_INTERCEPT = ft2m(1000);
/** 标准下降率参考（米/秒），约 1500 fpm */
export const DEFAULT_DESCENT_RATE = fpm2ms(1500);
/** 抬前轮速度：低于此速不能离地 */
const ROTATE_SPEED = kt2ms(140);
/** 起飞指令目标速度 */
const TAKEOFF_SPEED = kt2ms(152);
/** 地面滑跑加速度（约 2.3 m/s²，起飞滑跑约 30 秒） */
const GROUND_ACCEL = kt2ms(4.5);
/** 地面减速率 */
const GROUND_DECEL = kt2ms(6);

/** 风：direction 为来向（气象习惯），speed 单位 m/s */
export interface Wind {
  direction: number;
  speed: number;
}

export interface SimContext {
  time: number;
  dt: number;
  airport: Airport;
  wind: Wind;
  /** 指令真正生效时回调（用于世界层生成飞行员复诵的电台记录） */
  onExecuted?: (ac: Aircraft, cmd: Command) => void;
}

interface PerfInput {
  climbFpm: number;
  descentFpm: number;
  accelKt: number;
  decelKt: number;
  minKt: number;
  maxKt: number;
  approachKt: number;
  bank?: number;
}

function perf(o: PerfInput): AircraftPerformance {
  return {
    climbRate: fpm2ms(o.climbFpm),
    descentRate: fpm2ms(o.descentFpm),
    accel: kt2ms(o.accelKt),
    decel: kt2ms(o.decelKt),
    minSpeed: kt2ms(o.minKt),
    maxSpeed: kt2ms(o.maxKt),
    approachSpeed: kt2ms(o.approachKt),
    maxBank: o.bank ?? 25,
  };
}

export interface AircraftTypeSpec {
  wake: WakeCategory;
  perf: AircraftPerformance;
  /** 典型巡航高度（英尺） */
  cruiseAltFt: number;
  /** 是否常见 */
  weight: number;
}

/** 机型性能表 —— 数值取公开的典型值，不追求型号精确 */
export const AIRCRAFT_TYPES: Record<string, AircraftTypeSpec> = {
  A320: {
    wake: 'M',
    weight: 20,
    cruiseAltFt: 35000,
    perf: perf({ climbFpm: 2500, descentFpm: 2000, accelKt: 1.2, decelKt: 1.2, minKt: 130, maxKt: 340, approachKt: 135 }),
  },
  A321: {
    wake: 'M',
    weight: 12,
    cruiseAltFt: 35000,
    perf: perf({ climbFpm: 2400, descentFpm: 2000, accelKt: 1.1, decelKt: 1.1, minKt: 135, maxKt: 340, approachKt: 140 }),
  },
  B738: {
    wake: 'M',
    weight: 20,
    cruiseAltFt: 37000,
    perf: perf({ climbFpm: 2550, descentFpm: 2100, accelKt: 1.2, decelKt: 1.2, minKt: 132, maxKt: 340, approachKt: 138 }),
  },
  B739: {
    wake: 'M',
    weight: 8,
    cruiseAltFt: 37000,
    perf: perf({ climbFpm: 2450, descentFpm: 2050, accelKt: 1.1, decelKt: 1.1, minKt: 136, maxKt: 340, approachKt: 142 }),
  },
  A333: {
    wake: 'H',
    weight: 8,
    cruiseAltFt: 37000,
    perf: perf({ climbFpm: 2200, descentFpm: 2000, accelKt: 0.9, decelKt: 0.9, minKt: 140, maxKt: 330, approachKt: 143 }),
  },
  B77W: {
    wake: 'H',
    weight: 7,
    cruiseAltFt: 35000,
    perf: perf({ climbFpm: 2200, descentFpm: 2000, accelKt: 0.9, decelKt: 0.9, minKt: 145, maxKt: 330, approachKt: 148 }),
  },
  A388: {
    wake: 'J',
    weight: 3,
    cruiseAltFt: 35000,
    perf: perf({ climbFpm: 2000, descentFpm: 1800, accelKt: 0.8, decelKt: 0.8, minKt: 150, maxKt: 320, approachKt: 152 }),
  },
  E190: {
    wake: 'M',
    weight: 10,
    cruiseAltFt: 33000,
    perf: perf({ climbFpm: 2600, descentFpm: 2200, accelKt: 1.3, decelKt: 1.3, minKt: 125, maxKt: 330, approachKt: 128 }),
  },
  AT72: {
    wake: 'M',
    weight: 6,
    cruiseAltFt: 23000,
    perf: perf({ climbFpm: 1500, descentFpm: 1500, accelKt: 1.0, decelKt: 1.0, minKt: 105, maxKt: 250, approachKt: 112 }),
  },
  C560: {
    wake: 'L',
    weight: 5,
    cruiseAltFt: 39000,
    perf: perf({ climbFpm: 3000, descentFpm: 2500, accelKt: 1.5, decelKt: 1.5, minKt: 110, maxKt: 320, approachKt: 118 }),
  },
};

export const TYPE_KEYS = Object.keys(AIRCRAFT_TYPES);

/** 按权重随机取一个机型 */
export function randomType(rand: () => number = Math.random): string {
  const total = TYPE_KEYS.reduce((s, k) => s + AIRCRAFT_TYPES[k].weight, 0);
  let r = rand() * total;
  for (const k of TYPE_KEYS) {
    r -= AIRCRAFT_TYPES[k].weight;
    if (r <= 0) return k;
  }
  return 'A320';
}

/** 地速（米/秒）：空速向量 + 风向量 */
export function groundSpeedVec(ac: Aircraft, wind: Wind): Vec2 {
  const air = scale2(headingToVec(ac.heading), ac.ias);
  // 风向是"来向"，气流去向为 +180
  const flow = scale2(headingToVec(norm360(wind.direction + 180)), wind.speed);
  return add2(air, flow);
}

export function groundSpeed(ac: Aircraft, wind: Wind): number {
  return len2(groundSpeedVec(ac, wind));
}

/** 由坡度与真空速推出最大转弯率（度/秒） */
export function turnRateFor(ac: Aircraft): number {
  const bank = deg2rad(ac.perf.maxBank);
  const rate = rad2deg((G0 * Math.tan(bank)) / Math.max(ac.ias, 1)); // deg/s
  return Math.min(rate, MAX_TURN_RATE);
}

/** 当前转弯半径（米） */
export function turnRadius(ac: Aircraft): number {
  const bank = deg2rad(ac.perf.maxBank);
  return (ac.ias * ac.ias) / (G0 * Math.tan(bank));
}

/** 创建一架飞机 */
export interface SpawnOptions {
  id: number;
  callsign: string;
  type: string;
  pos: Vec3;
  heading: number;
  ias: number;
  isDeparture?: boolean;
  phase?: FlightPhase;
}

export function createAircraft(o: SpawnOptions, now: number): Aircraft {
  const spec = AIRCRAFT_TYPES[o.type] ?? AIRCRAFT_TYPES.A320;
  const intent: AircraftIntent = {
    heading: null,
    altitude: o.pos.z,
    speed: o.ias,
    speedLocked: false,
    expedite: false,
  };
  return {
    id: o.id,
    callsign: o.callsign,
    type: o.type,
    wake: spec.wake,
    isDeparture: o.isDeparture ?? false,
    pos: { ...o.pos },
    heading: norm360(o.heading),
    ias: o.ias,
    vs: 0,
    turnRate: 0,
    phase: o.phase ?? (o.isDeparture ? 'GROUND' : 'CRUISE'),
    perf: spec.perf,
    intent,
    pending: [],
    lastInstruction: '',
    route: [],
    routeIndex: 0,
    approach: null,
    assignedRunway: null,
    holding: null,
    trail: [],
    lastTrailTime: now,
    age: 0,
    hasBeenControlled: false,
    penaltyFlags: new Set<string>(),
    landedAt: null,
  };
}

/** 下达指令（进入复诵队列） */
export function issueCommand(ac: Aircraft, cmd: Command, now: number, delay = READBACK_DELAY): void {
  const family = commandFamily(cmd);
  const text = describeCommand(cmd, ac);
  // 连点同一指令时保持队列里那条原样生效 —— 重新排队会把 executeAt 一次次推后，
  // 指令永远执行不了
  if (ac.pending.some((p) => commandFamily(p.command) === family && describeCommand(p.command, ac) === text)) {
    ac.lastInstruction = text;
    return;
  }
  // 同类指令只保留最新的，避免玩家连点造成指令堆积
  ac.pending = ac.pending.filter((p) => commandFamily(p.command) !== family);
  ac.pending.push({ executeAt: now + delay, command: cmd, readback: true });
  ac.lastInstruction = text;
}

function commandFamily(c: Command): string {
  switch (c.kind) {
    case 'heading':
    case 'turnLeft':
    case 'turnRight':
    case 'direct':
      return 'lateral';
    case 'altitude':
      return 'vertical';
    case 'speed':
    case 'resumeNormalSpeed':
      return 'speed';
    default:
      return c.kind;
  }
}

/** 指令的无线电用语（管制指令与飞行员复诵共用同一份措辞） */
export function describeCommand(c: Command, ac?: Aircraft): string {
  switch (c.kind) {
    case 'heading':
      return `航向${String(Math.round(norm360(c.value))).padStart(3, '0')}`;
    case 'turnLeft':
      return `左转航向${String(Math.round(norm360(c.value))).padStart(3, '0')}`;
    case 'turnRight':
      return `右转航向${String(Math.round(norm360(c.value))).padStart(3, '0')}`;
    case 'altitude':
      return `高度${String(Math.round(m2ft(c.value) / 100) * 100)}`;
    case 'speed':
      return `速度${Math.round(ms2kt(c.value))}节`;
    case 'direct':
      return `直飞${c.waypoint}`;
    case 'clearedApproach':
      return `可以ILS跑道${c.runway}进近`;
    case 'goAround':
      return '复飞';
    case 'hold':
      return `${c.fix}等待`;
    case 'expedite':
      // 同一条指令在爬升和下降里是两句话，别一律念成"加速下降"
      return ac && ac.intent.altitude >= ac.pos.z ? '加速爬升' : '加速下降';
    case 'resumeNormalSpeed':
      return '恢复正常速度';
    case 'takeoff':
      return '可以起飞';
  }
}

/** 把到期的指令应用到意图上 */
function applyPending(ac: Aircraft, ctx: SimContext): void {
  if (ac.pending.length === 0) return;
  const still: PendingCommand[] = [];
  for (const p of ac.pending) {
    if (p.executeAt > ctx.time) {
      still.push(p);
      continue;
    }
    applyCommand(ac, p.command, ctx);
    ctx.onExecuted?.(ac, p.command);
  }
  ac.pending = still;
}

function applyCommand(ac: Aircraft, cmd: Command, ctx: SimContext): void {
  switch (cmd.kind) {
    case 'heading':
    case 'turnLeft':
    case 'turnRight':
      ac.intent.heading = norm360(cmd.value);
      // 脱离航路点跟随
      ac.route = [];
      ac.routeIndex = 0;
      ac.holding = null;
      if (ac.phase === 'APPROACH') ac.approach = null;
      break;
    case 'altitude':
      ac.intent.altitude = cmd.value;
      // 新的高度层就是新计划，别再沿用"加速"
      ac.intent.expedite = false;
      break;
    case 'speed':
      ac.intent.speed = cmd.value;
      ac.intent.speedLocked = true;
      break;
    case 'resumeNormalSpeed':
      ac.intent.speedLocked = false;
      break;
    case 'expedite':
      // 只加"用满变化率"的旗标，不动目标高度：
      // 旧实现把目标高度压成当前高度，下降时毫无作用、爬升时反而改平
      ac.intent.expedite = true;
      break;
    case 'takeoff':
      if (ac.phase === 'GROUND') {
        ac.phase = 'TAKEOFF';
        ac.intent.speed = TAKEOFF_SPEED;
        ac.intent.altitude = ft2m(6000);
        ac.hasBeenControlled = true;
      }
      break;
    case 'direct': {
      const wp = ctx.airport.waypoints.find((w) => w.name.toUpperCase() === cmd.waypoint.toUpperCase());
      if (wp) {
        ac.route = [wp.pos];
        ac.routeIndex = 0;
        ac.intent.heading = null;
        ac.holding = null;
      }
      break;
    }
    case 'clearedApproach': {
      const prevGoArounds = ac.approach?.goArounds ?? 0;
      ac.assignedRunway = cmd.runway;
      ac.intent.heading = null;
      ac.holding = null;
      // 清进近后飞行员会自行减到进近速度；玩家显式锁过速度则不覆盖
      if (!ac.intent.speedLocked) {
        ac.intent.speed = ac.perf.approachSpeed * 1.1;
      }
      ac.approach = {
        runway: cmd.runway,
        established: false,
        localizerCaptured: false,
        slopeCaptured: false,
        goArounds: prevGoArounds,
      };
      ac.phase = 'APPROACH';
      break;
    }
    case 'goAround':
      triggerGoAround(ac);
      break;
    case 'hold': {
      const wp = ctx.airport.waypoints.find((w) => w.name.toUpperCase() === cmd.fix.toUpperCase());
      if (wp) {
        ac.holding = {
          fix: wp.name,
          center: wp.pos,
          inboundCourse: ac.heading,
          turnDirection: 'R',
          // 标准等待腿长约 1 分钟航程
          legLength: Math.max(groundSpeed(ac, ctx.wind) * 60, 3000),
          entered: false,
          segment: 'INBOUND',
        };
        ac.intent.heading = null;
        ac.approach = null;
      }
      break;
    }
  }
}

/** 触发复飞：拉起、增速、脱离进近 */
export function triggerGoAround(ac: Aircraft): void {
  ac.phase = 'GO_AROUND';
  ac.approach = null;
  ac.assignedRunway = null;
  ac.intent.altitude = Math.max(ac.intent.altitude, ac.pos.z + 900);
  ac.intent.heading = norm360(ac.heading + 15);
  ac.route = [];
  ac.routeIndex = 0;
}

/** 每步推进一架飞机 */
export function updateAircraft(ac: Aircraft, ctx: SimContext): void {
  const dt = ctx.dt;
  ac.age += dt;

  // 落地后：滑跑减速，不再响应任何指令
  if (ac.phase === 'LANDED') {
    ac.vs = 0;
    ac.ias = Math.max(0, ac.ias - GROUND_DECEL * dt);
    const gs = groundSpeedVec(ac, ctx.wind);
    ac.pos.x += gs.x * dt;
    ac.pos.y += gs.y * dt;
    ac.turnRate = 0;
    return;
  }

  applyPending(ac, ctx);

  // 进近状态优先接管水平与垂直引导
  const onApproach = ac.approach !== null && ac.assignedRunway !== null;
  let targetHeading: number;

  if (ac.phase === 'GROUND' || ac.phase === 'TAKEOFF') {
    // 跑道约束：地面等待与起飞滑跑阶段不转向（否则飞机会原地/滑跑中
    // 朝 SID 航路点拐头），升空转 CLIMB 后才交给正常引导链
    targetHeading = ac.heading;
  } else if (onApproach) {
    targetHeading = steerApproach(ac, ctx);
  } else if (ac.holding) {
    targetHeading = steerHolding(ac);
  } else if (ac.intent.heading !== null) {
    targetHeading = ac.intent.heading;
  } else {
    targetHeading = steerRoute(ac, ctx);
  }

  applyTurn(ac, targetHeading, dt);
  applyVertical(ac, ctx);
  applySpeed(ac, ctx);
  integrate(ac, ctx);
  updatePhase(ac, ctx);
}

function applyTurn(ac: Aircraft, targetHeading: number, dt: number): void {
  const maxTurn = turnRateFor(ac) * dt;
  const diff = angleDiff(targetHeading, ac.heading);
  const applied = clamp(diff, -maxTurn, maxTurn);
  ac.heading = norm360(ac.heading + applied);
  ac.turnRate = dt > 0 ? applied / dt : 0;
}

function applyVertical(ac: Aircraft, ctx: SimContext): void {
  // 地面滑跑：速度不足以离地，垂直速度强制为零
  if (ac.phase === 'GROUND' || (ac.phase === 'TAKEOFF' && ac.ias < ROTATE_SPEED)) {
    ac.vs = 0;
    return;
  }

  const remaining = ac.intent.altitude - ac.pos.z;
  let targetVs = 0;

  // 提前退出"加速"：全速率冲到目标高度上会来回过冲（每帧 0.7 m 的锯齿，
  // 阶段位在 CLIMB/DESCENT 之间抖），留 500 ft 交给常规收敛逻辑收尾
  if (ac.intent.expedite && Math.abs(remaining) < ft2m(500)) ac.intent.expedite = false;

  if (Math.abs(remaining) > ALT_DEADBAND) {
    // 加速爬升/下降允许超过"标准率"，否则这条指令等于没按 ——
    // sim 平时就已经在用满 perf 变化率了
    if (remaining > 0) {
      targetVs = ac.perf.climbRate * (ac.intent.expedite ? 1.2 : 1);
    } else {
      targetVs = -ac.perf.descentRate * (ac.intent.expedite ? 1.35 : 1);
    }
    // 接近目标高度时收敛，避免过冲；"加速"就是叫它别收敛
    if (!ac.intent.expedite) {
      const closing = remaining / 4; // 约 4 秒收敛
      if (Math.abs(closing) < Math.abs(targetVs)) targetVs = closing;
    }
  }

  // 进近时跟随下滑道：所需下降率（前馈）+ 偏差修正（比例）
  // 只用比例控制会有稳态误差，飞机一路偏高，最后冲过跑道入口
  // 注意：必须已截获航向道才跟下滑道 —— 否则横向偏离时轴向距离很小，
  //       会算出接近地面的下滑道高度，把飞机按到地上去
  if (ac.approach) {
    ac.approach.slopeCaptured = false;
    if (ac.approach.localizerCaptured && ac.assignedRunway) {
      const rw = findRunway(ctx.airport, ac.assignedRunway);
      if (rw) {
        // 下滑道高度按"沿跑道方向的距离"算（与真实 ILS 一致）。
        // 用斜距会在横向偏离时高估距离，导致下降拖慢、冲过入口。
        const u = headingToVec(rw.heading);
        const axial =
          (ac.pos.x - rw.threshold.x) * u.x + (ac.pos.y - rw.threshold.y) * u.y;
        const d = Math.abs(axial);
        if (d < 30000 && d > 30) {
          const gpAlt = glidePathAltitude(rw, d);
          const diff = gpAlt - ac.pos.z;
          // 截获窗口：还差得远时保持玩家给的高度继续下降，别去追剖面。
          // 进场机被清进来时常常还在 FL240，按比例追会一路用满下降率仍追不上，
          // 最后带着两万英尺从跑道上空飞过。
          if (ac.pos.z - gpAlt <= SLOPE_INTERCEPT) {
            const gs = groundSpeed(ac, ctx.wind);
            // 3° 下滑道在当前位置所需的下降率
            const requiredVs = -gs * Math.tan(deg2rad(rw.glideslope));
            // 偏高时压下降、偏低时允许用满爬升率把机头抬回剖面：
            // 修正量一小，"低了一档"就永远补不回来，只能在跑道上空复飞
            const correction = clamp(diff * 0.18, -4, ac.perf.climbRate);
            targetVs = clamp(requiredVs + correction, -ac.perf.descentRate, ac.perf.climbRate);
            ac.approach.slopeCaptured = true;
          }
        }
      }
    }
  }

  const maxDelta = (targetVs > ac.vs ? ac.perf.climbRate : ac.perf.descentRate) * ctx.dt * 0.9;
  if (Math.abs(targetVs - ac.vs) <= maxDelta) {
    ac.vs = targetVs;
  } else {
    ac.vs += Math.sign(targetVs - ac.vs) * maxDelta;
  }
}

function applySpeed(ac: Aircraft, ctx: SimContext): void {
  // 建立下滑道后飞行员把速度收到进近速度：玩家锁着 210 节过跑道头是落不了地的，
  // 只会白送一次复飞 —— 真实管制里的速度限制不会要求以不安全速度落地
  if (ac.approach?.slopeCaptured && ac.ias > ac.perf.approachSpeed * 1.1) {
    ac.intent.speed = ac.perf.approachSpeed * 1.1;
    ac.intent.speedLocked = false;
  }
  const onGround = ac.phase === 'GROUND' || ac.phase === 'TAKEOFF';
  // 地面允许停机（速度 0），空中受最小速度约束
  const lo = onGround ? 0 : ac.perf.minSpeed;
  const target = clamp(ac.intent.speed, lo, ac.perf.maxSpeed);
  const diff = target - ac.ias;
  const rate =
    diff > 0
      ? onGround
        ? GROUND_ACCEL
        : ac.perf.accel
      : onGround
        ? GROUND_DECEL
        : ac.perf.decel;
  const maxDelta = rate * ctx.dt;
  if (Math.abs(diff) <= maxDelta) {
    ac.ias = target;
  } else {
    ac.ias += Math.sign(diff) * maxDelta;
  }
}

function integrate(ac: Aircraft, ctx: SimContext): void {
  // 地面阶段（等待/滑跑/落地滑跑）机轮约束在跑道方向：不随风漂移，
  // 否则侧风会把滑跑中的飞机吹出跑道中线
  const onGround =
    ac.phase === 'GROUND' || ac.phase === 'TAKEOFF' || ac.phase === 'LANDED';
  const gs = onGround
    ? scale2(headingToVec(ac.heading), ac.ias)
    : groundSpeedVec(ac, ctx.wind);
  ac.pos.x += gs.x * ctx.dt;
  ac.pos.y += gs.y * ctx.dt;
  ac.pos.z += ac.vs * ctx.dt;
  if (ac.pos.z < 0) {
    ac.pos.z = 0;
    ac.vs = 0;
  }
}

/** 提前拐向下一航点的转弯余量（转弯半径倍数） */
const LEG_TURN_AHEAD = 1.5;

/**
 * 航路点跟随。索引只增不减，推进判据用"是否已越过该点的最近点（abeam）"——
 * 即地速向量与"指向该点向量"的点积转负。
 *
 * 这里曾经是死循环的源头：提前拐向下一点的触发半径（约 2.5 NM）远大于
 * 到点判定阈值（约 0.15 NM），于是"拐向下一点"会让距当前点的距离重新变大，
 * 条件失效又切回当前点，飞机绕着第一个航路点无限盘旋、航路永不推进。
 */
function steerRoute(ac: Aircraft, ctx: SimContext): number {
  if (ac.routeIndex >= ac.route.length) return ac.heading;
  const here: Vec2 = { x: ac.pos.x, y: ac.pos.y };
  const cur = ac.route[ac.routeIndex];
  const d = dist2(here, cur);
  const gs = groundSpeedVec(ac, ctx.wind);

  const next = ac.route[ac.routeIndex + 1];
  // 来不及精确压点：按转弯提前量直接拐向下一段，并就此认定当前点已过
  if (next && d <= turnRadius(ac) * LEG_TURN_AHEAD) {
    ac.routeIndex++;
    return bearing(here, next);
  }

  // 已在远离当前点（越过切点）即推进，抗风且不回退
  if (len2(gs) > 1 && dot2(sub2(cur, here), gs) <= 0) {
    ac.routeIndex++;
    if (ac.routeIndex >= ac.route.length) return ac.heading;
    return bearing(here, ac.route[ac.routeIndex]);
  }

  return bearing(here, cur);
}

/**
 * 等待航线：航向驱动的标准跑道形
 *   INBOUND 直线段 → TURN1 半圆 → OUTBOUND 直线段 → TURN2 半圆 → 循环
 * 两端半圆只给出"继续转"的相对航向，实际转弯率由飞机自身包线决定。
 */
function steerHolding(ac: Aircraft): number {
  const h = ac.holding;
  if (!h) return ac.heading;

  const here: Vec2 = { x: ac.pos.x, y: ac.pos.y };
  const u = headingToVec(h.inboundCourse);
  const rel = { x: here.x - h.center.x, y: here.y - h.center.y };
  /** 沿入航轴的位置：正 = 已越过等待点（入航方向前方） */
  const s = rel.x * u.x + rel.y * u.y;

  const inbound = norm360(h.inboundCourse);
  const outbound = norm360(inbound + 180);
  const dir = h.turnDirection === 'R' ? 1 : -1;
  const half = h.legLength / 2;

  if (!h.entered) {
    const d = dist2(here, h.center);
    if (d < Math.max(turnRadius(ac) * 2, 1500)) {
      h.entered = true;
      h.segment = 'INBOUND';
    } else {
      return bearing(here, h.center);
    }
  }

  switch (h.segment) {
    case 'INBOUND':
      if (s >= half) h.segment = 'TURN1';
      return inbound;
    case 'TURN1':
      // 半圆转完即切出航边
      if (Math.abs(angleDiff(outbound, ac.heading)) < 20) h.segment = 'OUTBOUND';
      return norm360(ac.heading + dir * 30);
    case 'OUTBOUND':
      if (s <= -half) h.segment = 'TURN2';
      return outbound;
    case 'TURN2':
      if (Math.abs(angleDiff(inbound, ac.heading)) < 20) h.segment = 'INBOUND';
      return norm360(ac.heading + dir * 30);
    default:
      return inbound;
  }
}

/** 进近切入搜索半径：12 nm */
const LOCALIZER_RANGE = 22224;

/**
 * 进近引导
 *
 * 已截获：按"从入口看飞机的方位偏差"修正航向 —— 这是真实 ILS 航向道的行为，
 *   横向偏差在近处对应更大的角度偏差，因此天然越近越灵敏，且是连续的自稳定反馈。
 *   之前用"横向偏移 × 固定增益"的写法要么纠不回来（增益太小）、要么来回振荡（增益太大）。
 *
 * 未截获：朝中心线上"飞机前方 2 NM"的点飞，斜向收敛到延长线。
 */
function steerApproach(ac: Aircraft, ctx: SimContext): number {
  const runway = findRunway(ctx.airport, ac.assignedRunway!);
  if (!runway) return ac.heading;

  const here: Vec2 = { x: ac.pos.x, y: ac.pos.y };
  // 迟滞：已建立则放宽容差，避免捕获状态在边界反复抖动导致航向来回摆
  const established = ac.approach?.established ?? false;
  const cap = localizerCapture(
    ac.pos,
    ac.heading,
    runway,
    established ? nm2m(3.0) : nm2m(1.5),
    established ? 80 : 60,
  );
  if (ac.approach) {
    ac.approach.localizerCaptured = cap.captured;
    if (cap.captured) ac.approach.established = true;
  }

  if (cap.captured) {
    // 纯追踪：目标点固定在跑道中心线上、位于飞机前方。
    // 比"角度偏差 × 增益"稳得多 —— 天然补偿风引起的偏流（几何自洽），
    // 且航向随位置连续变化，不会像比例反馈那样在捕获边界来回振荡。
    const u = headingToVec(runway.heading);
    const axial =
      (ac.pos.x - runway.threshold.x) * u.x + (ac.pos.y - runway.threshold.y) * u.y;
    const lookAhead = clamp(Math.abs(axial) * 0.3, nm2m(0.6), nm2m(3));
    const targetAxial = axial + lookAhead;
    const aim: Vec2 = {
      x: runway.threshold.x + u.x * targetAxial,
      y: runway.threshold.y + u.y * targetAxial,
    };
    return bearing(here, aim);
  }

  // 未截获：斜向收敛到中心线
  const back = norm360(runway.heading + 180);
  const aimDistance = Math.min(LOCALIZER_RANGE, Math.max(cap.distance - nm2m(2), nm2m(1)));
  const aim = along(runway.threshold, back, aimDistance);
  return bearing(here, aim);
}

/** 阶段状态机 */
function updatePhase(ac: Aircraft, ctx: SimContext): void {
  const agl = ac.pos.z - ctx.airport.elevation;

  if (ac.phase === 'LANDED') return;

  if (ac.approach) {
    ac.phase = 'APPROACH';
    // 接地判定
    if (agl < 15 && ac.ias < ac.perf.approachSpeed * 1.25) {
      ac.phase = 'LANDED';
      ac.vs = 0;
      ac.intent.speed = 0;
      return;
    }
    // 飞越跑道头还没落地 = 进近失败，自动复飞。
    // 不接管它会绕着入口无限盘旋（跑道后方航向道失锁，纯追踪又把目标点拖到自己
    // 身后），既不离开扇区也不再受控，白白吃掉了交通名额。
    const rw = findRunway(ctx.airport, ac.approach.runway);
    if (rw) {
      const u = headingToVec(rw.heading);
      const axial = (ac.pos.x - rw.threshold.x) * u.x + (ac.pos.y - rw.threshold.y) * u.y;
      if (axial > 0) triggerGoAround(ac);
    }
    return;
  }

  if (ac.phase === 'GO_AROUND') {
    if (ac.pos.z > ctx.airport.elevation + 600) ac.phase = 'CLIMB';
    return;
  }

  if (ac.isDeparture) {
    // 地面等待许可：只有收到起飞指令才离开 GROUND
    if (ac.phase === 'GROUND') return;
    // 起飞滑跑：离地足够高才转为爬升阶段
    if (ac.phase === 'TAKEOFF') {
      if (agl > 300) ac.phase = 'CLIMB';
      return;
    }
  }

  if (ac.vs > 1.5) ac.phase = 'CLIMB';
  else if (ac.vs < -1.5) ac.phase = 'DESCENT';
  else if (Math.abs(ac.pos.z - ac.intent.altitude) < 30) ac.phase = 'CRUISE';
}
