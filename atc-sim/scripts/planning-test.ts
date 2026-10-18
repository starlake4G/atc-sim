import { confirmed } from "./test-radio";
import assert from "node:assert/strict";
import { getLevel } from "../src/data/levels";
import { goAround, spawnArrival, spawnDeparture } from "../src/sim/aircraft";
import { RunwayPlanner, isRunwayCandidate } from "../src/sim/planning";
import { departurePreparationSec, departureWindow, runwayBlockReason, wakeSeparationSec } from "../src/sim/runway";
import { botTick } from "../src/sim/bot";
import { glideAltM } from "../src/sim/airport";
import { makeRoute } from "../src/sim/route";
import { kt } from "../src/sim/units";
import { World } from "../src/sim/world";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }
function fixture() {
  const world = new World({ ...getLevel("intersection"), flights: [] }, { mode: "standard", safetyMode: "guarded" });
  const planner = new RunwayPlanner();
  const arrival = spawnArrival(world, { id: "arr", callsign: "ARR101", airline: "极光航空", typeId: "A320", kind: "arr", standId: null });
  const departure = spawnDeparture(world, { id: "dep", callsign: "DEP202", airline: "极光航空", typeId: "E190", kind: "dep", standId: "S4" })!;
  world.aircraft.set(arrival.id, arrival); world.aircraft.set(departure.id, departure);
  return { world, planner, arrival, departure };
}

test("计划默认空，显式加入后约束已入队及未入队飞机", () => {
  const { world, planner, arrival, departure } = fixture();
  assert.equal(planner.blockReason(world, departure), undefined);
  assert(planner.add(world, arrival.id).ok);
  assert.equal(planner.blockReason(world, arrival), undefined);
  assert.match(planner.blockReason(world, departure)!, /ARR101.*加入/);
  assert(planner.add(world, departure.id).ok);
  assert.match(planner.blockReason(world, departure)!, /ARR101.*等待/);
  assert(planner.move(world, departure.id, -1).ok);
  assert.equal(planner.blockReason(world, departure), undefined);
  assert.match(planner.blockReason(world, arrival)!, /DEP202/);
});

test("重复、失效飞机和非法移动有明确拒绝原因", () => {
  const { world, planner, arrival, departure } = fixture();
  assert(!planner.add(world, "missing").ok);
  assert(planner.add(world, arrival.id).ok);
  assert(!planner.add(world, arrival.id).ok);
  assert(!planner.move(world, arrival.id, -1).ok);
  assert(!planner.move(world, "missing", 1).ok);
  assert(!planner.remove(world, departure.id).ok);
  departure.scored.departed = true; assert(!isRunwayCandidate(departure));
  assert(!planner.add(world, departure.id).ok);
});

test("已经许可落地的飞机自动锁定首项，取消许可后可调整", () => {
  const { world, planner, arrival, departure } = fixture();
  planner.add(world, departure.id);
  arrival.phase = "approach"; arrival.approach = { runwayId: "27", established: true }; arrival.landCleared = true;
  assert.deepEqual(planner.snapshot(world).map((item) => item.aircraftId), [arrival.id, departure.id]);
  assert(!planner.remove(world, arrival.id).ok);
  assert(!planner.move(world, arrival.id, 1).ok);
  assert(!planner.move(world, departure.id, -1).ok);
  arrival.landCleared = false;
  assert(planner.move(world, departure.id, -1).ok);
  assert(planner.remove(world, arrival.id).ok);
});

test("已进跑道的离场飞机固定，计划不会阻碍其继续起飞", () => {
  const { world, planner, arrival, departure } = fixture();
  planner.add(world, arrival.id); departure.phase = "lineup";
  assert.equal(planner.snapshot(world)[0]!.aircraftId, departure.id);
  assert.equal(planner.blockReason(world, departure), undefined);
  assert(!planner.remove(world, departure.id).ok);
});

