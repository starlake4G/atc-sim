import assert from "node:assert/strict";
import { getLevel } from "../src/data/levels";
import { spawnArrival, spawnDeparture } from "../src/sim/aircraft";
import { alongRunway, findTaxiPath } from "../src/sim/airport";
import { previewCommand } from "../src/sim/commands";
import { aircraftCollide } from "../src/sim/collision";
import { taxiRoute } from "../src/sim/ground";
import { ReplayPlayer } from "../src/sim/replay";
import { makeGroundRoute, makeRoute } from "../src/sim/route";
import { runwayErrorReason, runwayTraffic, runwayWarning } from "../src/sim/runway";
import { TIME_SCALE, World } from "../src/sim/world";
import { botTick } from "../src/sim/bot";
import { ft, kt, angleDiff } from "../src/sim/units";
import { dist } from "../src/sim/vec";
import { confirmed } from "./test-radio";
import { advanceToDecision, recommendedCommand } from "../src/sim/flow";
import type { SafetyMode } from "../src/sim/types";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }
function fixture(safetyMode: SafetyMode = "consequence") {
  const level = getLevel("ground-school");
  return new World({ ...level, durationMin: 40, flights: [{ ...level.flights[0]!, atMin: 30 }] }, { mode: "standard", safetyMode });
}
function dep(w: World, id = "dep", stand = "S1") {
  const a = spawnDeparture(w, { id, callsign: id.toUpperCase(), airline: "测试", typeId: "A320", kind: "dep", standId: stand })!;
  w.aircraft.set(id, a); return a;
}
function ready(w: World, id = "dep", stand = "S1") {
  const a = dep(w, id, stand); a.phase = "hold_short"; a.controller = "TWR"; a.groundNodeId = w.idx.holdingNode;
  a.pos = { ...w.idx.nodes.get(w.idx.holdingNode)!.pos }; a.lastPos = { ...a.pos }; a.hdg = 180; return a;
}
function arr(w: World, id = "arr") {
  const a = spawnArrival(w, { id, callsign: id.toUpperCase(), airline: "测试", typeId: "B77W", kind: "arr", standId: null });
  Object.assign(a, { phase: "approach", controller: "TWR", approach: { runwayId: "27", established: true }, pos: { x: 9000, y: 0 }, hdg: 270, altM: 410, gs: kt(145), targetGs: kt(148) });
  a.lastPos = { ...a.pos }; w.aircraft.set(id, a); return a;
}
function to(w: World, t: number) { while (w.time < t - 1e-6 && w.status === "running") w.step(); }

