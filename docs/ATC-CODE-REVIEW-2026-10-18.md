# 代码审查：2026-10-18 工作区快照

> 审查时间窗 19:22–19:36。HEAD = `49329b8`，未提交 36 个文件（+607 / −347）。
> **重要前提：审查期间工作区一直在被另一个会话写入**（`world.ts` 19:25→19:29、`operations-test.ts` 19:26、`ground.ts` 19:29 连续变化），所以下面的结论只对"我取样时的文件内容"成立，不是对最终版的判决。

---

## 0. 结论

1. **方向是对的。** 这一轮把游戏从"在正确时刻点许可"改成了"排序、许可、恢复"，新增的计划/试排/运行窗口/回放/安全模式都是真实的机制增量，不是装修。
2. **当前快照是绿的**：`npm run accept`（typecheck + 10 个逻辑套件）全通过；sim 层仍然零渲染依赖。测试从 108 项扩到 131 项（新增 control 套件 23 项）。
3. **但有 2 个玩家可见的硬伤和 3 个结构性隐患**，其中"菜单显示的时长"和"1× 已是实时"是同一个改动的两半，只改了一半。下面按严重度列。

---

## 1. 这批改动在做什么

| 主题 | 关键改动 | 判断 |
|---|---|---|
| **时间与通话** | `TIME_SCALE` 6 → 1（1× = 实时）；指令不再立即生效，改为"发话时长 + 完整复诵"后才提交（`pendingClearance`）；同一席位频道串行（`channelAvailable`） | 拟真度大幅提升；但把节奏的决定权交给了关卡时长，而关卡时长没跟着改（见 P1-1） |
| **安全模式** | `guarded`（危险许可直接拒绝）/ `consequence`（照发，撞了判负）；`runwayTraffic` 区分"许可"与"实际占用"；碰撞即 `status: failed` | **这一轮最正确的建模决定**：许可 ≠ 占用。默认值有问题（见 P1-2） |
| **地面** | 滑行道单向化（B 出、A 进）、删掉 C 旁通道、新增 A4 出口；路口租约 + 跟车 + 推出/脱离用贝塞尔曲线 | 结构更清楚；但删 C 让"旁通道"这条玩法彻底消失，`bypass` 成了死符号 |
| **调度与复盘** | `planning`（跑道计划/试排）、`operations`（跑道检查/阵风窗口）、`journal` + `replay`、`decisions` UI、浮动窗口工作台 | 这是把游戏做深的主要投资，方向对 |

---

## 2. 已验证的正面事实

- `npm run typecheck` 通过；`npm run accept` 10 个套件全绿。
- 断言数核对：29（sim）+ 12（gameplay）+ 18（planning）+ 4（challenge，内部覆盖 128 个班表 / 28 个完整班次）+ 8（edge）+ 11（experience）+ 16（operations）+ 10（decisions）= 108，与文档一致；再加新增 `control` 23 项 = **131 项**。
- 分层红线守住：`src/sim` 里没有任何 `three` / `react` / `ui` / `views` 的 import。
- 浏览器实测（headless Chrome + 本机 5173）：开局、工作台、雷达、地面图、无线电、航班工作台都能正常渲染，无控制台报错。

---

## 3. 问题清单

### P1-1 菜单显示的时长是错的（玩家第一眼就会看到）

- `src/ui/session.tsx:28`：`Math.round(level.durationMin / 6)` 分钟。
- 但 `src/sim/world.ts:24` 已改成 `TIME_SCALE = 1`，`App.start()` 又固定 `setSpeed(1)`。
- 结果：晨间高峰 45 游戏分钟，菜单写"8 分钟左右"，实际 **45 分钟**；即使玩家手动 4× 也要 11 分钟。
- 同一处根因还牵出产品问题：`docs/ATC-RELEASE-ROADMAP.md` 写的目标是"每局 6–10 分钟现实时间"，当前配置下 **1× 是 45 分钟**。要么把关卡缩到 10 分钟，要么默认 4×，要么承认这是"实时值班"。

| 位置 | 现在写的 | 实际 |
|---|---|---|
| 菜单卡片 | 8 分钟左右 | 45 分钟（1×） |
| 结算说明 | 推出请求后 6 分钟 | 代码用 8 分钟（`world.ts` 目标时刻） |

### P1-2 默认安全模式是"后果自负"，教学关也是

