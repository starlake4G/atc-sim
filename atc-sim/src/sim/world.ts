import { getAirport } from "../data/airports";
import { getType } from "../data/aircraft-types";
import { buildAirport, distanceToThreshold, type AirportIndex } from "./airport";
import { isAirborne, spawnArrival, spawnDeparture, stepAircraft } from "./aircraft";
import { availableCommands, executeCommand, readbackText, seatOf } from "./commands";
import type { SimEnv } from "./env";
import { Rng } from "./rng";
import type { Aircraft, Command, CommandOption, CommandResult, LevelDef, RadioLine, SimState } from "./types";
import { dist } from "./vec";
import { ft, nm } from "./units";

export const TICK = 0.1;
/** 1 现实秒 = 6 游戏秒（1x）。班次 45 分钟 ≈ 7.5 现实分钟。 */
export const TIME_SCALE = 6;

interface PendingRadio {
  at: number;
  line: RadioLine;
}

export class World implements SimEnv {
  readonly level: LevelDef;
  readonly idx: AirportIndex;
  readonly rng: Rng;

  time = 0;
  dt = TICK;
  windDirDeg: number;
  windKt: number;

  aircraft = new Map<string, Aircraft>();
  radio: RadioLine[] = [];
  alerts: SimState["alerts"] = [];
  selectedId: string | null = null;
  runwayOccupantId: string | null = null;
  status: "running" | "finished" = "running";
  score = { landings: 0, takeoffs: 0, violations: 0, goArounds: 0 };
  conflicts: string[] = [];

  private pendingRadio: PendingRadio[] = [];
  private spawnIndex = 0;
  private nextAircraftId = 1;
  private nextRadioId = 1;
  private violationCooldown = new Map<string, number>();
  private parkOrder: string[] = [];

  constructor(level: LevelDef) {
    this.level = level;
    this.idx = buildAirport(getAirport(level.airportId), level.runwayId);
    this.windDirDeg = level.wind.dirDeg;
    this.windKt = level.wind.speedKt;
    this.rng = new Rng(level.id.length * 7919 + level.flights.length * 104729);
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
    this.notify(`${ac.callsign} 落地`, "warn");
  }

  countTakeoff(ac: Aircraft): void {
    if (ac.scored.departed) return;
    ac.scored.departed = true;
    this.score.takeoffs += 1;
    this.notify(`${ac.callsign} 起飞`, "warn");
  }

  addViolation(ac: Aircraft, reason: string, points: number): void {
    this.score.violations += 1;
    void points;
    this.notify(`${ac.callsign} ${reason}`, "danger");
  }

  occupyRunway(ac: Aircraft): void {
    this.runwayOccupantId = ac.id;
  }

  vacateRunway(ac: Aircraft): void {
    if (this.runwayOccupantId === ac.id) this.runwayOccupantId = null;
  }

  assignStand(ac: Aircraft): string | null {
    const used = new Set<string>();
    for (const other of this.aircraft.values()) {
      if (other.id !== ac.id && other.standId && this.occupiesStand(other)) used.add(other.standId);
    }
    const free = this.idx.def.stands.find((s) => !used.has(s.id));
    if (free) return free.id;
    return this.idx.def.stands[0]?.id ?? null;
  }

  /** 一架飞机是否真的占着机位：离场机只有停着时占，进场机滑入后占 */
  private occupiesStand(ac: Aircraft): boolean {
    if (ac.phase === "done") return false;
    if (ac.kind === "dep") return ac.phase === "parked";
    return ac.phase === "taxi_in" || ac.phase === "parked";
  }

  finish(ac: Aircraft): void {
    ac.phase = "done";
    this.aircraft.delete(ac.id);
    this.parkOrder = this.parkOrder.filter((id) => id !== ac.id);
  }

  // ---------- 主循环 ----------

  step(): void {
    if (this.status !== "running") return;
    this.time += TICK;

    this.spawnDue();
    for (const ac of this.aircraftList()) stepAircraft(ac, this);
    this.flushRadio();
    this.updateConflicts();
    this.checkSector();
    this.checkParked();

    if (this.time >= this.level.durationMin * 60) {
      this.status = "finished";
      this.systemLine("班次结束");
    }
  }

