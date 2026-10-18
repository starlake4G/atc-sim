import { findTaxiPath } from "./airport";
import type { SimEnv } from "./env";
import { makeRoute, makeGroundRoute } from "./route";
import type { Aircraft, Command, Route } from "./types";
import { angleDiff, clamp, kt, norm360 } from "./units";
import { bearing, dist, fromBearing, type Vec2 } from "./vec";

const pointKey = (p: Vec2) => `${Math.round(p.x)},${Math.round(p.y)}`;
const groundPhases = new Set(["parked", "pushback", "taxi_ready", "taxi_out", "hold_short", "lineup", "takeoff", "landing", "taxi_in"]);

/** Shared lanes allow convoys. Only junctions are leased; following uses a speed controller. */
export function advanceGround(ac: Aircraft, env: SimEnv, speedKt: number, noseHdg?: number): boolean {
  const route = ac.route;
  ac.blockedBy = null;
  if (!route || route.total < .5) { ac.gs = 0; releaseGround(ac, env); return true; }
  let start = 0;
  let index = 0;
  while (index < route.points.length - 2 && start + dist(route.points[index]!, route.points[index + 1]!) <= route.minS + .01) {
    start += dist(route.points[index]!, route.points[index + 1]!); index++;
  }
  const a = route.points[index]!;
  const b = route.points[index + 1]!;
  const segLength = dist(a, b);
  const progress = route.minS - start;
  const from = [...env.idx.nodes.values()].find((n) => dist(n.pos, a) < 1);
  const to = [...env.idx.nodes.values()].find((n) => dist(n.pos, b) < 1);
  const curve = route.points.length > 20;
  const junction = curve ? [...env.idx.nodes.values()].find((n) => dist(n.pos, route.points.at(-1)!) < 1) : to;
  const junctionPoint = junction?.pos ?? b;
  const junctionRemaining = curve ? route.total - route.minS : segLength - progress;
  const limit = from && to ? env.idx.adjacency.get(from.id)?.find((n) => n.to === to.id)?.kt ?? speedKt : speedKt;
  let target = kt(Math.min(speedKt, limit));
  let stopS = route.total;
  const keys: string[] = [];
  const startKey = `node:${pointKey(a)}`, endKey = `node:${pointKey(junctionPoint)}`;
  if (from && progress < ac.lengthM / 2 + 15 && (!env.groundLocks.has(startKey) || env.groundLocks.get(startKey) === ac.id)) keys.push(startKey);
  let junctionBlocked = false;
  let junctionGap = ac.lengthM / 2 + 20;
  for (const other of env.aircraftList()) {
    if (other.id === ac.id || !groundPhases.has(other.phase)) continue;
    if (junction && dist(other.pos, junctionPoint) < other.lengthM / 2 + 12 && dist(ac.pos, junctionPoint) > dist(other.pos, junctionPoint) + 2) {
      junctionBlocked = true;
      junctionGap = Math.max(junctionGap, (ac.lengthM + other.lengthM) / 2 + 16);
      ac.blockedBy = `跟随 ${other.callsign} · 交汇点让行`;
    }
  }
  const owner = env.groundLocks.get(endKey);
  if (junction && owner && owner !== ac.id) { junctionBlocked = true; ac.blockedBy = "交汇点让行"; const other = env.aircraftList().find((a) => a.id === owner); if (other) junctionGap = Math.max(junctionGap, (ac.lengthM + other.lengthM) / 2 + 16); }
  if (junction && junctionRemaining < ac.lengthM / 2 + 65) {
    if (junctionBlocked) stopS = Math.min(stopS, route.minS + junctionRemaining - junctionGap);
    else keys.push(endKey);
  }
  if (junctionBlocked && env.groundLocks.get(endKey) === ac.id) env.groundLocks.delete(endKey);
  const direction = { x: (b.x - a.x) / segLength, y: (b.y - a.y) / segLength };
  const nextPoint = route.points[index + 2];
  const continuesStraight = nextPoint && Math.abs(angleDiff(bearing(b, nextPoint), bearing(a, b))) < 30;
  for (const other of env.aircraftList()) {
    if (other.id === ac.id || !groundPhases.has(other.phase)) continue;
    const dx = other.pos.x - ac.pos.x, dy = other.pos.y - ac.pos.y;
    const ahead = dx * direction.x + dy * direction.y;
    const lateral = Math.abs(dx * direction.y - dy * direction.x);
    const clearance = (ac.lengthM + other.lengthM) / 2 + 12;
    if (ahead > 0 && ahead < clearance + 100 + ac.gs * 8 && (continuesStraight || ahead < segLength - progress + other.lengthM / 2 + 5) && lateral < 18) {
      const sameDirection = Math.abs(angleDiff(other.hdg, bearing(a, b))) < 60 && other.phase !== "pushback";
      const leadSpeed = sameDirection ? other.gs : 0;
      target = Math.min(target, Math.max(0, leadSpeed + .3 * (ahead - clearance - 12 - ac.gs * 2)));
      stopS = Math.min(stopS, route.minS + Math.max(0, ahead - clearance));
      ac.blockedBy = `自动跟随 ${other.callsign}`;
    }
  }
  for (const [key, owner] of env.groundLocks) if (owner === ac.id && !keys.includes(key)) env.groundLocks.delete(key);
  keys.forEach((key) => env.groundLocks.set(key, ac.id));
  target = Math.min(target, Math.sqrt(2 * 1.2 * Math.max(0, stopS - route.minS - .05)));
  if (ac.holding) { target = 0; ac.blockedBy = "管制员要求等待"; }
  // Curves slow the aircraft before nose steering falls behind the ground track.
  const lookBearing = bearing(route.pointAt(Math.max(0, route.minS - 1)), route.pointAt(Math.min(route.total, route.minS + 3)));
  const desired = noseHdg ?? norm360(lookBearing + (ac.phase === "pushback" ? 180 : 0));
  if (Math.abs(angleDiff(desired, ac.hdg)) > 20) target = Math.min(target, kt(2));
  ac.gs = ac.gs < target ? Math.min(target, ac.gs + .8 * env.dt) : Math.max(target, ac.gs - 1.5 * env.dt);
  const end = start + segLength;
  const next = Math.min(route.total, Math.max(route.minS, stopS), route.minS + ac.gs * env.dt);
  if (next <= route.minS + 1e-7 && stopS < route.total) ac.gs = 0;
  route.minS = next;
  ac.pos = { ...route.pointAt(route.minS) };
  ac.altM = env.idx.def.elevationM;
  if (ac.gs > .01) ac.hdg = norm360(ac.hdg + clamp(angleDiff(desired, ac.hdg), -18 * env.dt, 18 * env.dt));
  if (route.minS >= end - .01 && to) ac.groundNodeId = to.id;
  if (route.minS >= route.total - .06 && ac.gs < .6) { ac.gs = 0; ac.pos = { ...route.points.at(-1)! }; if (to) ac.groundNodeId = to.id; releaseGround(ac, env); return true; }
  return false;
}