- `world.ts:65` `options.safetyMode ?? "consequence"`；`App.tsx:40` localStorage 没值时同样回落到 `consequence`。
- `consequence` 下 `permissionError()` 恒为 `undefined`，所有危险许可都能发；碰撞一次直接 `status: "failed"`（本班失败）。
- 第三课"交汇时刻"就是两架离场 + 一架进场共用跑道 —— 这是最容易让新玩家在 3 分钟内吃到"本班失败"的地方。
- 建议：`level.lesson === true` 强制 `guarded`；`consequence` 作为"真实模式"在进入时显式勾选并写进 localStorage。

### P2-1 风速被算了两次（预计窗口偏保守）

- `gs` 语义已改成**地速**：`integrate()` 不再加风，`speedTo()` 把风加到目标空速上（这是对的，已有 control 测试"风不会在积分时重复叠加"覆盖）。
- 但 `src/sim/runway.ts:46` 和 `:66` 仍然是 `Math.max(ac.gs, vapp) + kt(env.windKt)` —— 地速再加一次风。
- 影响：`approachRunwayETA` / `departureWindowEstimates` 在 8–18 kt 风下偏差 3–8%，起飞窗口的"余量 X 秒"会系统性偏乐观/悲观（取决于风向）。

### P2-2 `previewCommand` 用"影子环境"，属于易碎设计

```ts
// commands.ts:141
const preview = Object.assign(Object.create(env) as SimEnv, { say: noop, ..., groundLocks: new Map(env.groundLocks) });
return executeCommand(preview, { ...ac, ... }, cmd);
```

- 靠"原型继承真实 World + 白名单 no-op"来模拟纯校验。
- 现在有测试"预览复飞和移交不改变世界"，但这只覆盖当前这两个指令；**以后给 `SimEnv` 加任何带副作用的方法，忘了加进 no-op 名单，就会在"预览"时改真实世界**，而且不会报错。
- 建议：把校验抽成显式的 `validate(env, ac, cmd)`（只读、返回 `CommandResult`），`executeCommand` 只负责改状态；或者至少加一条泛化断言：任意指令预览前后 `JSON.stringify(snapshot())` 完全相同。

### P2-3 测试助手 `confirmed()` 会推进模拟时间

- `scripts/test-radio.ts`：发指令后一直 `step()` 到复诵提交（约 5 秒）。
- 于是测试里 `to(world, 301)` 这种绝对时刻断言不再受控 —— 我 19:28 那次运行就撞到 `operations-test.ts:69` 因为这一点失败（几分钟后该文件被改，才变绿）。
- 建议：让 `confirmed()` 返回"提交时刻"，测试改用 `to(world, commitAt + x)`；或在断言里用相对时间。

### P3-1 死符号与别名

- `types.ts:255` 仍有 `{ kind: "taxi"; route: "main" | "bypass" }`，但 C 旁通道已从机场数据删除（edge 测试也改成了"两条主滑行道没有 C 节点"）。`bypass` 现在只剩类型和一个 CSS 类。
- `runway.ts:124` 的 `runwayBlockReason` 只是 `runwayWarning` 的别名，两个名字同时出现在 `world.ts` 和 `decisions-test.ts` 里，读代码时容易误以为是两个不同判据。

### P3-2 `world.ts` 已经是上帝对象

485 行，同时管：航班生成、无线电队列、碰撞判定、评分、跑道占用、扇区、计划、运行事件、回放、计分快照。`aircraft.ts` 458、`commands.ts` 397 也贴近 400 行红线。
现在还能忍，但**下一步加双跑道或跑道穿越时，这里会最先崩**。建议把"无线电/频道"和"评分/报告"各拆出去（它们已经有独立类型，边界清楚）。

### P3-3 3D 表面有条纹状伪影，机场占比偏小

见 `docs/review-3d-2026-10-18.png`（19:32 快照，1280×720，非 lite）：跑道与滑行道表面出现规律性横向条纹，像贴图重复或 z-fighting；机场在画面中占比小、透视很平。
不是功能性 bug，但与"3D 是主视图"的定位不符。建议单独列一张视觉验收清单（截图对比），不要混在逻辑回归里。

---

## 4. 建议动作（按顺序）

1. **先把未提交的 36 个文件切批提交**（无线电队列 / 安全模式 / 地面单向化 / UI 与计划），现在一次误操作能带走一整天的改动。
2. **修三个数字**：菜单时长、结算说明的 6 分钟、`runway.ts` 的两处 `+ wind`。半小时内可完成，都是玩家可见或预测正确性问题。
3. **教学关默认 `guarded`**，`consequence` 变成显式选择。
4. **给 `previewCommand` 加泛化断言**（任意指令预览不改快照），把 P2-2 从"靠自觉"变成"靠测试"。
5. **单独排一轮 3D 视觉验收**：跑道/滑行道表面、默认机位构图、昼夜与阴影。

