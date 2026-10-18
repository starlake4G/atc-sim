import { findTaxiPath } from "./airport";
import type { SimEnv } from "./env";
import { makeRoute } from "./route";
import type { Aircraft, Command, Route } from "./types";
import { angleDiff, clamp, kt, norm360 } from "./units";
import { bearing, dist, type Vec2 } from "./vec";

const pointKey = (p: Vec2) => `${Math.round(p.x)},${Math.round(p.y)}`;
const edgeKey = (a: Vec2, b: Vec2) => [pointKey(a), pointKey(b)].sort().join("/");
const groundPhases = new Set(["parked", "pushback", "taxi_ready", "taxi_out", "hold_short", "lineup", "takeoff", "landing", "taxi_in"]);

/** Arc-length movement stays on pavement. Short segment and junction reservations prevent merge races. */
export function advanceGround(ac: Aircraft, env: SimEnv, speedKt: number, noseHdg?: number): boolean {
  const route = ac.route;
  ac.blockedBy = null;
  if (!route || route.total < .5) { ac.gs = 0; releaseGround(ac, env); return true; }
  if (ac.holding) { ac.gs = 0; ac.blockedBy = "管制员要求等待"; return false; }
  let start = 0;
  let index = 0;
  while (index < route.points.length - 2 && start + dist(route.points[index]!, route.points[index + 1]!) <= route.minS + .01) {
    start += dist(route.points[index]!, route.points[index + 1]!); index++;
  }
  const a = route.points[index]!;
  const b = route.points[index + 1]!;
  const segLength = dist(a, b);
  const progress = route.minS - start;
  const keys = [edgeKey(a, b)];
  if (progress < ac.lengthM + 12) keys.push(`node:${pointKey(a)}`);
  if (segLength - progress < ac.lengthM + 45) keys.push(`node:${pointKey(b)}`);
  // A queued follower cannot reserve the node already occupied by the leading aircraft.
  // Otherwise it can prevent that leader leaving, creating a circular wait at H27.
  for (const other of env.aircraftList()) {
    if (other.id === ac.id || !groundPhases.has(other.phase)) continue;
    if (dist(other.pos, b) < other.lengthM / 2 + 9 && dist(ac.pos, b) > dist(other.pos, b) + 2) {
      const targetKey = `node:${pointKey(b)}`;
      if (env.groundLocks.get(targetKey) === ac.id) env.groundLocks.delete(targetKey);
      ac.blockedBy = `等待 ${other.callsign} 离开交汇点`; ac.gs = 0; return false;
    }
  }
  for (const key of keys) {
    const owner = env.groundLocks.get(key);
    if (owner && owner !== ac.id) {
      const other = env.aircraftList().find((o) => o.id === owner);
      ac.blockedBy = `${other?.callsign ?? "前机"} 正在通过路段`; ac.gs = 0; return false;
    }
  }
  const direction = { x: (b.x - a.x) / segLength, y: (b.y - a.y) / segLength };
  for (const other of env.aircraftList()) {
    if (other.id === ac.id || !groundPhases.has(other.phase)) continue;
    const dx = other.pos.x - ac.pos.x, dy = other.pos.y - ac.pos.y;
    const ahead = dx * direction.x + dy * direction.y;
    const lateral = Math.abs(dx * direction.y - dy * direction.x);
    const gap = (ac.lengthM + other.lengthM) / 2 + 16;
    if (ahead > 0 && ahead < gap && lateral < 16) {
      ac.blockedBy = `等待 ${other.callsign} 通过`; ac.gs = 0; return false;
    }
  }
  for (const [key, owner] of env.groundLocks) if (owner === ac.id && !keys.includes(key)) env.groundLocks.delete(key);
  keys.forEach((key) => env.groundLocks.set(key, ac.id));
  const from = [...env.idx.nodes.values()].find((n) => dist(n.pos, a) < 1);
  const to = [...env.idx.nodes.values()].find((n) => dist(n.pos, b) < 1);
  const limit = from && to ? env.idx.adjacency.get(from.id)?.find((n) => n.to === to.id)?.kt ?? speedKt : speedKt;
  const target = kt(Math.min(speedKt, limit));
  ac.gs = ac.gs < target ? Math.min(target, ac.gs + .8 * env.dt) : Math.max(target, ac.gs - 1.5 * env.dt);
  const end = start + segLength;
  route.minS = Math.min(end, route.minS + ac.gs * env.dt);
  ac.pos = { ...route.pointAt(route.minS) };
  ac.altM = env.idx.def.elevationM;
  const desired = noseHdg ?? bearing(a, b);
  ac.hdg = norm360(ac.hdg + clamp(angleDiff(desired, ac.hdg), -18 * env.dt, 18 * env.dt));
  if (route.minS >= end - .01 && to) ac.groundNodeId = to.id;
  if (route.minS >= route.total - .01) { ac.gs = 0; releaseGround(ac, env); return true; }
  return false;
}

export function releaseGround(ac: Aircraft, env: SimEnv): void {
  for (const [key, owner] of env.groundLocks) if (owner === ac.id) env.groundLocks.delete(key);
}

export function taxiRoute(env: SimEnv, ac: Aircraft, command: Extract<Command, { kind: "taxi" }>): Route | null {
  const from = ac.groundNodeId;
  const target = ac.kind === "dep" ? env.idx.holdingNode : env.idx.stands.get(ac.standId ?? "")?.node;
  if (!from || !target) return null;
  const via = command.via?.length ? command.via : command.route === "bypass" && ac.kind === "dep" ? ["C700"] : [];
  const nodes: string[] = [from];
  for (const next of [...via, target]) {
    if (env.idx.nodes.get(next)?.kind === "lineup" || env.idx.nodes.get(next)?.kind === "exit") return null;
    const path = findTaxiPath(env.idx, nodes.at(-1)!, next, ac.kind);
    if (!path) return null;
    nodes.push(...path.slice(1));
  }
  return makeRoute([ac.pos, ...nodes.map((id) => env.idx.nodes.get(id)!.pos)]);
}
