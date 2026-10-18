import { getType } from "../data/aircraft-types";
import type { SimEnv } from "./env";
import type { Aircraft, LevelDef, OperationDef, OperationState, WeatherDef } from "./types";
import type { PlanChangeResult } from "./planning";

/** Shared by the rendered vehicle and collision detection. */
export function inspectionVehiclePose(event: OperationState, time: number) {
  const progress = Math.max(0, Math.min(1, (time - event.startedAt!) / event.durationSec));
  return { x: 1000 - (progress < .5 ? progress * 2 : 2 - progress * 2) * 2000, y: -6, hdg: progress < .5 ? 270 : 90 };
}

/** Game limits, chosen for readable differences between light, medium and heavy aircraft. */
export function windLimits(typeId: string) {
  return { crosswindKt: getType(typeId).wake === "L" ? 15 : getType(typeId).wake === "H" ? 28 : 24, tailwindKt: 10 };
}
export function runwayWind(wind: WeatherDef, runwayHdg: number) {
  const angle = (wind.dirDeg - runwayHdg) * Math.PI / 180;
  return { headwindKt: wind.speedKt * Math.cos(angle), crosswindKt: Math.abs((wind.gustKt ?? wind.speedKt) * Math.sin(angle)),
    tailwindKt: Math.max(0, -(wind.gustKt ?? wind.speedKt) * Math.cos(angle)) };
}
export function windRestriction(wind: WeatherDef, runwayHdg: number, typeId: string): string | undefined {
  const components = runwayWind(wind, runwayHdg), limits = windLimits(typeId);
  if (components.crosswindKt > limits.crosswindKt + .01) return `阵风侧风 ${components.crosswindKt.toFixed(1)}kt，超出 ${typeId} 游戏限制 ${limits.crosswindKt}kt`;
  if (components.tailwindKt > limits.tailwindKt + .01) return `顺风 ${components.tailwindKt.toFixed(1)}kt，超出游戏限制 ${limits.tailwindKt}kt`;
}
export function runwayCommitted(ac: Aircraft): boolean {
  return ac.phase === "lineup" || ac.phase === "takeoff" || ac.phase === "approach" && ac.landCleared;
}

/** Deterministic operations. Inspections never displace a previously committed movement. */
export class OperationsManager {
  private entries: { def: OperationDef; state: OperationState }[];
  private baseWind: WeatherDef;
  revision = 0;

  constructor(level: LevelDef) {
    this.baseWind = { ...level.wind };
    const ids = new Set<string>();
    const defs = structuredClone(level.operations ?? []);
    for (const def of defs) {
      if (!def.id || ids.has(def.id) || ![def.announceMin, def.atMin, def.durationSec].every(Number.isFinite) ||
        def.announceMin < 0 || def.atMin < def.announceMin || def.durationSec <= 0 || def.atMin * 60 + def.durationSec > level.durationMin * 60) throw new Error(`无效运行事件：${def.id}`);
      ids.add(def.id);
      if (def.kind === "weather" && (!Number.isFinite(def.wind.dirDeg) || def.wind.dirDeg < 0 || def.wind.dirDeg >= 360 ||
        !Number.isFinite(def.wind.speedKt) || def.wind.speedKt < 0 || (def.wind.gustKt !== undefined && (!Number.isFinite(def.wind.gustKt) || def.wind.gustKt < def.wind.speedKt)))) throw new Error(`无效事件风况：${def.id}`);
    }
    const weather = defs.filter((def) => def.kind === "weather").sort((a, b) => a.atMin - b.atMin);
    if (weather.some((def, i) => i > 0 && def.atMin * 60 < weather[i - 1]!.atMin * 60 + weather[i - 1]!.durationSec)) throw new Error("风况事件不可重叠");
    this.entries = defs.sort((a, b) => a.atMin - b.atMin).map((def) => ({ def, state: { id: def.id, name: def.name, kind: def.kind,
      stage: "scheduled", plannedAt: def.atMin * 60, durationSec: def.durationSec, startedAt: null, endsAt: null, ...(def.kind === "weather" ? { wind: { ...def.wind } } : {}) } }));
  }

