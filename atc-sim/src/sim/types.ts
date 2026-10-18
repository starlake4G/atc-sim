import type { Vec2 } from "./vec";
import type { RunwayPlanEntry } from "./planning";

export type Seat = "GND" | "TWR" | "APP" | "SYS";
export type Wake = "L" | "M" | "H";
export type ControlMode = "assisted" | "standard";
export type SafetyMode = "guarded" | "consequence";
export type Controller = "GND" | "TWR" | "APP" | "DEP";

export interface AircraftTypeDef {
  id: string;
  name: string;
  wake: Wake;
  /** 进近速度（kt） */
  vappKt: number;
  /** 抬轮速度（kt） */
  rotationKt: number;
  climbFpm: number;
  descentFpm: number;
  accelKt: number;
  decelKt: number;
  /** 3D 用：机身长度（米）与外形类别 */
  lengthM: number;
  shape: "narrow" | "wide" | "turboprop";
}

export type NodeKind = "taxi" | "stand" | "apron" | "exit" | "holding" | "lineup";

export interface TaxiNodeDef {
  id: string;
  pos: Vec2;
  kind: NodeKind;
  /** 地面上显示的短标签，例如 "A3" */
  label?: string;
}

export interface TaxiEdgeDef {
  a: string;
  b: string;
  /** 限速（kt），默认 15 */
  maxKt?: number;
  oneWay?: boolean;
  traffic?: "arr" | "dep";
}

export interface StandDef {
  id: string;
  /** 机位在滑行图上对应的节点 */
  node: string;
  pos: Vec2;
  /** 停放时的机头朝向 */
  hdg: number;
  size: "S" | "M" | "L";
}

export interface RunwayExitDef {
  /** 脱离口名称，例如 "A3" */
  name: string;
  /** 距跑道入口（threshold）沿跑道方向的距离（米） */
  atM: number;
  /** 脱离后进入的滑行节点 */
  node: string;
  highSpeed: boolean;
}

export interface RunwayDef {
  /** 使用方向，例如 "27" */
  id: string;
  hdg: number;
  lengthM: number;
  widthM: number;
  /** 入口（接地带起点）坐标 */
  threshold: Vec2;
  /** 跑道另一端坐标 */
  end: Vec2;
  exits: RunwayExitDef[];
}

export interface FixDef {
  name: string;
  pos: Vec2;
}

export interface AirportDef {
  id: string;
  icao: string;
  name: string;
  /** 标高（米） */
  elevationM: number;
  /** 塔台位置与高度 */
  tower: { pos: Vec2; heightM: number };
  runways: RunwayDef[];
  nodes: TaxiNodeDef[];
  edges: TaxiEdgeDef[];
  stands: StandDef[];
  fixes: FixDef[];
  /** 简化进场程序：入口点 → 起始进近定位点 */
  arrival: { entryFix: string; iafFix: string };
  /** 简化离场程序：起飞后航路点（按顺序） */
  departure: string[];
}

export interface FlightPlanDef {
  callsign: string;
  airline: string;
  typeId: string;
  kind: "arr" | "dep";
  /** 相对班次开始的分钟数 */
  atMin: number;
  /** 离场机位（arr 会分配到达机位） */
  standId?: string;
  /** 挑战关入口与航路；省略时使用机场默认进场。 */
  entryFix?: string;
  arrivalRoute?: string[];
  initialAltFt?: number;
  initialSpeedKt?: number;
}

export interface LevelDef {
  id: string;
  name: string;
  airportId: string;
  /** 班次开始时的钟点（分钟，从 0 点起算） */
  startClockMin: number;
  durationMin: number;
  /** 使用跑道（AirportDef.runways[].id） */
  runwayId: string;
  /** 风：来向与风速 */
  wind: { dirDeg: number; speedKt: number };
  /** 同时在场飞机上限 */
  maxAircraft: number;
  /** 进度门槛：完成多少架次算过关（评级用） */
  targetMovements: number;
  flights: FlightPlanDef[];
  description?: string;
  lesson?: boolean;
  /** 相同种子对应相同流量计划，成绩按种子分别保存。 */
  seed?: string;
  /** 可预告、可恢复的固定运行事件；相同关卡与操作可精确回放。 */
  operations?: OperationDef[];
}

export interface WeatherDef { dirDeg: number; speedKt: number; gustKt?: number }
export type OperationDef = { id: string; name: string; announceMin: number; atMin: number; durationSec: number } & (
  { kind: "inspection" } | { kind: "weather"; wind: WeatherDef }
);
export interface OperationState {
  id: string;
  name: string;
  kind: OperationDef["kind"];
  stage: "scheduled" | "announced" | "pending" | "active" | "completed";
  plannedAt: number;
  durationSec: number;
  startedAt: number | null;
  endsAt: number | null;
  wind?: WeatherDef;
}

export type Phase =
  | "parked"
  | "pushback"
  | "taxi_ready"
  | "taxi_out"
  | "hold_short"
  | "lineup"
  | "takeoff"
  | "departure"
  | "arrival"
  | "approach"
  | "landing"
  | "taxi_in"
  | "done";

