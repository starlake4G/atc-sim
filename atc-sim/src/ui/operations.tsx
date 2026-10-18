import { useEffect, useState } from "react";
import { fmtClock } from "../format";
import { runwayWind } from "../sim/operations";
import type { OperationState, SimState } from "../sim/types";
import type { World } from "../sim/world";
import { fmtDuration } from "./experience";

const stages = { scheduled: "计划", announced: "已预告", pending: "待清空", active: "进行中", completed: "已恢复" };
function hint(event: OperationState, time: number): string {
  if (event.stage === "completed") return event.kind === "inspection" ? "检查已完成，跑道开放" : "已恢复基准风况";
  if (event.stage === "active") return `${fmtDuration(event.endsAt! - time)} 后恢复 · ${event.kind === "inspection" ? "可先安排滑行、地面移交或空中等待" : "按机型侧风限制放行；超限机型可等待或安全复飞"}`;
  if (event.stage === "pending") return "已许可航班先完成，清空后自动开始；新起降许可暂停";
  return event.kind === "inspection" ? `${fmtDuration(Math.max(0, event.plannedAt - time))} 后暂停新许可 · 检查用时 ${fmtDuration(event.durationSec)}` : `${fmtDuration(Math.max(0, event.plannedAt - time))} 后生效 · ${event.wind!.dirDeg}° / ${event.wind!.speedKt}G${event.wind!.gustKt ?? event.wind!.speedKt}kt`;
}

export function OperationBoard({ world, snap, onInspect, readOnly, focusToken }: { world: World; snap: SimState; onInspect: (id: string) => void; readOnly: boolean; focusToken: number }) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => { if (focusToken) setExpanded(true); }, [focusToken]);
  if (!snap.operations.length) return null;
  const active = snap.operations.filter((event) => event.stage !== "completed" && event.stage !== "scheduled");
  const upcoming = snap.operations.find((event) => event.stage === "scheduled");
  const visible = active.length ? active : upcoming ? [upcoming] : snap.operations.slice(-1);
  const components = runwayWind(snap.weather, world.idx.runway.hdg);
  return <section id="operation-board" className="operation-board" aria-label="运行事件"><button className="operation-heading" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}><span className={`dispatch-dot ${active.length ? "active" : ""}`} /><b>运行窗口</b><span>{active.length ? `${active.length} 项预告 / 限制` : upcoming ? "已知计划" : "本班事件已恢复"}</span><em>{expanded ? "−" : "+"}</em></button>
    {expanded && <div className="operation-body">{visible.map((event) => {
      const reason = world.operations.inspectionStartReason(world, event.id);
      return <div key={event.id} className={`operation-item kind-${event.kind} ${event.stage}`} data-operation={event.id}><div><b>{event.name}</b><span>{stages[event.stage]}</span></div><p>{hint(event, snap.time)}</p>
        {event.kind === "inspection" && (event.stage === "announced" || event.stage === "pending") && <><button className="inspection-start" disabled={readOnly || !!reason} title={reason} onClick={() => onInspect(event.id)}>利用空档 · 现在检查</button>{reason && <small>{reason}</small>}</>}
        {event.kind === "weather" && event.stage === "active" && <small>阵风侧风 {components.crosswindKt.toFixed(1)}kt · 轻型 / 中型 / 重型限制 15 / 24 / 28kt</small>}
      </div>;
    })}<details className="operation-timeline"><summary>本班运行计划 · {snap.operations.length} 项</summary>{snap.operations.map((event) => <div key={event.id}><i className={event.stage} /><b>{fmtClock(world.level.startClockMin + (event.startedAt ?? event.plannedAt) / 60)}</b><span>{event.name}</span><em>{stages[event.stage]}</em></div>)}</details></div>}
  </section>;
}

export function OperationReview({ world, snap }: { world: World; snap: SimState }) {
  if (!snap.operations.length) return null;
  return <div className="operation-review"><b>运行窗口复盘</b>{snap.operations.map((event) => {
    const early = event.kind === "inspection" && event.startedAt !== null ? event.plannedAt - event.startedAt : 0;
    return <div key={event.id}><span>{event.name}</span><em>{event.startedAt === null ? "未开始" : `${fmtClock(world.level.startClockMin + event.startedAt / 60)} → ${fmtClock(world.level.startClockMin + event.endsAt! / 60)}`}</em><strong>{early > 1 ? `提前 ${fmtDuration(early)}` : early < -1 ? `等已许可航班 ${fmtDuration(-early)}` : stages[event.stage]}</strong></div>;
  })}<p>检查不抢占已许可航班。提前检查可把停用时间移到流量空档；风况限制只作用于新的起降许可。</p></div>;
}
