import assert from "node:assert/strict";
import { getLevel } from "../src/data/levels";
import { World } from "../src/sim/world";
import { botTick } from "../src/sim/bot";
import { ReplayPlayer } from "../src/sim/replay";
import { advanceToDecision } from "../src/sim/flow";
import { spawnArrival, spawnDeparture } from "../src/sim/aircraft";
import { runwayWind, windLimits, windRestriction } from "../src/sim/operations";
import { runwayBlockReason } from "../src/sim/runway";
import { EnvironmentModel } from "../src/views/environment-model";
import type { Aircraft, OperationDef } from "../src/sim/types";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }
const inspection: OperationDef = { id: "check", kind: "inspection", name: "检查", announceMin: 1, atMin: 5, durationSec: 150 };
const weather: OperationDef = { id: "gust", kind: "weather", name: "阵风", announceMin: 0, atMin: 1, durationSec: 60, wind: { dirDeg: 210, speedKt: 18, gustKt: 26 } };
function fixture(operations: OperationDef[] = [inspection]): World {
  return new World({ ...getLevel("operating-windows"), operations, flights: [{ ...getLevel("ground-school").flights[0]!, atMin: 30 }] }, { mode: "standard" });
}
function to(world: World, seconds: number) { while (world.time < seconds - .00001 && world.status === "running") world.step(); }
function departure(world: World, typeId = "E190", id = "dep"): Aircraft {
  const ac = spawnDeparture(world, { id, callsign: id.toUpperCase(), airline: "天穹航空", typeId, kind: "dep", standId: "S4" })!;
  ac.phase = "hold_short"; ac.controller = "TWR"; ac.groundNodeId = world.idx.holdingNode; ac.pos = { ...world.idx.nodes.get(world.idx.holdingNode)!.pos };
  world.aircraft.set(id, ac); return ac;
}
function arrival(world: World, id = "arr"): Aircraft {
  const ac = spawnArrival(world, { id, callsign: id.toUpperCase(), airline: "极光航空", typeId: "A320", kind: "arr", standId: null });
  ac.phase = "approach"; ac.controller = "TWR"; ac.approach = { runwayId: "27", established: true }; ac.pos = { x: 4000, y: 0 }; ac.altM = 145; ac.hdg = 270;
  world.aircraft.set(id, ac); return ac;
}
function full(early: boolean): World {
  const world = new World(getLevel("operating-windows"), { mode: "standard" });
  for (let tick = 0; tick < world.level.durationMin * 600 && world.status === "running"; tick++) {
    world.step();
    if (early && world.operations.snapshot()[0]!.stage === "announced") world.startInspection("rwy-inspection");
    if (tick % 20 === 0) botTick(world);
  }
  return world;
}

test("事件计划拒绝无效时间、重复编号、无效阵风与重叠天气", () => {
  for (const operations of [[{ ...inspection, durationSec: 0 }], [{ ...inspection, atMin: .5 }], [inspection, inspection],
    [{ ...weather, wind: { dirDeg: 210, speedKt: 18, gustKt: 12 } }], [weather, { ...weather, id: "gust2", atMin: 1.5 }]]) assert.throws(() => fixture(operations as OperationDef[]));
  assert.deepEqual(new World(getLevel("tutorial")).snapshot().operations, []);
});

test("预告后可提前检查，按实际开始计时，拒绝请求不入回放", () => {
  const world = fixture(); assert(!world.startInspection("check").ok); to(world, 60);
  assert.equal(world.operations.snapshot()[0]!.stage, "announced"); assert(world.startInspection("check").ok);
  assert(!world.startInspection("check").ok); assert.equal(world.exportReplay().actions.length, 1);
  to(world, 209.9); assert.equal(world.operations.snapshot()[0]!.stage, "active");
  to(world, 210); assert.equal(world.operations.snapshot()[0]!.stage, "completed");
  assert.equal(world.score.violations, 0); assert.equal(world.operations.snapshot()[0]!.plannedAt, 300);
});

