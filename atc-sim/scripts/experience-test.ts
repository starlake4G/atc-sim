import assert from "node:assert/strict";
import { LEVELS, getLevel } from "../src/data/levels";
import { World } from "../src/sim/world";
import { botTick } from "../src/sim/bot";
import { ReplayPlayer } from "../src/sim/replay";
import { advanceToDecision, decisionFlights, recommendedCommand } from "../src/sim/flow";
import { aggregateDelays, delayReason } from "../src/sim/debrief";
import { kt } from "../src/sim/units";
import { makeAircraftMesh, updateAircraftModel } from "../src/views/aircraft-model";
import * as THREE from "three";
import { AIRCRAFT_TYPES } from "../src/data/aircraft-types";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }
const normalize = (world: World) => {
  const snap = world.snapshot();
  return { ...snap, selectedId: null, aircraft: snap.aircraft.map(({ route, ...ac }) => ({ ...ac, route: route ? { points: route.points, minS: route.minS, total: route.total } : null })) };
};
function complete(world: World) { for (let tick = 0; tick < world.level.durationMin * 600 && world.status === "running"; tick++) { world.step(); if (tick % 20 === 0) botTick(world); } }

test("全部关卡完整回放重建相同最终状态、无线电、评分和延误归因", () => {
  for (const level of LEVELS) {
    const world = new World(level, { mode: "standard" }); complete(world);
    const record = world.exportReplay(); assert(record.actions.length > 0, level.id);
    const player = new ReplayPlayer(record); player.seek(record.endedAt);
    assert.deepEqual(normalize(player.world), normalize(world), level.id);
    assert.equal(player.world.exportReplay().actions.length, 0);
  }
});

test("计划改序、拒绝指令与回放快照互不污染，任意跳转可复现", () => {
  const world = new World(getLevel("intersection"), { mode: "standard" }); world.step();
  const [dep, arr] = world.aircraftList();
  assert(!world.issue(dep!.id, { kind: "takeoff" }).ok);
  world.changeRunwayPlan(dep!.id, "add"); world.changeRunwayPlan(arr!.id, "add"); world.changeRunwayPlan(arr!.id, "up"); world.changeRunwayPlan(dep!.id, "remove");
  world.issue(dep!.id, { kind: "pushback", hdg: 180 });
  for (let i = 0; i < 850; i++) world.step();
  const middle = normalize(world);
  const player = new ReplayPlayer(world.exportReplay()); player.seek(world.time); assert.deepEqual(normalize(player.world), middle);
  player.seek(12); player.seek(world.time); assert.deepEqual(normalize(player.world), middle);
  const copy = world.exportReplay(); copy.actions.length = 0; assert.equal(world.exportReplay().actions.length, 5);
});

test("回放小于一个tick的帧时间会累积，暂停和倒退不跳过操作", () => {
  const world = new World(getLevel("ground-school"), { mode: "standard" }); complete(world);
  const player = new ReplayPlayer(world.exportReplay());
  for (let i = 0; i < 60; i++) player.advance(1 / 60);
  assert(Math.abs(player.world.time - 1) < .001);
  player.seek(0); player.advance(world.time + 10); assert.deepEqual(normalize(player.world), normalize(world)); assert(player.ended);
  player.seek(-20); assert.equal(player.world.time, 0); player.seek(Infinity); assert.equal(player.world.time, 0);
});

test("无待办才推进时间；推出后停在滑行请求，不会自动许可", () => {
  const world = new World(getLevel("ground-school"), { mode: "standard" }); world.step();
  const ac = world.aircraftList()[0]!; assert.equal(recommendedCommand(world, ac)?.key, "push-180");
  assert.equal(advanceToDecision(world).advanced, 0);
  world.issue(ac.id, { kind: "pushback", hdg: 180 }); assert.equal(decisionFlights(world).length, 0);
  const result = advanceToDecision(world); assert(result.advanced > 10); assert.equal(result.aircraftId, ac.id);
  assert.equal(ac.phase, "taxi_ready"); assert.equal(ac.route, null); assert.equal(world.exportReplay().actions.length, 1);
});

test("时间推进会停在新航班或临近落地的安全决定，主动等待不制造待办", () => {
  const original = getLevel("ground-school"), world = new World({ ...original, flights: [{ ...original.flights[0]!, atMin: 2 }] }, { mode: "standard" });
  const result = advanceToDecision(world); assert(Math.abs(result.advanced - 120) < .11); assert(result.aircraftId);
  const air = new World(getLevel("tutorial"), { mode: "standard" }); air.step(); const ac = air.aircraftList()[0]!;
  ac.pos = { x: 19000, y: 6000 }; ac.hdg = 270; ac.gs = ac.targetGs = kt(180);
  assert(air.issue(ac.id, { kind: "holdAir" }).ok); assert.equal(decisionFlights(air).length, 0);
  ac.airHolding = false; ac.pos = { x: 4000, y: 0 }; ac.phase = "approach"; ac.approach = { runwayId: "27", established: false };
  const urgent = advanceToDecision(air); assert.equal(urgent.advanced, 0); assert.equal(urgent.aircraftId, ac.id);
});

