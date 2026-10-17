import { getType } from "../data/aircraft-types";
import { alongRunway, bearingToThreshold, glideAltM, lateralOffset, pickExit, routeFrom } from "./airport";
import type { SimEnv } from "./env";
import { makeRoute } from "./route";
import type { Aircraft, AircraftTypeDef, Phase } from "./types";
import { DEG, RAD, angleDiff, clamp, ft, kt, norm360 } from "./units";
import { bearing, dist, fromBearing, type Vec2 } from "./vec";

const BANK_DEG = 25;
const AIR_MAX_TURN = 3.5;
const GROUND_MAX_TURN = 16;

const GROUND_PHASES = new Set<Phase>(["parked", "pushback", "taxi_out", "hold_short", "lineup", "landing", "taxi_in"]);

export const isGroundPhase = (ac: Aircraft): boolean => GROUND_PHASES.has(ac.phase);

export function isAirborne(ac: Aircraft): boolean {
  return ac.phase === "arrival" || ac.phase === "approach" || ac.phase === "departure" || ac.phase === "takeoff";
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
function blockedByTraffic(ac: Aircraft, env: SimEnv): boolean {
  for (const o of env.aircraftList()) {
    if (o.id === ac.id || !isGroundPhase(o)) continue;
    if (dist(ac.pos, o.pos) > 100) continue;
    if (Math.abs(angleDiff(bearing(ac.pos, o.pos), ac.hdg)) < 75) return true;
  }
  return false;
}

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
  ac.approach = null;
  ac.landCleared = false;
  ac.lineupCleared = false;
  ac.phase = "arrival";
  ac.route = null;
  ac.clearedHdg = env.idx.runway.hdg;
  ac.clearedAltM = ft(3000);
  ac.expedite = false;
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
      const r = ac.route ? ac.route.follow(ac.pos, 22) : null;
      speedTo(ac, 3, dt);
      if (r) {
        if (ac.clearedHdg !== null && r.s < 12) turnTo(ac, ac.clearedHdg, dt);
        else turnTo(ac, bearing(ac.pos, r.target), dt);
      }
      integrate(ac, env, dt);
      if (!r || r.finished || r.s > 40) {
        ac.phase = "taxi_out";
        ac.clearedHdg = null;
      }
      return;
    }

    case "taxi_out": {
      if (ac.holding || blockedByTraffic(ac, env)) {
        speedTo(ac, 0, dt);
        integrate(ac, env, dt);
        return;
      }
      const r = followRoute(ac, 35, dt);
      speedTo(ac, kt(13), dt);
      integrate(ac, env, dt);
      if (r && r.finished) {
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
      const r = followRoute(ac, 12, dt);
      speedTo(ac, kt(8), dt);
      integrate(ac, env, dt);
      if (!r || r.finished) {
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
      followRoute(ac, 1800, dt);
      speedTo(ac, kt(250), dt);
      verticalTo(ac, ac.clearedAltM ?? ft(5000), dt);
      integrate(ac, env, dt);
      if (env.runwayOccupantId === ac.id && (ac.altM - elev > 100 || alongRunway(idx, ac.pos) < -1200)) {
        env.vacateRunway(ac);
      }
      if ((ac.route && ac.route.minS >= ac.route.total - 1) || dist(ac.pos, idx.runway.threshold) > 42000) {
        if (ac.altM - elev > ft(1500)) env.finish(ac);
      }
      return;
    }

    case "arrival": {
      const r = followRoute(ac, 2200, dt);
      verticalTo(ac, ac.clearedAltM ?? ac.altM, dt);
      speedTo(ac, ac.targetGs, dt);
      integrate(ac, env, dt);
      if (r && r.finished) {
        ac.route = null;
        if (ac.clearedHdg === null) ac.clearedHdg = bearingToThreshold(idx, ac.pos);
      }
      if (ac.route === null && ac.clearedHdg !== null) turnTo(ac, ac.clearedHdg, dt);
      // 没清进近就飞过了跑道头：转回跑道方向重新引导，并提示一次
      if (alongRunway(idx, ac.pos) > 1500) {
        if (Math.abs(angleDiff(ac.hdg, idx.runway.hdg)) > 60) {
          env.notify(`${ac.callsign} 错过进近，已转回`, "warn");
        }
        ac.clearedHdg = idx.runway.hdg;
        ac.clearedAltM = Math.max(ac.clearedAltM ?? 0, ft(2500));
        ac.route = null;
      }
      return;
    }

    case "approach": {
      const along = alongRunway(idx, ac.pos);
      const before = -along;

      // 已飞越跑道入口：给过落地许可就接地，否则复飞
      if (before <= 0) {
        if (ac.landCleared && env.runwayOccupantId === null) {
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
      speedTo(ac, kt(speedKt), dt);

      if (ac.approach && !ac.approach.established && Math.abs(lateralOffset(idx, ac.pos)) < 200) {
        ac.approach.established = true;
      }
      integrate(ac, env, dt);

      if (along >= 40 && ac.altM <= elev + 4) {
        if (ac.landCleared && env.runwayOccupantId === null) {
          env.occupyRunway(ac);
          touchdown(ac, env);
        } else {
          goAround(ac, env);
        }
      }
      return;
    }

    case "landing": {
      ac.gs = Math.max(0, ac.gs - kt(2.2) * dt);
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
      if (exit && along >= exit.atM - 30) {
        const node = idx.nodes.get(exit.node)!;
        ac.phase = "taxi_in";
        ac.pos = { ...node.pos };
        ac.hdg = idx.runway.hdg + 90;
        ac.gs = Math.max(ac.gs, kt(10));
        env.vacateRunway(ac);
        ac.standId = ac.standId ?? env.assignStand(ac);
        const stand = idx.stands.get(ac.standId ?? "");
        if (stand) {
          const pts = routeFrom(idx, ac.pos, exit.node, stand.node);
          if (pts) ac.route = makeRoute(pts);
        }      }
      return;
    }

    case "taxi_in": {
      if (ac.holding || blockedByTraffic(ac, env)) {
        speedTo(ac, 0, dt);
        integrate(ac, env, dt);
        return;
      }
      const r = followRoute(ac, 30, dt);
      speedTo(ac, kt(12), dt);
      integrate(ac, env, dt);
      if (r && r.finished) {
        const stand = idx.stands.get(ac.standId ?? "");
        if (stand) {
          ac.pos = { ...stand.pos };
          ac.hdg = stand.hdg;
        }
        ac.phase = "parked";
        ac.gs = 0;
        ac.route = null;
        ac.removeAt = env.time + 120;
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
  const entry = idx.fixes.get(idx.def.arrival.entryFix)!;
  const iaf = idx.fixes.get(idx.def.arrival.iafFix)!;
  const type = getType(spec.typeId);
  const ac = baseAircraft(spec, type);
  ac.pos = { ...entry.pos };
  ac.altM = ft(6000);
  ac.hdg = bearing(entry.pos, iaf.pos);
  ac.gs = kt(250);
  ac.targetGs = kt(250);
  ac.clearedAltM = ft(6000);
  ac.phase = "arrival";
  ac.route = makeRoute([entry.pos, iaf.pos]);
  ac.spawnedAt = env.time;
  ac.lastPos = { ...ac.pos };
  return ac;
}

export function spawnDeparture(env: SimEnv, spec: SpawnSpec): Aircraft | null {
  const idx = env.idx;
  const stand = idx.stands.get(spec.standId ?? "");
  if (!stand) return null;
  const type = getType(spec.typeId);
  const ac = baseAircraft(spec, type);
  ac.pos = { ...stand.pos };
  ac.altM = idx.def.elevationM;
  ac.hdg = stand.hdg;
  ac.phase = "parked";
  ac.spawnedAt = env.time;
  ac.lastPos = { ...ac.pos };
  return ac;
}

/** 从任意点重新引导到某个航路点 */
export function routeViaFix(env: SimEnv, ac: Aircraft, fixName: string): boolean {
  const fix = env.idx.fixes.get(fixName);
  if (!fix) return false;
  ac.route = makeRoute([ac.pos, fix.pos]);
  ac.clearedHdg = null;
  return true;
}