test("已获落地许可的来机不被检查抢占，实际清空后才开始", () => {
  const world = fixture(); to(world, 290); const ac = arrival(world); assert(world.issue(ac.id, { kind: "land" }).ok);
  assert(!world.startInspection("check").ok); to(world, 300);
  assert.equal(world.operations.snapshot()[0]!.stage, "pending"); assert(ac.landCleared);
  to(world, 450); assert.equal(world.score.landings, 1); assert.equal(world.score.goArounds, 0);
  const event = world.operations.snapshot()[0]!; assert.equal(event.stage, "active"); assert(event.startedAt! > 300);
  assert.equal(world.runwayOccupantId, null); assert.equal(world.score.violations, 0);
});

test("检查不困住已进入跑道的离场机，允许追加起飞直到释放", () => {
  const world = fixture(); to(world, 299); const ac = departure(world); assert(world.issue(ac.id, { kind: "lineup" }).ok);
  to(world, 301); assert.equal(world.operations.snapshot()[0]!.stage, "pending"); assert(world.issue(ac.id, { kind: "takeoff" }).ok);
  to(world, 400); assert.equal(world.score.takeoffs, 1); assert.equal(world.operations.snapshot()[0]!.stage, "active");
  assert(world.operations.snapshot()[0]!.startedAt! > 301); assert.equal(world.runwayOccupantId, null);
});

test("检查期间的落地、进跑道、起飞均由同一守卫拒绝，空中和地面引导保留", () => {
  const world = fixture(); to(world, 60); world.startInspection("check"); const dep = departure(world), arr = arrival(world);
  for (const kind of ["lineup", "takeoff"] as const) assert.match((world.issue(dep.id, { kind }) as { reason: string }).reason, /检查中/);
  assert.match((world.issue(arr.id, { kind: "land" }) as { reason: string }).reason, /检查中/);
  assert(world.commandOptions(dep).filter((option) => option.group === "跑道").every((option) => option.disabledReason === runwayBlockReason(world, dep)));
  assert(world.issue(arr.id, { kind: "goAround" }).ok); assert(world.issue(arr.id, { kind: "holdAir" }).ok);
  assert.equal(world.runwayOccupantId, null); assert.equal(dep.phase, "hold_short");
});

test("阵风分量按跑道方向和机型计算，同一时刻轻型等待而中型可起飞", () => {
  const world = fixture([weather]); to(world, 60); const light = departure(world, "AT72", "light"), medium = departure(world);
  const components = runwayWind(world.snapshot().weather, 270); assert(components.crosswindKt > 22 && components.crosswindKt < 23);
  assert.equal(windLimits("AT72").crosswindKt, 15); assert.equal(windLimits("B77W").crosswindKt, 28);
  assert.match((world.issue(light.id, { kind: "takeoff" }) as { reason: string }).reason, /AT72.*15kt.*恢复/);
  assert(!runwayBlockReason(world, light)!.includes("复飞"), "地面航班不应收到复飞恢复建议");
  assert(world.issue(medium.id, { kind: "takeoff" }).ok);
  assert.match(windRestriction({ dirDeg: 90, speedKt: 12 }, 270, "A320")!, /顺风/);
});

test("天气结束后恢复基准风况和许可，已承诺起飞不因天气变化中止", () => {
  const world = fixture([weather]); to(world, 59); const ac = departure(world, "AT72"); assert(world.issue(ac.id, { kind: "lineup" }).ok);
  to(world, 60); assert(world.issue(ac.id, { kind: "takeoff" }).ok); to(world, 120);
  assert.equal(world.windDirDeg, world.level.wind.dirDeg); assert.equal(world.windKt, world.level.wind.speedKt); assert.equal(world.windGustKt, world.windKt);
  assert.equal(world.operations.snapshot()[0]!.stage, "completed"); to(world, 160); assert.equal(world.score.takeoffs, 1);
});

