import { confirmed } from "./test-radio";
import assert from "node:assert/strict";
import { getLevel } from "../src/data/levels";
import { botTick } from "../src/sim/bot";
import { spawnDeparture } from "../src/sim/aircraft";
import { rateShift } from "../src/sim/scoring";
import { ft } from "../src/sim/units";
import { World } from "../src/sim/world";

// These scenarios deliberately omit a legal player action or defer one request.
// They probe resource and ownership boundaries that an always-responsive bot skips.
const findings: string[] = [];
function audit(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { findings.push(name); console.log(`FAIL ${name}: ${(error as Error).message}`); }
}

audit("等待地面许可的到达机继续预留机位", () => {
  const original = getLevel("tutorial"), first = original.flights[0]!;
  const world = new World({ ...original, durationMin: 30, maxAircraft: 6, flights: [
    { ...first, callsign: "WAIT1", atMin: 0 },
    { ...first, callsign: "FOLLOW2", atMin: 3 },
  ] }, { mode: "standard", safetyMode: "guarded" });
  const issue = world.issue.bind(world);
  world.issue = (id, command) => world.aircraft.get(id)?.callsign === "WAIT1" && command.kind === "taxi"
    ? { ok: false, reason: "审计：玩家暂不下达滑入许可" } : issue(id, command);
  for (let tick = 0; tick < 15000 && world.status === "running"; tick++) {
    world.step(); if (tick % 20 === 0) botTick(world);
    const a = world.aircraftList().find((ac) => ac.callsign === "WAIT1");
    const b = world.aircraftList().find((ac) => ac.callsign === "FOLLOW2");
    if (a?.phase === "taxi_ready" && b?.phase === "taxi_in" && b.standId) {
      console.log(`  t=${world.time.toFixed(1)} first=${a.phase}/${a.standId} second=${b.phase}/${b.standId}`);
      assert.notEqual(b.standId, a.standId, "两架到达机拿到同一个预留机位");
      return;
    }
  }
  assert.fail("审计未到达目标阶段");
});

audit("标准模式不能通过等待飞机自动消失绕过 DEP 移交", () => {
  const world = new World(getLevel("ground-school"), { mode: "standard", safetyMode: "guarded" });
  const issue = world.issue.bind(world);
  world.issue = (id, command) => command.kind === "handoff" && command.controller === "DEP"
    ? { ok: false, reason: "审计：玩家漏做离场移交" } : issue(id, command);
  for (let tick = 0; tick < world.level.durationMin * 600 && world.status === "running"; tick++) {
    world.step(); if (tick % 20 === 0) botTick(world);
  }
  const grade = rateShift(world.score, world.level).grade;
  console.log(`  t=${world.time.toFixed(1)} status=${world.status} aircraft=${world.aircraft.size} grade=${grade} violations=${world.score.violations}`);
  assert(world.events.every((event) => !event.text.includes("移交 DEP")));
  assert(world.score.violations > 0 || grade !== "S", "没有移交离场仍提前成功且获得 S 级");
});

audit("机位占用导致延后生成的航班保留原计划延误", () => {
  const original = getLevel("ground-school"), flight = original.flights[0]!;
  const world = new World({ ...original, durationMin: 30, flights: [
    { ...flight, callsign: "BLOCKER", atMin: 0 },
    { ...flight, callsign: "LATE2", atMin: 1 },
  ] }, { mode: "standard", safetyMode: "guarded" });
  for (let tick = 0; tick < 6000; tick++) world.step();
  assert.equal(world.aircraft.size, 1);
  world.finish(world.aircraftList()[0]!); world.step();
  const late = world.aircraftList()[0]!;
  console.log(`  scheduledSpawn=60 actualSpawn=${late.spawnedAt.toFixed(1)} targetMovement=${late.scheduledMovementAt.toFixed(1)}`);
  assert(late.scheduledMovementAt <= 60 + 8 * 60 + 1, "实际生成时间覆盖原计划时间，抹掉约 9 分钟延误");
});

audit("推出后等待滑行的飞机仍预留进出机位走廊", () => {
  const original = getLevel("tutorial"), arrival = original.flights[0]!;
  const world = new World({ ...original, maxAircraft: 8, durationMin: 30, flights: [
    ...["S1", "S2", "S3"].map((standId, i) => ({ callsign: `BLOCK${i}`, airline: "测试", typeId: "A320", kind: "dep" as const, standId, atMin: 0 })),
    { callsign: "WAITDEP", airline: "测试", typeId: "E190", kind: "dep", standId: "S4", atMin: 0 },
    { ...arrival, callsign: "INGATE", atMin: 0 },
  ] }, { mode: "standard", safetyMode: "guarded" });
  const issue = world.issue.bind(world);
  world.issue = (id, command) => {
    const ac = world.aircraft.get(id)!;
    if (ac.callsign.startsWith("BLOCK") || ac.callsign === "WAITDEP" && command.kind !== "pushback") return { ok: false, reason: "审计：暂缓推出或滑行" };
    return issue(id, command);
  };
  for (let tick = 0; tick < 16000 && world.status === "running"; tick++) {
    world.step(); if (tick % 20 === 0) botTick(world);
    const dep = world.aircraftList().find((ac) => ac.callsign === "WAITDEP");
    const arr = world.aircraftList().find((ac) => ac.callsign === "INGATE");
    if (dep?.phase === "taxi_ready" && arr?.phase === "taxi_in" && arr.standId && arr.groundGoal === "stand") {
      console.log(`  t=${world.time.toFixed(1)} WAITDEP=${dep.phase}/${dep.groundNodeId}/${dep.standId} INGATE=${arr.phase}/${arr.standId}`);
      assert.notEqual(arr.standId, dep.standId, "到达机获配了推出后未清空进出走廊的机位，将在 AP↔B 间头对头互堵");
      assert(issue(dep.id, { kind: "taxi", route: "main" }).ok);
      for (let tick = 0; tick < 50; tick++) world.step();
      const demand = { ...arr, id: "new-stand-demand", standId: null };
      assert.notEqual(world.assignStand(demand), "S4", "刚开始 AP→B 滑行也不能提前释放共享走廊");
      for (let tick = 0; tick < 600; tick++) world.step();
      assert.equal(world.assignStand(demand), "S4", "离场机尾离开走廊后应及时释放机位");
      return;
    }
  }
  assert.fail("审计未到达目标阶段");
});

