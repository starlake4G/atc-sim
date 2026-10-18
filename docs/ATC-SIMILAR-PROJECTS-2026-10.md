# 同类 ATC 项目复查

检索日期：2026-10-18。依据项目官网、公开仓库 README、包配置和许可证。未安装运行这些候选，未做完整源码审计；功能描述与开发者声明分开理解，以下优先级是针对 Kestrel 当前方向的判断。

## 结论

确实有接近「浏览器 + 地面路网 + 雷达/3D 塔台」的公开项目。此前调研中的「Web 端全部是 2D、没有同类 3D 项目」应撤回；目前检索不足以评价这一市场的整体成熟度或证明存在市场空白。

最值得进一步读源码的三个候选：

1. DTW Metro Tower：最贴近当前双视角与地面路网的技术方向。
2. Tiny Tarmac：最值得借鉴内容组织、流量节奏、关卡和每日挑战。
3. OpenTaxi：最值得研究滑行路径代价、冲突与路线评估。

## 可读源码的候选

| 项目与一手来源 | 栈/定位 | 与当前项目有关的内容 | 许可与边界 |
| --- | --- | --- | --- |
| [DTW Metro Tower / lab1702/atc-sim](https://github.com/lab1702/atc-sim) | Go 仿真 + Three.js，浏览器地面雷达与 3D 塔台 | README 描述六条物理跑道、OSM 路网、滑行/占用/交叉跑道检查、改道、2D/3D 主副视图交换 | 原创代码 MIT；机场几何 ODbL，不能把所有数据当成 MIT。README 明确简化性能与程序，不模拟天气变化/尾流类别等 |
| [Tiny Tarmac](https://github.com/manimohans/tiny-tarmac) | Phaser 3 + TypeScript + Vite；轻量浏览器游戏 | 十座主题机场、落地到机位周转再离场、燃油等待、自适应流量、紧急任务、天气、奖牌与固定每日班次 | [MIT](https://github.com/manimohans/tiny-tarmac/blob/main/LICENSE)。其自由排队/碰撞失败规则和我们当前许可守卫不同，适合取内容与节奏思路 |
| [OpenTaxi](https://github.com/ATMRI-NTU/OpenTaxi) | Python，机场场面交通研究工具 | 图路网、A* 转弯惩罚、预测冲突控制、滑行时间/转弯/吞吐评估 | MIT；提供樟宜路网，监视数据不附带。适合算法比较，不能代替成品游戏/UI |
| [openScope](https://github.com/openscope/openscope) | JavaScript，浏览器雷达管制 | 指令、机场配置、教程与管制数据组织 | MIT；可参考空域系统，不提供当前需要的整套 3D 机场表现 |
| [vice](https://github.com/mmp/vice) / [官方文档](https://pharr.org/vice/) | Go + SDL 桌面 ATC 模拟 | 雷达工作流、进离场场景、波次设置、语音/复诵与复杂指令 | GPL-3.0；本轮作为设计与工程参考，未评估整合源码的许可兼容性 |
| [BlueSky](https://github.com/TUDelft-CNS-ATM/bluesky) | Python，空中交通/流量研究平台 | 可作为仿真算法研究与对照的候选，已有本地 refs 参考 | MIT；游戏化内容与机场美术仍需另做 |

Tiny Tarmac 的栈另核对了 [package.json](https://github.com/manimohans/tiny-tarmac/blob/main/package.json)。上述仓库是否能在当前机器开箱运行、测试是否可靠、实际画质与性能如何，仍需后续实测。

## 游戏与网页产品参考

### Airport Control 27

[Steam 官方页](https://store.steampowered.com/app/3328490/Airport_Control_25/)显示于 2026-09-21 开始抢先体验，提供 Demo。现有功能描述包括推出、路线规划、牵引车解冲突、风变换跑道、地面/进近雷达、进程单与无线电；机场道面、灯光和登机桥是画面参考重点。

适合用作全流程交互和机场表现标杆。商店页面对创意工坊存在「当前宣传」与「后续计划」两种表述，本轮不把相应能力认定为已验证的现成功能。

### Tower! Simulator 3

[FeelThere 官方产品页](https://feelthere.com/shop/tower-simulator-3/)列出 3D 塔台、地面调度、语音管制、多人分席位与机场内容；页面记录了 2026-06-16 的 Tower Update 7。

适合参考机场氛围、管制席位、无线电表现及工具布局。官网产品介绍不能代替实测其语音识别或游戏体验。

### I am an Air Traffic Controller 4

[TechnoBrain 官方页](https://www.technobrain.com/atc4_g/)介绍按钮式指令、分阶段关卡、特殊条件、自定义时段/风向/运行片段及从回放中段恢复。

适合参考互动学习、关卡节奏与恢复体验。

### ProjectATC

[官网](https://www.projectatc.com/)目前介绍五种席位、推出/滑行/跑道穿越、飞行员语音复诵、职业班次、每日挑战与复盘。官网同时明确：玩家用文本或上下文按钮发指令，尚不支持玩家语音输入。

这是浏览器产品参考；本轮未找到可确认的公开源码许可。不能沿用旧文档里仅将它描述为进近雷达的结论。

## 对当前项目的实际建议

- 技术调研先看 DTW Metro Tower 的机场数据导入、路网改道和双视角实现；保留我们现有仿真/回放/许可守卫的边界。
- 内容设计先看 Tiny Tarmac 的机场主题、自适应流量和每日班次；独立验证这些设计能否改善 Kestrel 的节奏。
- 下一项路线比较可用 OpenTaxi 的路径长度、转弯与滑行时间指标做对照，不直接把路径最短当成调度最好。
- 机场美术和无线电表现对照 Airport Control 27 / Tower! Simulator 3；教学与班次复盘对照 ATC4 / ProjectATC。
- 尚没有经过本轮验证的「可直接替换为当前成品游戏」的开源底座，也没有确认可直接商用复用的完整高质量机场/飞机资产包。

本轮只完成检索、核对和调研文档更新，没有下载运行候选或修改游戏代码。
