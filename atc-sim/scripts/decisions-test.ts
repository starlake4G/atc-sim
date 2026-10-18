import { confirmed } from "./test-radio";
import assert from "node:assert/strict";
import { getLevel } from "../src/data/levels";
import { getType } from "../src/data/aircraft-types";
import { World } from "../src/sim/world";
import { spawnArrival, spawnDeparture } from "../src/sim/aircraft";
import { approachRunwayETA, departurePreparationSec, departureWindow, departureWindowEstimates, runwayBlockReason } from "../src/sim/runway";
import { summarizePlan, type RunwayPlanEntry } from "../src/sim/planning";
import { ReplayPlayer } from "../src/sim/replay";
import { makeRoute } from "../src/sim/route";
import { kt } from "../src/sim/units";
import type { Aircraft, OperationDef } from "../src/sim/types";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }
function fixture(operations: OperationDef[] = []) {
  return new World({ ...getLevel("operating-windows"), wind: { dirDeg: 270, speedKt: 0 }, operations,
    flights: [{ ...getLevel("ground-school").flights[0]!, atMin: 30 }] }, { mode: "standard", safetyMode: "guarded" });
}
function dep(world: World, id = "dep", typeId = "AT72"): Aircraft {
  const ac = spawnDeparture(world, { id, callsign: id.toUpperCase(), airline: "清风航空", typeId, kind: "dep", standId: typeId === "B77W" ? "S1" : "S5" })!;
  ac.phase = "hold_short"; ac.controller = "TWR"; ac.groundNodeId = world.idx.holdingNode; ac.pos = { ...world.idx.nodes.get(world.idx.holdingNode)!.pos };
  world.aircraft.set(id, ac); return ac;
}
function arr(world: World, id = "arr", seconds = 160, speed = 180, typeId = "A320"): Aircraft {
  const ac = spawnArrival(world, { id, callsign: id.toUpperCase(), airline: "极光航空", typeId, kind: "arr", standId: null });
  ac.phase = "approach"; ac.controller = "TWR"; ac.approach = { runwayId: "27", established: true }; ac.hdg = 270;
  ac.gs = kt(speed); ac.pos = { x: world.idx.runway.threshold.x + seconds * (Math.max(kt(speed), kt(getType(typeId).vappKt)) + kt(world.windKt)), y: 0 };
  world.aircraft.set(id, ac); return ac;
}

test("充足的起飞窗口显示正余量，原许可守卫仍保持可用", () => {
  const world = fixture(), ac = dep(world), incoming = arr(world, "arr", 180);
  const estimate = departureWindowEstimates(world, ac)[0]!;
  assert.equal(estimate.callsign, incoming.callsign); assert(estimate.marginSec > 30); assert(estimate.requiredSec > estimate.preparationSec);
  assert.equal(estimate.arrivalInSec, approachRunwayETA(world, incoming)); assert.equal(departureWindow(world, ac), null);
  assert.equal(runwayBlockReason(world, ac), undefined); assert(world.commandOptions(ac).some((option) => option.key === "takeoff" && !option.disabledReason));
});

test("约束取所有来机的最小余量，慢机可比更近的快机留下更少余量", () => {
  const world = fixture(), ac = dep(world), fast = arr(world, "fast", 150, 250), slow = arr(world, "slow", 165, 120, "AT72");
  const estimates = departureWindowEstimates(world, ac);
  assert(approachRunwayETA(world, fast) < approachRunwayETA(world, slow)); assert.equal(estimates[0]!.aircraftId, slow.id);
  assert(estimates[0]!.marginSec < estimates[1]!.marginSec); assert.equal(estimates.length, 2);
});

test("来机足够完成滑跑却不够爬升和2NM缓冲时，余量与真实守卫均不足", () => {
  const world = fixture(), ac = dep(world), preparation = departurePreparationSec(world, ac); arr(world, "arr", preparation + 5);
  const estimate = departureWindowEstimates(world, ac)[0]!; assert(estimate.arrivalInSec > preparation); assert(estimate.marginSec < 0);
  assert(estimate.releaseSec > 0 && estimate.bufferSec > 5); assert(departureWindow(world, ac)); assert(!confirmed(world, ac.id, { kind: "takeoff" }).ok);
});

