import { fmtClock, phaseLabel } from "../format";
import { isRunwayCandidate } from "../sim/planning";
import type { SimState } from "../sim/types";
import type { World } from "../sim/world";
import { useEffect, useState } from "react";
import { PlanComparison } from "./decisions";

export type PlanAction = "add" | "remove" | "up" | "down";
const waitTime = (seconds: number) => { const rounded = Math.ceil(Math.max(0, seconds)); return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`; };

export function RunwayPlan({ world, snap, onClose, onPick, onChange, onReorder }: {
  world: World; snap: SimState; onClose: () => void; onPick: (id: string) => void;
  onChange: (id: string, action: PlanAction) => void; onReorder: (id: string, targetId: string) => void;
}) {
  const plan = snap.runwayPlan;
  const [previewId, setPreviewId] = useState<string | null>(null);
  const planKey = plan.map((entry) => `${entry.aircraftId}:${entry.committed}`).join("|");
  useEffect(() => setPreviewId(null), [world, planKey]);
  const preview = previewId ? world.runwayPlan.previewMove(world, previewId, -1) : null;
  const candidates = snap.aircraft.filter((ac) => isRunwayCandidate(ac) && !plan.some((item) => item.aircraftId === ac.id));
  const horizon = Math.max(600, Math.min(1800, Math.ceil(Math.max(0, ...plan.map((entry) => (entry.clearAt ?? snap.time) - snap.time)) / 60) * 60));
  const totalDelay = plan.reduce((sum, entry) => sum + (entry.delaySec ?? 0), 0);
  const pct = (time: number) => Math.max(0, Math.min(100, (time - snap.time) / horizon * 100));
  return <div className="overlay plan-overlay"><div className={`modal plan-modal ${preview?.ok ? "has-preview" : ""}`} role="dialog" aria-modal="true" aria-label="跑道计划工作台">
    <div className="editor-head"><div><b>跑道计划工作台</b><p>加入航班后按队首放行。拖动或用箭头改序，比较预计等待；许可仍需逐架下达。</p></div><button onClick={onClose}>关闭 Esc</button></div>
    <div className="plan-summary"><span>RWY {world.idx.runway.id} · {plan.length} 架已排</span><span>预计累计延误 <b>{waitTime(totalDelay)}{plan.some((entry) => entry.delaySec === null) ? " ＋ 待定" : ""}</b></span><span>时间单位：游戏分:秒</span></div>
    {previewId && preview && (preview.ok ? <PlanComparison before={plan} after={preview.entries} time={snap.time} onCancel={() => setPreviewId(null)} onApply={() => { setPreviewId(null); onChange(previewId, "up"); }} /> : <p className="comparison-uncertain">{preview.reason}<button onClick={() => setPreviewId(null)}>关闭预览</button></p>)}
    <div className="plan-ruler"><span>现在 {fmtClock(snap.clockMin)}</span><span>+{Math.round(horizon / 120)}′</span><span>+{Math.round(horizon / 60)}′</span></div>
    <div className="plan-rows">{plan.length === 0 && <div className="plan-empty"><b>先安排一架进场或离场</b><p>计划为空时可以自由放行。加入后，其他航班须排入顺序，或等计划执行完毕。</p></div>}
      {plan.map((entry, i) => {
        const ac = snap.aircraft.find((aircraft) => aircraft.id === entry.aircraftId)!;
        return <div key={entry.aircraftId} className={`plan-row ${entry.kind} ${entry.committed ? "locked" : ""} ${snap.selectedId === entry.aircraftId ? "selected" : ""}`} draggable={!entry.committed}
          onDragStart={(event) => { event.dataTransfer.setData("text/plain", entry.aircraftId); event.dataTransfer.effectAllowed = "move"; }}
          onDragOver={(event) => { if (!entry.committed) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }}
          onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain"); if (id) onReorder(id, entry.aircraftId); }}>
          <div className="plan-flight"><span className="plan-number">{entry.position}</span><button className="plan-callsign" onClick={() => onPick(entry.aircraftId)}>{entry.callsign}<small>{entry.kind === "arr" ? "进场" : "离场"} · {ac.typeId}</small></button><span className="plan-lock">{entry.committed ? "已许可 · 锁定" : "可改序"}</span></div>
          <div className="plan-times"><span>预计{entry.kind === "arr" ? "落地" : "起飞"} <b>{entry.useAt === null ? "待定" : `+${waitTime(entry.useAt - snap.time)}`}</b></span><span>预计延误 <b className={entry.delaySec ? "delay" : ""}>{entry.delaySec === null ? "待定" : waitTime(entry.delaySec)}</b></span></div>
          <div className="plan-track" aria-label="预计跑道占用窗口">{entry.useAt !== null && entry.occupyAt !== null && entry.clearAt !== null && <span style={{ left: `${pct(entry.occupyAt)}%`, width: `${Math.max(.8, pct(entry.clearAt) - pct(entry.occupyAt))}%` }} title={`预计${entry.kind === "arr" ? "落地" : "起飞"} +${waitTime(entry.useAt - snap.time)}，跑道释放 +${waitTime(entry.clearAt - snap.time)}`} />}</div>
          <div className="plan-reason">{entry.waitReason}</div><div className="plan-controls">{!entry.committed && i > 0 && !plan[i - 1]?.committed && <button className="plan-try" aria-label={`比较 ${entry.callsign} 前移`} aria-expanded={previewId === entry.aircraftId} onClick={() => setPreviewId((current) => current === entry.aircraftId ? null : entry.aircraftId)}>试排 ↑</button>}<button aria-label={`${entry.callsign} 前移`} disabled={entry.committed || i === 0 || plan[i - 1]?.committed} onClick={() => onChange(entry.aircraftId, "up")}>↑</button><button aria-label={`${entry.callsign} 后移`} disabled={entry.committed || i === plan.length - 1 || plan[i + 1]?.committed} onClick={() => onChange(entry.aircraftId, "down")}>↓</button><button aria-label={`${entry.callsign} 移出计划`} disabled={entry.committed} onClick={() => onChange(entry.aircraftId, "remove")}>移出</button></div>
        </div>;
      })}
    </div>
    <div className="plan-candidates"><div className="group-label">可加入的航班</div>{candidates.length === 0 ? <div className="empty">当前可调度航班已全部排入计划</div> : candidates.map((ac) => <div className="plan-candidate" key={ac.id}><button onClick={() => onPick(ac.id)}><b>{ac.callsign}</b><span>{ac.kind === "arr" ? "进场" : "离场"} · {ac.typeId} · {phaseLabel(ac)}</span></button><button aria-label={`${ac.callsign} 加入计划`} onClick={() => onChange(ac.id, "add")}>＋ 加入</button></div>)}</div>
    <p className="plan-note">「试排 ↑」先比较相邻交换的预计延误与释放时间，采用后才改序。已获落地许可或进入跑道的顺序锁定；复飞取消原位置。预测不包含你的指令反应时间，也不会自动减速或执行等待。</p>
  </div></div>;
}
