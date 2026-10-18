import { useEffect, useRef, useState } from "react";
import { fmtAlt, fmtClock, fmtDist, fmtHdg, fmtSpd, phaseLabel } from "../format";
import { distanceToThreshold } from "../sim/airport";
import { arrivalETA, attentionFor, predictConflicts } from "../sim/awareness";
import { wakeRemaining } from "../sim/runway";
import type { Aircraft, Command, CommandOption, SimState } from "../sim/types";
import type { World } from "../sim/world";
import type { ViewMode } from "../views/scene3d";
import { recommendedCommand } from "../sim/flow";
import { DispatchSummary, FlightSteps, fmtDuration } from "./experience";
import { OperationBoard } from "./operations";
import { runwayWind } from "../sim/operations";
import { DepartureOpportunity } from "./decisions";

export function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><b>{value}</b></div>;
}

export function TopBar(props: { snap: SimState; paused: boolean; speed: number; view: ViewMode; onPause: () => void; onSpeed: (speed: number) => void; onView: (view: ViewMode) => void; onBack: () => void; onHelp: () => void; editing: boolean; onLayout: () => void; onReset: () => void; onAdvance: () => void; canAdvance: boolean; sound: boolean; onSound: () => void; quality: string; onQuality: () => void; focused: boolean; onFocus: () => void }) {
  return <div className="topbar">
    <button className="ghost exit-button" onClick={props.onBack}>退出</button><span className="top-brand">KESTREL<small>APPROACH / KEKS</small></span>
    <div className="clock">{fmtClock(props.snap.clockMin)}</div>
    <div className="stat"><b>{props.snap.score.landings + props.snap.score.takeoffs}/{props.snap.movementsTarget}</b><span>架次</span></div>
    <div className="stat"><b>{props.snap.score.points}</b><span>积分</span></div>
    <div className={`stat ${props.snap.score.violations ? "bad" : ""}`}><b>{props.snap.score.violations}</b><span>违规</span></div>
    <div className="spacer" /><div className="toolbar-group time-controls"><button className="ghost" onClick={props.onPause}>{props.paused ? "继续" : "暂停"}</button>
    {[1, 2, 4].map((speed) => <button key={speed} className={`ghost ${props.speed === speed ? "on" : ""}`} onClick={() => props.onSpeed(speed)}>{speed}×</button>)}
    </div><button className="advance-button ghost" disabled={!props.canAdvance} title={props.canAdvance ? "推进至下个需要你处理的请求，最多 5 游戏分钟；不会替你下达许可" : "先处理待办，或先查看即将落地的航班"} onClick={props.onAdvance}>下一请求 »</button>
    <div className="toolbar-group camera-controls">{(["tower", "follow", "top"] as ViewMode[]).map((view) => <button key={view} className={`ghost ${props.view === view ? "on" : ""}`} onClick={() => props.onView(view)}>{({ tower: "塔台", follow: "跟机", top: "俯瞰" })[view]}</button>)}</div>
    <button className={`ghost focus-button ${props.focused ? "on" : ""}`} aria-pressed={props.focused} title="扩大机场画面，保留航班与许可；V 切换" onClick={props.onFocus}>专注视图</button>
    <button className="ghost" onClick={props.onHelp}>操作指南</button>
    <button className={`ghost ${props.editing ? "on" : ""}`} onClick={props.onLayout}>{props.editing ? "完成布局" : "布局编辑"}</button>
    {props.editing && <button className="ghost" onClick={props.onReset}>恢复布局</button>}
    <button className={`ghost sound-button ${props.sound ? "on" : ""}`} aria-pressed={props.sound} onClick={props.onSound}>提示音{props.sound ? "开" : "关"}</button><button className="ghost quality-button" onClick={props.onQuality}>画质 · {props.quality}</button>
  </div>;
}

