import assert from "node:assert/strict";
import * as THREE from "three";
import { AIRCRAFT_TYPES } from "../src/data/aircraft-types";
import { AIRPORTS } from "../src/data/airports";
import { buildAirport } from "../src/sim/airport";
import { LEVELS, getLevel } from "../src/data/levels";
import { botTick } from "../src/sim/bot";
import { predictConflicts } from "../src/sim/awareness";
import { taxiRoute } from "../src/sim/ground";
import { Rng } from "../src/sim/rng";
import { rateShift } from "../src/sim/scoring";
import { wakeRemaining } from "../src/sim/runway";
import { ft, kt } from "../src/sim/units";
import { dist } from "../src/sim/vec";
import { World } from "../src/sim/world";
import { makeAircraftMesh } from "../src/views/aircraft-model";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }
function runShift(world: World) {
  for (let i = 0; i <= world.level.durationMin * 600 && world.status === "running"; i++) {
    world.step(); if (i % 20 === 0) botTick(world);
    for (const ac of world.aircraft.values()) assert(Number.isFinite(ac.pos.x) && Number.isFinite(ac.pos.y) && Number.isFinite(ac.altM));
  }
  assert.equal(world.status, "finished");
}

test("全部标准模式班次均完成进离场及滑入，资源无残留", () => {
  for (const level of LEVELS) {
    const world = new World(level, { mode: "standard" }); runShift(world);
    assert.equal(world.score.landings, level.flights.filter((f) => f.kind === "arr").length, level.id);
    assert.equal(world.score.takeoffs, level.flights.filter((f) => f.kind === "dep").length, level.id);
    assert.equal(world.score.serviced, world.score.landings, level.id);
    assert.equal(world.score.violations, 0, level.id);
    assert.equal(world.runwayOccupantId, null, level.id);
    assert.equal(world.groundLocks.size, 0, level.id);
  }
});

test("18 组密集波次及旁通道组合不会形成永久地面互堵", () => {
  for (let seed = 1; seed <= 18; seed++) {
    const rng = new Rng(seed), original = getLevel("morning-rush");
    const factor = .5 + (seed % 5) * .06;
    const level = { ...original, maxAircraft: 12, flights: original.flights.map((f) => ({ ...f, atMin: Math.max(0, f.atMin * factor + (rng.next() - .5) * .3) })) };
    const world = new World(level, { mode: "standard" });
    const issue = world.issue.bind(world);
    world.issue = (id, command) => issue(id, command.kind === "taxi" && world.aircraft.get(id)?.kind === "dep" && (Number(id.slice(2)) + seed) % 2 ? { ...command, route: "bypass" } : command);
    runShift(world);
    assert.equal(world.score.serviced, 6, `seed ${seed}: 滑入未完成`);
    assert.equal(world.score.takeoffs, 5, `seed ${seed}: 离场未完成`);
    assert.equal(world.groundLocks.size, 0, `seed ${seed}`);
  }
});

test("推出后必须等待滑行许可；地图路径校验遵守有向道路", () => {
  const world = new World(getLevel("ground-school"), { mode: "standard" }); world.step();
  const ac = world.aircraftList()[0]!;
  assert(world.issue(ac.id, { kind: "pushback", hdg: 0 }).ok);
  for (let i = 0; i < 1500; i++) world.step();
  assert.equal(ac.phase, "taxi_ready"); const position = { ...ac.pos };
  for (let i = 0; i < 300; i++) world.step(); assert.equal(dist(position, ac.pos), 0);
  assert(taxiRoute(world, ac, { kind: "taxi", route: "bypass" })?.points.some((point) => point.x === 700 && point.y === 250));
  assert(!world.issue(ac.id, { kind: "taxi", route: "main", via: ["LINEUP"] }).ok);
  assert(world.issue(ac.id, { kind: "taxi", route: "bypass" }).ok);
});

test("合法席位移交有状态边界，重复移交不能刷分", () => {
  const world = new World(getLevel("ground-school"), { mode: "standard" }); world.step();
  const ac = world.aircraftList()[0]!;
  assert(!world.issue(ac.id, { kind: "handoff", controller: "DEP" }).ok);
  ac.phase = "hold_short";
  assert(!world.issue(ac.id, { kind: "takeoff" }).ok);
  assert(world.issue(ac.id, { kind: "handoff", controller: "TWR" }).ok);
  assert(!world.issue(ac.id, { kind: "handoff", controller: "TWR" }).ok);
  assert.equal(world.score.points, 0);
});

