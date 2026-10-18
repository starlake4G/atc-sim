import type { ReplayRecord } from "./journal";
import { TICK, World } from "./world";

/** Rebuild from accepted inputs and fixed ticks; never modifies the original session. */
export class ReplayPlayer {
  world: World;
  readonly record: ReplayRecord;
  private cursor = 0;
  private accumulator = 0;
  private tick = 0;

  constructor(record: ReplayRecord) {
    if (record.version !== 2) throw new Error("此回放使用旧版物理规则，请用原版本查看");
    this.record = structuredClone(record);
    this.world = new World(this.record.level, { mode: record.mode, recording: false, safetyMode: record.safetyMode });
    this.applyActions();
  }

  private applyActions(): void {
    while (this.cursor < this.record.actions.length && this.record.actions[this.cursor]!.tick <= this.tick) {
      const action = this.record.actions[this.cursor++]!;
      const result = action.kind === "command" ? this.world.issue(action.aircraftId, action.command) : action.kind === "operation" ? this.world.startInspection(action.operationId) : action.kind === "safety" ? this.world.setSafetyMode(action.mode) : this.world.changeRunwayPlan(action.aircraftId, action.action);
      if (!result.ok) throw new Error(`回放在 ${this.tick} tick 不一致：${result.reason}`);
    }
  }

  private step(): void {
    this.world.step(); this.tick++; this.applyActions();
  }

  seek(seconds: number): World {
    const target = Math.min(Math.round(this.record.endedAt / TICK), Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) / TICK)));
    if (target >= this.tick) { this.accumulator = 0; while (this.tick < target) this.step(); return this.world; }
    this.world = new World(this.record.level, { mode: this.record.mode, recording: false, safetyMode: this.record.safetyMode });
    this.cursor = 0; this.tick = 0; this.accumulator = 0; this.applyActions();
    while (this.tick < target) this.step();
    return this.world;
  }

  advance(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.accumulator += seconds;
    const end = Math.round(this.record.endedAt / TICK);
    while (this.accumulator + 1e-8 >= TICK && this.tick < end) { this.step(); this.accumulator -= TICK; }
  }

  get ended(): boolean { return this.tick >= Math.round(this.record.endedAt / TICK); }
}
