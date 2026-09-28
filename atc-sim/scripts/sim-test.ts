/**
 * Sim Core 无头冒烟测试
 *
 * 不依赖浏览器，直接以固定步长驱动世界，验证运动学 / 指令 / 进近 / 冲突
 * 的真实行为。跑法见 package.json 的 `npm run sim:test`。
 */

import { AIRPORT } from '../src/data/airports/aurora';
import { createAircraft } from '../src/sim/aircraft';
import { spawnArrival, spawnDeparture } from '../src/sim/traffic';
import { canClearApproach } from '../src/ui/commands';
import { createWorld, stepWorld, commandAircraft, worldStats } from '../src/sim/world';
import { angleDiff, ft2m, kt2ms, m2ft, m2nm, ms2kt, nm2m, norm360 } from '../src/sim/units';
import { headingToVec } from '../src/sim/vec';

const DT = 1 / 20;

let failures = 0;

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

function advance(seconds: number, w: ReturnType<typeof createWorld>): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) stepWorld(w, DT);
}

function inject(
  w: ReturnType<typeof createWorld>,
  o: { id: number; x: number; y: number; zFt: number; heading: number; iasKt: number },
) {
  const ac = createAircraft(
    {
      id: o.id,
      callsign: `TEST${o.id}`,
      type: 'A320',
      pos: { x: o.x, y: o.y, z: ft2m(o.zFt) },
      heading: o.heading,
      ias: kt2ms(o.iasKt),
    },
    0,
  );
  w.aircraft.push(ac);
  return ac;
}

// ---------------------------------------------------------------------------

console.log('\n[1] 世界推进与定步长');
{
  const w = createWorld({ airport: AIRPORT, seed: 7, storm: false });
  advance(120, w);
  check('时间按真实秒推进', Math.abs(w.time - 120) < 0.1, `t=${w.time.toFixed(2)}s`);
  check('交通能自动生成', w.aircraft.length > 0, `${w.aircraft.length} 架`);
  const allFinite = w.aircraft.every(
    (a) => Number.isFinite(a.pos.x) && Number.isFinite(a.pos.y) && Number.isFinite(a.pos.z),
  );
  check('位置数值有限（无 NaN）', allFinite);
}

console.log('\n[2] 航向指令与转弯惯性');
{
  const w = createWorld({ airport: AIRPORT, seed: 11 });
  const ac = inject(w, { id: 900, x: -20000, y: 30000, zFt: 10000, heading: 180, iasKt: 250 });
  commandAircraft(w, 900, { kind: 'heading', value: 90 });
  advance(90, w);
  const diff = Math.abs(angleDiff(ac.heading, 90));
  check('转向指令生效', diff < 5, `heading=${ac.heading.toFixed(1)}°`);

  // 转弯必须是渐进的：短时间内不可能转完 90°
  const w2 = createWorld({ airport: AIRPORT, seed: 12 });
  const ac2 = inject(w2, { id: 901, x: -20000, y: 30000, zFt: 10000, heading: 180, iasKt: 250 });
  commandAircraft(w2, 901, { kind: 'heading', value: 90 });
  advance(6, w2);
  check('转弯有惯性（非瞬转）', Math.abs(angleDiff(ac2.heading, 180)) < 60, `6s 后 ${ac2.heading.toFixed(1)}°`);
}

console.log('\n[3] 高度与速度指令');
{
  const w = createWorld({ airport: AIRPORT, seed: 21 });
  const ac = inject(w, { id: 910, x: -20000, y: 30000, zFt: 10000, heading: 180, iasKt: 250 });
  commandAircraft(w, 910, { kind: 'altitude', value: ft2m(6000) });
  advance(180, w);
  const errFt = Math.abs(m2ft(ac.pos.z) - 6000);
  check('下降并稳住在目标高度', errFt < 100, `误差 ${errFt.toFixed(0)} ft`);

  commandAircraft(w, 910, { kind: 'speed', value: kt2ms(200) });
  advance(120, w);
  const errKt = Math.abs(ac.ias / 0.514444 - 200);
  check('减速指令生效', errKt < 8, `误差 ${errKt.toFixed(1)} kt`);
}

