import { getType } from "../data/aircraft-types";
import { alongRunway, bearingToThreshold, glideAltM, lateralOffset, pickExit, routeFrom } from "./airport";
import type { SimEnv } from "./env";
import { makeRoute } from "./route";
import { advanceGround, releaseGround } from "./ground";
import type { Aircraft, AircraftTypeDef, Phase } from "./types";
import { DEG, RAD, angleDiff, clamp, ft, kt, norm360 } from "./units";
import { bearing, dist, fromBearing, type Vec2 } from "./vec";

const BANK_DEG = 25;
const AIR_MAX_TURN = 3.5;
const GROUND_MAX_TURN = 16;

const GROUND_PHASES = new Set<Phase>(["parked", "pushback", "taxi_ready", "taxi_out", "hold_short", "lineup", "takeoff", "landing", "taxi_in"]);

export const isGroundPhase = (ac: Aircraft): boolean => GROUND_PHASES.has(ac.phase);

export function isAirborne(ac: Aircraft): boolean {
  return ac.phase === "arrival" || ac.phase === "approach" || ac.phase === "departure";
}

function maxTurnRate(ac: Aircraft): number {
  if (isGroundPhase(ac)) return GROUND_MAX_TURN;
  return clamp((9.81 * Math.tan(BANK_DEG * DEG)) / Math.max(ac.gs, 25) * RAD, 0.6, AIR_MAX_TURN);
}

function turnTo(ac: Aircraft, desiredHdg: number, dt: number): void {
  const rate = maxTurnRate(ac) * dt;
  ac.hdg = norm360(ac.hdg + clamp(angleDiff(desiredHdg, ac.hdg), -rate, rate));
}

function speedTo(ac: Aircraft, targetMps: number, dt: number): void {
  const t = getType(ac.typeId);
  if (ac.gs < targetMps) ac.gs = Math.min(targetMps, ac.gs + kt(t.accelKt) * dt);
  else ac.gs = Math.max(targetMps, ac.gs - kt(t.decelKt * 1.8) * dt);
}

function verticalTo(ac: Aircraft, targetAltM: number, dt: number): void {
  const t = getType(ac.typeId);
  const diff = targetAltM - ac.altM;
  if (Math.abs(diff) < 0.3) {
    ac.vs = 0;
    return;
  }
  const base = diff > 0 ? ft(t.climbFpm) / 60 : -ft(t.descentFpm) / 60;
  const rate = base * (ac.expedite ? 1.3 : 1);
  const step = Math.sign(diff) * Math.min(Math.abs(diff), Math.abs(rate) * dt);
  ac.altM += step;
  ac.vs = step / dt;
}

function windComponent(ac: Aircraft, env: SimEnv): number {
  return kt(env.windKt) * Math.cos((env.windDirDeg + 180 - ac.hdg) * DEG);
}

function integrate(ac: Aircraft, env: SimEnv, dt: number): void {
  const ground = isGroundPhase(ac);
  const v = ground ? ac.gs : Math.max(0, ac.gs + windComponent(ac, env));
  const d = fromBearing(ac.hdg, v * dt);
  ac.pos = { x: ac.pos.x + d.x, y: ac.pos.y + d.y };
  if (ground) ac.altM = env.idx.def.elevationM;
}

function followRoute(ac: Aircraft, lookaheadM: number, dt: number) {
  if (!ac.route) return null;
  const r = ac.route.follow(ac.pos, lookaheadM);
  const desired = bearing(ac.pos, r.target);
  if (dist(ac.pos, r.target) > 2) turnTo(ac, desired, dt);
  return r;
}

/** 地面：前车太近就停住，避免追尾（也是地面冲突的第一道闸） */
function touchdown(ac: Aircraft, env: SimEnv): void {
  ac.altM = env.idx.def.elevationM;
  ac.vs = 0;
  ac.gs = Math.min(ac.gs, kt(140));
  ac.phase = "landing";
  ac.hdg = env.idx.runway.hdg;
  ac.approach = null;
  env.countLanding(ac);
}

export function goAround(ac: Aircraft, env: SimEnv): void {
  env.countGoAround(ac);
  ac.approach = null;
  ac.landCleared = false;
  ac.lineupCleared = false;
  ac.phase = "arrival";
  const { threshold } = env.idx.runway;
  const { dir, normal } = env.idx;
  const point = (along: number, side: number) => ({ x: threshold.x + dir.x * along + normal.x * side, y: threshold.y + dir.y * along + normal.y * side });
  ac.route = makeRoute([ac.pos, point(6000, 0), point(6000, 9000), point(-18000, 9000), point(-18000, 2000), point(-14000, 0)]);
  ac.clearedHdg = null;
  ac.clearedAltM = ft(3000);
  ac.expedite = false;
  ac.targetGs = kt(220);
  ac.missedApproachNotified = true;
  ac.controller = "APP";
  ac.airHolding = false;
  env.notify(`${ac.callsign} 执行复飞`, "warn");
}

