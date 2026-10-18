import { getAirport } from "../data/airports";
import { getType } from "../data/aircraft-types";
import { buildAirport, distanceToThreshold, type AirportIndex } from "./airport";
import { spawnArrival, spawnDeparture, stepAircraft } from "./aircraft";
import { availableCommands, executeCommand, previewCommand, readbackText, seatOf } from "./commands";
import { completeHandoff, transmissionSeconds } from "./radio";
import { hitsGroundObstacle } from "./collision";
import type { SimEnv } from "./env";
import { Rng } from "./rng";
import { challengeSeedHash } from "./challenge";
import { makeRoute } from "./route";
import { releaseGround } from "./ground";
import { RunwayPlanner, type PlanChangeResult } from "./planning";
import { runwayBlockReason, runwayTraffic, type RunwayUse } from "./runway";
import { delayReason, emptyDelays } from "./debrief";
import type { JournalAction, PlanEdit, ReplayRecord } from "./journal";
import type { Aircraft, Command, CommandOption, CommandResult, ControlMode, LevelDef, MovementReport, RadioLine, SafetyMode, Seat, SimEvent, SimState } from "./types";
import { dist, dot, sub } from "./vec";
import { OperationsManager, inspectionVehiclePose } from "./operations";
import { findAirConflicts, findCollision, findParkedToRemove, findSectorViolations } from "./safety";

import { TICK, TIME_SCALE } from "./constants";
export { TICK, TIME_SCALE };

export class World implements SimEnv {
  readonly level: LevelDef;
  readonly idx: AirportIndex;
  readonly rng: Rng;
  readonly mode: ControlMode;
  groundLocks = new Map<string, string>();
  events: SimEvent[] = [];
  lastRunwayUse: RunwayUse | null = null;
  readonly runwayPlan = new RunwayPlanner();
  readonly operations: OperationsManager;

  time = 0;
  dt = TICK;
  windDirDeg: number;
  windKt: number;
  windGustKt: number;

  aircraft = new Map<string, Aircraft>();
  radio: RadioLine[] = [];
  alerts: SimState["alerts"] = [];
  selectedId: string | null = null;
  runwayOccupantId: string | null = null;
  status: "running" | "finished" | "failed" = "running";
  safetyMode: SafetyMode;
  failureReason: string | null = null;
  private readonly initialSafetyMode: SafetyMode;
  score = { landings: 0, takeoffs: 0, violations: 0, goArounds: 0, points: 0, serviced: 0, totalDelaySec: 0, departuresTransferred: 0 };
  conflicts: string[] = [];

  private channelAvailable = new Map<Seat, number>();
  private spawnedFlights = new Set<number>();
  private nextAircraftId = 1;
  private nextRadioId = 1;
  private violationCooldown = new Map<string, number>();
  private journal: JournalAction[] = [];
  private recording: boolean;
  private reports = new Map<string, MovementReport>();

  constructor(level: LevelDef, options: { mode?: ControlMode; recording?: boolean; safetyMode?: SafetyMode } = {}) {
    this.safetyMode = this.initialSafetyMode = options.safetyMode ?? "consequence";
    this.level = level;
    this.recording = options.recording !== false;
    this.idx = buildAirport(getAirport(level.airportId), level.runwayId);
    const callsigns = new Set<string>();
    for (const flight of level.flights) {
      if (!Number.isFinite(flight.atMin) || flight.atMin < 0 || callsigns.has(flight.callsign)) throw new Error(`无效航班计划：${flight.callsign}`);
      callsigns.add(flight.callsign);
      this.reports.set(flight.callsign, { callsign: flight.callsign, aircraftId: null, kind: flight.kind, typeId: flight.typeId,
        targetAt: flight.atMin * 60 + (flight.kind === "arr" ? 7 : 8) * 60, actualAt: null, serviced: false, transferred: false, closed: false, delays: emptyDelays() });
      const type = getType(flight.typeId);
      if (flight.kind === "dep" && flight.standId) {
        const stand = this.idx.stands.get(flight.standId);
        if (!stand || type.wake === "H" && stand.size !== "L") throw new Error(`${flight.callsign} 的机位 ${flight.standId} 与机型不兼容`);
      }
      if (flight.kind === "arr") {
        const names = [flight.entryFix ?? this.idx.def.arrival.entryFix, ...(flight.arrivalRoute ?? [this.idx.def.arrival.iafFix])];
        if (names.some((name) => !this.idx.fixes.has(name)) || flight.arrivalRoute?.length === 0) throw new Error(`${flight.callsign} 的进场航路无效`);
      }
    }
    this.windDirDeg = level.wind.dirDeg;
    this.windKt = level.wind.speedKt;
    this.windGustKt = level.wind.speedKt;
    this.operations = new OperationsManager(level);
    this.rng = new Rng(level.seed ? challengeSeedHash(level.seed) : level.id.length * 7919 + level.flights.length * 104729);
    this.mode = options.mode ?? "assisted";
  }