console.log('\n[4] ILS 进近与落地');
{
  const w = createWorld({ airport: AIRPORT, seed: 31 });
  const rw = AIRPORT.runways[0]; // 18L
  // 放在跑道入口正北 18 NM、下滑道略上方
  const ac = createAircraft(
    {
      id: 920,
      callsign: 'TEST920',
      type: 'A320',
      pos: { x: rw.threshold.x, y: rw.threshold.y + 18 * 1852, z: ft2m(6000) },
      heading: 180,
      ias: kt2ms(180),
    },
    0,
  );
  w.aircraft.push(ac);
  commandAircraft(w, 920, { kind: 'clearedApproach', runway: rw.ident });
  advance(600, w);
  check('清进近后能截获并落地', ac.phase === 'LANDED', `phase=${ac.phase}`);

  // 单独验证：未清进近时不应自己落地
  const w2 = createWorld({ airport: AIRPORT, seed: 32 });
  const ac2 = createAircraft(
    {
      id: 921,
      callsign: 'TEST921',
      type: 'A320',
      pos: { x: rw.threshold.x, y: rw.threshold.y + 18 * 1852, z: ft2m(6000) },
      heading: 180,
      ias: kt2ms(180),
    },
    0,
  );
  w2.aircraft.push(ac2);
  advance(300, w2);
  check('未清进近不会自动落地', ac2.phase !== 'LANDED', `phase=${ac2.phase}`);
}

console.log('\n[5] 复飞');
{
  const w = createWorld({ airport: AIRPORT, seed: 41 });
  const rw = AIRPORT.runways[0];
  const ac = createAircraft(
    {
      id: 930,
      callsign: 'TEST930',
      type: 'A320',
      pos: { x: rw.threshold.x, y: rw.threshold.y + 8 * 1852, z: ft2m(3000) },
      heading: 180,
      ias: kt2ms(160),
    },
    0,
  );
  w.aircraft.push(ac);
  commandAircraft(w, 930, { kind: 'clearedApproach', runway: rw.ident });
  advance(60, w);
  const altBefore = ac.pos.z;
  commandAircraft(w, 930, { kind: 'goAround' });
  advance(90, w);
  check('复飞后开始爬升', ac.pos.z > altBefore + 100, `+${(ac.pos.z - altBefore).toFixed(0)} m`);
}

console.log('\n[6] 冲突探测');
{
  const w = createWorld({ airport: AIRPORT, seed: 51 });
  // 两架对头飞，同高度
  inject(w, { id: 940, x: -30000, y: 0, zFt: 20000, heading: 90, iasKt: 300 });
  inject(w, { id: 941, x: 30000, y: 0, zFt: 20000, heading: 270, iasKt: 300 });
  advance(20, w);
  check('远距离时能预测到冲突', w.conflicts.length > 0, `${w.conflicts.length} 对`);

  const far = createWorld({ airport: AIRPORT, seed: 52 });
  inject(far, { id: 942, x: -30000, y: 0, zFt: 20000, heading: 90, iasKt: 300 });
  inject(far, { id: 943, x: 30000, y: 0, zFt: 34000, heading: 270, iasKt: 300 });
  advance(20, far);
  check('垂直间隔足够时不报警', far.conflicts.length === 0, `${far.conflicts.length} 对`);
}

console.log('\n[7] 等待航线');
{
  const w = createWorld({ airport: AIRPORT, seed: 61 });
  const wp = AIRPORT.waypoints.find((x) => x.name === 'BRAVO')!;
  const ac = createAircraft(
    {
      id: 950,
      callsign: 'TEST950',
      type: 'A320',
      pos: { x: wp.pos.x - 8000, y: wp.pos.y - 8000, z: ft2m(12000) },
      heading: norm360(45),
      ias: kt2ms(220),
    },
    0,
  );
  w.aircraft.push(ac);
  commandAircraft(w, 950, { kind: 'hold', fix: 'BRAVO' });
  advance(120, w);
  const d = Math.hypot(ac.pos.x - wp.pos.x, ac.pos.y - wp.pos.y);
  check('已进入等待航线', ac.holding?.entered === true, `距等待点 ${m2nm(d).toFixed(1)} NM`);
  check('高度保持稳定', Math.abs(m2ft(ac.pos.z) - 12000) < 300, `${m2ft(ac.pos.z).toFixed(0)} ft`);
}

