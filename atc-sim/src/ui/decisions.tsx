import { useEffect, useState } from "react";
import { departurePreparationSec, departureWindowEstimates, runwayBlockReason } from "../sim/runway";
import { summarizePlan, type RunwayPlanEntry } from "../sim/planning";
import type { Aircraft } from "../sim/types";
import type { World } from "../sim/world";
import { fmtDuration } from "./experience";

const signedTime = (value: number) => `${value < 0 ? "−" : "+"}${fmtDuration(Math.abs(value))}`;
const deltaTone = (value: number | null) => value === null || Math.abs(value) < .5 ? "neutral" : value < 0 ? "less" : "more";

export function DepartureOpportunity({ ac, world }: { ac: Aircraft; world: World }) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [ac.id]);
  const estimate = departureWindowEstimates(world, ac)[0];
  const permission = world.commandOptions(ac).find((option) => option.key === "takeoff");
  const blocked = permission?.disabledReason ?? (world.mode === "standard" && ac.controller !== "TWR" ? "先联系塔台，再申请起飞许可" : runwayBlockReason(world, ac));
  const margin = estimate?.marginSec;
  const tone = ac.takeoffPending ? "executing" : blocked || margin !== undefined && margin < 0 ? "limited" : margin !== undefined && margin < 30 ? "tight" : "open";
  return <div className={`departure-opportunity ${tone}`} data-margin={margin ?? "none"} data-blocked={!!blocked}>
    <div className="opportunity-heading"><b>{ac.takeoffPending ? "已获起飞许可 · 执行中" : estimate ? `进近时间余量 ${signedTime(estimate.marginSec)}` : "当前无进近来机"}</b><span>{estimate ? `约束来机 ${estimate.callsign}` : "仍需观察引导中的航班"}</span><button aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "收起计算" : "计算详情"}</button></div>
    <p className={`guidance ${blocked ? "blocked" : ""}`}>{ac.takeoffPending ? "完成对正后按已获许可起飞，继续监控进近交通。" : blocked ?? (estimate ? `来机约 ${fmtDuration(estimate.arrivalInSec)} 到达，完整起飞窗口需 ${fmtDuration(estimate.requiredSec)}；下达许可前余量会随时间变化。` : `进跑道与滑跑预计需 ${fmtDuration(departurePreparationSec(world, ac))}；请确认跑道、尾流与运行条件，再下达许可。`)}</p>
    {expanded && <div className="opportunity-calculation">{estimate ? <><span>来机到达 <b>{fmtDuration(estimate.arrivalInSec)}</b></span><span>进跑道 + 滑跑 <b>−{fmtDuration(estimate.preparationSec)}</b></span><span>爬升释放 <b>−{fmtDuration(estimate.releaseSec)}</b></span><span>2 NM + 5s 缓冲 <b>−{fmtDuration(estimate.bufferSec)}</b></span><p>按当前进近速度和保守风分量估计，取所有进近来机中最小的余量。余量表示时间关系；许可仍需满足跑道占用、尾流、风况、检查、计划顺序与席位要求。</p></> : <p>没有进入进近阶段的来机，无法给出进近时间余量。引导阶段的航班、后续风况与管制操作仍会改变可用窗口。</p>}</div>}
  </div>;
}

export function PlanComparison({ before, after, time, onApply, onCancel }: { before: RunwayPlanEntry[]; after: RunwayPlanEntry[]; time: number; onApply: () => void; onCancel: () => void }) {
  const original = summarizePlan(before), preview = summarizePlan(after);
  const comparable = original.totalDelaySec !== null && preview.totalDelaySec !== null && original.lastClearAt !== null && preview.lastClearAt !== null;
  const delayDelta = comparable ? preview.totalDelaySec! - original.totalDelaySec! : null;
  const clearDelta = comparable ? preview.lastClearAt! - original.lastClearAt! : null;
  const changes = after.map((entry) => ({ entry, old: before.find((old) => old.aircraftId === entry.aircraftId)! }));
  const faster = changes.filter(({ entry, old }) => entry.useAt !== null && old.useAt !== null && entry.useAt < old.useAt - .5).length;
  const slower = changes.filter(({ entry, old }) => entry.useAt !== null && old.useAt !== null && entry.useAt > old.useAt + .5).length;
  return <div className="plan-comparison" data-comparable={comparable} aria-label="改序结果预览">
    <div className="comparison-heading"><b>试排预览 · 当前顺序尚未改变</b><button onClick={onCancel}>收起预览</button></div>
    <div className="comparison-order"><span>当前 {before.map((entry) => entry.callsign).join(" → ")}</span><strong>试排 {after.map((entry) => entry.callsign).join(" → ")}</strong></div>
    <div className="comparison-metrics"><div><span>累计预计延误</span><b className={deltaTone(delayDelta)}>{delayDelta === null ? "暂不可比较" : Math.abs(delayDelta) < .5 ? "无明显变化" : `${signedTime(delayDelta)}`}</b><small>{original.totalDelaySec === null ? "待定" : fmtDuration(original.totalDelaySec)} → {preview.totalDelaySec === null ? "待定" : fmtDuration(preview.totalDelaySec)}</small></div><div><span>末架释放时间</span><b className={deltaTone(clearDelta)}>{clearDelta === null ? "暂不可比较" : Math.abs(clearDelta) < .5 ? "无明显变化" : `${signedTime(clearDelta)}`}</b><small>{original.lastClearAt === null ? "待定" : `+${fmtDuration(original.lastClearAt - time)}`} → {preview.lastClearAt === null ? "待定" : `+${fmtDuration(preview.lastClearAt - time)}`}</small></div></div>
    {comparable ? <><p className="comparison-effect">{faster} 架预计提前，{slower} 架预计推迟；两项指标分别比较，只包含当前计划内的航班。</p><div className="comparison-flights">{changes.map(({ entry, old }) => <div key={entry.aircraftId}><b>{entry.callsign}</b><span>{entry.kind === "arr" ? "落地" : "起飞"} +{fmtDuration(old.useAt! - time)} → +{fmtDuration(entry.useAt! - time)}</span><em className={deltaTone(entry.useAt! - old.useAt!)}>{Math.abs(entry.useAt! - old.useAt!) < .5 ? "—" : signedTime(entry.useAt! - old.useAt!)}</em></div>)}</div></> : <p className="comparison-uncertain">{original.waitReason ? `当前：${original.waitReason}。` : ""}{preview.waitReason ? `试排：${preview.waitReason}。` : ""}先解除等待或处理窗口限制，再比较总量。可估计航班：{original.known}/{original.total} → {preview.known}/{preview.total}。</p>}
    <div className="comparison-footer"><span>采用后只修改计划；等待、速度和许可仍由你决定。</span><button className="comparison-apply" onClick={onApply}>采用这个顺序</button></div>
  </div>;
}
