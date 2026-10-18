import type { FlightPlanDef, LevelDef } from "../sim/types";
import { createChallenge } from "../sim/challenge";

interface FlightSpec {
  callsign: string;
  airline: string;
  typeId: string;
  kind: "arr" | "dep";
  atMin: number;
  standId?: string;
}

const f = (spec: FlightSpec): FlightPlanDef => ({
  callsign: spec.callsign,
  airline: spec.airline,
  typeId: spec.typeId,
  kind: spec.kind,
  atMin: spec.atMin,
  standId: spec.standId,
});

/** 教学：只有一架飞机，教"下降 → 清进近 → 落地" */
const TUTORIAL: LevelDef = {
  id: "tutorial",
  name: "第一班 · 单机落地",
  airportId: "kestrel",
  startClockMin: 7 * 60 + 30,
  durationMin: 20,
  runwayId: "27",
  wind: { dirDeg: 260, speedKt: 6 },
  maxAircraft: 3,
  targetMovements: 1,
  flights: [f({ callsign: "AUR102", airline: "极光航空", typeId: "A320", kind: "arr", atMin: 0 })],
  description: "从选中飞机到落地、脱离与滑入。单机练习，完成后立即结算。",
  lesson: true,
};

/** 正常关卡：进离场混合，跑道开始需要排序 */
const MORNING_RUSH: LevelDef = {
  id: "morning-rush",
  name: "第二班 · 晨间高峰",
  airportId: "kestrel",
  startClockMin: 8 * 60,
  durationMin: 45,
  runwayId: "27",
  wind: { dirDeg: 260, speedKt: 8 },
  maxAircraft: 8,
  targetMovements: 9,
  description: "进离场混合的完整班次。安排推出顺序，在进场之间寻找起飞窗口。",
  flights: [
    f({ callsign: "AUR101", airline: "极光航空", typeId: "A320", kind: "dep", atMin: 0, standId: "S3" }),
    f({ callsign: "VLT210", airline: "北风航空", typeId: "A320", kind: "arr", atMin: 1 }),
    f({ callsign: "NRD305", airline: "北欧航空", typeId: "B738", kind: "dep", atMin: 4, standId: "S1" }),
    f({ callsign: "SKY118", airline: "天穹航空", typeId: "E190", kind: "arr", atMin: 7 }),
    f({ callsign: "AUR145", airline: "极光航空", typeId: "B77W", kind: "arr", atMin: 11 }),
    f({ callsign: "KST220", airline: "清风航空", typeId: "AT72", kind: "dep", atMin: 13, standId: "S5" }),
    f({ callsign: "NRD331", airline: "北欧航空", typeId: "A21N", kind: "arr", atMin: 17 }),
    f({ callsign: "SKY402", airline: "天穹航空", typeId: "E190", kind: "dep", atMin: 20, standId: "S2" }),
    f({ callsign: "VLT255", airline: "北风航空", typeId: "A320", kind: "arr", atMin: 24 }),
    f({ callsign: "AUR177", airline: "极光航空", typeId: "B738", kind: "dep", atMin: 28, standId: "S4" }),
    f({ callsign: "KST290", airline: "清风航空", typeId: "AT72", kind: "arr", atMin: 31 }),
  ],
};

const GROUND_SCHOOL: LevelDef = {
  ...TUTORIAL, id: "ground-school", name: "第二课 · 地面放行", lesson: true, durationMin: 18,
  description: "批准推出、预览滑行路线、联系塔台、起飞并移交。学会一个完整离场流程。",
  flights: [f({ callsign: "KST101", airline: "清风航空", typeId: "E190", kind: "dep", atMin: 0, standId: "S4" })],
};
const MERGE: LevelDef = {
  ...TUTORIAL, id: "intersection", name: "第三课 · 交汇时刻", lesson: true, durationMin: 25, targetMovements: 3,
  description: "两架离场与一架进场共用跑道。先走谁，由你决定。",
  flights: [f({ callsign: "AUR201", airline: "极光航空", typeId: "A320", kind: "dep", atMin: 0, standId: "S3" }), f({ callsign: "SKY310", airline: "天穹航空", typeId: "E190", kind: "arr", atMin: 0 }), f({ callsign: "KST106", airline: "清风航空", typeId: "AT72", kind: "dep", atMin: 1, standId: "S5" })],
};
const PEAK: LevelDef = {
  ...MORNING_RUSH, id: "peak-flow", name: "挑战 · 流量波次", durationMin: 38, maxAircraft: 12, targetMovements: 11,
  description: "同一座机场，更密集的波次。用等待、机型速度差与旁通道保持流量。",
  flights: MORNING_RUSH.flights.map((flight) => ({ ...flight, atMin: flight.atMin * .55 })),
};
const HEAVY: LevelDef = {
  ...MORNING_RUSH, id: "heavy-wave", name: "挑战 · 重型机之夜", startClockMin: 18 * 60 + 25, durationMin: 42, maxAircraft: 12, targetMovements: 10,
  description: "黄昏里交织的重型机与涡桨。大机需要兼容机位，慢机占用更长的进近时间。",
  flights: MORNING_RUSH.flights.map((flight, i) => ({ ...flight, callsign: `NIT${210 + i}`, atMin: flight.atMin * .7, typeId: flight.kind === "arr" ? i % 2 ? "B77W" : "AT72" : flight.typeId })),
};

const OPERATIONS: LevelDef = {
  ...MORNING_RUSH, id: "operating-windows", name: "挑战 · 运行窗口", durationMin: 32, maxAircraft: 10, targetMovements: 8,
  description: "利用空档提前安排跑道检查；阵风期间，轻型机等待，喷气机仍可放行。用预告、机型差异和空中等待掌握主动。",
  operations: [
    { id: "rwy-inspection", kind: "inspection", name: "跑道例行检查", announceMin: 1, atMin: 5, durationSec: 150 },
    { id: "crosswind", kind: "weather", name: "西南阵风", announceMin: 7, atMin: 9, durationSec: 240, wind: { dirDeg: 210, speedKt: 18, gustKt: 26 } },
  ],
  flights: [
    f({ callsign: "OPS201", airline: "极光航空", typeId: "A320", kind: "dep", atMin: 0, standId: "S4" }),
    f({ callsign: "OPS302", airline: "天穹航空", typeId: "E190", kind: "arr", atMin: 1 }),
    f({ callsign: "OPS203", airline: "北欧航空", typeId: "B738", kind: "dep", atMin: 4, standId: "S2" }),
    f({ callsign: "OPS204", airline: "清风航空", typeId: "AT72", kind: "dep", atMin: 8, standId: "S5" }),
    f({ callsign: "OPS305", airline: "北风航空", typeId: "A320", kind: "arr", atMin: 9 }),
    f({ callsign: "OPS206", airline: "极光航空", typeId: "B77W", kind: "dep", atMin: 12, standId: "S1" }),
    f({ callsign: "OPS307", airline: "清风航空", typeId: "AT72", kind: "arr", atMin: 16 }),
    f({ callsign: "OPS208", airline: "天穹航空", typeId: "E190", kind: "dep", atMin: 18, standId: "S3" }),
  ],
};

export const LEVELS: LevelDef[] = [TUTORIAL, GROUND_SCHOOL, MERGE, MORNING_RUSH, PEAK, HEAVY, createChallenge(), OPERATIONS];

export function getLevel(id: string): LevelDef {
  const lvl = LEVELS.find((l) => l.id === id);
  if (!lvl) throw new Error(`未知关卡 ${id}`);
  return lvl;
}

export const DEFAULT_LEVEL_ID = "tutorial";