test("逐航班延误归因只计目标时刻后，合计与实际延误吻合", () => {
  const level = getLevel("ground-school"), world = new World(level, { mode: "standard" });
  for (let i = 0; i < 5000; i++) world.step();
  complete(world);
  const report = world.snapshot().movementReports[0]!;
  assert(report.actualAt !== null && report.transferred);
  assert(report.delays.permission > 139); assert(report.delays.taxi > 0);
  const total = Object.values(aggregateDelays(world.snapshot().movementReports)).reduce((a, b) => a + b, 0);
  assert(Math.abs(total - world.score.totalDelaySec) < .11);
  assert(Math.abs(total - (report.actualAt! - report.targetAt)) < .11);
});

test("结束后的操作不能添加记录，推进也不改变已结算世界", () => {
  const world = new World(getLevel("tutorial")); complete(world); const before = normalize(world), count = world.exportReplay().actions.length;
  assert.equal(advanceToDecision(world).advanced, 0); assert(!world.issue("ac1", { kind: "goAround" }).ok); assert(!world.changeRunwayPlan("ac1", "add").ok);
  assert.equal(world.exportReplay().actions.length, count); assert.deepEqual(normalize(world), before);
});

test("飞机根据真实转弯和升降显示姿态，暂停不抹掉转弯倾斜，接地恢复水平", () => {
  const world = new World(getLevel("tutorial")); world.step(); const ac = world.aircraftList()[0]!;
  const mesh = makeAircraftMesh(ac.typeId, ac.airline); ac.gs = kt(180); ac.vs = 4;
  updateAircraftModel(mesh, ac, .2, 8, 0); ac.hdg += 2; updateAircraftModel(mesh, ac, .2, 8, 1);
  assert(mesh.rotation.x > 0 && mesh.rotation.x <= .44); assert(mesh.rotation.z > 0);
  const bank = mesh.rotation.x; updateAircraftModel(mesh, ac, .2, 8, 1); assert(mesh.rotation.x >= bank);
  ac.phase = "taxi_ready"; ac.altM = 8; updateAircraftModel(mesh, ac, .2, 8, 2);
  assert.equal(mesh.rotation.x, 0); assert.equal(mesh.rotation.z, 0); assert(mesh.userData.gear.visible);
});

test("未完成而退出的航班不会在删除后继续积累虚假的容量等待", () => {
  const world = new World(getLevel("tutorial")); for (let tick = 0; tick < 5000; tick++) world.step();
  world.finish(world.aircraftList()[0]!); const before = world.snapshot().movementReports[0]!;
  for (let tick = 0; tick < 1000; tick++) world.step(); const after = world.snapshot().movementReports[0]!;
  assert(before.closed && after.closed); assert.equal(after.actualAt, null); assert.deepEqual(after.delays, before.delays);
});

test("主动等待与实际交通阻塞分开归因，已许可进跑道不误算许可等待", () => {
  const world = new World(getLevel("ground-school")); world.step(); const ac = world.aircraftList()[0]!;
  ac.phase = "taxi_out"; ac.holding = true; ac.blockedBy = "管制员要求等待";
  assert.equal(delayReason(ac, false), "permission"); ac.holding = false; ac.blockedBy = "前机占用";
  assert.equal(delayReason(ac, false), "traffic"); ac.blockedBy = null; ac.phase = "lineup";
  assert.equal(delayReason(ac, false), "runway");
});

test("六种模型在细节合批后保持拾取、地面接触及渲染对象预算", () => {
  for (const type of Object.keys(AIRCRAFT_TYPES)) {
    const mesh = makeAircraftMesh(type, "极光航空"); mesh.userData.aircraftId = type; mesh.updateMatrixWorld(true);
    let count = 0; mesh.traverse((object) => { if (object instanceof THREE.Mesh) count++; });
    assert(count <= 16, `${type} 超出每机绘制对象预算：${count}`);
    const box = new THREE.Box3().setFromObject(mesh); assert(Math.abs(box.min.y) < .01);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 30, 0), new THREE.Vector3(0, -1, 0));
    const hits = ray.intersectObject(mesh, true); assert(hits.length > 0);
    let object: THREE.Object3D | null = hits[0]!.object;
    while (object && !object.userData.aircraftId) object = object.parent;
    assert.equal(object?.userData.aircraftId, type);
    assert(mesh.userData.gear.parent === mesh);
  }
});
console.log(`\n体验与回放回归通过 ${passed} 项`);
