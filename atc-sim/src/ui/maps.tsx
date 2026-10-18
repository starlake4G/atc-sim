import { useEffect, useMemo, useState } from "react";
import { fmtAlt, fmtSpd } from "../format";
import { isAirborne } from "../sim/aircraft";
import { predictConflicts } from "../sim/awareness";
import { taxiRoute } from "../sim/ground";
import type { Aircraft, Command, SimState } from "../sim/types";
import type { World } from "../sim/world";

interface MapProps { world: World; snap: SimState; onPick: (id: string) => void }

function GroundDrawing({ world, snap, onPick, draft, onNode }: MapProps & { draft?: string[]; onNode?: (id: string) => void }) {
  const selected = snap.aircraft.find((a) => a.id === snap.selectedId);
  const px = (x: number) => 160 + x * .118;
  const py = (y: number) => 122 - y * .16;
  const preview = draft && selected ? taxiRoute(world, selected, { kind: "taxi", route: "main", via: draft }) : null;
  const route = preview ?? selected?.route;
  const closed = snap.operations.some((event) => event.kind === "inspection" && event.stage === "active");
  return <svg className="ground-svg" viewBox="0 0 320 150" aria-label="机场地面图">
    <path d="M18 122H302" className={`map-runway ${closed ? "closed" : ""}`} />
    {closed && <g className="map-closure"><path d="M23 117l10 10m0-10l-10 10M287 117l10 10m0-10l-10 10" /><text x="160" y="140" textAnchor="middle">检查中 · 暂停新起降</text></g>}
    <text x="300" y="137" textAnchor="end" className="map-caption">RWY 27</text>
    {world.idx.def.edges.map((edge, i) => {
      const a = world.idx.nodes.get(edge.a)!.pos, b = world.idx.nodes.get(edge.b)!.pos;
      return <path key={i} d={`M${px(a.x)} ${py(a.y)}L${px(b.x)} ${py(b.y)}`} className={`map-taxi ${edge.a.startsWith("C") && edge.b.startsWith("C") ? "bypass" : ""}`} />;
    })}
    <text x="20" y="93" className="map-caption">A ← 进场</text><text x="20" y="64" className="map-caption">B → 离场</text><text x="255" y="80" className="map-caption">C →</text>
    {world.idx.def.stands.map((stand) => <g key={stand.id}><rect x={px(stand.pos.x)-5} y={py(stand.pos.y)-6} width="10" height="12" rx="2" className="map-stand" /><text x={px(stand.pos.x)} y={py(stand.pos.y)-10} textAnchor="middle" className="map-caption">{stand.id}</text></g>)}
    {route && !isAirborne(selected!) && <polyline points={route.points.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")} className="map-route" />}
    {world.idx.exitsByDistance.map((exit) => { const p = world.idx.nodes.get(exit.node)!.pos; return <text key={exit.node} x={px(p.x)+4} y={py(p.y)-8} className="map-caption">{exit.name}</text>; })}
    {onNode && world.idx.def.nodes.filter((n) => !["stand", "lineup", "exit"].includes(n.kind)).map((node) => <g key={node.id} className={`map-node ${draft?.includes(node.id) ? "picked" : ""}`} role="button" tabIndex={0} aria-label={`经过 ${node.label ?? node.id}`} onClick={() => onNode(node.id)} onKeyDown={(e) => { if (e.key === "Enter") onNode(node.id); }} transform={`translate(${px(node.pos.x)},${py(node.pos.y)})`}><circle r="5" /><title>{node.label ?? node.id}</title></g>)}
    {snap.aircraft.filter((a) => !isAirborne(a)).map((ac) => <g key={ac.id} className={`map-aircraft ${ac.id === snap.selectedId ? "selected" : ""}`} transform={`translate(${px(ac.pos.x)},${py(ac.pos.y)})`} role="button" tabIndex={0} aria-label={`选择 ${ac.callsign}`} onClick={() => onPick(ac.id)} onKeyDown={(e) => { if (e.key === "Enter") onPick(ac.id); }}><circle r="7" fill="transparent" /><path d="M0 -4L3 3L0 1L-3 3Z" transform={`rotate(${ac.hdg})`} /><title>{ac.callsign} · {ac.blockedBy ?? ac.phase}</title></g>)}
  </svg>;
}

export function GroundMap(props: MapProps & { onOpenRoute: () => void }) {
  return <div className="panel ground-panel"><div className="panel-title"><span>地面交通</span><button className="map-expand" onClick={props.onOpenRoute}>放大 / 规划</button></div><GroundDrawing {...props} /></div>;
}

export function RouteEditor(props: MapProps & { onClose: () => void; onCmd: (cmd: Command) => void }) {
  const selected = props.snap.aircraft.find((a) => a.id === props.snap.selectedId);
  const [draft, setDraft] = useState<string[]>([]);
  const [choice, setChoice] = useState<"main" | "bypass">("main");
  useEffect(() => { setDraft([]); setChoice("main"); }, [selected?.id]);
  const route = selected ? taxiRoute(props.world, selected, { kind: "taxi", route: choice, via: draft }) : null;
  const canIssue = selected?.phase === "taxi_ready" && (selected.controller === "GND" || props.world.mode === "assisted");
  return <div className="overlay route-overlay"><div className="modal route-modal">
    <div className="editor-head"><div><b>滑行路线工作台</b><p>{selected ? `${selected.callsign} · ${selected.kind === "dep" ? "至跑道外等待点 H27" : `至机位 ${selected.standId ?? "待分配"}`}` : "选择一架地面飞机查看路线"}</p></div><button onClick={props.onClose}>关闭 Esc</button></div>
    <GroundDrawing {...props} draft={draft.length ? draft : choice === "bypass" ? ["C700"] : []} onNode={canIssue ? (id) => setDraft((items) => [...items, id]) : undefined} />
    <div className="route-tools"><button onClick={() => { setDraft([]); setChoice("main"); }}>推荐路线 B / A</button>{selected?.kind === "dep" && <button onClick={() => { setDraft([]); setChoice("bypass"); }}>旁通道 C</button>}<button onClick={() => setDraft((items) => items.slice(0, -1))}>撤销路点</button></div>
    <p className="route-description">{canIssue ? "点击圆点指定经过节点，系统补全合法连接。青色线为确认后将执行的路线。" : "推出或脱离完成，并联系地面后，可以在这里下达滑行许可。"}</p>
    {draft.length > 0 && <div className="route-string">经 {draft.map((id) => props.world.idx.nodes.get(id)?.label ?? id).join(" → ")}</div>}
    <div className="editor-foot"><span>{route ? `路线 ${Math.round(route.total)} 米 · 预计 ${Math.ceil(route.total / 5 / 60)} 游戏分钟` : "路线不可通行或没有兼容机位"}</span><button className="primary" disabled={!canIssue || !route} onClick={() => { props.onCmd({ kind: "taxi", route: choice, via: draft }); props.onClose(); }}>确认滑行许可</button></div>
  </div></div>;
}

export function Radar({ world, snap, onPick }: MapProps) {
  const [zoom, setZoom] = useState(1);
  const air = snap.aircraft.filter(isAirborne);
  const selected = snap.aircraft.find((a) => a.id === snap.selectedId);
  const scale = 270 / zoom;
  const px = (x: number) => 160 + x / scale;
  const py = (y: number) => 105 - y / scale;
  const predictions = useMemo(() => predictConflicts(air, world.windDirDeg, world.windKt), [snap, world]);
  const placed: { x: number; y: number }[] = [];
  const labels = new Map<string, { x: number; y: number }>();
  for (const ac of [...air].sort((a, b) => Number(b.id === snap.selectedId) - Number(a.id === snap.selectedId))) {
    const x = Math.max(8, Math.min(239, px(ac.pos.x) + (px(ac.pos.x) > 220 ? -79 : 9)));
    let y = py(ac.pos.y) - 13;
    for (const offset of [0, -24, 24, -48, 48]) {
      const candidate = Math.max(12, Math.min(185, py(ac.pos.y) - 13 + offset));
      if (!placed.some((p) => Math.abs(p.x - x) < 76 && Math.abs(p.y - candidate) < 22)) { y = candidate; break; }
    }
    placed.push({ x, y }); labels.set(ac.id, { x, y });
  }
  return <div className="panel radar"><div className="panel-title"><span>空域雷达 <small>{air.length} 架 · 环距 {10 / zoom} NM</small></span><button className="map-expand" onClick={() => setZoom((z) => z === 1 ? 2 : 1)}>{zoom === 1 ? "放大" : "全域"}</button></div>
    <svg viewBox="0 0 320 210" aria-label="空域雷达，点击航班选择">
      {[1, 2].map((ring) => <circle key={ring} cx="160" cy="105" r={18520 / 270 * ring} className="radar-ring" />)}
      <path d="M0 105H320 M160 0V210" className="radar-axis" /><path d="M156 105H164" className="radar-runway" />
      {[...world.idx.fixes.values()].map((fix) => <g key={fix.name} className="radar-fix"><path d={`M${px(fix.pos.x)} ${py(fix.pos.y)-3}l3 6h-6z`} /><text x={px(fix.pos.x) + (px(fix.pos.x) > 270 ? -5 : 5)} y={py(fix.pos.y)+3} textAnchor={px(fix.pos.x) > 270 ? "end" : "start"}>{fix.name}</text></g>)}
      {selected?.route && isAirborne(selected) && <polyline className="radar-route" points={selected.route.points.map((p) => `${px(p.x)},${py(p.y)}`).join(" ")} />}
      {predictions.map((p) => { const a = air.find((a) => a.id === p.a)!, b = air.find((a) => a.id === p.b)!; return <path key={`${p.a}|${p.b}`} className="radar-prediction" d={`M${px(a.pos.x)} ${py(a.pos.y)}L${px(b.pos.x)} ${py(b.pos.y)}`} />; })}
      {air.filter((a) => px(a.pos.x) > 3 && px(a.pos.x) < 317 && py(a.pos.y) > 3 && py(a.pos.y) < 207).map((ac) => {
        const label = labels.get(ac.id)!;
        return <g key={ac.id} role="button" tabIndex={0} aria-label={`选择 ${ac.callsign}`} onClick={() => onPick(ac.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onPick(ac.id); } }} className={`radar-aircraft ${ac.id === snap.selectedId ? "selected" : ""} ${snap.conflicts.some((c) => c.split("|").includes(ac.id)) ? "conflict" : ""}`}>
          <path className="radar-leader" d={`M${px(ac.pos.x)} ${py(ac.pos.y)}L${label.x} ${label.y}`} />
          <g transform={`translate(${px(ac.pos.x)},${py(ac.pos.y)})`}><circle r="10" fill="transparent" stroke="none" /><path d="M0 -5L3 4L0 2L-3 4Z" transform={`rotate(${ac.hdg})`} /></g>
          <text x={label.x} y={label.y}>{ac.callsign}</text><text className="radar-alt" x={label.x} y={label.y+11}>{fmtAlt(ac.altM)} · {fmtSpd(ac.gs)}</text>
        </g>;
      })}
    </svg>
  </div>;
}

export function selectedAircraft(snap: SimState): Aircraft | null { return snap.aircraft.find((a) => a.id === snap.selectedId) ?? null; }