export function FlightList({ snap, world, onPick }: { snap: SimState; world: World; onPick: (id: string) => void }) {
  const [filter, setFilter] = useState("ALL");
  useEffect(() => setFilter("ALL"), [world]);
  const sorted = [...snap.aircraft].filter((ac) => filter === "ALL" || ac.controller === filter).sort((a, b) => attentionFor(b, world.idx, world.mode).priority - attentionFor(a, world.idx, world.mode).priority || distanceToThreshold(world.idx, a.pos) - distanceToThreshold(world.idx, b.pos));
  const pending = world.pendingFlights().slice(0, 3);
  return <div className="panel flights"><div className="panel-title"><span>航班工作台</span><span>{snap.aircraft.length} 架在管</span></div>
    <div className="seat-tabs">{["ALL", "APP", "TWR", "GND"].map((seat) => <button key={seat} className={filter === seat ? "on" : ""} onClick={() => setFilter(seat)}>{seat === "ALL" ? "全部" : seat}<span>{snap.aircraft.filter((ac) => seat === "ALL" || ac.controller === seat).length}</span></button>)}</div>
    <DispatchSummary world={world} onPick={onPick} />
    <div className="flight-rows">{sorted.length === 0 && <div className="empty">当前席位暂无航班</div>}{sorted.map((ac) => {
      const attention = attentionFor(ac, world.idx, world.mode); const eta = arrivalETA(ac, world.idx);
      const operational = ac.controller === "TWR" && (ac.phase === "hold_short" || ac.phase === "approach") ? world.operations.blockReason(world, ac) : undefined;
      const conflict = snap.conflicts.some((c) => c.split("|").includes(ac.id));
      return <button key={ac.id} className={`row ${ac.id === snap.selectedId ? "sel" : ""} ${conflict ? "conflict" : ""}`} onClick={() => onPick(ac.id)}>
        <span className="cs">{ac.callsign}<small>{ac.kind === "arr" ? "↙" : "↗"}</small></span><span className="ty">{ac.typeId} · {ac.controller}</span>
        <span className="ph">{phaseLabel(ac)}</span><span className="rt">{eta === null ? ac.kind === "arr" ? ac.standId ?? "" : fmtAlt(ac.altM) : `ETA ${fmtDuration(eta)}`}</span>
        {attention.priority > 0 && <span title={operational} className={`row-action ${attention.priority >= 60 ? "urgent" : ""}`}>{operational ? operational.split("，")[0] : attention.text}</span>}
      </button>;
    })}</div>
    <div className="schedule"><div className="group-label">接下来的航班</div>{pending.length ? pending.map((flight) => <div key={flight.callsign} className="schedule-row"><span>{fmtClock(world.level.startClockMin + flight.atMin)}</span><b>{flight.callsign}</b><span>{flight.kind === "arr" ? "进场" : "离场"}</span></div>) : <div className="empty">本班航班已全部到齐</div>}</div>
  </div>;
}

