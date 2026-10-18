import { LEVELS } from "../data/levels";
import { fmtClock } from "../format";
import { rateShift } from "../sim/scoring";
import { CHALLENGE_ID, CHALLENGE_VERSION, createChallenge, normalizeChallengeSeed } from "../sim/challenge";
import type { ControlMode, SimState } from "../sim/types";
import type { World } from "../sim/world";
import { Metric } from "./panels";
import { AirportPreview, Debrief, ShiftGoals } from "./experience";
import { OperationReview } from "./operations";

export interface BestRecord { grade: string; points: number; movements: number; violations: number; delaySec?: number }
export type Records = Record<string, BestRecord>;
export const recordKey = (id: string, mode: ControlMode, seed?: string) => `${id}:${mode}${seed ? `:v${CHALLENGE_VERSION}:${encodeURIComponent(normalizeChallengeSeed(seed))}` : ""}`;
export function readRecords(): Records {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem("kestrel.records.v2") ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, item]) => item && typeof item.grade === "string" && Number.isFinite(item.points) && Number.isFinite(item.movements) && Number.isFinite(item.violations)));
  } catch { return {}; }
}
export function writeRecords(records: Records) { try { localStorage.setItem("kestrel.records.v2", JSON.stringify(records)); } catch { /* Play still works when browser storage is unavailable. */ } }

export function StartScreen({ levelId, mode, records, seed, onSeed, onNewSeed, onNormalizeSeed, onPick, onMode, onStart }: { levelId: string; mode: ControlMode; records: Records; seed: string; onSeed: (seed: string) => void; onNewSeed: () => void; onNormalizeSeed: () => void; onPick: (id: string) => void; onMode: (mode: ControlMode) => void; onStart: () => void }) {
  const selected = levelId === CHALLENGE_ID ? createChallenge(seed) : LEVELS.find((level) => level.id === levelId)!;
  return <div className="overlay menu-overlay"><div className="modal start-modal"><div className="brand">KESTREL <span>APPROACH</span></div><div className="sub">一座机场。一条跑道。每一次放行，都改变接下来的顺序。</div>
    <div className="menu-layout"><div className="cards">{LEVELS.map((level, i) => {
      const best = records[recordKey(level.id, mode, level.id === CHALLENGE_ID ? seed : undefined)];
      return <button key={level.id} className={`card ${levelId === level.id ? "sel" : ""}`} onClick={() => onPick(level.id)}><span className="card-index">0{i + 1}</span><div><div className="card-name">{level.name}</div><div className="card-meta">{level.lesson ? "引导训练" : "完整班次"} · {level.flights.length} 个航班 · {Math.round(level.durationMin / 6)} 分钟左右</div></div><span className="best-grade">{best?.grade ?? "—"}</span></button>;
    })}</div><div className={`scenario-detail ${selected.seed ? "with-seed" : ""}`}><AirportPreview evening={selected.startClockMin >= 17 * 60} /><span className="eyebrow">{selected.lesson ? "从容练习 · 完整引导" : "安排顺序 · 控制间隔 · 挑战最优解"}</span><h2>{selected.name}</h2><p>{selected.description}</p><div className="scenario-stats"><Metric label="机场" value="KEKS" /><Metric label="跑道" value="27" /><Metric label="目标" value={`${selected.targetMovements} 架次`} /></div>
      <div className="mode-picker"><button className={mode === "standard" ? "on" : ""} onClick={() => onMode("standard")}>标准管制<span>路线许可 + 席位移交</span></button><button className={mode === "assisted" ? "on" : ""} onClick={() => onMode("assisted")}>辅助管制<span>自动滑行，专注起降排序</span></button></div>
      <div className="scenario-note">{mode === "standard" ? "推出完成后申请滑行；进近建立后联系塔台。所有等待都会显示原因。" : "系统协助处理常规地面流程；跑道许可与安全规则保持一致。"}</div>
      {selected.operations && <div className="scenario-operations">{selected.operations.map((event) => <div key={event.id}><b>{fmtClock(selected.startClockMin + event.atMin)}</b><span>{event.name}</span><em>{Math.round(event.durationSec / 60 * 10) / 10}′</em></div>)}<p>检查可提前开始 · 新许可受限 · 已许可航班继续</p></div>}
      {selected.seed && <div className="seed-picker"><label htmlFor="challenge-seed">挑战种子 <small>相同种子 · 相同流量 · 独立成绩</small></label><div><input id="challenge-seed" value={seed} maxLength={40} onChange={(event) => onSeed(event.target.value)} onBlur={onNormalizeSeed} spellCheck={false} /><button onClick={onNewSeed}>换一组</button></div><p>北 ORVIN / 东 ESTRA / 南 SOVIN 合流 · {fmtClock(selected.startClockMin)} 开班</p></div>}
    </div></div>
    <button className="primary" onClick={onStart}>开始值班 <span>→</span></button><div className="help menu-keys">E 下一步许可 · N 下个待办 · 空格 暂停 · 1 / 2 / 4 倍速 · F1 / F2 / F3 视角</div>
  </div></div>;
}

