import type { FlightPlanDef, LevelDef } from "../sim/types";

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
    f({ callsign: "KST290", airline: "清风航空", typeId: "AT72", kind: "arr", atMin: 33 }),
  ],
};

export const LEVELS: LevelDef[] = [TUTORIAL, MORNING_RUSH];

export function getLevel(id: string): LevelDef {
  const lvl = LEVELS.find((l) => l.id === id);
  if (!lvl) throw new Error(`未知关卡 ${id}`);
  return lvl;
}

export const DEFAULT_LEVEL_ID = "morning-rush";
