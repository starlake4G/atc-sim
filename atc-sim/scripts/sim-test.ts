import { confirmed } from "./test-radio";
import { AIRPORTS } from "../src/data/airports";
import { alongRunway, buildAirport, findTaxiPath, lateralOffset } from "../src/sim/airport";
import { botTick } from "../src/sim/bot";
import { makeRoute } from "../src/sim/route";
import { World, TICK } from "../src/sim/world";
import { getLevel, LEVELS } from "../src/data/levels";
import { kt as ktRaw, nm, toKt } from "../src/sim/units";
import { dist } from "../src/sim/vec";

let pass = 0;
const failures: string[] = [];

function check(name: string, fn: () => boolean | string): void {
  try {
    const r = fn();
    if (r === true) {
      pass += 1;
    } else {
      failures.push(`${name}: ${r === false ? "断言为假" : r}`);
    }
  } catch (e) {
    failures.push(`${name}: 抛错 ${(e as Error).message}`);
  }
}

check("机场数据：Kestrel 27 号跑道可构建", () => {
  const idx = buildAirport(AIRPORTS.kestrel, "27");
  return idx.runway.threshold.x === 1200 || "threshold 不对";
});

check("机场数据：每个机位都能滑到跑道外等待点", () => {
  const idx = buildAirport(AIRPORTS.kestrel, "27");
  for (const s of idx.def.stands) {
    const p = findTaxiPath(idx, s.node, idx.holdingNode);
    if (!p) return `机位 ${s.id} 不可达`;
  }
  return true;
});

check("机场数据：每个脱离口都能滑回机位", () => {
  const idx = buildAirport(AIRPORTS.kestrel, "27");
  for (const ex of idx.runway.exits) {
    const p = findTaxiPath(idx, ex.node, "ST1");
    if (!p) return `脱离口 ${ex.name} 不可达`;
  }
  return true;
});

check("航路：直线折线能从起点走到终点", () => {
  const r = makeRoute([
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 1000, y: 1000 },
  ]);
  let s = r.follow({ x: 0, y: 0 }, 50);
  for (let i = 0; i < 100 && !s.finished; i++) {
    const p = { x: s.target.x, y: s.target.y };
    s = r.follow(p, 50);
  }
  if (!s.finished) return "没有到达终点";
  return Math.abs(r.total - 2000) < 1 || `总长 ${r.total}`;
});

check("航路：横向偏移不会导致绕圈（弧长单调）", () => {
  const r = makeRoute([
    { x: 0, y: 0 },
    { x: 2000, y: 0 },
  ]);
  const a = r.follow({ x: 300, y: 200 }, 100);
  const s1 = a.s;
  const b = r.follow({ x: 200, y: -200 }, 100);
  return b.s >= s1 - 13 || `s 回退：${s1} -> ${b.s}`;
});

check("关卡：全部关卡都能构建世界并跑通前 60 秒", () => {
  for (const lvl of LEVELS) {
    const w = new World(lvl, { safetyMode: "guarded" });
    for (let i = 0; i < 600; i++) w.step();
    for (const ac of w.aircraftList()) {
      if (!Number.isFinite(ac.pos.x) || !Number.isFinite(ac.altM)) return `${lvl.id} 出现 NaN`;
    }
  }
  return true;
});

check("全流程：正常关卡能在机器人管制下完成多架次落地与起飞", () => {
  const lvl = getLevel("morning-rush");
  const w = new World(lvl, { safetyMode: "guarded" });
  const steps = Math.ceil((lvl.durationMin * 60) / TICK);
  for (let i = 0; i < steps; i++) {
    w.step();
    if (i % 20 === 0) botTick(w);
  }
  const landed = w.score.landings;
  const took = w.score.takeoffs;
  if (landed < 3) return `落地只有 ${landed} 架`;
  if (took < 2) return `起飞只有 ${took} 架`;
  if (w.score.landings + w.score.takeoffs < 6) return `总架次只有 ${landed + took}`;
  if (landed !== 6 || took !== 5 || w.score.violations !== 0 || w.score.goArounds !== 0) return `应完成 11 架次且零违规/复飞，实际 ${JSON.stringify(w.score)}`;
  return true;
});