export function stepAircraft(ac: Aircraft, env: SimEnv): void {
  const dt = env.dt;
  const idx = env.idx;
  const elev = idx.def.elevationM;

  switch (ac.phase) {
    case "parked": {
      ac.gs = 0;
      if (ac.removeAt !== null && env.time >= ac.removeAt) env.finish(ac);
      return;
    }

    case "pushback": {
      const finished = advanceGround(ac, env, 5, ac.clearedHdg ?? 0);
      if (env.mode === "standard" ? finished : finished || (ac.route?.minS ?? 0) > 40) {
        ac.phase = env.mode === "standard" ? "taxi_ready" : "taxi_out";
        ac.clearedHdg = null;
        if (env.mode === "standard") { ac.route = null; env.say("GND", ac.callsign, "推出完成，请求滑行许可"); }
      }
      return;
    }

    case "taxi_ready": {
      ac.gs = 0; ac.vs = 0; ac.altM = elev;
      if (ac.kind === "arr" && !ac.standId) ac.standId = env.assignStand(ac);
      return;
    }

    case "taxi_out": {
      if (advanceGround(ac, env, 15)) {
        ac.phase = "hold_short";
        ac.gs = 0;
        ac.route = null;
        env.say("TWR", ac.callsign, "跑道外等待");
      }
      return;
    }

    case "hold_short": {
      ac.gs = 0;
      ac.vs = 0;
      ac.altM = elev;
      return;
    }

    case "lineup": {
      if (advanceGround(ac, env, 8)) {
        ac.gs = 0;
        ac.route = null;
        ac.hdg = idx.runway.hdg;
        ac.pos = {
          x: idx.runway.threshold.x + idx.dir.x * 80,
          y: idx.runway.threshold.y + idx.dir.y * 80,
        };
        ac.altM = elev;
        if (ac.takeoffPending) ac.phase = "takeoff";
      }
      return;
    }

    case "takeoff": {
      const t = getType(ac.typeId);
      ac.gs = Math.min(kt(t.rotationKt), ac.gs + kt(3.6) * dt);
      ac.hdg = idx.runway.hdg;
      ac.altM = elev;
      integrate(ac, env, dt);
      if (ac.gs >= kt(t.rotationKt) - 0.5) {
        ac.phase = "departure";
        env.countTakeoff(ac);
        startDepartureRoute(ac, env);
      }
      return;
    }

    case "departure": {
      if (ac.clearedHdg !== null) turnTo(ac, ac.clearedHdg, dt);
      else followRoute(ac, 1800, dt);
      speedTo(ac, ac.targetGs, dt);
      verticalTo(ac, ac.clearedAltM ?? ft(5000), dt);
      integrate(ac, env, dt);
      if (env.runwayOccupantId === ac.id && (ac.altM - elev > 100 || alongRunway(idx, ac.pos) < -1200)) {
        env.vacateRunway(ac);
      }
      if ((ac.route && ac.route.minS >= ac.route.total - 1) || dist(ac.pos, idx.runway.threshold) > 42000) {
        if (ac.altM - elev > ft(1500)) {
          if (env.mode === "standard" && ac.controller !== "DEP") env.addViolation(ac, "未完成离场移交", 8);
          env.finish(ac);
        }
      }
      return;
    }

    case "arrival": {
      const r = followRoute(ac, 2200, dt);
      verticalTo(ac, ac.clearedAltM ?? ac.altM, dt);
      speedTo(ac, ac.targetGs, dt);
      integrate(ac, env, dt);
      if (r && r.finished) {
        if (ac.airHolding && ac.route) { ac.route = makeRoute(ac.route.points.map((p) => ({ ...p }))); return; }
        ac.route = null;
        if (ac.clearedHdg === null) ac.clearedHdg = bearingToThreshold(idx, ac.pos);
      }
      if (ac.route === null && ac.clearedHdg !== null) turnTo(ac, ac.clearedHdg, dt);
      if (alongRunway(idx, ac.pos) > 1500 && !ac.missedApproachNotified) {
        ac.missedApproachNotified = true;
        env.notify(`${ac.callsign} 错过进近，请重新引导至 ${idx.def.arrival.iafFix}`, "warn");
        if (!ac.route) goAround(ac, env);
      }
      return;
    }

    case "approach": {
      const along = alongRunway(idx, ac.pos);
      const before = -along;

      // 已飞越跑道入口：给过落地许可就接地，否则复飞
      if (before <= 0) {
        const stable = Math.abs(lateralOffset(idx, ac.pos)) <= idx.runway.widthM / 2 &&
          ac.altM <= elev + 15 && Math.abs(angleDiff(ac.hdg, idx.runway.hdg)) <= 10;
        if (stable && ac.landCleared && env.runwayOccupantId === null) {
          env.occupyRunway(ac);
          touchdown(ac, env);
        } else {
          goAround(ac, env);
        }
        return;
      }

      const aimDist = Math.max(0, before - 250);
      const aim: Vec2 = {
        x: idx.runway.threshold.x - idx.dir.x * aimDist,
        y: idx.runway.threshold.y - idx.dir.y * aimDist,
      };
      turnTo(ac, bearing(ac.pos, aim), dt);
      verticalTo(ac, Math.max(elev, glideAltM(idx, ac.pos)), dt);

      const speedKt = before > 15000 ? 230 : before > 9000 ? 180 : before > 5000 ? 160 : getType(ac.typeId).vappKt;
      speedTo(ac, Math.max(kt(getType(ac.typeId).vappKt), Math.min(ac.targetGs, kt(speedKt))), dt);

      if (ac.approach && !ac.approach.established && Math.abs(lateralOffset(idx, ac.pos)) < 200 && Math.abs(angleDiff(ac.hdg, idx.runway.hdg)) < 10) {
        ac.approach.established = true;
      }
      integrate(ac, env, dt);

      return;
    }

    case "landing": {
      ac.gs = Math.max(kt(10), ac.gs - 2.2 * dt);
      ac.hdg = idx.runway.hdg;
      ac.altM = elev;
      // 滑跑：沿跑道方向推进（不能只做投影，否则位置永远不动）
      const along = Math.max(0, alongRunway(idx, ac.pos)) + ac.gs * dt;
      ac.pos = {
        x: idx.runway.threshold.x + idx.dir.x * along,
        y: idx.runway.threshold.y + idx.dir.y * along,
      };
      const exit = ac.exitNodeId
        ? idx.exitsByDistance.find((e) => e.node === ac.exitNodeId) ?? null
        : pickExit(idx, along, ac.gs);
      if (exit && along >= exit.atM && ac.gs <= kt(20)) {
        const node = idx.nodes.get(exit.node)!;
        ac.phase = "taxi_in";
        ac.exitNodeId = exit.node;
        ac.pos = { ...node.pos };
        ac.hdg = idx.runway.hdg + 90;
        ac.gs = kt(10);
        ac.standId = ac.standId ?? env.assignStand(ac);
        if (env.mode === "standard") {
          const clear = idx.def.edges.find((edge) => edge.a === exit.node);
          if (clear) {
            ac.route = makeRoute([ac.pos, idx.nodes.get(clear.b)!.pos]);
            ac.groundGoal = "clear";
          }
          return;
        }
        const stand = idx.stands.get(ac.standId ?? "");
        if (stand) {
          const pts = routeFrom(idx, ac.pos, exit.node, stand.node, "arr");
          if (pts) ac.route = makeRoute(pts);
        }
      }
      return;
    }

    case "taxi_in": {
      // 脱离口仍在跑道中心线上，机尾越过道面后才能释放跑道。
      if (env.runwayOccupantId === ac.id && Math.abs(lateralOffset(idx, ac.pos)) > idx.runway.widthM / 2 + ac.lengthM) env.vacateRunway(ac);
      if (!ac.route) {
        ac.standId = ac.standId ?? env.assignStand(ac);
        const stand = idx.stands.get(ac.standId ?? "");
        if (stand && ac.exitNodeId) {
          const pts = routeFrom(idx, ac.pos, ac.groundNodeId ?? ac.exitNodeId, stand.node, "arr");
          if (pts) ac.route = makeRoute(pts);
        }
        if (!ac.route) { ac.gs = 0; return; }
      }
      if (advanceGround(ac, env, 12)) {
        if (ac.groundGoal === "clear") {
          ac.phase = "taxi_ready"; ac.route = null; ac.groundGoal = null;
          env.vacateRunway(ac);
          env.say("TWR", ac.callsign, "跑道已脱离，请求联系地面");
          return;
        }
        const stand = idx.stands.get(ac.standId ?? "");
        if (stand) {
          ac.pos = { ...stand.pos };
          ac.hdg = stand.hdg;
        }
        ac.phase = "parked";
        ac.gs = 0;
        ac.route = null;
        ac.removeAt = env.time + 120;
        releaseGround(ac, env);
        env.countService(ac);
      }
      return;
    }

    case "done":
      return;
  }
}