test("跑道计划不消除物理占用与尾流阻挡", () => {
  const { world, planner, arrival, departure } = fixture();
  planner.add(world, departure.id); world.runwayOccupantId = arrival.id; arrival.phase = "landing";
  assert.equal(planner.blockReason(world, departure), undefined);
  assert.match(runwayBlockReason(world, departure)!, /ARR101.*占用/);
  world.runwayOccupantId = null; departure.typeId = "AT72";
  world.lastRunwayUse = { callsign: "HEAVY1", typeId: "B77W", at: world.time };
  assert.match(runwayBlockReason(world, departure)!, /尾流/);
});

test("完成起降和删除飞机立即清理计划，不阻挡后续航班", () => {
  const { world, planner, arrival, departure } = fixture();
  planner.add(world, arrival.id); planner.add(world, departure.id);
  arrival.scored.landed = true; arrival.phase = "landing";
  assert.equal(planner.snapshot(world)[0]!.aircraftId, departure.id);
  world.finish(departure);
  assert.equal(planner.snapshot(world).length, 0);
  assert.equal(planner.blockReason(world, arrival), undefined);
});

test("复飞取消原到达时隙，恢复后可以重新加入", () => {
  const { world, planner, arrival, departure } = fixture();
  arrival.phase = "approach"; arrival.approach = { runwayId: "27", established: true }; arrival.landCleared = true;
  planner.add(world, arrival.id); planner.add(world, departure.id);
  goAround(arrival, world);
  assert.deepEqual(planner.snapshot(world).map((item) => item.aircraftId), [departure.id]);
  assert.equal(world.score.goArounds, 1);
  assert(planner.add(world, arrival.id).ok);
  assert(planner.contains(world, arrival.id));
});

test("等待航班无法估时；改序可以释放可用离场时隙", () => {
  const { world, planner, arrival, departure } = fixture();
  arrival.airHolding = true; departure.phase = "hold_short"; departure.controller = "TWR";
  planner.add(world, arrival.id); planner.add(world, departure.id);
  const waiting = planner.snapshot(world);
  assert.equal(waiting[0]!.useAt, null); assert.equal(waiting[1]!.useAt, null);
  assert.match(waiting[0]!.waitReason, /解除空中等待/);
  planner.move(world, departure.id, -1);
  const changed = planner.snapshot(world);
  assert(Number.isFinite(changed[0]!.useAt)); assert.equal(changed[1]!.useAt, null);
  assert.equal(planner.blockReason(world, departure), undefined);
});

test("预测使用时间、脱离时间和延误遵守同一尾流游戏常量", () => {
  const { world, planner, departure } = fixture();
  world.time = 200; departure.phase = "hold_short"; departure.typeId = "AT72"; departure.scheduledMovementAt = 250;
  world.lastRunwayUse = { callsign: "HEAVY1", typeId: "B77W", at: 200 };
  planner.add(world, departure.id);
  const entry = planner.snapshot(world)[0]!;
  assert.equal(wakeSeparationSec("B77W", "AT72"), 120);
  assert.equal(entry.readyAt, 200);
  assert.equal(entry.occupyAt, 320);
  assert(entry.useAt! >= 320 && entry.clearAt! > entry.useAt!);
  assert.equal(entry.delaySec, entry.useAt! - 250);
  assert.match(entry.waitReason, /HEAVY1.*尾流/);
});

test("进跑道和起飞许可都会拒绝尚未许可落地的短五边窗口", () => {
  const { world, arrival, departure } = fixture();
  departure.phase = "hold_short"; departure.controller = "TWR"; departure.pos = { ...world.idx.nodes.get(world.idx.holdingNode)!.pos };
  arrival.phase = "approach"; arrival.approach = { runwayId: "27", established: true }; arrival.landCleared = false;
  arrival.pos = { x: world.idx.runway.threshold.x + 9500, y: 0 }; arrival.gs = kt(180);
  for (const kind of ["lineup", "takeoff"] as const) {
    const result = confirmed(world, departure.id, { kind });
    assert(!result.ok); if (!result.ok) assert.match(result.reason, /ARR101.*起飞窗口/);
    assert.match(world.commandOptions(departure).find((option) => option.command.kind === kind)!.disabledReason!, /ARR101.*起飞窗口/);
  }
  assert.equal(departure.phase, "hold_short"); assert.equal(world.runwayOccupantId, null);
});