check("全流程：一架进场机能沿 STAR 进场、截获 ILS 并落地", () => {
  const lvl = { ...getLevel("tutorial") };
  const w = new World(lvl, { safetyMode: "guarded" });
  let landed = false;
  for (let i = 0; i < 20 * 60 * 10 && !landed; i++) {
    w.step();
    if (i % 20 === 0) botTick(w);
    landed = w.score.landings > 0;
  }
  return landed || "20 分钟内没有落地";
});

check("全流程：离场机能推出、滑行、起飞并移交", () => {
  const lvl = { ...getLevel("tutorial"), flights: [{ callsign: "TST001", airline: "测试", typeId: "A320", kind: "dep" as const, atMin: 0, standId: "S2" }] };
  const w = new World(lvl, { safetyMode: "guarded" });
  let took = false;
  for (let i = 0; i < 15 * 60 * 10 && !took; i++) {
    w.step();
    if (i % 20 === 0) botTick(w);
    took = w.score.takeoffs > 0;
  }
  return took || "15 分钟内没有起飞";
});

check("跑道互锁：跑道被占时落地许可被拒", () => {
  const lvl = getLevel("morning-rush");
  const w = new World(lvl, { safetyMode: "guarded" });
  for (let i = 0; i < 300; i++) w.step();
  const ac = w.aircraftList()[0];
  if (!ac) return "没有生成飞机";
  ac.phase = "approach";
  ac.approach = { runwayId: "27", established: true };
  const other = { ...ac, id: "occupant", callsign: "BUSY", phase: "lineup" as const };
  w.aircraft.set(other.id, other);
  w.occupyRunway(other);
  const res = confirmed(w, ac.id, { kind: "land" });
  return !res.ok && res.reason.includes("BUSY") || "应因另一架飞机占用跑道被拒绝";
});

check("分离：两架飞机贴近时会被判为冲突", () => {
  const lvl = getLevel("tutorial");
  const w = new World(lvl, { safetyMode: "guarded" });
  for (let i = 0; i < 300; i++) w.step();
  const list = w.aircraftList();
  if (list.length < 1) return "没有飞机";
  const a = list[0]!;
  const b = { ...a, id: "fake", callsign: "FAKE1", pos: { x: a.pos.x + nm(1), y: a.pos.y }, altM: a.altM + 50 };
  w.aircraft.set(b.id, b);
  for (let i = 0; i < 20; i++) w.step();
  return w.conflicts.length > 0 || "没有检测到冲突";
});

check("单位：速度换算往返一致", () => {
  return Math.abs(toKt(ktRaw(1)) - 1) < 1e-9 || "换算不一致";
});

check("地面：所有飞机位置都在物理范围内（不出现地下/天上乱飞）", () => {
  const lvl = getLevel("morning-rush");
  const w = new World(lvl, { safetyMode: "guarded" });
  for (let i = 0; i < 4500; i++) {
    w.step();
    if (i % 20 === 0) botTick(w);
    for (const ac of w.aircraftList()) {
      if (ac.altM < -1) return `${ac.callsign} 高度为负`;
      if (dist(ac.pos, { x: 0, y: 0 }) > 60000) return `${ac.callsign} 跑出 60km`;
    }
  }
  return true;
});

function singleDeparture() {
  const w = new World({ ...getLevel("tutorial"), flights: [{ callsign: "DEP1", airline: "测试", typeId: "A320", kind: "dep", atMin: 0, standId: "S2" }] });
  w.step();
  return { w, ac: w.aircraftList()[0]! };
}

function singleArrival() {
  const w = new World(getLevel("tutorial"), { safetyMode: "guarded" });
  w.step();
  return { w, ac: w.aircraftList()[0]! };
}

check("推出：四种机头朝向均能完成离场", () => {
  for (const hdg of [0, 90, 180, 270]) {
    const { w, ac } = singleDeparture();
    confirmed(w, ac.id, { kind: "pushback", hdg });
    for (let i = 0; i < 9000; i++) { w.step(); if (i % 20 === 0) botTick(w); }
    if (w.score.takeoffs !== 1) return `机头 ${hdg}° 卡在 ${ac.phase}`;
  }
  return true;
});