console.log('\n[8] 起飞与离场');
{
  const w = createWorld({ airport: AIRPORT, seed: 71 });
  const rw = AIRPORT.runways[0];
  const ac = createAircraft(
    {
      id: 960,
      callsign: 'TEST960',
      type: 'B738',
      pos: { x: rw.threshold.x, y: rw.threshold.y, z: rw.elevation },
      heading: rw.heading,
      ias: 0,
      isDeparture: true,
      phase: 'GROUND',
    },
    0,
  );
  w.aircraft.push(ac);

  advance(30, w);
  check('未给许可时停在原地', ac.ias < 1, `ias=${(ac.ias / 0.514444).toFixed(1)} kt`);

  commandAircraft(w, 960, { kind: 'takeoff' });
  advance(240, w);
  check('起飞许可后离地爬升', ac.pos.z > ft2m(1000), `${m2ft(ac.pos.z).toFixed(0)} ft`);
}

console.log('\n[9] 长时运行稳定性（30 分钟仿真，无人干预）');
{
  const w = createWorld({ airport: AIRPORT, seed: 99, storm: true });
  const t0 = Date.now();
  advance(1800, w);
  const ms = Date.now() - t0;
  const st = worldStats(w);

  const finite = w.aircraft.every(
    (a) =>
      Number.isFinite(a.pos.x) &&
      Number.isFinite(a.pos.y) &&
      Number.isFinite(a.pos.z) &&
      Number.isFinite(a.heading) &&
      Number.isFinite(a.ias),
  );
  check('30 分钟后无 NaN', finite);
  check(
    '飞机数不失控',
    w.aircraft.length <= st.capacity + 6,
    `${w.aircraft.length} 架 / 容量 ${st.capacity}`,
  );
  check('仿真吞吐足够快', ms < 20000, `${ms}ms 跑完 1800s 仿真`);
  check('日志未无限增长', w.log.length <= 120, `${w.log.length} 条`);
  console.log(`        （分数 ${st.score}，冲突告警 ${st.conflicts} 对，容量 ${st.capacity}）`);
}

console.log('\n[10] 起飞滑跑保持跑道航向');
{
  const w = createWorld({ airport: AIRPORT, seed: 23, storm: false });
  w.aircraft.length = 0; // 清掉预置交通，隔离被测飞机
  const dep = spawnDeparture(950, AIRPORT, '18L', 'AURORA1D', 0, w.rand);
  if (dep) {
    w.aircraft.push(dep);
    commandAircraft(w, 950, { kind: 'takeoff' });
    advance(20, w);
    check(
      '滑跑阶段保持跑道航向',
      Math.abs(angleDiff(dep.heading, 180)) < 5,
      `20s 后 heading=${dep.heading.toFixed(1)}°`,
    );
    check(
      '滑跑不偏离跑道中线（侧风不吹偏）',
      Math.abs(dep.pos.x - (-380)) < 5,
      `x=${dep.pos.x.toFixed(1)}m（18L 中线 x=-380）`,
    );
    advance(110, w);
    check(
      '升空爬升后转向 SID',
      dep.phase === 'CLIMB' && Math.abs(angleDiff(dep.heading, 180)) > 15,
      `phase=${dep.phase} heading=${dep.heading.toFixed(1)}°`,
    );
  }
}

// ---------------------------------------------------------------------------
// 链路级断言：上面各组只测部件，这三组测"主玩法能不能真的跑通"
// ---------------------------------------------------------------------------

