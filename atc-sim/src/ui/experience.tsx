import { fmtClock } from "../format";
import { recommendedCommand, decisionFlights, flightProgress } from "../sim/flow";
import { aggregateDelays, DELAY_LABELS, shiftObjectives, type DelayReason } from "../sim/debrief";
import type { Aircraft, SimState } from "../sim/types";
import type { World } from "../sim/world";
import type { JournalAction, ReplayRecord } from "../sim/journal";
import { useEffect, useRef, useState } from "react";

export const fmtDuration = (seconds: number) => { const s = Math.max(0, Math.round(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
function describeAction(action: JournalAction): string {
  if (action.kind === "safety") return action.mode === "guarded" ? "开启风险保护" : "关闭风险保护";
  if (action.kind === "operation") return "提前开始跑道检查";
  if (action.kind === "plan") return "调整跑道计划顺序";
  const cmd = action.command;
  if (cmd.kind === "heading") return `航向 ${cmd.hdg}°`;
  if (cmd.kind === "altitude") return `高度 ${cmd.altFt} ft`;
  if (cmd.kind === "speed") return `速度 ${cmd.kt} kt`;
  if (cmd.kind === "direct") return `直飞 ${cmd.fix}`;
  if (cmd.kind === "handoff") return `移交 ${cmd.controller}`;
  return ({ approach: "ILS 进近许可", goAround: "安全复飞", land: "落地许可", cancelLanding: "取消落地许可", lineup: "进跑道等待", takeoff: "起飞许可", pushback: "推出许可", hold: "原地等待", resume: "恢复滑行", exit: "指定脱离口", taxi: "滑行许可", holdAir: "空中等待" })[cmd.kind];
}

export function FlightSteps({ ac }: { ac: Aircraft }) {
  const progress = flightProgress(ac);
  return <div className="flight-steps" aria-label="航班流程">{progress.labels.map((label, i) => <span key={label} className={i < progress.index ? "complete" : i === progress.index ? "current" : ""}><i>{i < progress.index ? "✓" : i + 1}</i>{label}</span>)}</div>;
}

export function DispatchSummary({ world, onPick }: { world: World; onPick: (id: string) => void }) {
  const decisions = decisionFlights(world), next = decisions[0];
  return <div className="dispatch-summary"><div><span className={`dispatch-dot ${decisions.length ? "active" : ""}`} /><b>{decisions.length ? `${decisions.length} 项待处理` : "航班按许可执行中"}</b><kbd>N</kbd></div>
    {next ? <button className="next-decision" onClick={() => onPick(next.id)}><strong>{next.callsign}</strong><span>{recommendedCommand(world, next)?.label ?? "检查进近 / 间隔"}</span><em>→</em></button> : <p>可推进到下个请求，或观察当前交通。</p>}
  </div>;
}

export function ShiftGoals({ snap, world }: { snap: SimState; world: World }) {
  return <div className="shift-goals">{shiftObjectives(snap, world.level.flights.filter((f) => f.kind === "arr").length).map((goal) => <div key={goal.label} className={goal.good ? "good" : ""}><span>{goal.label}</span><b>{goal.value}</b><i><em style={{ width: `${Math.min(1, goal.progress) * 100}%` }} /></i></div>)}</div>;
}

export function AirportPreview({ evening = false }: { evening?: boolean }) {
  return <svg className={`airport-preview ${evening ? "evening" : ""}`} viewBox="0 0 560 210" aria-label="Kestrel 机场示意预览"><defs><linearGradient id="preview-land" x2="1" y2="1"><stop stopColor={evening ? "#26374a" : "#244a4a"} /><stop offset="1" stopColor="#132a36" /></linearGradient></defs>
    <rect width="560" height="210" fill="url(#preview-land)" /><g opacity=".16" stroke="#97c7c2" strokeWidth="1">{Array.from({ length: 18 }, (_, i) => <path key={i} d={`M${i * 42 - 60} 0l-40 210`} />)}{[25, 65, 105, 145, 185].map((y) => <path key={y} d={`M0 ${y}H560`} />)}</g>
    <g transform="translate(280 105) rotate(-14) translate(-280 -105)"><path d="M50 155H510" stroke="#527774" strokeWidth="42" /><path d="M50 155H510" stroke="#182b36" strokeWidth="24" /><path d="M70 155H490" stroke="#e0ece6" strokeWidth="1.5" strokeDasharray="13 12" />
      <path d="M62 147v16m5-16v16m425-16v16m5-16v16" stroke="#e2eee7" strokeWidth="3" /><text x="465" y="159" fill="#d5e8e5" fontSize="11" fontFamily="monospace">27</text>
      <path d="M82 115H480v32M82 95H460v20M135 115v40m145-40v40m145-40v40" fill="none" stroke="#789c93" strokeWidth="6" /><path d="M82 115H480v32M82 95H460v20" fill="none" stroke="#c5b976" strokeWidth="1" />
      <path d="M115 55H380v22H115z" fill="#a3b8b1" /><path d="M115 55H380" stroke="#d2ded7" strokeWidth="4" />{[140, 190, 240, 290, 340].map((x) => <g key={x}><path d={`M${x} 77v18`} stroke="#9db4b0" strokeWidth="4" /><path d={`M${x} 91v12m-5-6h10`} stroke="#d6ded6" strokeWidth="1.6" /></g>)}
      <circle cx="435" cy="62" r="5" fill="#efc78c" /><path d="M435 62v23" stroke="#9eb8b9" strokeWidth="3" />
    </g><text x="24" y="27" fill="#9ecac5" fontSize="9" letterSpacing="2">KEKS / KESTREL INTERNATIONAL</text><text x="24" y="190" fill="#a9c9c7" fontSize="9" letterSpacing="1">27 • 2,400 M • SINGLE RUNWAY</text><circle cx="526" cy="23" r="3" fill="#94e1ce" />
  </svg>;
}

export function Debrief({ snap, world, onReplay, onExport }: { snap: SimState; world: World; onReplay: () => void; onExport: () => void }) {
  const totals = aggregateDelays(snap.movementReports.filter((report) => report.actualAt !== null)), total = Object.values(totals).reduce((a, b) => a + b, 0);
  const mainCause = (Object.keys(totals) as DelayReason[]).sort((a, b) => totals[b] - totals[a])[0]!;
  const advice = { traffic: "试试分批推出，保持进出机位的共用走廊畅通，让同向航班自动跟车。", permission: "优先处理待办和席位移交，再推进至下个请求。", runway: "提前比较进场 ETA，为起飞留出完整时窗，并考虑重型机的尾流间隔。", flight: "提前减速和分层，合流拥挤时先等待，再恢复进近。", taxi: "比较路线与出口位置，减少长距离滑行，同时保留前机的通行空间。" }[mainCause];
  const delayed = [...snap.movementReports].filter((r) => r.actualAt !== null).sort((a, b) => (b.actualAt! - b.targetAt) - (a.actualAt! - a.targetAt));
  return <div className="debrief"><div className="debrief-heading"><div><b>下一班可以怎样更快</b><p>已完成航班的超目标时间，按当时状态估计。</p></div><button onClick={onReplay}>回看调度 ↗</button><button className="ghost export-replay" onClick={onExport}>保存记录</button></div>
    <div className="delay-stack">{(Object.keys(totals) as DelayReason[]).map((key) => totals[key] > .1 && <span key={key} className={`delay-${key}`} style={{ width: `${totals[key] / Math.max(1, total) * 100}%` }} title={`${DELAY_LABELS[key]} ${fmtDuration(totals[key])}`} />)}</div>
    <div className="delay-legend">{(Object.keys(totals) as DelayReason[]).map((key) => <span key={key}><i className={`delay-${key}`} />{DELAY_LABELS[key]} <b>{fmtDuration(totals[key])}</b></span>)}</div>
    <div className="movement-review">{delayed.slice(0, 5).map((report) => { const main = (Object.keys(totals) as DelayReason[]).sort((a, b) => report.delays[b] - report.delays[a])[0]!; const late = Math.max(0, report.actualAt! - report.targetAt); return <div key={report.callsign}><b>{report.callsign}</b><span>{report.kind === "arr" ? "落地" : "起飞"} {fmtClock(world.level.startClockMin + report.actualAt! / 60)}</span><span>{late > 1 ? DELAY_LABELS[main] : "准时完成"}</span><em className={late > 1 ? "late" : ""}>{late > 1 ? `+${fmtDuration(late)}` : "ON TIME"}</em></div>; })}</div>
    <p className="debrief-coach">{total < 1 ? "本班航班准时完成。可以尝试更密集的波次，或用同一种子比较不同排序。" : advice}</p>
  </div>;
}

export function ReplayTransport({ record, time, playing, onPlay, onSeek, onClose }: { record: ReplayRecord; time: number; playing: boolean; onPlay: () => void; onSeek: (t: number) => void; onClose: () => void }) {
  const [draftTime, setDraftTime] = useState<number | null>(null);
  const timer = useRef<number | null>(null), seekRef = useRef(onSeek); seekRef.current = onSeek;
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  function seekDraft(value: number) { setDraftTime(value); if (timer.current !== null) clearTimeout(timer.current); timer.current = window.setTimeout(() => { seekRef.current(value); setDraftTime(null); timer.current = null; }, 80); }
  function flushDraft() { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; if (draftTime !== null) { seekRef.current(draftTime); setDraftTime(null); } }
  const recent = record.actions.filter((action) => action.tick * .1 <= time + .001).at(-1);
  const previous = record.actions.filter((action) => action.tick * .1 < time - .11).at(-1), next = record.actions.find((action) => action.tick * .1 > time + .11);
  return <div className="replay-transport"><div className="replay-heading"><span className="eyebrow">调度回放</span><b>{fmtClock(record.level.startClockMin + time / 60)}</b><span>第 {record.actions.filter((action) => action.tick * .1 <= time + .001).length} / {record.actions.length} 条操作</span><button onClick={onClose}>返回复盘</button></div>
    <div className="replay-controls"><button onClick={onPlay}>{playing ? "暂停回放" : time >= record.endedAt - .05 ? "从头播放" : "播放回放"}</button><button onClick={() => onSeek(Math.max(0, time - 60))}>−1′</button><input aria-label="回放时间" type="range" min="0" max={Math.round(record.endedAt * 10) / 10} step="0.1" value={draftTime ?? Math.round(time * 10) / 10} onChange={(event) => seekDraft(Number(event.target.value))} onPointerUp={flushDraft} onBlur={flushDraft} /><span>{fmtDuration(time)} / {fmtDuration(record.endedAt)}</span><button onClick={() => onSeek(Math.min(record.endedAt, time + 60))}>＋1′</button></div>
    <div className="replay-action"><p>{recent ? `${recent.callsign} · ${describeAction(recent)}` : "拖动时间轴，观察航班和许可如何执行。回放不改变本班成绩。"}</p><button disabled={!previous} onClick={() => previous && onSeek(previous.tick * .1)}>上一条操作</button><button disabled={!next} onClick={() => next && onSeek(next.tick * .1)}>下一条操作</button></div>
  </div>;
}
