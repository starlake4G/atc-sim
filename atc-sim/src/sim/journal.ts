import type { Command, ControlMode, LevelDef, SafetyMode } from "./types";

export type PlanEdit = "add" | "remove" | "up" | "down";
export type JournalAction = { tick: number; aircraftId: string; callsign: string } & (
  { kind: "command"; command: Command } | { kind: "plan"; action: PlanEdit } | { kind: "operation"; operationId: string } | { kind: "safety"; mode: SafetyMode }
);
export interface ReplayRecord {
  version: 2;
  level: LevelDef;
  mode: ControlMode;
  safetyMode?: SafetyMode;
  endedAt: number;
  actions: JournalAction[];
}
