import type { AirportDef, FixDef, RunwayDef, StandDef, TaxiNodeDef } from "./types";
import { GLIDE_SLOPE, kt, norm360 } from "./units";
import { bearing, dist, dot, fromBearing, sub, type Vec2 } from "./vec";

export interface AirportIndex {
  def: AirportDef;
  runway: RunwayDef;
  nodes: Map<string, TaxiNodeDef>;
  stands: Map<string, StandDef>;
  fixes: Map<string, FixDef>;
  adjacency: Map<string, { to: string; kt: number; traffic?: "arr" | "dep" }[]>;
  /** 跑道方向单位向量（指向着陆方向） */
  dir: Vec2;
  /** 跑道法向（左正右负，仅用于离线偏差） */
  normal: Vec2;
  holdingNode: string;
  lineupNode: string;
  /** 从跑道入口算起的脱离口，按距离升序 */
  exitsByDistance: { name: string; node: string; atM: number; highSpeed: boolean }[];
}

const DEFAULT_TAXI_KT = 15;

export function buildAirport(def: AirportDef, runwayId: string): AirportIndex {
  const runway = def.runways.find((r) => r.id === runwayId);
  if (!runway) throw new Error(`机场 ${def.icao}: 找不到跑道 ${runwayId}`);

  const nodes = new Map(def.nodes.map((n) => [n.id, n]));
  const stands = new Map(def.stands.map((s) => [s.id, s]));
  const fixes = new Map(def.fixes.map((f) => [f.name, f]));
  const adjacency: AirportIndex["adjacency"] = new Map();
  for (const n of def.nodes) adjacency.set(n.id, []);

  for (const e of def.edges) {
    if (!nodes.has(e.a)) throw new Error(`机场 ${def.icao}: 边 ${e.a}-${e.b} 引用了不存在的节点 ${e.a}`);
    if (!nodes.has(e.b)) throw new Error(`机场 ${def.icao}: 边 ${e.a}-${e.b} 引用了不存在的节点 ${e.b}`);
    const kt = e.maxKt ?? DEFAULT_TAXI_KT;
    adjacency.get(e.a)!.push({ to: e.b, kt, traffic: e.traffic });
    if (!e.oneWay) adjacency.get(e.b)!.push({ to: e.a, kt, traffic: e.traffic });
  }

  const holdingNode = def.nodes.find((n) => n.kind === "holding")?.id;
  const lineupNode = def.nodes.find((n) => n.kind === "lineup")?.id;
  if (!holdingNode) throw new Error(`机场 ${def.icao}: 缺少 holding 节点（跑道外等待点）`);
  if (!lineupNode) throw new Error(`机场 ${def.icao}: 缺少 lineup 节点（进跑道点）`);
  const direction = fromBearing(runway.hdg);
  const expectedLineup = { x: runway.threshold.x + direction.x * 80, y: runway.threshold.y + direction.y * 80 };
  if (dist(nodes.get(lineupNode)!.pos, expectedLineup) > 10) throw new Error(`机场 ${def.icao}: 跑道 ${runwayId} 尚未配置对应方向的进跑道点`);
  if (!runway.exits.length) throw new Error(`机场 ${def.icao}: 跑道 ${runwayId} 缺少脱离口`);

  for (const s of def.stands) {
    if (!nodes.has(s.node)) throw new Error(`机场 ${def.icao}: 机位 ${s.id} 引用了不存在的节点 ${s.node}`);
  }
  if (!fixes.has(def.arrival.entryFix)) throw new Error(`机场 ${def.icao}: 缺少进场入口点 ${def.arrival.entryFix}`);
  if (!fixes.has(def.arrival.iafFix)) throw new Error(`机场 ${def.icao}: 缺少 IAF ${def.arrival.iafFix}`);
  for (const f of def.departure) {
    if (!fixes.has(f)) throw new Error(`机场 ${def.icao}: 离场航路点 ${f} 不存在`);
  }

  // 反向遍历验证每个机位能到等待点；有向图不能从等待点向外做此检查。
  const reach = new Set<string>();
  const queue = [holdingNode];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (reach.has(cur)) continue;
    reach.add(cur);
    for (const [from, neighbors] of adjacency) if (neighbors.some((nb) => nb.to === cur)) queue.push(from);
  }
  for (const s of def.stands) {
    if (!reach.has(s.node)) throw new Error(`机场 ${def.icao}: 机位 ${s.id} 与跑道外等待点不连通`);
  }
  for (const ex of runway.exits) if (!nodes.has(ex.node)) throw new Error(`机场 ${def.icao}: 脱离口 ${ex.name} 不存在`);

  const dir = fromBearing(runway.hdg);
  const normal = { x: -dir.y, y: dir.x };

  return {
    def,
    runway,
    nodes,
    stands,
    fixes,
    adjacency,
    dir,
    normal,
    holdingNode,
    lineupNode,
    exitsByDistance: [...runway.exits].sort((a, b) => a.atM - b.atM),
  };
}