  private runwayBusy(env: SimEnv): boolean {
    return env.runwayOccupantId !== null || env.aircraftList().some(runwayCommitted);
  }
  private change(env: SimEnv, _state: OperationState, text: string): void {
    this.revision++;
    env.notify(text, "warn");
    // World records transitions alongside movements; light-weight test environments need no callback.
    (env as SimEnv & { operationEvent?: (text: string) => void }).operationEvent?.(text);
  }
  private begin(env: SimEnv, state: OperationState): void {
    state.stage = "active"; state.startedAt = env.time; state.endsAt = env.time + state.durationSec;
    this.change(env, state, `跑道检查开始，${env.safetyMode === "consequence" ? "新许可提示检查风险" : "暂停新起降许可"}，预计 ${Math.ceil(state.durationSec)} 游戏秒后开放`);
  }

  update(env: SimEnv): void {
    for (const { def, state } of this.entries) {
      if (state.stage === "scheduled" && env.time + 1e-6 >= def.announceMin * 60) {
        state.stage = "announced";
        this.change(env, state, def.kind === "inspection" ? `${def.name}已预告：可利用空档提前开始；计划 ${Math.ceil(def.atMin)} 分钟时暂停新许可` : `${def.name}预告：${def.wind.dirDeg}° / ${def.wind.speedKt}kt，阵风 ${def.wind.gustKt ?? def.wind.speedKt}kt`);
      }
      if (state.stage === "active" && env.time + 1e-6 >= state.endsAt!) {
        state.stage = "completed";
        this.change(env, state, def.kind === "inspection" ? "跑道检查完成，恢复新起降许可" : `${def.name}结束，恢复基准风况`);
      }
      if (def.kind === "weather") {
        if (state.stage === "announced" && env.time + 1e-6 >= state.plannedAt) {
          state.stage = "active"; state.startedAt = state.plannedAt; state.endsAt = state.plannedAt + state.durationSec;
          this.change(env, state, `${def.name}生效：新许可按机型侧风限制校验；已许可航班继续执行`);
        }
      } else {
        if (state.stage === "announced" && env.time + 1e-6 >= state.plannedAt) {
          state.stage = "pending";
          this.change(env, state, this.runwayBusy(env) ? "跑道检查待开始：保留已许可航班，待其清空后检查；暂停新许可" : "已到跑道检查窗口");
        }
        if (state.stage === "pending" && !this.runwayBusy(env) && !this.entries.some((entry) => entry.state.kind === "inspection" && entry.state.stage === "active")) this.begin(env, state);
      }
    }
    const weather = this.entries.find(({ state }) => state.kind === "weather" && state.stage === "active")?.state.wind ?? this.baseWind;
    env.windDirDeg = weather.dirDeg; env.windKt = weather.speedKt; env.windGustKt = weather.gustKt ?? weather.speedKt;
  }

  startInspection(env: SimEnv, id: string): PlanChangeResult {
    const reason = this.inspectionStartReason(env, id);
    if (reason) return { ok: false, reason };
    const entry = this.entries.find(({ state }) => state.id === id && state.kind === "inspection");
    this.begin(env, entry!.state); return { ok: true };
  }

  inspectionStartReason(env: SimEnv, id: string): string | undefined {
    const entry = this.entries.find(({ state }) => state.id === id && state.kind === "inspection");
    if (!entry || entry.state.stage !== "announced" && entry.state.stage !== "pending") return "检查尚未预告、已经开始或已完成";
    if (this.runwayBusy(env)) return "先等待已许可飞机清空跑道，再提前开始检查";
    if (this.entries.some(({ state }) => state.kind === "inspection" && state.stage === "active")) return "另一项检查正在进行";
  }