check("推出：原地等待确实停止，继续后恢复", () => {
  const { w, ac } = singleDeparture();
  confirmed(w, ac.id, { kind: "pushback", hdg: 180 });
  confirmed(w, ac.id, { kind: "hold" });
  for (let i = 0; i < 50 && ac.gs > 0; i++) w.step();
  const pos = { ...ac.pos };
  for (let i = 0; i < 100; i++) w.step();
  if (dist(pos, ac.pos) > 0.01) return "等待后仍在移动";
  confirmed(w, ac.id, { kind: "resume" });
  for (let i = 0; i < 100; i++) w.step();
  return dist(pos, ac.pos) > 10;
});

check("起飞：进跑道途中追加许可，必须完成对正后才滑跑", () => {
  const { w, ac } = singleDeparture();
  ac.phase = "hold_short"; ac.pos = { ...w.idx.nodes.get(w.idx.holdingNode)!.pos };
  confirmed(w, ac.id, { kind: "lineup" });
  confirmed(w, ac.id, { kind: "takeoff" });
  if (w.aircraft.get(ac.id)?.phase !== "lineup") return "在滑行道上提前开始起飞";
  for (let i = 0; i < 1000 && w.aircraft.get(ac.id)?.phase === "lineup"; i++) w.step();
  return w.aircraft.get(ac.id)?.phase === "takeoff" && Math.abs(lateralOffset(w.idx, ac.pos)) < 1;
});

check("进近：错跑道与未建立进近的落地许可被拒绝", () => {
  const { w, ac } = singleArrival();
  ac.pos = { x: 18000, y: 0 };
  if (confirmed(w, ac.id, { kind: "approach", runwayId: "09" }).ok) return "接受了错误跑道";
  confirmed(w, ac.id, { kind: "approach", runwayId: "27" });
  return !confirmed(w, ac.id, { kind: "land" }).ok;
});

check("跑道预留：落地许可阻止其他机进跑道，取消后可进入", () => {
  const { w, ac } = singleArrival();
  ac.phase = "approach";
  ac.approach = { runwayId: "27", established: true };
  const dep = { ...singleDeparture().ac, id: "dep", phase: "hold_short" as const };
  w.aircraft.set(dep.id, dep);
  if (!confirmed(w, ac.id, { kind: "land" }).ok) return "无法取得落地许可";
  if (confirmed(w, dep.id, { kind: "lineup" }).ok || confirmed(w, dep.id, { kind: "takeoff" }).ok) return "落地预留未互锁";
  confirmed(w, ac.id, { kind: "cancelLanding" });
  confirmed(w, ac.id, { kind: "goAround" });
  return confirmed(w, dep.id, { kind: "lineup" }).ok;
});

check("进近：改航向或直飞后恢复引导阶段", () => {
  for (const cmd of [{ kind: "heading" as const, hdg: 250 }, { kind: "direct" as const, fix: "KAVLA" }]) {
    const { w, ac } = singleArrival();
    ac.phase = "approach"; ac.approach = { runwayId: "27", established: true }; ac.landCleared = true;
    confirmed(w, ac.id, cmd);
    if (w.aircraft.get(ac.id)?.phase !== "arrival" || ac.approach || ac.landCleared) return "仍停留在进近阶段或保留许可";
  }
  return true;
});

check("进近：玩家减速指令生效", () => {
  const { w, ac } = singleArrival();
  ac.pos = { x: 22000, y: 0 }; ac.hdg = 270;
  confirmed(w, ac.id, { kind: "approach", runwayId: "27" });
  confirmed(w, ac.id, { kind: "speed", kt: 160 });
  for (let i = 0; i < 500; i++) w.step();
  return toKt(ac.gs) <= 161 || `速度仍为 ${toKt(ac.gs)}`;
});

check("复飞恢复：飞过跑道后仍能直飞 IAF，指令不被自动逻辑覆盖", () => {
  const { w, ac } = singleArrival();
  ac.phase = "approach"; ac.approach = { runwayId: "27", established: true };
  ac.pos = { x: -2000, y: 0 }; ac.hdg = 270;
  confirmed(w, ac.id, { kind: "goAround" });
  confirmed(w, ac.id, { kind: "direct", fix: "KAVLA" });
  for (let i = 0; i < 100; i++) w.step();
  return ac.route !== null && ac.clearedHdg === null && w.score.goArounds === 1;
});

