import { AIRPORTS } from "../src/data/airports";
import { buildAirport, findTaxiPath } from "../src/sim/airport";
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
    const w = new World(lvl);
    for (let i = 0; i < 600; i++) w.step();
    for (const ac of w.aircraftList()) {
      if (!Number.isFinite(ac.pos.x) || !Number.isFinite(ac.altM)) return `${lvl.id} 出现 NaN`;
    }
  }
  return true;
});

check("全流程：正常关卡能在机器人管制下完成多架次落地与起飞", () => {
  const lvl = getLevel("morning-rush");
  const w = new World(lvl);
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
  return true;
});

check("全流程：一架进场机能沿 STAR 进场、截获 ILS 并落地", () => {
  const lvl = { ...getLevel("tutorial") };
  const w = new World(lvl);
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
  const w = new World(lvl);
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
  const w = new World(lvl);
  for (let i = 0; i < 300; i++) w.step();
  const ac = w.aircraftList()[0];
  if (!ac) return "没有生成飞机";
  w.occupyRunway(ac);
  const res = w.issue(ac.id, { kind: "land" });
  return res.ok === false || "应当被拒绝";
});

check("分离：两架飞机贴近时会被判为冲突", () => {
  const lvl = getLevel("tutorial");
  const w = new World(lvl);
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
  const w = new World(lvl);
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

console.log(`\n通过 ${pass} / ${pass + failures.length}`);
if (failures.length > 0) {
  console.log("失败：");
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