export interface Aircraft {
  id: string;
  callsign: string;
  airline: string;
  typeId: string;
  kind: "arr" | "dep";
  pos: Vec2;
  altM: number;
  /** 航向（度） */
  hdg: number;
  /** 地速（m/s） */
  gs: number;
  /** 升降率（m/s，正为爬升） */
  vs: number;
  phase: Phase;
  controller: Controller;
  pendingClearance: PendingClearance | null;
  pendingHandoff: { controller: Controller; confirmedAt: number } | null;
  touchdownAt: number | null;
  airHolding: boolean;
  groundNodeId: string | null;
  groundGoal: "runway" | "stand" | "clear" | null;
  blockedBy: string | null;
  scheduledMovementAt: number;
  /** 已许可高度（米），null = 保持当前 */
  clearedAltM: number | null;
  /** 已许可航向，null = 无 */
  clearedHdg: number | null;
  /** 目标速度（m/s） */
  targetGs: number;
  expedite: boolean;
  /** 当前航路（地面滑行 / 进场程序 / 离场程序） */
  route: Route | null;
  /** 进近状态 */
  approach: { runwayId: string; established: boolean } | null;
  landCleared: boolean;
  lineupCleared: boolean;
  exitNodeId: string | null;
  standId: string | null;
  /** 主动停止（等待指令） */
  holding: boolean;
  /** 已给"可以起飞"但还在进跑道：滑到位就直接开始滑跑 */
  takeoffPending: boolean;
  missedApproachNotified: boolean;
  /** 机长（米），3D 与间隔用 */
  lengthM: number;
  /** 防呆：长时间没有位移则强制推进航路，避免绕圈 */
  stuckTimer: number;
  lastPos: Vec2;
  /** 停靠后自动移除的时刻（秒），null 表示不移除 */
  removeAt: number | null;
  spawnedAt: number;
  /** 已计入统计，避免重复计分 */
  scored: { landed: boolean; departed: boolean };
}

export interface Route {
  /** 已走过的最小弧长，保证单调前进 */
  minS: number;
  total: number;
  points: Vec2[];
  follow(pos: Vec2, lookaheadM: number): { target: Vec2; s: number; finished: boolean; total: number };
  pointAt(s: number): Vec2;
  remaining(pos: Vec2): number;
}

export type Command =
  | { kind: "heading"; hdg: number }
  | { kind: "altitude"; altFt: number; expedite?: boolean }
  | { kind: "speed"; kt: number }
  | { kind: "direct"; fix: string }
  | { kind: "approach"; runwayId: string }
  | { kind: "goAround" }
  | { kind: "land" }
  | { kind: "cancelLanding" }
  | { kind: "lineup" }
  | { kind: "takeoff" }
  | { kind: "pushback"; hdg: number }
  | { kind: "hold" }
  | { kind: "resume" }
  | { kind: "exit"; nodeId: string }
  | { kind: "taxi"; route: "main" | "bypass"; via?: string[] }
  | { kind: "handoff"; controller: Controller }
  | { kind: "holdAir" };

export interface CommandOption {
  key: string;
  label: string;
  /** 指令条分组：引导 / 高度 / 速度 / 进近 / 地面 / 跑道 */
  group: string;
  command: Command;
  tone?: "primary" | "danger" | "muted";
  disabledReason?: string;
  warning?: string;
}

export type CommandResult =
  | { ok: true; radio: string; seat: Seat; warning?: string }
  | { ok: false; reason: string };

export interface RadioLine {
  id: number;
  t: number;
  seat: Seat | "PILOT";
  callsign: string;
  text: string;
  tone: "cmd" | "readback" | "event" | "warn";
  endsAt?: number;
  channel?: Seat;
}

export interface PendingClearance {
  command: Command;
  startsAt: number;
  readbackAt: number;
  commitAt: number;
  seat: Seat;
  radio: string;
  readback: string;
  warning?: string;
  sent: boolean;
  pilotSent: boolean;
}

export interface SimState {
  time: number;
  status: "running" | "finished" | "failed";
  safetyMode: SafetyMode;
  failureReason: string | null;
  aircraft: Aircraft[];
  radio: RadioLine[];
  selectedId: string | null;
  score: {
    landings: number;
    takeoffs: number;
    violations: number;
    goArounds: number;
    points: number;
    serviced: number;
    totalDelaySec: number;
    departuresTransferred: number;
  };
  runwayOccupant: string | null;
  runwayOccupants: string[];
  conflicts: string[];
  alerts: { id: number; text: string; tone: "warn" | "danger"; t: number }[];
  clockMin: number;
  movementsTarget: number;
  events: SimEvent[];
  runwayPlan: RunwayPlanEntry[];
  movementReports: MovementReport[];
  weather: WeatherDef;
  operations: OperationState[];
}

export interface MovementReport {
  callsign: string;
  aircraftId: string | null;
  kind: "arr" | "dep";
  typeId: string;
  targetAt: number;
  actualAt: number | null;
  serviced: boolean;
  transferred: boolean;
  closed: boolean;
  delays: { traffic: number; permission: number; runway: number; flight: number; taxi: number };
}

export interface SimEvent {
  id: number;
  t: number;
  aircraftId: string;
  callsign: string;
  kind: "landing" | "takeoff" | "service" | "violation" | "goAround" | "handoff" | "operation";
  text: string;
  points: number;
}