function startDepartureRoute(ac: Aircraft, env: SimEnv): void {
  const pts: Vec2[] = [ac.pos];
  for (const name of env.idx.def.departure) {
    const f = env.idx.fixes.get(name);
    if (f) pts.push(f.pos);
  }
  ac.route = makeRoute(pts);
  ac.clearedAltM = ac.clearedAltM ?? ft(5000);
  ac.targetGs = kt(250);
}

export interface SpawnSpec {
  id: string;
  callsign: string;
  airline: string;
  typeId: string;
  kind: "arr" | "dep";
  standId: string | null;
  entryFix?: string;
  arrivalRoute?: string[];
  initialAltFt?: number;
  initialSpeedKt?: number;
}

function baseAircraft(spec: SpawnSpec, type: AircraftTypeDef): Aircraft {
  return {
    id: spec.id,
    callsign: spec.callsign,
    airline: spec.airline,
    typeId: spec.typeId,
    kind: spec.kind,
    pos: { x: 0, y: 0 },
    altM: 0,
    hdg: 0,
    gs: 0,
    vs: 0,
    phase: "parked",
    controller: spec.kind === "dep" ? "GND" : "APP",
    airHolding: false,
    groundNodeId: null,
    groundGoal: null,
    blockedBy: null,
    scheduledMovementAt: 0,
    clearedAltM: null,
    clearedHdg: null,
    targetGs: 0,
    expedite: false,
    route: null,
    approach: null,
    landCleared: false,
    lineupCleared: false,
    exitNodeId: null,
    standId: spec.standId,
    holding: false,
    takeoffPending: false,
    missedApproachNotified: false,
    lengthM: type.lengthM,
    stuckTimer: 0,
    lastPos: { x: 0, y: 0 },
    spawnedAt: 0,
    removeAt: null,
    scored: { landed: false, departed: false },
  };
}