/** 最近的可脱离口（按当前地速估算需要的滑跑距离） */
export function pickExit(idx: AirportIndex, sAlongM: number, gs: number): { name: string; node: string; atM: number } | null {
  return idx.exitsByDistance.find((ex) => usableExit(ex, sAlongM, gs)) ?? null;
}

export function usableExit(ex: { atM: number; highSpeed: boolean }, along: number, gs: number): boolean {
  const exitSpeed = kt(12);
  const brakingDistance = Math.max(0, (gs * gs - exitSpeed * exitSpeed) / (2 * 2.2)) + (gs > kt(20) ? gs * 1.5 : 0);
  return ex.atM >= along - 2 && ex.atM - along + 2 >= brakingDistance;
}

/** 沿跑道方向、距入口的距离（负值表示还没到入口） */
export function alongRunway(idx: AirportIndex, pos: Vec2): number {
  return dot(sub(pos, idx.runway.threshold), idx.dir);
}

/** 相对跑道中心线的横向偏差（米），正为跑道左侧 */
export function lateralOffset(idx: AirportIndex, pos: Vec2): number {
  return dot(sub(pos, idx.runway.threshold), idx.normal);
}

export function distanceToThreshold(idx: AirportIndex, pos: Vec2): number {
  return dist(pos, idx.runway.threshold);
}

/** 三度下滑道在该位置应处的高度（米）。距入口越远越高。 */
export function glideAltM(idx: AirportIndex, pos: Vec2): number {
  const beforeThreshold = -alongRunway(idx, pos);
  return idx.def.elevationM + (beforeThreshold >= 0 ? 15 + beforeThreshold * GLIDE_SLOPE : 15 * Math.max(0, 1 + beforeThreshold / 250) ** 2);
}

export function nodePos(idx: AirportIndex, id: string): Vec2 {
  const n = idx.nodes.get(id);
  if (!n) throw new Error(`未知滑行节点 ${id}`);
  return n.pos;
}

/** Dijkstra：返回节点 id 序列（含起终点），不可达返回 null */
export function findTaxiPath(idx: AirportIndex, from: string, to: string, traffic?: "arr" | "dep"): string[] | null {
  if (from === to) return [from];
  const distTo = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  distTo.set(from, 0);
  const open = new Set<string>([from]);
  while (open.size > 0) {
    let cur: string | null = null;
    let best = Infinity;
    for (const id of open) {
      const d = distTo.get(id) ?? Infinity;
      if (d < best) {
        best = d;
        cur = id;
      }
    }
    if (cur === null) break;
    open.delete(cur);
    if (cur === to) break;
    visited.add(cur);
    for (const nb of idx.adjacency.get(cur) ?? []) {
      if (traffic && nb.traffic && nb.traffic !== traffic) continue;
      if (visited.has(nb.to)) continue;
      const nd = best + dist(nodePos(idx, cur), nodePos(idx, nb.to));
      if (nd < (distTo.get(nb.to) ?? Infinity)) {
        distTo.set(nb.to, nd);
        prev.set(nb.to, cur);
        open.add(nb.to);
      }
    }
  }
  if (!distTo.has(to)) return null;
  const path: string[] = [to];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    path.unshift(p);
    cur = p;
  }
  return path;
}

export function pathPoints(idx: AirportIndex, path: string[]): Vec2[] {
  return path.map((id) => nodePos(idx, id));
}

export function standById(idx: AirportIndex, id: string | undefined): StandDef | null {
  if (!id) return null;
  return idx.stands.get(id) ?? null;
}

/** 从某个坐标出发，沿滑行图到目标节点的折线（起点是飞机自身位置） */
export function routeFrom(idx: AirportIndex, startPos: Vec2, startNode: string, targetNode: string, traffic?: "arr" | "dep"): Vec2[] | null {
  const path = findTaxiPath(idx, startNode, targetNode, traffic);
  if (!path) return null;
  return [startPos, ...pathPoints(idx, path)];
}

/** 离场航路：起飞后依次飞过的点（用跑道延长线 + 航路点，简化 SID） */
export function departureRoute(idx: AirportIndex): Vec2[] {
  const pts = [idx.runway.threshold, ...idx.def.departure.map((f) => idx.fixes.get(f)!.pos)];
  return pts;
}

/** 进场程序：入口点 → IAF（之后由玩家引导或截获 ILS） */
export function arrivalRoute(idx: AirportIndex): Vec2[] {
  const entry = idx.fixes.get(idx.def.arrival.entryFix)!.pos;
  const iaf = idx.fixes.get(idx.def.arrival.iafFix)!.pos;
  return [entry, iaf];
}

/** 从 IAF 之后默认飞向跑道入口的航向 */
export function bearingToThreshold(idx: AirportIndex, pos: Vec2): number {
  return bearing(pos, idx.runway.threshold);
}

export function runwayHeadingDiff(idx: AirportIndex, hdg: number): number {
  const d = Math.abs(norm360(hdg) - norm360(idx.runway.hdg));
  return d > 180 ? 360 - d : d;
}
