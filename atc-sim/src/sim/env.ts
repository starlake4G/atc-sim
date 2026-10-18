import type { AirportIndex } from "./airport";
import type { Aircraft, ControlMode, SafetyMode, Seat } from "./types";
import type { RunwayUse } from "./runway";
import type { RunwayPlanner } from "./planning";
import type { OperationsManager } from "./operations";

/** aircraft.ts 需要的世界能力。world.ts 实现它，避免 sim 内部互相 import 成环。 */
export interface SimEnv {
  idx: AirportIndex;
  time: number;
  dt: number;
  windDirDeg: number;
  windKt: number;
  windGustKt?: number;
  runwayOccupantId: string | null;
  mode: ControlMode;
  safetyMode?: SafetyMode;
  groundLocks: Map<string, string>;
  lastRunwayUse: RunwayUse | null;
  runwayPlan?: RunwayPlanner;
  operations?: OperationsManager;
  aircraftList(): Aircraft[];
  /** 无线电：管制员发话 */
  say(seat: Seat, callsign: string, text: string): void;
  /** 系统提示（不占无线电） */
  notify(text: string, tone: "warn" | "danger"): void;
  countLanding(ac: Aircraft): void;
  countTakeoff(ac: Aircraft): void;
  countGoAround(ac: Aircraft): void;
  countService(ac: Aircraft): void;
  countHandoff(ac: Aircraft): void;
  addViolation(ac: Aircraft, reason: string, points: number): void;
  occupyRunway(ac: Aircraft): void;
  vacateRunway(ac: Aircraft): void;
  /** 找一张空闲机位给进场飞机 */
  assignStand(ac: Aircraft): string | null;
  finish(ac: Aircraft): void;
  failShift?(ac: Aircraft, reason: string): void;
}