test("跑道计划预测绕开检查和超限阵风；可用机型保留时窗", () => {
  const world = fixture(); to(world, 60); world.startInspection("check"); const dep = departure(world); world.changeRunwayPlan(dep.id, "add");
  const plan = world.snapshot().runwayPlan[0]!; assert(plan.occupyAt! >= 210 - .01); assert.match(plan.waitReason, /检查.*结束/);
  const gust = fixture([weather]); to(gust, 60); const light = departure(gust, "AT72"); gust.changeRunwayPlan(light.id, "add");
  assert.equal(gust.snapshot().runwayPlan[0]!.occupyAt, 120);
  light.typeId = "E190"; assert(gust.snapshot().runwayPlan[0]!.occupyAt! < 120);
});

test("待检查的计划估时包括已许可航班清空后的完整检查时间", () => {
  const world = fixture(); to(world, 290); const ac = arrival(world); world.issue(ac.id, { kind: "land" }); to(world, 300);
  const dep = departure(world); world.changeRunwayPlan(dep.id, "add"); const plan = world.snapshot().runwayPlan;
  assert.equal(plan[0]!.aircraftId, ac.id); assert(plan[1]!.occupyAt! >= plan[0]!.clearAt! + 150 - .01);
  assert.match(plan[1]!.waitReason, /检查.*结束/);
});

test("阵风时可把可用喷气机排在轻型机前，改序实际释放起飞窗口", () => {
  const world = fixture([weather]); to(world, 60); const light = departure(world, "AT72", "light"), jet = departure(world, "E190", "jet");
  world.changeRunwayPlan(light.id, "add"); world.changeRunwayPlan(jet.id, "add");
  assert.match((world.issue(jet.id, { kind: "takeoff" }) as { reason: string }).reason, /计划先安排 LIGHT/);
  assert(world.changeRunwayPlan(jet.id, "up").ok); assert(world.snapshot().runwayPlan[0]!.occupyAt! < 120);
  assert(world.issue(jet.id, { kind: "takeoff" }).ok); assert(!world.issue(light.id, { kind: "takeoff" }).ok);
});

test("尚未许可的计划前机跨过检查时刻，后机预测包含其清空后完整检查", () => {
  const world = fixture(); to(world, 250); const first = departure(world, "E190", "first"), second = departure(world, "E190", "second"), third = departure(world, "E190", "third");
  for (const ac of [first, second, third]) world.changeRunwayPlan(ac.id, "add");
  const plan = world.snapshot().runwayPlan; assert(plan[0]!.occupyAt! < 300); assert(plan[0]!.clearAt! > 300);
  assert(plan[1]!.occupyAt! >= plan[0]!.clearAt! + 150 - .01);
  assert.equal(plan[2]!.occupyAt, plan[1]!.clearAt, "完成一次检查后，不能为每一架后机重复顺延同一检查");
  const operations = world.operations.snapshot(); world.snapshot(); assert.deepEqual(world.operations.snapshot(), operations, "计划预测不能修改实际运行事件");
  assert(world.issue(first.id, { kind: "takeoff" }).ok);
  while (world.operations.snapshot()[0]!.stage !== "completed" && world.time < 600) world.step();
  const event = world.operations.snapshot()[0]!; assert.equal(event.stage, "completed");
  assert(plan[1]!.occupyAt! >= event.endsAt! - .01); assert(plan[1]!.occupyAt! < event.endsAt! + 5, "预测与实际检查开放应在模型估计误差内");
});