---

## 5. 这次没验证的部分

- 6 个 UI 套件（`ui-test`、`planning-ui-test`、`decisions-ui-test`、`operations-ui-test`、`experience-ui-test`、`control-ui-test`、`visual-ui-test`）需要浏览器交互，未逐一跑。
- 真人手感：通话串行 + 实时节奏下的操作压力，只能靠试玩判断。
- 我审查期间文件在变，任何一条结论在最终版里都可能已被修掉 —— 修复前请先按文件行号复核。

---

# 第二轮复核（20:50，针对"改造说明"那一版）

> 这一轮工作区已稳定（20:40 后无写入），HEAD 仍是 `49329b8`，**43 个文件、+683/−386 未提交**。

## 已核实为真

| 声明 | 核实方式 | 结果 |
|---|---|---|
| 133 项逻辑验收 | `npm run accept` 实跑 | ✅ EXIT=0；29+12+18+4+8+11+16+10+25 = 133 |
| 生产构建通过 | `npm run build` | ✅ 1,012 kB / gzip 285 kB |
| 界面回归通过 | `control-ui-test.mjs http://localhost:5173` | ✅ 5 项全过（但见问题 4） |
| 1× 实时 | `TIME_SCALE = 1` | ✅ |
| 复诵后才执行 | `pendingClearance{startsAt,readbackAt,commitAt}` | ✅ |
| 提前移交 | `pendingHandoff` + `completeHandoff` 条件生效 | ✅ |
| 接地/拉平/渐进制动 | `aircraft.ts` landing 分支：0.4→2.2 m/s² 斜坡、保留接地速度、横向偏差指数收敛 | ✅ |
| 双滑行道 + A4 | `kestrel.ts` 无 C 节点，A4 atM=2100 接 x=-900 | ✅ |
| 自动跟车 | 同向共享路段 + 速度控制器 + 仅路口预约 | ✅（跟机截图可见） |

跟机视角的飞机模型（机身/机翼/尾翼/发动机/起落架 + 航司尾色）和姿态明显好于上一版，工作台的信息层级也完整了。

## 仍未解决

**1. 菜单时长仍然是错的（唯一还留在玩家眼前的硬伤）**
`src/ui/session.tsx:28` 依旧 `Math.round(level.durationMin / 6)`。1× 已改实时、`start()` 又固定 `setSpeed(1)`：45 分钟的晨间高峰在菜单上写"8 分钟左右"，实际 45 分钟，4× 也要 11 分钟。改 TIME_SCALE 时漏了这一处。

**2. 教学关默认"风险保护关"**
`world.ts:65` 默认 `consequence`，`App.tsx:40` 也从 localStorage 回落 `consequence`，`start()` 没有对 `level.lesson` 做例外。第三课是两架离场 + 一架进场共用跑道，保护关掉时新手可能三分钟内吃"本班失败"。建议 lesson 强制 `guarded`（机制不动，只改默认）。

**3. `runway.ts` 的地速/空速混用**
`:46` 与 `:67` 仍是 `Math.max(ac.gs, kt(vappKt)) + kt(env.windKt)`。`gs` 已是地速、`vapp` 是空速，两者被塞进同一个 `max` 后再统一加风：当 `gs ≥ vapp` 时风被算了两次。修法：`Math.max(ac.gs, kt(vappKt) + 风分量)`。

**4. 6 个 UI 回归脚本硬编码 `localhost:5174`**
`control/decisions/experience/operations/planning/visual` 六个脚本的默认 base 是 5174，而 `ui-test.mjs` 与 `dev` 是 5173。只有"5173 恰好被占用、vite 顺延到 5174"时它们才通过；换台机器就是 `ERR_CONNECTION_REFUSED`——我这次先撞上的就是这个。属于典型的假绿：建议从 `process.env.BASE_URL` 取，或脚本内自己起 preview。

**5. 43 个文件仍未提交**
"已完成"但 HEAD 还停在 `49329b8`，+683/−386 全在工作区。这个仓库有一次"代码整体被删掉"的前科，先把这批切 3–4 个提交落库，再谈下一轮。

**6. 结构性**
`world.ts` 497 行（生成/通话/碰撞/评分/跑道/计划/回放/快照全在一个类里）；`previewCommand` 的原型影子环境仍在（有测试兜底，但新增 `SimEnv` 方法时仍是静默风险）。