test("足够远的进近留有完整窗口，可真实放行并占用跑道", () => {
  const { world, arrival, departure } = fixture();
  departure.phase = "hold_short"; departure.controller = "TWR"; departure.pos = { ...world.idx.nodes.get(world.idx.holdingNode)!.pos };
  arrival.phase = "approach"; arrival.approach = { runwayId: "27", established: true };
  arrival.pos = { x: world.idx.runway.threshold.x + 25000, y: 0 }; arrival.gs = kt(180);
  assert.equal(departureWindow(world, departure), null);
  assert(confirmed(world, departure.id, { kind: "takeoff" }).ok);
  assert.equal(departure.phase, "lineup"); assert.equal(world.runwayOccupantId, departure.id);
});

test("窗口检查每架进近来机，并按真实剩余进跑道长度计算", () => {
  const { world, arrival, departure } = fixture();
  departure.phase = "hold_short"; departure.controller = "TWR";
  arrival.phase = "approach"; arrival.pos = { x: 30000, y: 0 }; arrival.gs = kt(160);
  const close = { ...arrival, id: "close", callsign: "CLOSE303", pos: { x: 10700, y: 0 } };
  world.aircraft.set(close.id, close);
  assert.equal(departureWindow(world, departure)?.callsign, close.callsign);
  const full = departurePreparationSec(world, departure);
  departure.phase = "lineup"; departure.route = null;
  assert(departurePreparationSec(world, departure) < full);
  world.aircraft.delete(close.id);
  assert.equal(departureWindow(world, departure), null);
});

test("真实World计划改序改变起飞许可，已承诺顺序不可撤销", () => {
  const { world, arrival, departure } = fixture();
  departure.phase = "hold_short"; departure.controller = "TWR";
  assert(world.changeRunwayPlan(arrival.id, "add").ok); assert(world.changeRunwayPlan(departure.id, "add").ok);
  const blocked = confirmed(world, departure.id, { kind: "takeoff" });
  assert(!blocked.ok); if (!blocked.ok) assert.match(blocked.reason, /跑道计划先安排 ARR101/);
  assert(world.changeRunwayPlan(departure.id, "up").ok);
  assert(confirmed(world, departure.id, { kind: "takeoff" }).ok);
  assert(!world.changeRunwayPlan(departure.id, "remove").ok);
  assert.equal(world.snapshot().runwayPlan[0]!.committed, true);
});

test("窗口关闭时计划预测明确需要调整，安全复飞仍可执行", () => {
  const { world, arrival, departure } = fixture();
  departure.phase = "hold_short"; departure.controller = "TWR";
  arrival.phase = "approach"; arrival.approach = { runwayId: "27", established: true }; arrival.pos = { x: 9500, y: 0 }; arrival.gs = kt(180);
  world.changeRunwayPlan(departure.id, "add"); world.changeRunwayPlan(arrival.id, "add");
  const entry = world.snapshot().runwayPlan[0]!;
  assert.equal(entry.useAt, null); assert.equal(entry.occupyAt, null); assert.match(entry.waitReason, /ARR101.*起飞窗口不足/);
  assert(confirmed(world, arrival.id, { kind: "goAround" }).ok);
  assert.deepEqual(world.snapshot().runwayPlan.map((item) => item.aircraftId), [departure.id]);
  assert(confirmed(world, departure.id, { kind: "takeoff" }).ok);
});