export function RadioLog({ snap, baseClock }: { snap: SimState; baseClock: number }) {
  const ref = useRef<HTMLDivElement>(null); const follow = useRef(true);
  useEffect(() => { if (ref.current && follow.current) ref.current.scrollTop = ref.current.scrollHeight; }, [snap.radio.at(-1)?.id]);
  return <div className="panel radio"><div className="panel-title"><span>无线电记录</span><span>APP · TWR · GND</span></div>
    <div className="radio-body" ref={ref} onScroll={() => { const el = ref.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}>
      {snap.radio.map((line) => <div key={line.id} className={`line ${line.tone}`}><span className="t">{fmtClock(baseClock + Math.floor(line.t / 60))}</span><span className="from">{line.seat}</span><span className="txt">{line.callsign !== "—" ? `${line.callsign} ` : ""}{line.text}</span></div>)}
    </div>
  </div>;
}

export function guidanceFor(ac: Aircraft, world: World): string {
  if (ac.blockedBy) return `${ac.blockedBy}。可等待通行，后续放行可使用旁通道 C。`;
  if (ac.airHolding) return "正在空中等待。需要恢复时，选择直飞 KAVLA，再安排 ILS 进近。";
  switch (ac.phase) {
    case "arrival": return "预排进场顺序：可减速、等待或直飞。距场 32 公里内下达 ILS 进近许可。";
    case "approach": return ac.landCleared ? "已获准落地，保持监控；可取消许可或执行安全复飞。" : !ac.approach?.established ? "正在截获航向道。建立后联系塔台，再下达落地许可。" : ac.controller === "APP" && world.mode === "standard" ? "已建立进近：联系塔台 118.1，然后下达落地许可。" : "确认跑道空闲，再下达落地许可。";
    case "parked": return ac.kind === "dep" ? "批准推出；标准模式下，推出完成后还需批准滑行。" : "到达机位，服务完成。";
    case "pushback": return "牵引车正在推出。完成后会请求滑行许可，可先观察地面路线。";
    case "taxi_ready": return ac.kind === "arr" && ac.controller !== "GND" && world.mode === "standard" ? "已清空跑道：联系地面 121.7，再批准滑入机位。" : "选择推荐路线或打开路线工作台；确认后飞机才开始滑行。";
    case "taxi_out": return ac.holding ? "主动等待中。选择继续滑行恢复。" : "按许可路线滑行。到达 H27 后联系塔台，等待起飞许可。";
    case "hold_short": return ac.controller !== "TWR" && world.mode === "standard" ? "到达等待点：联系塔台 118.1。" : "结合进场 ETA，确认跑道空闲，再进跑道等待或批准起飞。";
    case "lineup": return ac.takeoffPending ? "已获准起飞，完成对正后开始滑跑。" : "正在进跑道等待，可追加起飞许可。";
    case "landing": return "选择可安全减速到达的出口；不指定时自动选择。较早脱离有助于释放跑道。";
    case "taxi_in": return world.runwayOccupantId === ac.id ? "正在脱离，机尾越过道面后释放跑道。" : "按路线滑入兼容机位，停稳后完成服务。";
    case "departure": return ac.controller === "DEP" ? "已移交离场，航班将继续沿离场程序飞行。" : "爬升至机场上方 1500 ft 后，可移交离场 124.6。";
    default: return "观察航班执行情况，优先处理右侧待办提示。";
  }
}

export function CommandStrip({ ac, world, options, onCmd, onPlanRoute }: { ac: Aircraft; world: World; options: CommandOption[]; onCmd: (cmd: Command) => void; onPlanRoute: () => void }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [ac.id]);
  const recommended = recommendedCommand(world, ac);
  const advanced = ["引导", "高度", "速度"];
  const groups = new Map<string, CommandOption[]>(); for (const option of options) if (option.key !== recommended?.key && (expanded || !advanced.includes(option.group) && option.command.kind !== "pushback")) groups.set(option.group, [...groups.get(option.group) ?? [], option]);
  const blocked = options.find((option) => option.disabledReason && (option.tone === "primary" || option.key === "takeoff"));
  const delay = Math.max(0, world.time - ac.scheduledMovementAt);
  const showOpportunity = ac.kind === "dep" && (ac.phase === "hold_short" || ac.phase === "lineup");
  return <div className="strip"><div className="strip-info"><div className="strip-head"><b>{ac.callsign}</b><span>{ac.typeId} · {ac.controller}</span><span className="phase">{phaseLabel(ac)}</span></div><div className="strip-metrics"><Metric label="高度" value={fmtAlt(ac.altM)} /><Metric label="地速" value={`${fmtSpd(ac.gs)}kt`} /><Metric label="航向" value={fmtHdg(ac.hdg)} /><Metric label="距场" value={fmtDist(distanceToThreshold(world.idx, ac.pos))} /></div></div>
    <div className="command-workflow"><FlightSteps ac={ac} /><span className={`flight-delay ${delay > 60 ? "late" : ""}`}>{ac.scored.departed || ac.scored.landed ? "已完成起降" : delay > 0 ? `目标延误 +${fmtDuration(delay)}` : `目标时刻 ${fmtClock(world.level.startClockMin + ac.scheduledMovementAt / 60)}`}</span></div>
    {showOpportunity ? <DepartureOpportunity ac={ac} world={world} /> : <div className={`guidance ${blocked ? "blocked" : ""}`}>{blocked?.disabledReason ?? guidanceFor(ac, world)}</div>}<div className="strip-cmds">{recommended && <button className="cmd primary recommended-command" onClick={() => onCmd(recommended.command)}><kbd>E</kbd>{recommended.label}</button>}{options.length === 0 && <span className="none">按许可执行中</span>}{[...groups].map(([group, list]) => <div key={group} className="cmd-group"><span className="gname">{group}</span>{list.map((option) => <button key={option.key} disabled={!!option.disabledReason} title={option.disabledReason} className={`cmd ${option.tone ?? ""}`} onClick={() => onCmd(option.command)}>{option.label}</button>)}</div>)}{ac.phase === "taxi_ready" && <button className="cmd" onClick={onPlanRoute}>规划滑行路线</button>}{options.some((option) => (advanced.includes(option.group) || option.command.kind === "pushback") && option.key !== recommended?.key) && <button className={`cmd vector-toggle ${expanded ? "on" : ""}`} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{ac.phase === "parked" ? expanded ? "收起方向选项" : "其他推出方向" : expanded ? "收起雷达指令" : "航向 / 高度 / 速度"}</button>}</div>
  </div>;
}