test("正余量不绕过占用、尾流、检查、侧风、计划或塔台移交", () => {
  const world = fixture(), ac = dep(world); arr(world, "arr", 300); const other = dep(world, "other", "E190");
  const positive = () => assert(departureWindowEstimates(world, ac)[0]!.marginSec > 0);
  world.runwayOccupantId = other.id; positive(); assert.match(runwayBlockReason(world, ac)!, /占用/);
  world.runwayOccupantId = null; world.lastRunwayUse = { callsign: "HEAVY", typeId: "B77W", at: world.time }; positive(); assert.match(runwayBlockReason(world, ac)!, /尾流/);
  world.lastRunwayUse = null; world.changeRunwayPlan(other.id, "add"); positive(); assert.match(runwayBlockReason(world, ac)!, /计划/);
  world.changeRunwayPlan(other.id, "remove"); ac.controller = "GND"; positive(); assert(!confirmed(world, ac.id, { kind: "takeoff" }).ok);
  const check = fixture([{ id: "check", name: "检查", kind: "inspection", announceMin: 0, atMin: 5, durationSec: 60 }]); check.step();
  const checked = dep(check); arr(check, "arr", 300); assert(check.startInspection("check").ok); assert(departureWindowEstimates(check, checked)[0]!.marginSec > 0); assert.match(runwayBlockReason(check, checked)!, /检查/);
  const gust = fixture([{ id: "gust", name: "阵风", kind: "weather", announceMin: 0, atMin: 0, durationSec: 60, wind: { dirDeg: 210, speedKt: 18, gustKt: 26 } }]); gust.step();
  const light = dep(gust); arr(gust, "arr", 300); assert(departureWindowEstimates(gust, light)[0]!.marginSec > 0); assert.match(runwayBlockReason(gust, light)!, /侧风/);
});

test("进跑道剩余路程改变时窗口同步变化，无进近来机不构造无限余量", () => {
  const world = fixture(), ac = dep(world); assert.deepEqual(departureWindowEstimates(world, ac), []); arr(world);
  const first = departureWindowEstimates(world, ac)[0]!;
  ac.phase = "lineup"; ac.route = makeRoute([ac.pos, { x: ac.pos.x + 15, y: ac.pos.y }]);
  const next = departureWindowEstimates(world, ac)[0]!; assert(next.preparationSec < first.preparationSec); assert(next.marginSec > first.marginSec);
  ac.phase = "departure"; assert.deepEqual(departureWindowEstimates(world, ac), []);
});

test("重型与轻型试排能比较尾流代价，反复预览不改变世界、路线或记录", () => {
  const world = fixture(); world.time = 500; const heavy = dep(world, "heavy", "B77W"), light = dep(world, "light");
  heavy.scheduledMovementAt = light.scheduledMovementAt = 360;
  world.changeRunwayPlan(heavy.id, "add"); world.changeRunwayPlan(light.id, "add");
  const before = world.snapshot(), journal = world.exportReplay(); let result = world.runwayPlan.previewMove(world, light.id, -1);
  for (let i = 0; i < 12; i++) result = world.runwayPlan.previewMove(world, light.id, -1);
  assert(result.ok); const original = summarizePlan(before.runwayPlan), preview = summarizePlan((result as { ok: true; entries: RunwayPlanEntry[] }).entries);
  assert(original.lastClearAt! - preview.lastClearAt! > 100); assert(preview.totalDelaySec! < original.totalDelaySec!);
  assert.deepEqual(world.snapshot(), before); assert.deepEqual(world.exportReplay(), journal);
  (result as { ok: true; entries: RunwayPlanEntry[] }).entries[0]!.callsign = "MUTATED"; assert.equal(world.snapshot().runwayPlan[0]!.callsign, "HEAVY");
});