  // ---------- SimEnv ----------

  aircraftList(): Aircraft[] {
    return [...this.aircraft.values()];
  }

  say(seat: RadioLine["seat"], callsign: string, text: string): void {
    this.radio.push({ id: this.nextRadioId++, t: this.time, seat, callsign, text, tone: seat === "PILOT" ? "readback" : "cmd" });
    if (this.radio.length > 240) this.radio.splice(0, this.radio.length - 240);
  }

  private systemLine(text: string): void {
    this.radio.push({ id: this.nextRadioId++, t: this.time, seat: "SYS", callsign: "—", text, tone: "event" });
  }

  notify(text: string, tone: "warn" | "danger"): void {
    this.alerts.push({ id: this.nextRadioId++, text, tone, t: this.time });
    if (this.alerts.length > 6) this.alerts.shift();
    this.radio.push({ id: this.nextRadioId++, t: this.time, seat: "SYS", callsign: "—", text, tone: tone === "danger" ? "warn" : "event" });
  }

  countLanding(ac: Aircraft): void {
    if (ac.scored.landed) return;
    ac.scored.landed = true;
    this.score.landings += 1;
    this.recordMovement(ac);
    this.lastRunwayUse = { callsign: ac.callsign, typeId: ac.typeId, at: this.time };
    this.score.totalDelaySec += Math.max(0, this.time - ac.scheduledMovementAt);
    this.event(ac, "landing", "落地，等待脱离与滑入", 12);
    this.notify(`${ac.callsign} 落地`, "warn");
  }

  countTakeoff(ac: Aircraft): void {
    if (ac.scored.departed) return;
    ac.scored.departed = true;
    this.score.takeoffs += 1;
    this.recordMovement(ac);
    this.lastRunwayUse = { callsign: ac.callsign, typeId: ac.typeId, at: this.time };
    this.score.totalDelaySec += Math.max(0, this.time - ac.scheduledMovementAt);
    this.event(ac, "takeoff", "起飞", 6);
    this.notify(`${ac.callsign} 起飞`, "warn");
  }

  countGoAround(ac: Aircraft): void {
    this.score.goArounds += 1;
    this.event(ac, "goAround", "执行安全复飞，请重新引导", 0);
  }

  countService(ac: Aircraft): void {
    const report = this.reports.get(ac.callsign); if (report) report.serviced = true;
    this.score.serviced += 1;
    this.event(ac, "service", `到达机位 ${ac.standId}，服务完成`, 4);
  }

  countHandoff(ac: Aircraft): void {
    if (ac.controller === "DEP") { this.score.departuresTransferred += 1; const report = this.reports.get(ac.callsign); if (report) report.transferred = true; }
    this.event(ac, "handoff", `移交 ${ac.controller}`, 0);
  }

  operationEvent(text: string): void {
    this.events.push({ id: this.nextRadioId++, t: this.time, aircraftId: "", callsign: "OPS", kind: "operation", text, points: 0 });
  }