export function releaseGround(ac: Aircraft, env: SimEnv): void {
  for (const [key, owner] of env.groundLocks) if (owner === ac.id) env.groundLocks.delete(key);
}

export function taxiRoute(env: SimEnv, ac: Aircraft, command: Extract<Command, { kind: "taxi" }>): Route | null {
  const from = ac.groundNodeId;
  const target = ac.kind === "dep" ? env.idx.holdingNode : env.idx.stands.get(ac.standId ?? "")?.node;
  if (!from || !target) return null;
  const via = command.via ?? [];
  const nodes: string[] = [from];
  for (const next of [...via, target]) {
    if (env.idx.nodes.get(next)?.kind === "lineup" || env.idx.nodes.get(next)?.kind === "exit") return null;
    const path = findTaxiPath(env.idx, nodes.at(-1)!, next, ac.kind);
    if (!path) return null;
    nodes.push(...path.slice(1));
  }
  return makeGroundRoute([ac.pos, ...nodes.map((id) => env.idx.nodes.get(id)!.pos)]);
}

/** Sampled towing / steering curves. Nose follows the tangent, never a stationary pivot. */
export function steeringRoute(a: Vec2, b: Vec2, startBearing: number, endBearing: number, handle: number): Route {
  const v = fromBearing(startBearing, handle), w = fromBearing(endBearing, handle);
  const c = { x: a.x + v.x, y: a.y + v.y }, d = { x: b.x - w.x, y: b.y - w.y };
  return makeRoute(Array.from({ length: 65 }, (_, i) => {
    const t = i / 64, u = 1 - t;
    return { x: u ** 3 * a.x + 3 * u * u * t * c.x + 3 * u * t * t * d.x + t ** 3 * b.x,
      y: u ** 3 * a.y + 3 * u * u * t * c.y + 3 * u * t * t * d.y + t ** 3 * b.y };
  }));
}

export function pushbackRoute(ac: Aircraft, target: Vec2, nose: number): Route {
  // Opposite headings need room to tow around a loop; an offset handle avoids a cusp.
  const route = steeringRoute(ac.pos, target, ac.hdg + 180, nose + 180, 45);
  if (Math.abs(angleDiff(nose, ac.hdg)) > 150) {
    const points = route.points.map((p, i) => ({ x: p.x + 38 * Math.sin(Math.PI * i / (route.points.length - 1)) ** 2, y: p.y }));
    return makeRoute(points);
  }
  return route;
}

export function lineupRoute(env: SimEnv, ac: Aircraft): Route {
  return steeringRoute(ac.pos, env.idx.nodes.get(env.idx.lineupNode)!.pos, 180, env.idx.runway.hdg, 60);
}

/** Paved curve and simulation trajectory share endpoints and steering handles. */
export function groundEdgePoints(env: Pick<SimEnv, "idx">, aId: string, bId: string): Vec2[] {
  const a = env.idx.nodes.get(aId)!, b = env.idx.nodes.get(bId)!;
  if (b.kind === "lineup") return steeringRoute(a.pos, b.pos, 180, env.idx.runway.hdg, 60).points;
  if (a.kind === "exit") {
    const start = { x: a.pos.x - env.idx.dir.x * 35, y: a.pos.y - env.idx.dir.y * 35 };
    return steeringRoute(start, b.pos, env.idx.runway.hdg, bearing(a.pos, b.pos), 45).points;
  }
  return [a.pos, b.pos];
}