test("试排遵守承诺边界，越过锁定前机、无效航班和边界都明确拒绝", () => {
  const world = fixture(), heavy = dep(world, "heavy", "B77W"), light = dep(world, "light");
  world.changeRunwayPlan(heavy.id, "add"); world.changeRunwayPlan(light.id, "add"); heavy.phase = "lineup"; world.runwayOccupantId = heavy.id;
  const before = world.snapshot(); const result = world.runwayPlan.previewMove(world, light.id, -1);
  assert(!result.ok); assert.match((result as { ok: false; reason: string }).reason, /锁定/); assert(!world.runwayPlan.previewMove(world, heavy.id, -1).ok); assert(!world.runwayPlan.previewMove(world, "missing", 1).ok);
  assert.deepEqual(world.snapshot(), before);
});

test("待定方案不把未知当零延误，交换后仍有等待时不虚假排名", () => {
  const world = fixture(), heavy = dep(world, "heavy", "B77W"), light = dep(world, "light"); heavy.holding = true;
  world.changeRunwayPlan(heavy.id, "add"); world.changeRunwayPlan(light.id, "add");
  const original = summarizePlan(world.snapshot().runwayPlan), result = world.runwayPlan.previewMove(world, light.id, -1); assert(result.ok);
  const preview = summarizePlan((result as { ok: true; entries: RunwayPlanEntry[] }).entries); assert.equal(original.totalDelaySec, null); assert.equal(preview.totalDelaySec, null); assert.equal(preview.lastClearAt, null);
  assert.equal(original.known, 0); assert.equal(preview.known, 1); assert.match(preview.waitReason!, /等待继续滑行/);
});

test("试排沿用检查和风况窗口，预测上下文不会污染实际事件", () => {
  const world = fixture([{ id: "gust", name: "阵风", kind: "weather", announceMin: 0, atMin: 0, durationSec: 120, wind: { dirDeg: 210, speedKt: 18, gustKt: 26 } }]); world.step();
  const light = dep(world, "light"), jet = dep(world, "jet", "E190"); world.changeRunwayPlan(light.id, "add"); world.changeRunwayPlan(jet.id, "add");
  const before = world.snapshot(), result = world.runwayPlan.previewMove(world, jet.id, -1); assert(result.ok);
  const res = result as { ok: true; entries: RunwayPlanEntry[] }; assert(res.entries[0]!.occupyAt! < before.runwayPlan[0]!.occupyAt!); assert(res.entries[1]!.occupyAt! >= 120);
  assert.deepEqual(world.snapshot(), before);
  const check = fixture([{ id: "check", name: "检查", kind: "inspection", announceMin: 0, atMin: 5, durationSec: 60 }]); check.step(); check.startInspection("check");
  const a = dep(check, "a"), b = dep(check, "b", "E190"); check.changeRunwayPlan(a.id, "add"); check.changeRunwayPlan(b.id, "add");
  const events = check.operations.snapshot(), checked = check.runwayPlan.previewMove(check, b.id, -1); assert(checked.ok);
  const cr = checked as { ok: true; entries: RunwayPlanEntry[] }; assert(cr.entries[0]!.occupyAt! >= events[0]!.endsAt!); assert.deepEqual(check.operations.snapshot(), events);
});

test("采用预览才生成一次真实改序，回放可精确重建被采用的计划", () => {
  const world = new World(getLevel("intersection"), { mode: "standard", safetyMode: "guarded" }); world.step(); const [first, second] = world.aircraftList();
  world.changeRunwayPlan(first!.id, "add"); world.changeRunwayPlan(second!.id, "add"); const count = world.exportReplay().actions.length;
  const preview = world.runwayPlan.previewMove(world, second!.id, -1); assert(preview.ok); assert.equal(world.exportReplay().actions.length, count);
  assert(world.changeRunwayPlan(second!.id, "up").ok); assert.equal(world.exportReplay().actions.length, count + 1); assert.deepEqual(world.snapshot().runwayPlan, (preview as { ok: true; entries: RunwayPlanEntry[] }).entries);
  const player = new ReplayPlayer(world.exportReplay()); player.seek(world.time); assert.deepEqual(player.world.snapshot(), world.snapshot());
});
console.log(`\n调度决策回归通过 ${passed} 项`);