  private event(ac: Aircraft, kind: SimEvent["kind"], text: string, points: number): void {
    this.score.points += points;
    this.events.push({ id: this.nextRadioId++, t: this.time, aircraftId: ac.id, callsign: ac.callsign, kind, text, points });
  }

  private recordMovement(ac: Aircraft): void {
    const report = this.reports.get(ac.callsign);
    if (!report) return;
    report.actualAt = this.time;
    const accounted = Object.values(report.delays).reduce((sum, value) => sum + value, 0);
    report.delays[delayReason(ac, false)] += Math.max(0, this.time - report.targetAt - accounted);
  }

  private updateDelays(): void {
    for (const report of this.reports.values()) {
      if (report.closed || report.actualAt !== null || this.time <= report.targetAt) continue;
      const ac = report.aircraftId ? this.aircraft.get(report.aircraftId) : undefined;
      const blocked = !!ac && (ac.phase === "hold_short" || ac.phase === "approach") && !!runwayBlockReason(this, ac);
      report.delays[delayReason(ac, blocked)] += Math.min(TICK, this.time - report.targetAt);
    }
  }

  addViolation(ac: Aircraft, reason: string, points: number): void {
    this.score.violations += 1;
    this.event(ac, "violation", reason, -points);
    this.notify(`${ac.callsign} ${reason}`, "danger");
  }

  occupyRunway(ac: Aircraft): void {
    this.runwayOccupantId ??= ac.id;
  }

  vacateRunway(ac: Aircraft): void {
    if (this.runwayOccupantId === ac.id) this.runwayOccupantId = this.aircraftList().find((a) => a.id !== ac.id && (["lineup", "takeoff", "landing"].includes(a.phase) || runwayTraffic(this).includes(a)))?.id ?? null;
  }

  assignStand(ac: Aircraft): string | null {
    const used = new Set<string>();
    for (const other of this.aircraft.values()) {
      if (other.id !== ac.id && other.standId && this.occupiesStand(other)) used.add(other.standId);
    }
    const free = this.idx.def.stands.find((s) => !used.has(s.id) && (getType(ac.typeId).wake !== "H" || s.size === "L"));
    if (free) return free.id;
    return null;
  }

  /** 推出清空机位前持续占用；进场机在滑入期间预留机位。 */
  private occupiesStand(ac: Aircraft): boolean {
    if (ac.phase === "done") return false;
    if (ac.kind === "dep") {
      const stand = this.idx.stands.get(ac.standId ?? "");
      if (ac.phase === "parked" || ac.phase === "pushback" || ac.phase === "taxi_ready") return true;
      if (ac.phase !== "taxi_out" || !stand) return false;
      // 入位与出位共享 ST→AP→B 走廊。离场机尾清空整段走廊后才释放机位，
      // 避免到达机在 B 口迎面堵住仍停在 AP 的离场机。
      const apronId = this.idx.adjacency.get(stand.node)?.find((edge) => this.idx.nodes.get(edge.to)?.kind === "apron")?.to;
      const joinId = this.idx.adjacency.get(apronId ?? "")?.find((edge) => this.idx.nodes.get(edge.to)?.kind === "taxi")?.to;
      const join = this.idx.nodes.get(joinId ?? "")?.pos;
      if (!join) return true;
      const axis = sub(join, stand.pos), lengthSquared = dot(axis, axis);
      const t = lengthSquared ? Math.max(0, Math.min(1, dot(sub(ac.pos, stand.pos), axis) / lengthSquared)) : 0;
      return dist(ac.pos, { x: stand.pos.x + axis.x * t, y: stand.pos.y + axis.y * t }) < ac.lengthM / 2 + 25;
    }
    return ac.phase === "taxi_in" || ac.phase === "taxi_ready" || ac.phase === "parked";
  }

  finish(ac: Aircraft): void {
    const report = this.reports.get(ac.callsign); if (report) report.closed = true;
    releaseGround(ac, this);
    this.vacateRunway(ac);
    if (this.selectedId === ac.id) this.selectedId = null;
    ac.phase = "done";
    this.aircraft.delete(ac.id);
    this.runwayPlan.sync(this);
  }