test("1× 是实时，模拟固定步长不随帧率和加速改变", () => { assert.equal(TIME_SCALE, 1); const w = fixture(); for (let i = 0; i < 100; i++) w.step(); assert(Math.abs(w.time - 10) < 1e-8); });
test("发话与完整复诵期间不执行动作，重复点击不重复入队", () => {
  const w = fixture(), a = dep(w), before = { ...a.pos };
  assert(w.issue(a.id, { kind: "pushback", hdg: 180 }).ok); const p = { ...a.pendingClearance! };
  assert.equal(a.phase, "parked"); assert(!w.issue(a.id, { kind: "pushback", hdg: 180 }).ok);
  to(w, p.readbackAt + .1); assert(w.radio.some((line) => line.seat === "PILOT")); assert.equal(a.phase, "parked"); assert.deepEqual(a.pos, before);
  to(w, p.commitAt - .11); assert.equal(a.phase, "parked"); to(w, p.commitAt + .01); assert.equal(a.phase, "pushback"); assert.equal(a.pendingClearance, null);
});
test("同频道按完整通话串行，不同频道可以并行", () => {
  const w = fixture(), a = dep(w), b = dep(w, "second", "S4"), c = arr(w);
  w.issue(a.id, { kind: "pushback", hdg: 180 }); w.issue(b.id, { kind: "pushback", hdg: 180 }); w.issue(c.id, { kind: "land" });
  assert(b.pendingClearance!.startsAt >= a.pendingClearance!.commitAt); assert.equal(c.pendingClearance!.startsAt, a.pendingClearance!.startsAt);
  assert(!w.radio.some((line) => line.callsign === b.callsign)); to(w, b.pendingClearance!.startsAt + .1); assert(w.radio.some((line) => line.callsign === b.callsign));
});
test("预览复飞和移交不改变世界、评分、计划或快照", () => {
  const w = fixture(), a = arr(w), before = w.snapshot();
  assert(previewCommand(w, a, { kind: "goAround" }).ok); assert(previewCommand(w, a, { kind: "handoff", controller: "TWR" }).ok === false);
  assert.deepEqual(w.snapshot(), before);
});
test("任意可用指令的预览都不改变世界（泛化断言）", () => {
  for (const safety of ["guarded", "consequence"] as const) {
    const w = new World(getLevel("operating-windows"), { mode: "standard", safetyMode: safety });
    for (let t = 0; t < 900 && w.status === "running"; t++) { w.step(); if (t % 20 === 0) botTick(w); }
    let checked = 0;
    for (const ac of w.aircraftList()) {
      for (const option of w.commandOptions(ac)) {
        const before = JSON.stringify(w.snapshot());
        previewCommand(w, ac, option.command);
        const after = JSON.stringify(w.snapshot());
        assert.equal(after, before, `${safety}/${ac.callsign}/${option.key} 的预览改动了世界`);
        checked += 1;
      }
    }
    assert(checked >= 5, `${safety} 下只覆盖到 ${checked} 条指令，断言没有意义`);
  }
});