console.log('\n[11] 航路推进（回归：绕点死循环）');
{
  const w = createWorld({ airport: AIRPORT, seed: 101 });
  w.aircraft.length = 0;
  const arr = spawnArrival(970, AIRPORT, 'AURORA1A', 0, w.rand);
  if (arr) {
    w.aircraft.push(arr);
    const d0 = Math.hypot(arr.pos.x, arr.pos.y);
    advance(600, w);
    const d1 = Math.hypot(arr.pos.x, arr.pos.y);
    check('STAR 航路点能推进', arr.routeIndex > 0, `idx=${arr.routeIndex}/${arr.route.length}`);
    check('沿航路向机场收敛（不绕点盘旋）', d1 < d0 - nm2m(15), `距场 ${m2nm(d0).toFixed(1)} → ${m2nm(d1).toFixed(1)} NM`);
  }
}

console.log('\n[12] 交通生成不被开局预置名额卡死');
{
  const w = createWorld({ airport: AIRPORT, seed: 102 });
  advance(720, w);
  check('无人干预 12 分钟内有新航班生成', w.traffic.spawned > 0, `${w.traffic.spawned} 架`);
}

console.log('\n[13] 指令条门控 + 端到端落地链路');
{
  const w = createWorld({ airport: AIRPORT, seed: 103 });
  w.aircraft.length = 0;
  const arr = spawnArrival(980, AIRPORT, 'AURORA1A', 0, w.rand);
  const dep = spawnDeparture(981, AIRPORT, '18R', 'AURORA2D', 0, w.rand);
  if (arr && dep) {
    w.aircraft.push(arr, dep);
    check('门控：空中进场机可给 ILS 许可', canClearApproach(arr));
    check('门控：地面等待机不可给 ILS 许可', !canClearApproach(dep));

    // 像玩家一样飞：先减速、再按 3° 剖面逐级降高，压到剖面附近清 ILS
    const rw = AIRPORT.runways[0]; // 18L
    const ALT_STEPS = [12000, 8000, 6000, 4000, 3000];
    let cleared = false;
    let slowed = false;
    const steps = Math.round((40 * 60) / DT);
    for (let i = 0; i < steps && arr.phase !== 'LANDED'; i++) {
      stepWorld(w, DT);
      if (!canClearApproach(arr)) continue;
      const altFt = m2ft(arr.pos.z);
      // 以 18L 中心线延长线为基准：进近侧轴向距离 + 横向偏离（雷达屏上玩家就照这个判）
      const u = headingToVec(rw.heading);
      const axial = (arr.pos.x - rw.threshold.x) * u.x + (arr.pos.y - rw.threshold.y) * u.y;
      const dNm = m2nm(Math.abs(axial));
      const latNm = m2nm(Math.abs((arr.pos.x - rw.threshold.x) * -u.y + (arr.pos.y - rw.threshold.y) * u.x));
      if (!cleared && axial < 0 && dNm < 15 && latNm < 2 && altFt < 6000) {
        commandAircraft(w, arr.id, { kind: 'clearedApproach', runway: rw.ident });
        cleared = true;
      }
      if (!slowed && ms2kt(arr.ias) > 210 && dNm < 45) {
        commandAircraft(w, arr.id, { kind: 'speed', value: kt2ms(210) });
        slowed = true;
      }
      // 清了进近就把垂直剖面交给下滑道，别再手压高度
      if (cleared || arr.approach?.slopeCaptured) continue;
      if (Math.abs(arr.pos.z - arr.intent.altitude) < 60) {
        const want = Math.max(3000, dNm * 300);
        const nextStep = ALT_STEPS.find((s) => s <= want) ?? ALT_STEPS[ALT_STEPS.length - 1];
        if (nextStep < m2ft(arr.intent.altitude)) {
          commandAircraft(w, arr.id, { kind: 'altitude', value: ft2m(nextStep) });
        }
      }
    }
    check('玩家能在指令条上给出首次 ILS 许可', cleared, `t=${(w.time / 60).toFixed(1)}min`);
    check(
      '沿 STAR 进场的航班最终落地',
      arr.phase === 'LANDED',
      `phase=${arr.phase}，距场 ${m2nm(Math.hypot(arr.pos.x, arr.pos.y)).toFixed(1)} NM`,
    );
  }
}

// ---------------------------------------------------------------------------

console.log(
  failures === 0
    ? '\n全部通过。\n'
    : `\n${failures} 项失败。\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