  // ---------- 主循环 ----------

  step(): void {
    if (this.status !== "running") return;
    this.time += TICK;

    this.operations.update(this);

    this.spawnDue();
    this.updateDelays();
    this.flushRadio();
    for (const ac of this.aircraftList()) { if (this.status !== "running") break; ac.lastPos = { ...ac.pos }; completeHandoff(ac, this); stepAircraft(ac, this); completeHandoff(ac, this); }
    this.checkCollisions();
    if (this.status !== "running") return;
    this.updateConflicts();
    this.checkSector();
    this.checkParked();
    this.runwayPlan.sync(this);
    if (this.radio.length > 240) this.radio.splice(0, this.radio.length - 240);
    this.alerts = this.alerts.filter((a) => this.time - a.t < 90);

    if (this.time >= this.level.durationMin * 60) {
      this.status = "finished";
      this.systemLine("班次结束");
    } else if (this.spawnedFlights.size === this.level.flights.length &&
      this.score.serviced + this.score.takeoffs >= this.level.flights.length &&
      (this.mode === "assisted" || this.aircraftList().every((ac) => ac.kind === "arr" || ac.controller === "DEP"))) {
      this.status = "finished";
      this.systemLine(this.level.lesson ? "训练目标完成，班次提前结束" : "本班全部航班处理完成，提前收班");
    }
  }

  private spawnDue(): void {
    const flights = this.level.flights;
    for (let flightIndex = 0; flightIndex < flights.length; flightIndex++) {
      const f = flights[flightIndex]!;
      if (this.spawnedFlights.has(flightIndex) || this.time < f.atMin * 60) continue;
      if (this.aircraft.size >= this.level.maxAircraft) break;

      const standId = f.standId ?? this.idx.def.stands.find((s) => !this.isStandTaken(s.id) && (getType(f.typeId).wake !== "H" || s.size === "L"))?.id;
      if (f.kind === "dep" && (!standId || this.isStandTaken(standId))) continue;
      const id = `ac${this.nextAircraftId++}`;
      if (f.kind === "dep") {
        const ac = spawnDeparture(this, {
          id,
          callsign: f.callsign,
          airline: f.airline,
          typeId: f.typeId,
          kind: "dep",
          standId: standId ?? null,
        });
        if (!ac) {
          this.spawnedFlights.add(flightIndex);
          continue;
        }
        this.aircraft.set(ac.id, ac);
        this.systemLine(`${ac.callsign}（${getType(ac.typeId).name}）停在机位 ${ac.standId}`);
      } else {
        const ac = spawnArrival(this, {
          id,
          callsign: f.callsign,
          airline: f.airline,
          typeId: f.typeId,
          kind: "arr",
          standId: null,
          entryFix: f.entryFix,
          arrivalRoute: f.arrivalRoute,
          initialAltFt: f.initialAltFt,
          initialSpeedKt: f.initialSpeedKt,
        });
        this.aircraft.set(ac.id, ac);
        this.systemLine(`${ac.callsign}（${getType(ac.typeId).name}）进场，距场 ${Math.round(distanceToThreshold(this.idx, ac.pos) / 1000)} 公里`);
      }
      // 目标时刻取计划请求时刻，避免机位/在管上限造成的生成延误被抹掉。
      const spawned = this.aircraft.get(id);
      if (spawned) { spawned.scheduledMovementAt = f.atMin * 60 + (f.kind === "arr" ? 7 : 8) * 60; this.reports.get(f.callsign)!.aircraftId = id; }
      this.spawnedFlights.add(flightIndex);
    }
  }

  private isStandTaken(standId: string): boolean {
    for (const ac of this.aircraft.values()) {
      if (ac.standId === standId && this.occupiesStand(ac)) return true;
    }
    return false;
  }