  private spawnDue(): void {
    const flights = this.level.flights;
    while (this.spawnIndex < flights.length) {
      const f = flights[this.spawnIndex]!;
      if (this.time < f.atMin * 60) break;
      if (this.aircraft.size >= this.level.maxAircraft) break;

      const id = `ac${this.nextAircraftId++}`;
      if (f.kind === "dep") {
        if (f.standId && this.isStandTaken(f.standId)) {
          // 机位还没空出来，等下一帧再放
          break;
        }
        const ac = spawnDeparture(this, {
          id,
          callsign: f.callsign,
          airline: f.airline,
          typeId: f.typeId,
          kind: "dep",
          standId: f.standId ?? null,
        });
        if (!ac) {
          this.spawnIndex += 1;
          continue;
        }
        this.aircraft.set(ac.id, ac);
        this.parkOrder.push(ac.id);
        this.systemLine(`${ac.callsign}（${getType(ac.typeId).name}）停在机位 ${ac.standId}`);
      } else {
        const ac = spawnArrival(this, {
          id,
          callsign: f.callsign,
          airline: f.airline,
          typeId: f.typeId,
          kind: "arr",
          standId: null,
        });
        this.aircraft.set(ac.id, ac);
        this.systemLine(`${ac.callsign}（${getType(ac.typeId).name}）进场，距场 ${Math.round(distanceToThreshold(this.idx, ac.pos) / 1000)} 公里`);
      }
      this.spawnIndex += 1;
    }
  }

  private isStandTaken(standId: string): boolean {
    for (const ac of this.aircraft.values()) {
      if (ac.standId === standId && this.occupiesStand(ac)) return true;
    }
    return false;
  }

  private flushRadio(): void {
    if (this.pendingRadio.length === 0) return;
    const due = this.pendingRadio.filter((p) => p.at <= this.time);
    if (due.length === 0) return;
    this.pendingRadio = this.pendingRadio.filter((p) => p.at > this.time);
    for (const p of due) {
      this.radio.push(p.line);
      if (this.radio.length > 240) this.radio.splice(0, this.radio.length - 240);
    }
  }

  private updateConflicts(): void {
    const air = this.aircraftList().filter((a) => isAirborne(a) && a.altM > 40);
    const found: string[] = [];
    for (let i = 0; i < air.length; i++) {
      for (let j = i + 1; j < air.length; j++) {
        const a = air[i]!;
        const b = air[j]!;
        const h = dist(a.pos, b.pos);
        const v = Math.abs(a.altM - b.altM);
        if (h < nm(3) && v < ft(1000)) {
          found.push(`${a.id}|${b.id}`);
          if (h < nm(2) && v < ft(600)) {
            const key = [a.id, b.id].sort().join("|");
            const last = this.violationCooldown.get(key) ?? -999;
            if (this.time - last > 90) {
              this.violationCooldown.set(key, this.time);
              this.addViolation(a, `与 ${b.callsign} 失去间隔`, 15);
            }
          }
        }
      }
    }
    this.conflicts = found;
  }

  private checkSector(): void {
    for (const ac of this.aircraftList()) {
      if (ac.phase === "done") continue;
      if (dist(ac.pos, { x: 0, y: 0 }) > 42000) {
        this.addViolation(ac, "飞出扇区", 8);
        this.finish(ac);
      }
    }
  }

  private checkParked(): void {
    for (const ac of this.aircraftList()) {
      if (ac.phase === "parked" && ac.kind === "arr" && ac.removeAt !== null && this.time >= ac.removeAt) {
        this.finish(ac);
      }
    }
  }

  // ---------- 玩家操作 ----------

  commandOptions(ac: Aircraft): CommandOption[] {
    return availableCommands(ac, this);
  }

  issue(acId: string, cmd: Command): CommandResult {
    const ac = this.aircraft.get(acId);
    if (!ac) return { ok: false, reason: "找不到这架飞机" };
    const result = executeCommand(this, ac, cmd);
    if (result.ok) {
      const seat = result.seat ?? seatOf(cmd);
      this.say(seat, ac.callsign, result.radio);
      const text = readbackText(ac, cmd);
      this.pendingRadio.push({
        at: this.time + 2.5,
        line: { id: this.nextRadioId++, t: this.time + 2.5, seat: "PILOT", callsign: ac.callsign, text, tone: "readback" },
      });
    }
    return result;
  }

  select(id: string | null): void {
    this.selectedId = id;
  }

  snapshot(): SimState {
    const aircraft = this.aircraftList().map((a) => ({ ...a }));
    return {
      time: this.time,
      status: this.status,
      aircraft,
      radio: this.radio.slice(-60),
      selectedId: this.selectedId,
      score: { ...this.score },
      runwayOccupant: this.runwayOccupantId,
      conflicts: [...this.conflicts],
      alerts: this.alerts.slice(-4),
      clockMin: this.level.startClockMin + Math.floor(this.time / 60),
      movementsTarget: this.level.targetMovements,
    };
  }
}