test("确认前风险变化会重新校验，失败指令不会执行", () => {
  const w = fixture("guarded"), a = ready(w); assert(w.issue(a.id, { kind: "takeoff" }).ok);
  w.lastRunwayUse = { callsign: "HEAVY", typeId: "B77W", at: w.time };
  to(w, a.pendingClearance!.commitAt + .1); assert.equal(a.phase, "hold_short"); assert(w.radio.some((line) => line.text.includes("未生效")));
});
test("保护关闭时尾流、计划和预计窗口只警告；开启后拒绝", () => {
  for (const risk of ["wake", "plan", "window"] as const) {
    const w = fixture(), a = ready(w);
    if (risk === "wake") w.lastRunwayUse = { callsign: "HEAVY", typeId: "B77W", at: w.time };
    if (risk === "plan") { const b = dep(w, "first", "S4"); w.changeRunwayPlan(b.id, "add"); }
    if (risk === "window") arr(w).pos = { x: 5000, y: 0 };
    const option = w.commandOptions(a).find((o) => o.key === "takeoff")!; assert(option.warning); assert.equal(option.disabledReason, undefined);
    w.setSafetyMode("guarded"); assert(!w.issue(a.id, { kind: "takeoff" }).ok);
    w.setSafetyMode("consequence"); const result = w.issue(a.id, { kind: "takeoff" }); assert(result.ok && result.warning);
  }
});
test("保护关闭时风限与检查均为可执行警告", () => {
  for (const kind of ["weather", "inspection"] as const) {
    const w = new World({ ...getLevel("ground-school"), flights: [{ ...getLevel("ground-school").flights[0]!, atMin: 30 }], operations: [kind === "inspection" ? { id: "op", kind, name: "检查", announceMin: 0, atMin: 0, durationSec: 100 } : { id: "op", kind, name: "阵风", announceMin: 0, atMin: 0, durationSec: 100, wind: { dirDeg: 210, speedKt: 30 } }] }, { mode: "standard" });
    w.step(); const a = ready(w); const result = w.issue(a.id, { kind: "takeoff" }); assert(result.ok && result.warning); assert.equal(a.phase, "hold_short");
  }
});
test("有风险的许可可点但不会被推荐，尾流等待仍可推进下一请求", () => {
  const w = fixture(), a = ready(w); w.lastRunwayUse = { callsign: "HEAVY", typeId: "B77W", at: w.time };
  assert.equal(recommendedCommand(w, a), null); const result = advanceToDecision(w, 120);
  assert(result.advanced >= 89.9 && result.advanced <= 90.2); assert.equal(a.phase, "hold_short"); assert.equal(result.aircraftId, a.id); assert(recommendedCommand(w, a));
});
test("实际短五边保留危险诊断，自由模式仍可下达许可", () => {
  const w = fixture(), a = ready(w), b = arr(w); b.pos = { x: 1600, y: 0 }; b.altM = 40;
  assert.match(runwayErrorReason(w, a)!, /短五边/); assert(w.issue(a.id, { kind: "takeoff" }).ok);
});
test("早移交 DEP 完整复诵后等待离地及高度，仍可由塔台起飞", () => {
  const w = fixture(), a = ready(w); confirmed(w, a.id, { kind: "handoff", controller: "DEP" });
  assert.equal(a.controller, "TWR"); assert.equal(a.pendingHandoff?.controller, "DEP"); assert.equal(w.score.departuresTransferred, 0);
  assert(confirmed(w, a.id, { kind: "takeoff" }).ok);
  for (let i = 0; i < 2000 && String(a.controller) !== "DEP"; i++) w.step();
  assert.equal(a.controller, "DEP"); assert(a.altM - w.idx.def.elevationM >= ft(1500)); assert.equal(w.score.departuresTransferred, 1); assert.equal(w.score.violations, 0);
  assert(!w.issue(a.id, { kind: "handoff", controller: "DEP" }).ok);
});
test("接地滑跑中可以联系地面，复诵结束前仍归塔台", () => {
  const w = fixture(), a = arr(w); Object.assign(a, { phase: "landing", approach: null, pos: { x: 800, y: 0 }, altM: 8, gs: kt(130), touchdownAt: 0 }); w.occupyRunway(a);
  assert(w.issue(a.id, { kind: "handoff", controller: "GND" }).ok); assert.equal(a.controller, "TWR"); to(w, a.pendingClearance!.commitAt + .1);
  assert.equal(a.controller, "GND"); assert.equal(a.phase, "landing"); assert(w.commandOptions(a).some((o) => o.command.kind === "exit"));
});
test("滑行中可预联系塔台，未到等待点时不会提前失去地面管制", () => {
  const w = fixture(), a = dep(w); a.phase = "taxi_out"; a.groundNodeId = "B1000"; a.pos = { ...w.idx.nodes.get("B1000")!.pos }; a.hdg = 90; a.route = taxiRoute(w, a, { kind: "taxi", route: "main" });
  confirmed(w, a.id, { kind: "handoff", controller: "TWR" }); assert.equal(a.controller, "GND"); assert(a.pendingHandoff);
  for (let i = 0; i < 1500 && String(a.phase) !== "hold_short"; i++) w.step(); assert.equal(a.controller, "TWR"); assert.equal(a.pendingHandoff, null);
});
test("四种推出方向均边移动边转向，连续航向并在机坪结束", () => {
  for (const hdg of [0, 90, 180, 270]) {
    const w = fixture(), a = dep(w); confirmed(w, a.id, { kind: "pushback", hdg });
    let previous = { p: { ...a.pos }, h: a.hdg }, distance = 0;
    for (let i = 0; i < 2000 && a.phase === "pushback"; i++) {
      w.step(); const move = dist(a.pos, previous.p), turn = Math.abs(angleDiff(a.hdg, previous.h));
      assert(turn <= 1.801); if (turn > .2) assert(move > .001, "不应在停止状态原地旋转"); distance += move; previous = { p: { ...a.pos }, h: a.hdg };
    }
    assert.equal(a.phase, "taxi_ready"); assert(distance > 60); assert(Math.abs(angleDiff(a.hdg, hdg)) < 8); assert.equal(a.groundNodeId, "AP1");
  }
});
test("宽体接地保留速度，制动逐步建立且不会瞬间转向", () => {
  const w = fixture(), a = arr(w); Object.assign(a, { pos: { x: 949, y: 0 }, altM: 8, gs: kt(148), hdg: 273, landCleared: true });
  const before = a.gs; w.step(); assert.equal(a.phase, "landing"); assert.equal(a.gs, before); assert.equal(a.hdg, 273);
  const heading = a.hdg; w.step(); assert(Math.abs(angleDiff(a.hdg, heading)) <= 1.601); assert(before - a.gs < .1);
  to(w, w.time + 5); const speed = a.gs; w.step(); assert(speed - a.gs > .2 && speed - a.gs <= .221);
});
test("脱离入口不瞬移、不瞬转 90°，机尾清空后释放跑道", () => {
  const w = fixture(), a = arr(w); Object.assign(a, { phase: "landing", approach: null, pos: { x: 34, y: 0 }, altM: 8, gs: kt(10), hdg: 270, exitNodeId: "E_A2", touchdownAt: -60 }); w.occupyRunway(a);
  const before = { ...a.pos }; w.step(); assert.equal(a.phase, "taxi_in"); assert(dist(a.pos, before) < 1); assert.equal(a.hdg, 270); assert.equal(w.runwayOccupantId, a.id);
  for (let i = 0; i < 1000 && w.runwayOccupantId; i++) w.step(); assert.equal(w.runwayOccupantId, null); assert(a.pos.y > 70);
});
test("同向飞机跨过图节点仍保持跟车，前机停走时自动减速恢复", () => {
  const w = fixture(), lead = dep(w, "lead"), follow = dep(w, "follow", "S4");
  Object.assign(lead, { phase: "taxi_out", groundNodeId: "B1000", pos: { x: 1030, y: 330 }, hdg: 90, gs: 0, holding: true });
  lead.route = makeGroundRoute([lead.pos, { x: 1090, y: 330 }, { x: 1090, y: 150 }]);
  Object.assign(follow, { phase: "taxi_out", groundNodeId: "B700", pos: { x: 850, y: 330 }, hdg: 90, gs: kt(15) });
  follow.route = makeGroundRoute([follow.pos, { x: 1000, y: 330 }, { x: 1090, y: 330 }, { x: 1090, y: 150 }]);
  let stopped = false;
  for (let i = 0; i < 450; i++) { const speed = follow.gs; w.step(); assert.equal(w.status, "running"); assert(!aircraftCollide(lead, follow)); assert(speed - follow.gs <= .151); if (follow.gs < .01) stopped = true; }
  assert(stopped); const before = { ...follow.pos }; lead.holding = false; for (let i = 0; i < 300; i++) w.step(); assert(dist(before, follow.pos) > 5); assert.equal(w.status, "running");
});
test("两条主滑行道没有 C 节点，西侧出口能到达每个机位", () => {
  const w = fixture(); assert(!w.idx.def.nodes.some((n) => /^C-?\d/.test(n.id)));
  const west = w.idx.exitsByDistance.find((ex) => ex.name === "A4")!; assert.equal(west.atM, 2100);
  for (const stand of w.idx.def.stands) assert(findTaxiPath(w.idx, west.node, stand.node, "arr"));
  assert(!w.idx.nodes.has("B1150")); assert(!w.idx.nodes.has("P1150"));
});
test("多个跑道使用者不会覆盖占用记录或提前清空跑道", () => {
  const w = fixture(), a = dep(w), b = dep(w, "other", "S4");
  Object.assign(a, { phase: "landing", pos: { x: 300, y: 0 } }); Object.assign(b, { phase: "lineup", pos: { x: 1120, y: 0 } }); w.occupyRunway(a); w.occupyRunway(b);
  assert.equal(w.runwayOccupantId, a.id); assert.equal(runwayTraffic(w).length, 2); a.pos.y = 150; a.phase = "taxi_in"; w.vacateRunway(a); assert.equal(w.runwayOccupantId, b.id); assert(runwayWarning(w, a));
});
test("自由模式不会提前代为刹停，真实碰撞才失败，结束后不再计分", () => {
  const w = fixture(), a = ready(w), b = dep(w, "blocking", "S4");
  Object.assign(a, { phase: "takeoff", pos: { x: 1000, y: 0 }, hdg: 270, gs: kt(60) }); Object.assign(b, { phase: "lineup", pos: { x: 900, y: 0 }, hdg: 270, route: null });
  w.occupyRunway(a); w.occupyRunway(b); w.step(); assert.equal(w.status, "running"); assert(a.gs > kt(60));
  for (let i = 0; i < 100 && w.status === "running"; i++) w.step(); assert.equal(w.status, "failed"); assert.match(w.failureReason!, /碰撞/); const snapshot = w.snapshot(); w.step(); assert.deepEqual(w.snapshot(), snapshot);
});
test("保护模式在同一场景中中断起飞并保持实际距离", () => {
  const w = fixture("guarded"), a = ready(w), b = dep(w, "blocking", "S4");
  Object.assign(a, { phase: "takeoff", pos: { x: 1000, y: 0 }, hdg: 270, gs: kt(20) }); Object.assign(b, { phase: "lineup", pos: { x: 900, y: 0 }, hdg: 270, route: null });
  w.occupyRunway(a); w.occupyRunway(b); for (let i = 0; i < 100; i++) w.step(); assert.equal(w.status, "running"); assert.equal(a.gs, 0); assert(dist(a.pos, b.pos) > 40);
});
test("真实滑跑冲出跑道只触发一次失败", () => {
  const w = fixture(), a = arr(w); Object.assign(a, { phase: "landing", approach: null, pos: { x: -1199, y: 0 }, hdg: 270, altM: 8, gs: kt(100), touchdownAt: -10 }); w.occupyRunway(a);
  w.step(); assert.equal(w.status, "failed"); assert.match(w.failureReason!, /冲出跑道/); assert.equal(w.score.violations, 1);
});
test("自由模式下检查车的实际位置参与碰撞判定", () => {
  const w = new World({ ...getLevel("ground-school"), flights: [{ ...getLevel("ground-school").flights[0]!, atMin: 30 }], operations: [{ id: "check", kind: "inspection", name: "检查", announceMin: 0, atMin: 0, durationSec: 150 }] });
  w.step(); const a = dep(w); Object.assign(a, { phase: "lineup", pos: { x: 998, y: -6 }, altM: 8, hdg: 270, route: null }); w.step(); assert.equal(w.status, "failed"); assert.match(w.failureReason!, /检查车/);
});
test("近距掠过且高度足够时不会被二维重叠误判为碰撞", () => {
  const w = fixture(), a = dep(w), b = dep(w, "air", "S4"); b.pos = { ...a.pos }; b.lastPos = { ...b.pos }; b.altM = a.altM + 50; assert(!aircraftCollide(a, b));
});
test("新指令和模式切换完整回放包括通话中间状态", () => {
  const w = new World(getLevel("ground-school"), { mode: "standard" }); w.step(); const a = w.aircraftList()[0]!;
  w.issue(a.id, { kind: "pushback", hdg: 180 }); to(w, 2); w.setSafetyMode("guarded"); const midway = w.snapshot(); to(w, 15); w.setSafetyMode("consequence");
  const p = new ReplayPlayer(w.exportReplay()); p.seek(2); assert.deepEqual(p.world.snapshot(), midway); p.seek(w.time); assert.deepEqual(p.world.snapshot(), w.snapshot()); p.seek(0); p.seek(w.time); assert.deepEqual(p.world.snapshot(), w.snapshot());
});
test("地速与实际位移相符，风不会在积分时重复叠加", () => {
  const w = fixture(), a = arr(w); a.phase = "arrival"; a.approach = null; a.route = makeRoute([a.pos, { x: 1000, y: 0 }]); a.clearedAltM = a.altM;
  const before = { ...a.pos }; w.step(); assert(Math.abs(dist(before, a.pos) / .1 - a.gs) < .001); assert(alongRunway(w.idx, a.pos) < 0);
});
console.log(`\n控制、物理与跟车回归通过 ${passed} 项`);