  private flushRadio(): void {
    for (const ac of this.aircraftList()) {
      const p = ac.pendingClearance;
      if (!p) continue;
      if (!p.sent && this.time >= p.startsAt) {
        this.radio.push({ id: this.nextRadioId++, t: this.time, endsAt: p.readbackAt - .4, channel: p.seat, seat: p.seat, callsign: ac.callsign, text: p.radio, tone: p.warning ? "warn" : "cmd" });
        p.sent = true;
      }
      if (!p.pilotSent && this.time >= p.readbackAt) {
        this.radio.push({ id: this.nextRadioId++, t: this.time, endsAt: p.commitAt, channel: p.seat, seat: "PILOT", callsign: ac.callsign, text: p.readback, tone: "readback" });
        p.pilotSent = true;
      }
      if (this.time >= p.commitAt - 1e-6) {
        ac.pendingClearance = null;
        const result = executeCommand(this, ac, p.command);
        if (!result.ok) { this.systemLine(`${ac.callsign} 指令未生效：${result.reason}`); this.notify(`${ac.callsign}：${result.reason}`, "danger"); }
        else if (result.warning) this.notify(`${ac.callsign}：${result.warning}`, "warn");
      }
    }
  }

  private updateConflicts(): void {
    const found = findAirConflicts(this.aircraftList());
    this.conflicts = found.map((c) => c.key);
    for (const c of found) {
      if (!c.severe) continue;
      const last = this.violationCooldown.get(c.key) ?? -999;
      if (this.time - last <= 90) continue;
      this.violationCooldown.set(c.key, this.time);
      this.addViolation(c.a, `与 ${c.b.callsign} 失去间隔`, 15);
    }
  }

  private checkCollisions(): void {
    const aircraft = this.aircraftList();
    const inspection = this.operations.snapshot().find((event) => event.kind === "inspection" && event.stage === "active");
    if (inspection) {
      const vehicle = inspectionVehiclePose(inspection, this.time);
      const hit = aircraft.find((ac) => hitsGroundObstacle(ac, vehicle, this.idx.def.elevationM));
      if (hit) { this.failShift(hit, "与跑道检查车发生碰撞"); return; }
    }
    const pair = findCollision(aircraft);
    if (pair) this.failShift(pair[0], `与 ${pair[1].callsign} 发生碰撞`);
  }

  failShift(ac: Aircraft, reason: string): void {
    if (this.status !== "running") return;
    this.failureReason = `${ac.callsign} ${reason}`;
    this.status = "failed";
    this.addViolation(ac, reason, 100);
    this.systemLine(`本班失败：${this.failureReason}`);
  }

  setSafetyMode(mode: SafetyMode): PlanChangeResult {
    if (mode !== "guarded" && mode !== "consequence") return { ok: false, reason: "未知安全模式" };
    if (this.status !== "running") return { ok: false, reason: "班次已结束" };
    if (this.safetyMode === mode) return { ok: true };
    this.safetyMode = mode;
    if (this.recording) this.journal.push({ tick: Math.round(this.time / TICK), aircraftId: "", callsign: "SYS", kind: "safety", mode });
    return { ok: true };
  }

  private checkSector(): void {
    for (const ac of findSectorViolations(this.aircraftList())) {
      this.addViolation(ac, "飞出扇区", 8);
      this.finish(ac);
    }
  }

  private checkParked(): void {
    for (const ac of findParkedToRemove(this.aircraftList(), this.time)) this.finish(ac);
  }

  // ---------- 玩家操作 ----------

  pendingFlights() {
    return this.level.flights.filter((_, index) => !this.spawnedFlights.has(index)).sort((a, b) => a.atMin - b.atMin);
  }

  changeRunwayPlan(id: string, action: PlanEdit): PlanChangeResult {
    if (this.status !== "running") return { ok: false, reason: "班次已结束，请开始新的班次" };
    const result = action === "add" ? this.runwayPlan.add(this, id) : action === "remove" ? this.runwayPlan.remove(this, id) : this.runwayPlan.move(this, id, action === "up" ? -1 : 1);
    if (result.ok && this.recording) this.journal.push({ tick: Math.round(this.time / TICK), aircraftId: id, callsign: this.aircraft.get(id)!.callsign, kind: "plan", action });
    return result;
  }