test("物理跑道占用与尾流原因优先于窗口与计划原因", () => {
  const { world, arrival, departure } = fixture();
  departure.phase = "hold_short"; departure.controller = "TWR";
  arrival.phase = "approach"; arrival.pos = { x: 8000, y: 0 }; arrival.gs = kt(180); arrival.landCleared = true;
  world.changeRunwayPlan(arrival.id, "add"); world.changeRunwayPlan(departure.id, "add");
  const reserved = confirmed(world, departure.id, { kind: "takeoff" });
  assert(!reserved.ok); if (!reserved.ok) assert.match(reserved.reason, /占用或获准落地/);
  arrival.landCleared = false; departure.typeId = "AT72";
  world.lastRunwayUse = { callsign: "HEAVY1", typeId: "B77W", at: world.time };
  const wake = confirmed(world, departure.id, { kind: "takeoff" });
  assert(!wake.ok); if (!wake.ok) assert.match(wake.reason, /HEAVY1.*尾流/);
});

test("短五边被守卫保护后真实推进，先落后起且没有间隔违规", () => {
  const { world, arrival, departure } = fixture();
  world.level.flights.push({ callsign: "FUTURE", airline: "测试", typeId: "A320", kind: "arr", atMin: 40 });
  departure.phase = "hold_short"; departure.controller = "TWR"; departure.pos = { ...world.idx.nodes.get(world.idx.holdingNode)!.pos };
  arrival.phase = "approach"; arrival.approach = { runwayId: "27", established: true }; arrival.controller = "TWR";
  arrival.pos = { x: 10700, y: 0 }; arrival.hdg = 270; arrival.gs = kt(180); arrival.targetGs = kt(180); arrival.altM = glideAltM(world.idx, arrival.pos); arrival.route = null;
  assert(!confirmed(world, departure.id, { kind: "takeoff" }).ok);
  for (let tick = 0; tick < 6000 && world.score.serviced + world.score.takeoffs < 2; tick++) {
    world.step(); if (tick % 20 === 0) botTick(world);
  }
  assert.equal(world.score.landings, 1); assert.equal(world.score.takeoffs, 1); assert.equal(world.score.serviced, 1);
  assert.equal(world.score.violations, 0); assert.equal(world.score.goArounds, 0);
  const movements = world.events.filter((event) => event.kind === "landing" || event.kind === "takeoff");
  assert.deepEqual(movements.map((event) => event.kind), ["landing", "takeoff"]);
});

test("同一波次重新排序会改变预测延误，快照不会修改飞机航路", () => {
  const { world, planner, arrival, departure } = fixture();
  arrival.pos = { x: 25000, y: 6000 }; arrival.gs = kt(180);
  arrival.route = makeRoute([arrival.pos, { x: 19000, y: 6000 }]);
  departure.phase = "hold_short"; departure.scheduledMovementAt = 0;
  planner.add(world, arrival.id); planner.add(world, departure.id);
  const first = planner.snapshot(world), routeProgress = arrival.route.minS;
  planner.move(world, departure.id, -1);
  const second = planner.snapshot(world);
  assert(second.find((item) => item.aircraftId === departure.id)!.delaySec! < first.find((item) => item.aircraftId === departure.id)!.delaySec!);
  assert.equal(arrival.route.minS, routeProgress);
  second[0]!.callsign = "MUTATED";
  assert.equal(planner.snapshot(world)[0]!.callsign, departure.callsign);
});

test("推出、滑行和地面停止均给出稳定预测或明确等待状态", () => {
  const { world, planner, departure } = fixture();
  planner.add(world, departure.id);
  assert(Number.isFinite(planner.snapshot(world)[0]!.useAt));
  departure.phase = "taxi_out"; departure.route = makeRoute([departure.pos, world.idx.nodes.get(world.idx.holdingNode)!.pos]);
  assert(Number.isFinite(planner.snapshot(world)[0]!.useAt));
  departure.holding = true;
  assert.equal(planner.snapshot(world)[0]!.useAt, null);
  assert.match(planner.snapshot(world)[0]!.waitReason, /继续滑行/);
});

console.log(`\n跑道计划回归通过 ${passed} 项`);