export function spawnArrival(env: SimEnv, spec: SpawnSpec): Aircraft {
  const idx = env.idx;
  const entryName = spec.entryFix ?? idx.def.arrival.entryFix;
  const entry = idx.fixes.get(entryName);
  const routeNames = spec.arrivalRoute ?? [idx.def.arrival.iafFix];
  const fixes = routeNames.map((name) => idx.fixes.get(name));
  if (!entry || fixes.some((fix) => !fix) || fixes.length === 0) throw new Error(`无效进场航路：${entryName} → ${routeNames.join(" → ")}`);
  const points = [entry.pos, ...fixes.map((fix) => fix!.pos)];
  const type = getType(spec.typeId);
  const ac = baseAircraft(spec, type);
  ac.pos = { ...entry.pos };
  ac.altM = ft(spec.initialAltFt ?? 6000);
  ac.hdg = bearing(points[0]!, points[1]!);
  ac.gs = kt(spec.initialSpeedKt ?? 250);
  ac.targetGs = ac.gs;
  ac.clearedAltM = ac.altM;
  ac.phase = "arrival";
  ac.route = makeRoute(points);
  ac.spawnedAt = env.time;
  ac.scheduledMovementAt = env.time + 7 * 60;
  ac.lastPos = { ...ac.pos };
  return ac;
}

export function spawnDeparture(env: SimEnv, spec: SpawnSpec): Aircraft | null {
  const idx = env.idx;
  const stand = idx.stands.get(spec.standId ?? "");
  if (!stand) return null;
  const type = getType(spec.typeId);
  if (type.wake === "H" && stand.size !== "L") return null;
  const ac = baseAircraft(spec, type);
  ac.pos = { ...stand.pos };
  ac.altM = idx.def.elevationM;
  ac.hdg = stand.hdg;
  ac.phase = "parked";
  ac.spawnedAt = env.time;
  ac.scheduledMovementAt = env.time + 6 * 60;
  ac.groundNodeId = stand.node;
  ac.lastPos = { ...ac.pos };
  return ac;
}

/** 从任意点重新引导到某个航路点 */
export function routeViaFix(env: SimEnv, ac: Aircraft, fixName: string): boolean {
  const fix = env.idx.fixes.get(fixName);
  if (!fix) return false;
  ac.route = makeRoute([ac.pos, fix.pos]);
  ac.clearedHdg = null;
  ac.airHolding = false;
  return true;
}