  startInspection(id: string): PlanChangeResult {
    if (this.status !== "running") return { ok: false, reason: "班次已结束，请开始新的班次" };
    const result = this.operations.startInspection(this, id);
    if (result.ok && this.recording) this.journal.push({ tick: Math.round(this.time / TICK), aircraftId: "", callsign: "OPS", kind: "operation", operationId: id });
    return result;
  }

  commandOptions(ac: Aircraft): CommandOption[] {
    return availableCommands(ac, this);
  }

  issue(acId: string, cmd: Command): CommandResult {
    if (this.status !== "running") return { ok: false, reason: "班次已结束，请开始新的班次" };
    const ac = this.aircraft.get(acId);
    if (!ac) return { ok: false, reason: "找不到这架飞机" };
    if (ac.pendingClearance) return { ok: false, reason: "无线电通话中，等待完整复诵确认" };
    const result = previewCommand(this, ac, cmd);
    if (result.ok) {
      if (this.recording) this.journal.push({ tick: Math.round(this.time / TICK), aircraftId: acId, callsign: ac.callsign, kind: "command", command: structuredClone(cmd) });
      const seat = result.seat ?? seatOf(cmd);
      const readback = readbackText(ac, cmd);
      const startsAt = Math.max(this.time, this.channelAvailable.get(seat) ?? 0);
      const readbackAt = startsAt + transmissionSeconds(result.radio) + .4;
      const commitAt = readbackAt + transmissionSeconds(readback);
      this.channelAvailable.set(seat, commitAt + .3);
      ac.pendingClearance = { command: structuredClone(cmd), startsAt, readbackAt, commitAt, seat, radio: result.radio, readback, warning: result.warning, sent: false, pilotSent: false };
      this.flushRadio();
    }
    return result;
  }

  select(id: string | null): void {
    this.selectedId = id !== null && this.aircraft.has(id) ? id : null;
  }

  exportReplay(): ReplayRecord {
    return { version: 2, level: structuredClone(this.level), mode: this.mode, safetyMode: this.initialSafetyMode, endedAt: this.time, actions: structuredClone(this.journal) };
  }

  snapshot(): SimState {
    const aircraft = this.aircraftList().map((a) => {
      const route = a.route ? makeRoute(a.route.points.map((p) => ({ ...p }))) : null;
      if (route && a.route) route.minS = a.route.minS;
      return { ...a, pendingClearance: a.pendingClearance ? structuredClone(a.pendingClearance) : null, pendingHandoff: a.pendingHandoff ? { ...a.pendingHandoff } : null, pos: { ...a.pos }, lastPos: { ...a.lastPos }, scored: { ...a.scored }, approach: a.approach ? { ...a.approach } : null, route };
    });
    return {
      time: this.time,
      status: this.status,
      safetyMode: this.safetyMode,
      failureReason: this.failureReason,
      aircraft,
      radio: this.radio.slice(-60).map((line) => ({ ...line })),
      selectedId: this.selectedId,
      score: { ...this.score },
      runwayOccupant: this.runwayOccupantId,
      runwayOccupants: runwayTraffic(this).map((a) => a.id),
      conflicts: [...this.conflicts],
      alerts: this.alerts.slice(-4).map((alert) => ({ ...alert })),
      clockMin: this.level.startClockMin + Math.floor(this.time / 60),
      movementsTarget: this.level.targetMovements,
      events: this.events.map((event) => ({ ...event })),
      runwayPlan: this.runwayPlan.snapshot(this),
      movementReports: [...this.reports.values()].map((report) => ({ ...report, delays: { ...report.delays } })),
      weather: { dirDeg: this.windDirDeg, speedKt: this.windKt, gustKt: this.windGustKt },
      operations: this.operations.snapshot(),
    };
  }
}
