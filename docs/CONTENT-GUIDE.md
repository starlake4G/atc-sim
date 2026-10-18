# 加一个机场 / 加一个关卡

> 目标：加内容不改代码。机场是数据，关卡是数据 + 一条航班表。
> 相关目录：`atc-sim/src/data/airports/`、`atc-sim/src/data/levels.ts`

---

## 1. 加一个机场

### 1.1 坐标系

局部 ENU 平面，原点任取（一般取跑道中点附近）：

- `x` = 东（米），`y` = 北（米）
- 航向 `0` = 正北，顺时针增加（`90` = 东）
- 跑道沿 `x` 轴摆最省事：`27` 号跑道入口在 `x = +1200`，另一端在 `x = -1200`

### 1.2 必备字段

```ts
{
  id: "kestrel",            // 唯一标识，关卡用它引用
  icao: "KEKS",
  name: "Kestrel International",
  elevationM: 8,            // 标高，飞机接地高度取这个值
  tower: { pos: {x, y}, heightM },   // 3D 塔台位置（目前只影响建模，不影响玩法）

  runways: [{ id, hdg, lengthM, widthM, threshold, end, exits }],
  nodes:   [{ id, pos, kind, label }],   // kind: taxi | stand | apron | exit | holding | lineup
  edges:   [{ a, b, maxKt, oneWay, traffic }], // 可设有向边；traffic 可限制 arr / dep
  stands:  [{ id, node, pos, hdg, size }],
  fixes:   [{ name, pos }],
  arrival: { entryFix, iafFix },
  departure: ["BEKTO", "LUSAK"],
}
```

### 1.3 必须满足的约束（启动即校验，不合法直接抛错）

| 约束 | 为什么 |
|---|---|
| 恰好一个 `kind: "holding"` 节点与一个 `kind: "lineup"` 节点 | 跑道外等待与进跑道是两条固定相位 |
| 每条 `edge` 两端的节点都存在 | 打错字会让飞机凭空停住 |
| 每个机位节点都能沿图走到 `holding` | 否则离场机永远到不了跑道，必死锁 |
| 每个脱离口节点都能连通滑行道 | 否则落地后无法脱离 |
| `arrival.entryFix` / `iafFix` / `departure[]` 里的航路点都存在 | 进场/离场航路要能生成 |

校验实现见 `sim/airport.ts` 的 `buildAirport()`，报错信息会直接指出是哪个机位、哪个脱离口。

### 1.4 滑行图怎么摆（Kestrel 的摆法可以直接抄）

```
机位（y=500）       ST1 / ST2 / ... / ST6
机坪（y=420）       AP1 / AP2 / ... / AP6
离场 B（y=330）     B-1150 → ... → B1090 ↓
进场 A（y=150）     P-1150 ← ... ← P1090(H) → LINEUP
跑道（y=0）         E_A1 / E_A2 / E_A3 / E_A4
```

- 机位到机坪为推出路径；标准模式停在机坪申请滑行，辅助模式继续推荐路线
- 路段可用 `oneWay` 和 `traffic` 指定方向与机型流向。A 道进场西向，B 道离场东向；进场机经联络道到机位，必要时经西侧环路回到 B 道
- B1090 → P1090 是唯一东端离场联络道；C 旁通道已删除。西端 P-1150 → B-1150 保留进场闭环，A4 在 x=-900 接入 A 道
- 脱离口 `atM` 是**距跑道入口**的距离（不是距跑道端），四个口为 800 / 1200 / 1600 / 2100 米；当前曲线脱离按 12 kt 校验，不因 `highSpeed` 标签跳过转弯减速
- `LINEUP` 放在入口内侧 80 米处（`threshold + dir * 80`），起飞滑跑从这里开始

### 1.5 多跑道

`AirportDef.runways` 可以记录多个方向，但 **一个关卡只用一条**：`LevelDef.runwayId`。Kestrel 当前仅 27 方向有完整程序；09 保留几何记录，缺少反向进跑道点，启动校验会明确拒绝。新增方向需同时配置等待点、进跑道点、进离场程序。
当前关卡仍只有一条使用方向，`runwayTraffic` 派生全部实际使用者，`runwayOccupantId` 保留首位兼容显示。多跑道仍需按跑道分别维护占用、计划与尾流，不能只加数据。

### 1.6 注册

```ts
// src/data/airports/index.ts
export const AIRPORTS = { kestrel: KESTREL, myport: MYPORT };
```

---

## 2. 加一个关卡