audit("移交离场后执行层也拒绝本席继续引导", () => {
  const world = new World(getLevel("ground-school"), { mode: "standard", safetyMode: "guarded" });
  for (let tick = 0; tick < 6000 && world.status === "running"; tick++) {
    world.step(); if (tick % 20 === 0) botTick(world);
    const dep = world.aircraftList().find((ac) => ac.controller === "DEP");
    if (dep) {
      const before = dep.clearedHdg;
      assert(!confirmed(world, dep.id, { kind: "heading", hdg: 123 }).ok);
      assert(!confirmed(world, dep.id, { kind: "speed", kt: 100 }).ok);
      assert.equal(dep.clearedHdg, before);
      return;
    }
  }
  assert.fail("审计未到达离场移交阶段");
});

audit("重型离场不能从不兼容机位生成", () => {
  const original = getLevel("ground-school");
  const flight = { ...original.flights[0]!, typeId: "B77W", standId: "S2" };
  assert.throws(() => new World({ ...original, flights: [flight] }), /不兼容/);
  const world = new World(original);
  assert.equal(spawnDeparture(world, { id: "bad-heavy", callsign: "HEAVY", airline: "测试", typeId: "B77W", kind: "dep", standId: "S2" }), null);
});

audit("截止时尚未完成离场移交不能被评为流程完整 S 级", () => {
  const world = new World({ ...getLevel("ground-school"), durationMin: 7.5 }, { mode: "standard", safetyMode: "guarded" });
  for (let tick = 0; tick < 5000 && world.status === "running"; tick++) {
    world.step(); if (tick % 20 === 0) botTick(world);
  }
  const pending = world.aircraftList().filter((ac) => ac.phase === "departure" && ac.controller !== "DEP");
  assert.equal(world.score.takeoffs, 1); assert.equal(pending.length, 1);
  assert.notEqual(rateShift(world.score, world.level).grade, "S", "起飞后未完成移交，却在截止时评为完整流程");
});

audit("双滑行道中同向队列通过东侧联络道后均能实际起飞", () => {
  for (const reversed of [false, true]) {
    const original = getLevel("ground-school");
    const flights = [
      { ...original.flights[0]!, callsign: "MAIN", standId: "S1" },
      { ...original.flights[0]!, callsign: "BYPASS", standId: "S4" },
    ];
    const world = new World({ ...original, flights: reversed ? flights.reverse() : flights, targetMovements: 2 }, { mode: "standard", safetyMode: "guarded" });
    world.step();
    // Exact regression setup: both aircraft approach the same merge at equal
    // speed and distance. Thereafter every movement uses a real taxi clearance.
    for (const ac of world.aircraftList()) {
      const nodeId = ac.callsign === "MAIN" ? "B1000" : "B700";
      ac.phase = "taxi_ready"; ac.groundNodeId = nodeId;
      ac.pos = { ...world.idx.nodes.get(nodeId)!.pos }; ac.hdg = 90; ac.gs = 0;
      const command = ac.callsign === "MAIN"
        ? { kind: "taxi" as const, route: "main" as const }
        : { kind: "taxi" as const, route: "bypass" as const, via: ["B1090"] };
      assert(confirmed(world, ac.id, command).ok);
      const ids = ac.route!.points.map((point) => [...world.idx.nodes.values()].find((node) => node.pos.x === point.x && node.pos.y === point.y)?.id);
      assert(ids.includes("P1090"));
      assert(ids.includes("B1090"), "离场路线应从 B1090 接入 P1090");
    }
    const passedMerge = new Set<string>(); let waitedForMerge = false;
    for (let tick = 0; tick < 9000 && world.status === "running"; tick++) {
      world.step();
      for (const ac of world.aircraftList()) {
        if (ac.groundNodeId === "P1090") passedMerge.add(ac.callsign);
        if (ac.phase === "taxi_out" && ac.blockedBy) waitedForMerge = true;
        if (tick % 20) continue;
        if (ac.phase === "hold_short") {
          if (ac.controller !== "TWR") assert(confirmed(world, ac.id, { kind: "handoff", controller: "TWR" }).ok);
          confirmed(world, ac.id, { kind: "takeoff" });
        } else if (ac.phase === "departure" && ac.controller !== "DEP" && ac.altM - world.idx.def.elevationM >= ft(1500)) {
          assert(confirmed(world, ac.id, { kind: "handoff", controller: "DEP" }).ok);
        }
      }
    }
    assert.equal(passedMerge.size, 2, "两架飞机都应通过 P1090 等待点");
    assert(waitedForMerge, "应覆盖真实交汇等待，而非完全错开的两次通行");
    assert.equal(world.score.takeoffs, 2, `合流后卡死：${world.aircraftList().map((ac) => `${ac.callsign}/${ac.phase}/${ac.blockedBy}`).join("; ")}`);
    assert.equal(world.score.departuresTransferred, 2);
    assert.equal(world.score.violations, 0);
    assert.equal(world.runwayOccupantId, null); assert.equal(world.groundLocks.size, 0);
  }
});

if (findings.length) process.exitCode = 1;
console.log(`\n边界审计：${findings.length} 个问题`);