## 3D 意见

跟机视角合格；**宽视角还有两个问题**（截图 `docs/review-3d-wide-2046.png` 宽视角、`docs/review-3d-follow-2046.png` 跟机）：

- 跑道/滑行道在远距离呈"梯子状"条纹：道面贴图缺 mipmap/anisotropy，掠射角下混叠。开 `anisotropy=8` + mipmap 就能解决大半。
- 机场占画面比例偏小，宽视角下 37 m 的飞机基本不可见。建议默认机位再拉近 25–30%，或在宽视角把"飞机 + 标牌"做得更醒目。

## 产品意见（三条都是默认值，不动机制）

1. **默认倍速 1× → 4×**：实时是拟真，但 45 分钟一局对"好奇但没入门"的玩家太长；4× 仍保留真实的通话与惯性。
2. **教学关默认开保护**：教学的目标是学会流程，不是承担后果。
3. **consequence 改名"真实模式"并在进关时显式勾选**：现在它叫"风险保护关"，语义是"关掉保护"，玩家会以为这是默认推荐状态。

## 结论

机制层面这一轮是净收益，验收数字也对得上。剩下的是三件收尾：**菜单时长、教学默认值、UI 测试端口**，再加一次提交。这三件都不到一小时，但不做的话，"133 项通过"只是在开发机上通过。

---

# 第三轮：处理结果（21:10）

按 zz 的要求处理了「1 和 3、次要、3D」，逐条交代。

## 已修

| 项 | 改动 | 证据 |
|---|---|---|
| 选关页时长 | `format.ts` 新增 `DEFAULT_SPEED` / `realMinutes()`，选关页显示「45 分钟左右（1× 实时）」，起始倍速读同一常量 | `ab5085b`/`f3cf954` |
| UI 回归端口 | 七个 UI 脚本统一走 `scripts/test-base.mjs`（命令行 > `BASE_URL` > 5173） | `cf60439`；`control-ui-test` 在默认端口跑通 5 项 |
| 风重复计入 | 抽出 `groundSpeedFor()`，进近 ETA、离场窗口、抬轮三处共用；不再对地速再加一次风 | `ab5085b` |
| 预览影子环境 | no-op 白名单改成类型分类 + `AssertNever`：给 `SimEnv` 加方法不登记分类，`tsc` 直接报方法名（已实测会报 `dummyWrite`）；另加泛化断言，对运行中世界逐条指令比对预览前后快照 | `32922d3`/`cf60439` |
| world 过大 | 冲突/碰撞/出界/停靠移除移到 `safety.ts` 纯函数，`TICK/TIME_SCALE` 移到 `constants.ts`（避免循环 import）；497 → 471 行 | `32922d3` |
| 3D 远视角 | 中线 0.65→1.5 m、跑道虚线 1.6 m、道面 anisotropy 4→8 + 显式 mipmap；全场机位拉近约三成 | `ce1c252` |

`npm run accept` 仍全绿（控制套件 25 → 26 项，合计 134），`npm run build` 通过。

## 关于 3D 条纹的更正

上一轮我判断是"道面贴图缺 mipmap 导致混叠"，放大到 2 倍分辨率后确认**主因不是贴图**：
是 0.65 m 宽的滑行道中线在"1 像素 ≈ 2 m"的远景里比一个像素还细，被采样成虚线。
已通过加宽中线缓解，但根治要把中线烘进道面贴图（跟着 mipmap 一起模糊），属于后续工作。

## 仍未处理（留给 zz 决定）

1. **教学关默认「风险保护关」** —— 这次没动（zz 只点了 1 和 3）。第三课仍是两架离场 + 一架进场共用跑道，建议 `level.lesson` 强制 `guarded`。
2. **world.ts 471 行** —— 继续拆需要同时搬字段（`score`/`reports`/`radio`），不是纯方法搬迁，风险和收益要单独评估。
3. **默认 1× / 45 分钟一局** —— 文案已经说实话，但要不要把默认倍速提到 4×，是产品判断。

## 顺带发现（未改）

- `commands.ts` 的 `taxi.route: "main" | "bypass"` 仍保留 `bypass`，文档说明是"旧回放兼容"，可以接受，但类型上已无实际路径。
- `safety.ts` 的 `findCollision` 每个 tick 做 O(n²) 粗筛 + 扫掠，8–12 架无压力，上百架时需要空间网格。