```ts
const MY_LEVEL: LevelDef = {
  id: "evening",
  name: "第三班 · 黄昏",
  airportId: "kestrel",
  startClockMin: 18 * 60,      // 18:00 开局
  durationMin: 45,             // 班次长度（游戏分钟）
  runwayId: "27",
  wind: { dirDeg: 250, speedKt: 12 },
  maxAircraft: 10,             // 同时在场上限，直接决定难度
  targetMovements: 12,         // 评级用的目标架次（落地 + 起飞）
  flights: [
    { callsign: "AUR201", airline: "极光航空", typeId: "A320", kind: "dep", atMin: 0, standId: "S2" },
    { callsign: "VLT310", airline: "北风航空", typeId: "B738", kind: "arr", atMin: 2 },
    // ...
  ],
};
```

规则：

- `atMin` 是相对班次开始的分钟数，进场机会在该时刻出现在入口点（约 31 公里外）
- 离场机必须给 `standId`，且同一时刻不能有两架离场机共用一个机位
- 进场机不用给机位：落地脱离时自动分配空机位
- 重型离场只能使用 `size: "L"` 机位；指定不兼容机位、重复呼号或不存在的进场航路点会在 World 初始化时明确报错
- `entryFix` / `arrivalRoute` / `initialAltFt` / `initialSpeedKt` 可覆盖默认进场；航路列表应从入口后的定位点开始，省略时完全沿用机场默认入口与程序
- `seed?: string` 标识可重复班表；Kestrel 挑战生成器在 `sim/challenge.ts`，按版本和规范化种子生成 12 架航班。修改生成规则时须递增 `CHALLENGE_VERSION`
- 建议航班表按 `atMin` 升序写；生成器独立检查到期航班，等待机位的离场机不会阻塞后续进场
- 难度三个旋钮：`maxAircraft`（同时压力）、航班密度（`atMin` 间隔）、`targetMovements`（评级门槛）
- `operations?: OperationDef[]` 可添加固定运行窗口。每项有唯一 `id`、`name`、`announceMin`（预告）、`atMin`（计划生效）、`durationSec`（持续游戏秒）。`kind: "inspection"` 可在预告后提前开始；到时暂停新许可，待已承诺航班清空后开始，持续时间按实际开始计算。`kind: "weather"` 另有 `wind: { dirDeg, speedKt, gustKt? }`，按固定时刻生效并恢复基准风况；天气窗口不可重叠。事件结束应落在班次时长内。
- 跑道风分量和轻 / 中 / 重型 15 / 24 / 28kt 侧风限制在 `sim/operations.ts`，属于游戏规则。已进入跑道与已获落地许可的航班不因天气或检查被抢占。新增事件需测试预告、共享许可守卫、恢复、计划预测和确定性回放，避免制造无法提前处理的失败。

加完在 `src/data/levels.ts` 的 `LEVELS` 数组里登记即可，开始界面自动出现。

---

## 3. 调试入口（URL 参数）

| 参数 | 作用 |
|---|---|
| `?level=tutorial` | 跳过开始界面直接进关卡 |
| `&fast=540` | 先把世界快进 540 游戏秒再渲染（看中后段画面） |
| `&bot=1` | 快进期间让测试机器人接管（能直接看到落地/起飞的场面） |
| `&lite=1` | 关阴影、锁 1 倍像素比（无头截图用，正常玩不要加） |
| `&view=tower\|follow\|top` | 指定初始视角 |
| `&mode=standard` | 标准模式：滑行许可和席位移交；默认调试使用辅助模式 |
| `&seed=KESTREL-2026` | `level=seed-challenge` 时指定可重复挑战种子 |
| `&paused=1` | 完成 URL 快进后保持暂停，方便检查特定运行窗口或截图 |

例：`http://localhost:5173/?level=morning-rush&fast=700&bot=1`

---

## 4. 修改后必须跑

```bash
cd atc-sim
npm run accept      # 类型、数据、玩法、排序、挑战及边界回归
npm run build
```

`sim:test` 里有一条"全流程"断言：机器人把整个班次跑完，落地与起飞架次不足会失败。改机场/航班表后这条最容易先炸，它就是用来兜住"改数据改坏了玩法链路"的。

## 仿真与安全模式（2026-10-18）

1× 已改为实时。所有指令等待完整发话与复诵；新增关卡必须给出足够的通信与滑行时间。离场目标为请求后 8 分钟，种子挑战预算 45 分钟。详细规则及验证见 [仿真与控制改造](ATC-PHYSICS-AND-CONTROL.md)。