check("落地：高度或横向偏差过大时复飞，不能瞬移接地", () => {
  for (const [alt, offset] of [[800, 0], [8, 400]]) {
    const { w, ac } = singleArrival();
    ac.phase = "approach"; ac.approach = { runwayId: "27", established: true }; ac.landCleared = true;
    ac.pos = { x: 1199, y: offset! }; ac.hdg = 270; ac.altM = alt!;
    w.step();
    if (w.score.landings !== 0 || w.score.goArounds !== 1 || w.aircraft.get(ac.id)?.phase !== "arrival") return "不稳定进近被算作落地";
  }
  return true;
});

check("滑跑：减速后仍能到达脱离口，机尾清空前持续占用跑道", () => {
  const { w, ac } = singleArrival();
  ac.phase = "landing"; ac.pos = { x: 1100, y: 0 }; ac.gs = ktRaw(10); ac.hdg = 270;
  ac.altM = w.idx.def.elevationM; ac.route = null; ac.exitNodeId = "E_A2";
  w.occupyRunway(ac);
  for (let i = 0; i < 3000 && ac.phase === "landing"; i++) w.step();
  if (w.aircraft.get(ac.id)?.phase !== "taxi_in") return `停在 ${alongRunway(w.idx, ac.pos)} 米`;
  if (w.runwayOccupantId !== ac.id) return "机尾未清空就释放跑道";
  for (let i = 0; i < 500 && w.runwayOccupantId; i++) w.step();
  return w.runwayOccupantId === null && Math.abs(lateralOffset(w.idx, ac.pos)) > 60;
});

check("脱离：拒绝已经错过的出口", () => {
  const { w, ac } = singleArrival();
  ac.phase = "landing"; ac.pos = { x: 100, y: 0 }; ac.gs = ktRaw(10);
  return !confirmed(w, ac.id, { kind: "exit", nodeId: "E_A1" }).ok && ac.exitNodeId === null;
});

check("航班生成：被占用机位不能阻塞后续进场", () => {
  const dep = { callsign: "D1", airline: "测试", typeId: "A320", kind: "dep" as const, atMin: 0, standId: "S2" };
  const w = new World({ ...getLevel("tutorial"), flights: [dep, { ...dep, callsign: "D2" }, { ...dep, callsign: "A1", kind: "arr" }] });
  for (let i = 0; i < 100; i++) w.step();
  return w.aircraftList().some((a) => a.callsign === "A1") && w.aircraft.size === 2;
});

check("机位：满位时不重复分配", () => {
  const { w, ac } = singleArrival();
  for (const stand of w.idx.def.stands) w.aircraft.set(stand.id, { ...ac, id: stand.id, phase: "parked", standId: stand.id });
  return w.assignStand(ac) === null;
});

check("状态清理：飞机移除时释放跑道和选中状态", () => {
  const { w, ac } = singleDeparture();
  w.select(ac.id); w.occupyRunway(ac); w.finish(ac);
  return w.selectedId === null && w.runwayOccupantId === null && w.aircraft.size === 0;
});

check("指令校验：非法数值及班次结束后不能修改世界", () => {
  const { w, ac } = singleArrival();
  for (const cmd of [{ kind: "speed" as const, kt: NaN }, { kind: "altitude" as const, altFt: -100 }, { kind: "heading" as const, hdg: Infinity }]) {
    if (confirmed(w, ac.id, cmd).ok) return "接受非法指令";
  }
  w.status = "finished";
  return !confirmed(w, ac.id, { kind: "heading", hdg: 50 }).ok;
});

check("快照：嵌套对象不能反向修改世界", () => {
  const { w, ac } = singleArrival();
  const snap = w.snapshot().aircraft[0]!;
  snap.pos.x = 0; snap.scored.landed = true; snap.route!.minS = 10000; snap.route!.points[0]!.x = 0;
  return ac.pos.x !== 0 && !ac.scored.landed && ac.route!.minS !== 10000 && ac.route!.points[0]!.x !== 0;
});

console.log(`\n通过 ${pass} / ${pass + failures.length}`);
if (failures.length > 0) {
  console.log("失败：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