test("仍占跑道的脱离机原地等待时，计划保持待定；继续脱离后恢复估时", () => {
  const world = fixture(); to(world, 290); const ac = arrival(world); assert(world.issue(ac.id, { kind: "land" }).ok);
  while (ac.phase !== "taxi_in" && world.time < 600) world.step();
  assert.equal(world.runwayOccupantId, ac.id); assert(world.issue(ac.id, { kind: "hold" }).ok);
  const dep = departure(world); world.changeRunwayPlan(dep.id, "add");
  for (const time of [world.time, world.time + 100]) {
    to(world, time); const plan = world.snapshot().runwayPlan[0]!;
    assert.equal(plan.occupyAt, null); assert.equal(plan.useAt, null); assert.equal(plan.clearAt, null); assert.equal(plan.delaySec, null);
    assert.match(plan.waitReason, /ARR.*继续脱离.*待定/); assert.equal(world.operations.snapshot()[0]!.stage, "pending");
  }
  assert(world.issue(ac.id, { kind: "resume" }).ok);
  while (world.operations.snapshot()[0]!.stage === "pending" && world.time < 800) world.step();
  const event = world.operations.snapshot()[0]!; assert.equal(event.stage, "active");
  assert(world.snapshot().runwayPlan[0]!.occupyAt! >= event.endsAt! - .01);
});

test("推进下个请求会停在运行预告、关闭和恢复，避免跳过策略窗口", () => {
  const world = fixture(); const first = advanceToDecision(world); assert(Math.abs(first.advanced - 60) < .01); assert(first.operationChanged);
  world.startInspection("check"); const second = advanceToDecision(world); assert(Math.abs(second.advanced - 150) < .01); assert(second.operationChanged);
});

test("事件和风况快照不污染模拟；提前检查、天气与任意回放跳转一致", () => {
  const world = fixture([inspection, weather]); to(world, 60); world.startInspection("check"); to(world, 240);
  const snap = world.snapshot(); snap.operations.find((event) => event.id === "gust")!.wind!.speedKt = 999; snap.weather.speedKt = 999;
  assert.equal(world.windKt, 8); assert.equal(world.operations.snapshot().find((event) => event.id === "gust")!.wind!.speedKt, 18);
  const player = new ReplayPlayer(world.exportReplay()); player.seek(240); assert.deepEqual(player.world.snapshot(), world.snapshot());
  player.seek(90); assert.equal(player.world.windGustKt, 26); assert.equal(player.world.operations.snapshot()[0]!.stage, "active");
  player.seek(0); player.seek(240); assert.deepEqual(player.world.snapshot(), world.snapshot());
});

test("检查车与关闭标记只在实际关闭时出现，风袋跟随风向且暂停不飘移", () => {
  const world = fixture(); const scene = new EnvironmentModel(); scene.update(world);
  const before = scene.root.children.map((item) => item.visible); assert.equal(before.filter(Boolean).length, 3);
  to(world, 60); world.startInspection("check"); scene.update(world); assert(scene.root.children.every((item) => item.visible));
  const matrices = scene.root.children.map((item) => [item.position.toArray(), item.rotation.toArray()]); scene.update(world);
  assert.deepEqual(scene.root.children.map((item) => [item.position.toArray(), item.rotation.toArray()]), matrices);
  to(world, 210); scene.update(world); assert.equal(scene.root.children.filter((item) => item.visible).length, 3);
});

test("同班表两种检查策略均能完成，提前安排实际减少延误和复飞", () => {
  const normal = full(false), early = full(true);
  for (const world of [normal, early]) {
    assert.equal(world.status, "finished"); assert.equal(world.score.landings, 3); assert.equal(world.score.takeoffs, 5);
    assert.equal(world.score.serviced, 3); assert.equal(world.score.departuresTransferred, 5); assert.equal(world.score.violations, 0);
    assert.equal(world.runwayOccupantId, null); assert.equal(world.groundLocks.size, 0);
  }
  assert(early.score.totalDelaySec < normal.score.totalDelaySec - 300); assert(early.score.goArounds < normal.score.goArounds);
  const player = new ReplayPlayer(early.exportReplay()); player.seek(early.time); assert.deepEqual(player.world.snapshot(), early.snapshot());
  early.status = "finished"; assert(!early.startInspection("rwy-inspection").ok);
});

console.log(`\n运行事件回归通过 ${passed} 项`);
