# Kestrel Approach

浏览器里的机场管制模拟器。3D 视景为主视图，底部情境化指令条下达管制指令。

## 运行

```bash
npm install
npm run dev        # http://localhost:5173，同时监听 0.0.0.0，局域网可直接访问
npm run typecheck
npm run sim:test   # 无头仿真回归（不需要浏览器）
npm run build
```

> 开发与预览服务都绑 `0.0.0.0`（见 `vite.config.ts`）：同一局域网的手机 / 另一台机器用 `http://<本机IP>:5173` 即可打开。
> 如果外部设备连不上，是 Windows 防火墙拦了 node.exe 的入站，放行"专用网络"即可。

## 操作

| 操作 | 说明 |
|---|---|
| 点击飞机 / 点击标牌 / 点击右侧列表 | 选中航班 |
| 底部指令条 | 只显示当前阶段可用的管制用语 |
| 空格 | 暂停 / 继续 |
| 1 / 2 / 4 | 时间倍速（1× = 每 10 现实秒走 1 游戏分钟） |
| F1 / F2 / F3 | 塔台（全场） / 跟机 / 俯瞰 |
| Tab | 循环选机 |
| Esc | 取消选中 |
| 滚轮 / 拖拽 | 缩放 / 环绕视角 |

## 玩法

- **进场**：进场机沿 STAR 飞到 IAF，之后默认飞向跑道。下高度 → 在 32 公里内清 `ILS 进近` → 建立后 `可以落地` → 接地后选脱离口，自动滑到机位。
- **离场**：选 `推出`（选机头朝向）→ 自动沿滑行道滑到跑道外等待 → `进跑道等待` 或直接 `可以起飞` → 离场。
- **跑道是唯一互斥资源**：被占时落地/起飞许可会被驳回并说明原因。
- 班次结束按「完成架次 / 目标架次 / 违规数」评级。

## 目录

```
src/sim/      纯逻辑仿真（10Hz 定步长，禁止 import three/react）
src/data/     机场与关卡数据（加内容看 ../docs/CONTENT-GUIDE.md）
src/views/    three.js 场景
src/ui/       React 界面
scripts/      无头回归测试
```

## 调试参数

`?level=tutorial&fast=540&bot=1&lite=1&view=tower` —— 详见 `../docs/CONTENT-GUIDE.md` §3。
