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
  edges:   [{ a, b, maxKt }],            // 无向边，滑行图
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
滑行道（y=190）   P-1150 ── P-700 ── ... ── P1090(H) ── LINEUP
                     │         │              (跑道外等待点)
机位（y=420）      ST1 ═ AP1 ═ P-700   ← 每个机位三段：机位 → 机坪口 → 滑行道
跑道（y=0）        E_A1 / E_A2 / E_A3   ← 脱离口落在这条线上，再向北接滑行道
```

- 机位用三段链（`stand → apron → taxi`），推出时走前两段
- 脱离口 `atM` 是**距跑道入口**的距离（不是距跑道端），三个口建议 800 / 1200 / 1600 米，第一个标 `highSpeed`
- `LINEUP` 放在入口内侧 80 米处（`threshold + dir * 80`），起飞滑跑从这里开始

### 1.5 多跑道

`AirportDef.runways` 可以有多个方向（Kestrel 有 09/27），但 **一个关卡只用一条**：`LevelDef.runwayId`。
跑道是单一互斥资源，同时开两条跑道要改 `World` 的跑道占用模型（目前是 `runwayOccupantId: string | null`），不是加数据能解决的。

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
- 航班表按 `atMin` 升序写，生成器按顺序投放
- 难度三个旋钮：`maxAircraft`（同时压力）、航班密度（`atMin` 间隔）、`targetMovements`（评级门槛）

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

例：`http://localhost:5173/?level=morning-rush&fast=700&bot=1`

---

## 4. 修改后必须跑

```bash
cd atc-sim
npm run typecheck
npm run sim:test    # 含"每个机位都能滑到跑道外等待点"这类数据校验
npm run build
```

`sim:test` 里有一条"全流程"断言：机器人把整个班次跑完，落地与起飞架次不足会失败。改机场/航班表后这条最容易先炸，它就是用来兜住"改数据改坏了玩法链路"的。