  blockReason(env: SimEnv, ac: Aircraft): string | undefined {
    if (runwayCommitted(ac)) return undefined;
    const closure = this.entries.find(({ state }) => state.kind === "inspection" && (state.stage === "active" || state.stage === "pending"))?.state;
    if (closure) return closure.stage === "pending" ? "跑道检查待开始，先让已许可飞机清空；暂停新起降许可" : `跑道检查中，还需 ${Math.ceil(Math.max(0, closure.endsAt! - env.time))} 游戏秒；可先安排地面或空中等待`;
    const reason = windRestriction({ dirDeg: env.windDirDeg, speedKt: env.windKt, gustKt: env.windGustKt }, env.idx.runway.hdg, ac.typeId);
    if (!reason) return;
    const weather = this.entries.find(({ state }) => state.kind === "weather" && state.stage === "active")?.state;
    return `${reason}${weather ? `，预计 ${Math.ceil(Math.max(0, weather.endsAt! - env.time))} 游戏秒后恢复` : ""}；${ac.kind === "dep" ? "请在跑道外等待，可先安排不受限机型" : "可提前空中等待或安排安全复飞"}`;
  }

  /** Forecast shifts the queue through known unavailable windows, without granting permissions. */
  nextAvailable(env: SimEnv, ac: Aircraft, earliest: number, committedClearAt = env.time, inspectionStarts?: Map<string, number>): { at: number; reason?: string } {
    if (runwayCommitted(ac)) return { at: earliest };
    let at = earliest, reason: string | undefined;
    for (let pass = 0; pass <= this.entries.length; pass++) {
      let moved = false;
      for (const { state } of this.entries) {
        if (state.stage === "completed") continue;
        const start = state.kind === "inspection" && inspectionStarts?.has(state.id) ? inspectionStarts.get(state.id)! :
          state.startedAt ?? (state.kind === "inspection" ? Math.max(state.plannedAt, committedClearAt, state.stage === "pending" ? env.time : 0) : state.plannedAt);
        const end = state.endsAt ?? start + state.durationSec;
        const restricted = state.kind === "inspection" || windRestriction(state.wind!, env.idx.runway.hdg, ac.typeId);
        if (restricted && at >= start - 1e-6 && at < end - 1e-6) { at = end; reason = `${state.name}结束后可安排 · `; moved = true; }
      }
      if (!moved) break;
    }
    return { at, reason };
  }

  private inspectionOrder(): OperationState[] {
    return this.entries.map(({ state }) => state).filter((state) => state.kind === "inspection" && state.stage !== "completed")
      .sort((a, b) => Number(b.stage === "active") - Number(a.stage === "active") || a.plannedAt - b.plannedAt);
  }

  /** A local planning context, independent of actual event state and rebuilt for every snapshot. */
  forecastInspections(env: SimEnv, committedClearAt: number): Map<string, number> {
    const starts = new Map<string, number>(); let available = env.time;
    for (const state of this.inspectionOrder()) {
      const start = state.startedAt ?? Math.max(state.plannedAt, committedClearAt, available);
      starts.set(state.id, start); available = Math.max(available, start + state.durationSec);
    }
    return starts;
  }

  /** An earlier queued movement may cross the due time; the inspection must then wait for its tail. */
  deferForecastInspections(env: SimEnv, starts: Map<string, number>, occupyAt: number, clearAt: number): void {
    let available = env.time;
    for (const state of this.inspectionOrder()) {
      let start = starts.get(state.id)!;
      if (state.stage !== "active") {
        start = Math.max(start, available);
        if (occupyAt < start && clearAt > start) start = clearAt;
        starts.set(state.id, start);
      }
      available = Math.max(available, start + state.durationSec);
    }
  }

  snapshot(): OperationState[] { return this.entries.map(({ state }) => ({ ...state, ...(state.wind ? { wind: { ...state.wind } } : {}) })); }
}