export function Operations({ world, snap, onPick, onPlan, onInspect, readOnly = false, focusToken = 0 }: { world: World; snap: SimState; onPick: (id: string) => void; onPlan: () => void; onInspect: (id: string) => void; readOnly?: boolean; focusToken?: number }) {
  const occupant = snap.aircraft.find((ac) => ac.id === snap.runwayOccupant || ac.phase === "approach" && ac.landCleared);
  const wake = Math.max(0, ...snap.aircraft.filter((ac) => ac.phase === "hold_short" || ac.phase === "approach" && !ac.landCleared).map((ac) => wakeRemaining(world, ac)));
  const inbound = snap.aircraft.map((ac) => ({ ac, eta: arrivalETA(ac, world.idx) })).filter((item) => item.eta !== null).sort((a, b) => a.eta! - b.eta!).slice(0, 3);
  const predictions = predictConflicts(snap.aircraft, world.windDirDeg, world.windKt);
  const closure = snap.operations.find((event) => event.kind === "inspection" && (event.stage === "active" || event.stage === "pending"));
  const wind = runwayWind(snap.weather, world.idx.runway.hdg);
  return <div className="operations"><div className={`runway-state ${closure ? "closed" : occupant || wake > 0 ? "occupied" : ""}`}><span className="status-dot" /> RWY 27 · {closure ? closure.stage === "active" ? `检查关闭 · ${fmtDuration(closure.endsAt! - snap.time)} 后开放` : "检查待开始 · 已许可优先清空" : occupant ? `${occupant.callsign} ${occupant.phase === "approach" ? "落地预留" : "占用中"}` : wake > 0 ? `道面空闲 · 尾流保护 ${Math.ceil(wake)}s` : "空闲"}</div>
    <div className="weather"><span className="wind-arrow" style={{ transform: `rotate(${snap.weather.dirDeg + 180}deg)` }}>↑</span> 风 {world.windDirDeg}° / {world.windKt}{snap.weather.gustKt! > world.windKt ? `G${snap.weather.gustKt}` : ""}kt · 侧风 {wind.crosswindKt.toFixed(1)}kt · 剩余 {Math.max(0, Math.ceil(world.level.durationMin - snap.time / 60))}′</div>
    <div className="plan-compact"><button className="plan-open" onClick={onPlan}>跑道计划 <b>{snap.runwayPlan.length || "＋"}</b></button>{snap.runwayPlan.slice(0, 2).map((entry) => <button key={entry.aircraftId} onClick={() => onPick(entry.aircraftId)}>{entry.position}. {entry.callsign} <span>{entry.kind === "arr" ? "↙" : "↗"}{entry.committed ? " 已许可" : ""}</span></button>)}{world.level.seed && <span className="seed-label" title={`规则种子 ${world.level.seed}`}>种子 {world.level.seed}</span>}</div>
    {inbound.length > 0 && <div className="arrival-sequence"><span>预计进场</span>{inbound.map(({ ac, eta }, i) => <button key={ac.id} onClick={() => onPick(ac.id)}><b>{i + 1}</b> {ac.callsign} <em>{Math.floor(eta! / 60)}:{String(Math.floor(eta! % 60)).padStart(2, "0")}</em></button>)}</div>}
    <OperationBoard world={world} snap={snap} onInspect={onInspect} readOnly={readOnly} focusToken={focusToken} />
    {predictions.slice(0, 1).map((p) => <button key={p.a + p.b} className="prediction-warning" onClick={() => onPick(p.a)}>预计 {Math.ceil(p.inSec)} 秒后接近间隔限制 · 提前检查排序</button>)}
    {snap.alerts.slice(-1).map((alert) => <div key={alert.id} className={`event ${alert.tone}`} role="status">{alert.text}</div>)}
  </div>;
}