test("空中等待可持续且可通过直飞恢复", () => {
  const world = new World(getLevel("tutorial"), { mode: "standard" }); world.step(); const ac = world.aircraftList()[0]!;
  ac.pos = { x: 19000, y: 6000 }; ac.hdg = 270; ac.gs = kt(180); ac.targetGs = kt(180);
  assert(world.issue(ac.id, { kind: "holdAir" }).ok);
  for (let i = 0; i < 6000; i++) world.step();
  assert(world.aircraft.has(ac.id)); assert(ac.airHolding); assert.equal(world.score.violations, 0);
  assert(world.issue(ac.id, { kind: "direct", fix: "KAVLA" }).ok); assert(!ac.airHolding);
});

test("不稳定进近复飞后可沿恢复路径重新完成落地", () => {
  const world = new World({ ...getLevel("tutorial"), durationMin: 35 }, { mode: "standard" }); world.step(); const ac = world.aircraftList()[0]!;
  ac.pos = { x: 1199, y: 0 }; ac.hdg = 270; ac.altM = ft(2500); ac.phase = "approach"; ac.approach = { runwayId: "27", established: true };
  ac.controller = "TWR"; ac.landCleared = true;
  world.step(); assert.equal(world.score.goArounds, 1); assert(ac.route);
  runShift(world); assert.equal(world.score.landings, 1); assert.equal(world.score.serviced, 1);
});

test("未来冲突提示不直接增加违规计数", () => {
  const world = new World(getLevel("tutorial")); world.step(); const a = world.aircraftList()[0]!;
  a.pos = { x: -4000, y: 0 }; a.hdg = 90; a.gs = kt(220); a.altM = ft(6000); a.vs = 0;
  const b = { ...a, id: "second", callsign: "SECOND", pos: { x: 4000, y: 0 }, hdg: 270 };
  assert(predictConflicts([a, b], 0, 0).length > 0); assert.equal(world.score.violations, 0);
});

test("机位兼容、满位等待与已占资源清理", () => {
  const world = new World(getLevel("tutorial")); world.step(); const ac = world.aircraftList()[0]!; ac.typeId = "B77W";
  const stand = world.assignStand(ac)!; assert.equal(world.idx.stands.get(stand)?.size, "L");
  world.groundLocks.set("edge", ac.id); world.finish(ac); assert.equal(world.groundLocks.size, 0);
});

test("重型机后的小型机需等待尾流间隔，过期后可放行", () => {
  const world = new World(getLevel("ground-school"), { mode: "standard" }); world.step(); const ac = world.aircraftList()[0]!;
  ac.typeId = "AT72"; ac.phase = "hold_short"; ac.controller = "TWR";
  world.lastRunwayUse = { callsign: "HEAVY1", typeId: "B77W", at: world.time };
  assert.equal(wakeRemaining(world, ac), 120); assert(!world.issue(ac.id, { kind: "takeoff" }).ok);
  world.time += 121; assert(world.issue(ac.id, { kind: "takeoff" }).ok);
});

test("评级区分完整滑入和延误；安全复飞本身不降安全级别", () => {
  const level = getLevel("tutorial"); const score = new World(level).score;
  score.landings = 1; score.serviced = 1; score.points = 16; score.goArounds = 1;
  assert.equal(rateShift(score, level).grade, "S");
  score.totalDelaySec = 300; assert.equal(rateShift(score, level).grade, "A");
  score.serviced = 0; assert.equal(rateShift(score, level).grade, "B");
});

test("六种飞机模型轮胎接地，宽体翼展和机身尺寸合理", () => {
  for (const type of Object.values(AIRCRAFT_TYPES)) {
    const mesh = makeAircraftMesh(type.id, "极光航空"); mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh), size = box.getSize(new THREE.Vector3());
    assert(box.min.y >= -.01 && box.min.y < .01, `${type.id}: 穿地或悬空 ${box.min.y}`);
    assert(size.x >= type.lengthM * .95 && size.x <= type.lengthM * 1.1, type.id);
    assert(size.y > 7 && size.y < 22, type.id);
    if (type.wake === "H") assert(size.z >= 64 && size.z < 70);
  }
});

test("未配置反向程序的跑道在启动时明确拒绝，避免反向起降异常", () => {
  assert.throws(() => buildAirport(AIRPORTS.kestrel, "09"), /尚未配置对应方向/);
});
console.log(`\n玩法与建模回归通过 ${passed} 项`);