export function Result({ world, snap, onRestart, onMenu, onNext, onReplay, onExport }: { world: World; snap: SimState; onRestart: () => void; onMenu: () => void; onNext?: () => void; onReplay: () => void; onExport: () => void }) {
  const movements = snap.score.landings + snap.score.takeoffs;
  const grade = rateShift(snap.score, world.level, world.mode);
  const averageDelay = movements ? Math.round(snap.score.totalDelaySec / movements / 60) : 0;
  return <div className="overlay"><div className="modal result"><div className="result-heading"><div className="grade">{grade.grade}</div><div><h2>{world.level.lesson ? "训练完成" : "班次复盘"}</h2><div className="sub">{grade.note} · {world.mode === "standard" ? "标准管制" : "辅助管制"}</div></div></div>
    <div className="result-grid"><Metric label="架次" value={`${movements}/${snap.movementsTarget}`} /><Metric label="滑入完成" value={String(snap.score.serviced)} /><Metric label="安全事件" value={String(snap.score.violations)} /><Metric label="安全复飞" value={String(snap.score.goArounds)} /><Metric label="积分" value={String(snap.score.points)} /><Metric label="平均延误" value={`${averageDelay}′`} /></div>
    <p className="result-note">延误以进入扇区后 7 分钟 / 推出请求后 6 分钟的目标起降时刻估计。主动安全复飞本身不扣安全分。</p>
    <ShiftGoals snap={snap} world={world} />
    <Debrief snap={snap} world={world} onReplay={onReplay} onExport={onExport} />
    <OperationReview world={world} snap={snap} />
    {world.level.seed && <div className="challenge-code">本次种子 <b>{world.level.seed}</b> · 规则 v{CHALLENGE_VERSION} · 再值一班将使用同一流量</div>}
    <details className="event-details"><summary>查看无线电与事件记录 · {snap.events.length} 条</summary><div className="review-events">{snap.events.slice(-24).map((event) => <div key={event.id} className={`review-event ${event.kind}`}><span>{fmtClock(world.level.startClockMin + event.t / 60)}</span><b>{event.callsign}</b><span>{event.text}</span><em>{event.points > 0 ? `+${event.points}` : event.points || ""}</em></div>)}{snap.events.length === 0 && <p>本班次尚未完成任何航班，重新练习一次。</p>}</div></details>
    {snap.aircraft.some((a) => !["parked", "done"].includes(a.phase) && !(a.phase === "departure" && (a.controller === "DEP" || world.mode === "assisted"))) && <div className="unfinished">待处理：{snap.aircraft.filter((a) => !["parked", "done"].includes(a.phase) && !(a.phase === "departure" && (a.controller === "DEP" || world.mode === "assisted"))).map((a) => `${a.callsign}${a.phase === "departure" ? "（离场移交）" : ""}`).join("、")}</div>}
    <div className="row-btns">{onNext && <button className="primary" onClick={onNext}>下一班</button>}<button className={onNext ? "ghost" : "primary"} onClick={onRestart}>再值一班</button><button className="ghost" onClick={onMenu}>选择关卡</button></div>
  </div></div>;
}

export function Help({ onClose }: { onClose: () => void }) {
  return <div className="overlay"><div className="modal help-modal"><h2>你的工作是决定顺序与许可</h2><p>右侧汇总当前待办；按 N 选择下个需要处理的航班，按 E 下达底部高亮的许可。航向、高度和速度选项可按需展开。</p><div className="help-flow"><b>离场</b><p>批准推出 → 滑行许可 / 规划路线 → 跑道外等待 → 联系塔台 → 起飞 → 移交离场</p><b>进场</b><p>减速 / 等待排序 → ILS 进近 → 联系塔台 → 落地 → 脱离 → 联系地面 → 滑入机位</p></div><p>暂无待办时可点「下一请求」，最多推进 5 游戏分钟，遇到新请求或临近落地的安全决定就停下；系统不会替你发指令。</p><p>「跑道计划」可拖动调整顺序，也可先用「试排 ↑」比较相邻交换的预计延误、末架释放时间及逐航班代价，点击采用后才改序。计划非空时按队首放行，已许可顺序锁定；仍需手动控制速度、等待和许可。</p><p>离场待命时显示进近时间余量，可展开查看进跑道、滑跑、爬升释放和缓冲的计算；正余量仍需满足跑道、尾流、风况和席位等条件。短五边时间不足时会阻止起飞，并说明原因。地图可点节点规划滑行路线；空中等待后用「直飞 KAVLA」恢复进场。</p><p>运行窗口关会预告检查和阵风。可利用空档提前检查，期间先安排滑行与空中等待；超限机型可在跑道外等风，也可把可用喷气机排到前面。已许可航班先完成，检查与阵风结束后自动恢复。</p><p>结算中的「回看调度」可拖动时间轴或逐条查看操作；回放不会改变成绩。提示音可自行开启，画质可在节能、均衡和精细之间切换。</p><p>空格暂停；F2 跟随选机，F3 俯瞰。窄屏用底部按钮切换航班、雷达、地面和无线电面板。</p><button className="primary" onClick={onClose}>返回值班</button></div></div>;
}
