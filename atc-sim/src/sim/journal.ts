import type { Command, ControlMode, LevelDef } from "./types";

export type PlanEdit = "add" | "remove" | "up" | "down";
export type JournalAction = { tick: number; aircraftId: string; callsign: string } & (
  { kind: "command"; command: Command } | { kind: "plan"; action: PlanEdit } | { kind: "operation"; operationId: string }
);
export interface ReplayRecord {
  version: 1;
  level: LevelDef;
  mode: ControlMode;
  endedAt: number;
  actions: JournalAction[];
}
