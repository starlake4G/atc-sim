import assert from "node:assert/strict";
import { AIRCRAFT_TYPES } from "../src/data/aircraft-types";
import { AIRPORTS } from "../src/data/airports";
import { getLevel } from "../src/data/levels";
import { ARRIVAL_ENTRIES, CHALLENGE_FIXES, CHALLENGE_ID, createChallenge, normalizeChallengeSeed } from "../src/sim/challenge";
import { botTick } from "../src/sim/bot";
import { ft, kt, nm } from "../src/sim/units";
import { World } from "../src/sim/world";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`✓ ${name}`); }

test("种子统一规范，空值有默认且同种子严格复现", () => {
  assert.equal(normalizeChallengeSeed(" ｔｅｓｔ  ２０２６ "), "TEST-2026");
  assert.equal(normalizeChallengeSeed(null), normalizeChallengeSeed(""));
  assert.equal(normalizeChallengeSeed("a".repeat(100)).length, 40);
  const level = createChallenge(" test  2026 ");
  assert.equal(level.id, CHALLENGE_ID);
  assert.deepEqual(level, createChallenge("TEST-2026"));
  assert.notDeepEqual(level.flights, createChallenge("TEST-2027").flights);
  level.flights[0]!.callsign = "MUTATED";
  assert.notEqual(createChallenge("TEST-2026").flights[0]!.callsign, "MUTATED");
});

test("128 个种子均生成完整合法班表与三个分开的进场入口", () => {
  const airport = AIRPORTS.kestrel;
  const fixes = new Map([...airport.fixes, ...CHALLENGE_FIXES].map((fix) => [fix.name, fix]));
  for (let seed = 1; seed <= 128; seed++) {
    const level = createChallenge(seed);
    assert.equal(level.flights.length, 12);
    assert(level.durationMin >= 25 && level.durationMin <= 35);
    assert.equal(new Set(level.flights.map((flight) => flight.callsign)).size, 12);
    const arrivals = level.flights.filter((flight) => flight.kind === "arr");
    const departures = level.flights.filter((flight) => flight.kind === "dep");
    assert.equal(arrivals.length, 6);
    assert.equal(departures.length, 6);
    assert.equal(new Set(departures.map((flight) => flight.standId)).size, 6);
    assert(arrivals.some((flight) => flight.typeId === "B77W"));
    assert(arrivals.some((flight) => flight.typeId === "AT72"));
    for (const entry of ARRIVAL_ENTRIES) assert.equal(arrivals.filter((flight) => flight.entryFix === entry.id).length, 2);
    for (const flight of level.flights) {
      assert(AIRCRAFT_TYPES[flight.typeId]);
      assert(flight.atMin >= 0 && flight.atMin <= level.durationMin - 15);
      if (flight.kind === "dep") {
        const stand = airport.stands.find((item) => item.id === flight.standId);
        assert(stand);
        if (AIRCRAFT_TYPES[flight.typeId]!.wake === "H") assert.equal(stand.size, "L");
      } else {
        assert(fixes.has(flight.entryFix!));
        assert((flight.initialAltFt ?? 0) >= 6000);
        assert(flight.arrivalRoute?.every((fix) => fixes.has(fix)));
        const entry = fixes.get(flight.entryFix!)!;
        assert(Math.hypot(entry.pos.x, entry.pos.y) < 42000);
      }
    }
    for (let i = 1; i < arrivals.length; i++) assert((arrivals[i]!.atMin - arrivals[i - 1]!.atMin) * 60 >= 143.9);
  }
});

test("未传进场配置的既有关卡继续从原始入口生成", () => {
  const world = new World(getLevel("tutorial")); world.step();
  const aircraft = world.aircraftList()[0]!;
  assert.equal(aircraft.altM, ft(6000));
  assert.equal(aircraft.route?.points[0]?.x, 30000);
  assert.equal(aircraft.route?.points[0]?.y, 11000);
  assert.equal(aircraft.route?.points.at(-1)?.x, 19000);
  assert.equal(aircraft.route?.points.at(-1)?.y, 6000);
});

test("28 个挑战种子在标准模式完成全部进离场与滑入，没有违规或资源残留", () => {
  for (const seed of ["KESTREL-2026", "TEST-2026", "中国机场", "A", ...Array.from({ length: 24 }, (_, index) => index + 1)]) {
    const level = createChallenge(seed);
    const world = new World(level, { mode: "standard" });
    const observedEntries = new Set<string>();
    const observedAircraft = new Set<string>();
    for (let tick = 0; tick <= level.durationMin * 600 && world.status === "running"; tick++) {
      world.step();
      for (const aircraft of world.aircraft.values()) {
        assert(Number.isFinite(aircraft.pos.x) && Number.isFinite(aircraft.pos.y) && Number.isFinite(aircraft.altM));
        if (aircraft.kind === "arr" && !observedAircraft.has(aircraft.id)) {
          observedAircraft.add(aircraft.id);
          const flight = level.flights.find((item) => item.callsign === aircraft.callsign)!;
          observedEntries.add(flight.entryFix!);
          const fix = world.idx.fixes.get(flight.entryFix!)!;
          assert(fix, `${seed}: 缺少入口 ${flight.entryFix}`);
          assert(Math.hypot(aircraft.pos.x - fix.pos.x, aircraft.pos.y - fix.pos.y) < 30, `${seed}: 没有使用配置入口 ${flight.entryFix}`);
          assert.equal(aircraft.altM, ft(flight.initialAltFt!));
          assert.equal(aircraft.targetGs, kt(flight.initialSpeedKt!));
          assert.deepEqual(aircraft.route?.points, [fix.pos, ...flight.arrivalRoute!.map((name) => world.idx.fixes.get(name)!.pos)]);
          for (const other of world.aircraft.values()) {
            if (other.id === aircraft.id) continue;
            assert(Math.hypot(other.pos.x - aircraft.pos.x, other.pos.y - aircraft.pos.y) >= nm(3) || Math.abs(other.altM - aircraft.altM) >= ft(1000), `${seed}: 入口处生成时已失去间隔`);
          }
        }
      }
      if (tick % 20 === 0) botTick(world);
    }
    assert.equal(world.status, "finished", `seed ${seed}`);
    assert.equal(observedEntries.size, 3, `seed ${seed}`);
    assert.equal(world.score.landings, 6, `seed ${seed}: 落地`);
    assert.equal(world.score.takeoffs, 6, `seed ${seed}: 离场`);
    assert.equal(world.score.serviced, 6, `seed ${seed}: 完整滑入`);
    assert.equal(world.score.violations, 0, `seed ${seed}: ${world.events.filter((event) => event.kind === "violation").map((event) => event.text).join("; ")}`);
    assert.equal(world.runwayOccupantId, null, `seed ${seed}`);
    assert.equal(world.groundLocks.size, 0, `seed ${seed}`);
  }
});

console.log(`\n种子挑战回归通过 ${passed} 项（128 个班表、28 个完整班次）`);
