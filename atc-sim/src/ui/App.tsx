import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_LEVEL_ID, LEVELS, getLevel } from "../data/levels";
import { DEFAULT_SPEED } from "../format";
import { rateShift } from "../sim/scoring";
import { botTick } from "../sim/bot";
import { CHALLENGE_ID, DEFAULT_CHALLENGE_SEED, createChallenge, normalizeChallengeSeed } from "../sim/challenge";
import type { Command, ControlMode, SafetyMode, SimState } from "../sim/types";
import { TIME_SCALE, TICK, World } from "../sim/world";
import { Scene3D, type ViewMode } from "../views/scene3d";
import { GroundMap, Radar, RouteEditor, selectedAircraft } from "./maps";
import { CommandStrip, FlightList, Operations, RadioLog, TopBar } from "./panels";
import { Help, Result, StartScreen, readRecords, recordKey, writeRecords } from "./session";
import { WorkspaceWindow } from "./window";
import { RunwayPlan, type PlanAction } from "./planning";
import { advanceToDecision, decisionFlights, recommendedCommand } from "../sim/flow";
import { ReplayPlayer } from "../sim/replay";
import { ReplayTransport, ShiftGoals, fmtDuration } from "./experience";
import { RadioAudio } from "./audio";

interface Session { world: World; levelId: string }

export default function App() {
  const [levelId, setLevelId] = useState(DEFAULT_LEVEL_ID);
  const [mode, setMode] = useState<ControlMode>("standard");
  const [challengeSeed, setChallengeSeed] = useState(DEFAULT_CHALLENGE_SEED);
  const [session, setSession] = useState<Session | null>(null);
  const [snap, setSnap] = useState<SimState | null>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<ViewMode>("tower");
  const [toast, setToast] = useState<string | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [records, setRecords] = useState(readRecords);
  const [layoutEditing, setLayoutEditing] = useState(false);
  const [layoutReset, setLayoutReset] = useState(0);
  const [review, setReview] = useState<ReplayPlayer | null>(null);
  const [reviewPlaying, setReviewPlaying] = useState(false);
  const [sound, setSound] = useState(false);
  const [safetyMode, setSafetyMode] = useState<SafetyMode>(() => { try { return localStorage.getItem("kestrel.safety") === "guarded" ? "guarded" : "consequence"; } catch { return "consequence"; } });
  const [quality, setQuality] = useState<"low" | "balanced" | "high">(() => { try { const saved = localStorage.getItem("kestrel.quality"); return saved === "low" || saved === "high" ? saved : "balanced"; } catch { return "balanced"; } });
  const [toastTone, setToastTone] = useState("info");
  const [compactPane, setCompactPane] = useState<string | null>("flights");
  const [operationFocus, setOperationFocus] = useState(0);
  const [focused, setFocused] = useState(() => { try { return new URLSearchParams(location.search).get("focus") === "1" || localStorage.getItem("kestrel.focus") === "true"; } catch { return false; } });
  const [focusPane, setFocusPane] = useState<string | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const pausedRef = useRef(false), speedRef = useRef(1), viewRef = useRef<ViewMode>("tower");
  const toastTimer = useRef<number | null>(null);
  const overlayWasPaused = useRef(false);
  const savedWorld = useRef<World | null>(null);
  const reviewRef = useRef<ReplayPlayer | null>(null), reviewPlayingRef = useRef(false), activeWorld = useRef<World | null>(null);
  const audio = useRef<RadioAudio | null>(null);
  const playedRadio = useRef(0);
  const world = review?.world ?? session?.world ?? null;
  reviewRef.current = review; reviewPlayingRef.current = reviewPlaying; activeWorld.current = world;
  pausedRef.current = paused; speedRef.current = speed; viewRef.current = view;
  useEffect(() => { try { localStorage.setItem("kestrel.focus", String(focused)); } catch { /* View remains available without storage. */ } }, [focused]);

  const showToast = (text: string, tone = "info") => {
    setToast(text);
    setToastTone(tone);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  };

  function start(id: string) {
    const level = id === CHALLENGE_ID ? createChallenge(challengeSeed) : getLevel(id);
    if (level.seed) setChallengeSeed(level.seed);
    const world = new World(level, { mode, safetyMode }); world.step();
    setCompactPane(innerWidth <= 760 && level.lesson ? null : "flights");
    setFocusPane(null);
    setReview(null); reviewRef.current = null; setReviewPlaying(false); playedRadio.current = 0;
    if (level.lesson) world.select(world.aircraftList()[0]?.id ?? null);
    setLevelId(id); setSession({ world, levelId: id }); setSnap(world.snapshot());
    setPaused(!!level.lesson); setSpeed(DEFAULT_SPEED); setView("tower"); setToast(null); setRouteOpen(false); setHelpOpen(false); setPlanOpen(false);
  }

  useEffect(() => {
    const q = new URLSearchParams(location.search), id = q.get("level");
    if (!id) return;
    const template = LEVELS.find((level) => level.id === id);
    if (!template) { showToast("关卡不存在，请重新选择"); return; }
    const level = id === CHALLENGE_ID ? createChallenge(q.get("seed")) : template;
    if (level.seed) setChallengeSeed(level.seed);
    const debugMode = q.get("mode") === "standard" ? "standard" : "assisted";
    const world = new World(level, { mode: debugMode, safetyMode: q.get("safety") === "guarded" ? "guarded" : safetyMode });
    const raw = Number(q.get("fast") ?? "0");
    const fast = Number.isFinite(raw) ? Math.max(0, Math.min(raw, level.durationMin * 60)) : 0;
    for (let i = 0; i < fast / TICK && world.status === "running"; i++) { world.step(); if (q.get("bot") === "1" && i % 20 === 0) botTick(world); }
    if (world.time === 0) world.step();
    setLevelId(id); setMode(debugMode); setSession({ world, levelId: id }); setSnap(world.snapshot());
    setPaused(q.get("paused") === "1");
    const initialView = q.get("view"); if (initialView === "tower" || initialView === "follow" || initialView === "top") setView(initialView);
  }, []);

  useEffect(() => {
    if (!session || !stageRef.current || !labelsRef.current) return;
    const scene = new Scene3D(stageRef.current, labelsRef.current, session.world, (id) => { const current = activeWorld.current; if (current) { current.select(id); setSnap(current.snapshot()); } }, { shadows: quality !== "low" && !new URLSearchParams(location.search).has("lite"), quality });
    sceneRef.current = scene;
    return () => { scene.dispose(); sceneRef.current = null; };
  }, [session, quality]);

  useEffect(() => () => { if (toastTimer.current !== null) clearTimeout(toastTimer.current); audio.current?.dispose(); }, []);

  useEffect(() => {
    if (!session) return;
    let raf = 0, last = performance.now(), accumulator = 0, lastUi = 0;
    const world = session.world;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const realDt = Math.min(.25, (now - last) / 1000); last = now;
      const player = reviewRef.current;
      const displayWorld = player?.world ?? world;
      if (player) {
        accumulator = 0;
        if (reviewPlayingRef.current) { player.advance(realDt * TIME_SCALE * speedRef.current); if (player.ended) setReviewPlaying(false); }
      } else if (!pausedRef.current && world.status === "running") {
        accumulator += realDt * TIME_SCALE * speedRef.current;
        let steps = 0;
        while (accumulator >= TICK && steps < 80) { world.step(); accumulator -= TICK; steps++; }
        if (steps === 80) accumulator = 0;
      }
      sceneRef.current?.update(displayWorld, realDt, viewRef.current, displayWorld.selectedId, displayWorld.selectedId);
      if (now - lastUi > 100) { lastUi = now; setSnap(displayWorld.snapshot()); }
    };
    raf = requestAnimationFrame(frame); return () => cancelAnimationFrame(raf);
  }, [session]);

  function closeOverlay() { setRouteOpen(false); setHelpOpen(false); setPlanOpen(false); setPaused(overlayWasPaused.current); }
  function openRoute() { overlayWasPaused.current = pausedRef.current; setPaused(true); setRouteOpen(true); }
  function openHelp() { overlayWasPaused.current = pausedRef.current; setPaused(true); setHelpOpen(true); }
  function openPlan() { overlayWasPaused.current = pausedRef.current; setPaused(true); setPlanOpen(true); }

  useEffect(() => {
    if (!session) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && layoutEditing) { setLayoutEditing(false); return; }
      if (layoutEditing) return;
      if (event.key === "Escape" && (routeOpen || helpOpen || planOpen)) { closeOverlay(); return; }
      if (routeOpen || helpOpen || planOpen) return;
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, select") || target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
      const world = activeWorld.current!;
      if (event.code === "Space") {
        if (event.repeat || target.closest("button")) return;
        event.preventDefault(); if (reviewRef.current) setReviewPlaying((value) => !value); else setPaused((value) => !value);
      } else if (["1", "2", "4"].includes(event.key)) setSpeed(Number(event.key));
      else if (["F1", "F2", "F3"].includes(event.key)) { event.preventDefault(); setView(({ F1: "tower", F2: "follow", F3: "top" } as const)[event.key as "F1"]); }
      else if (event.key.toLowerCase() === "n" && !event.repeat) { const next = decisionFlights(world)[0]; if (next) pick(next.id); }
      else if (event.key.toLowerCase() === "v" && !event.repeat && innerWidth > 760) { setFocused((value) => !value); setLayoutEditing(false); setFocusPane(null); }
      else if (event.key.toLowerCase() === "e" && !event.repeat && !reviewRef.current && world.selectedId && world.status === "running") { const ac = world.aircraft.get(world.selectedId)!; const command = recommendedCommand(world, ac); if (command) issue(command.command); }
      else if (event.key === "Tab") {
        if (target.closest("button") && !target.closest(".flights")) return;
        event.preventDefault(); const aircraft = world.aircraftList(); if (!aircraft.length) return;
        const i = aircraft.findIndex((ac) => ac.id === world.selectedId);
        world.select(aircraft[(i + (event.shiftKey ? aircraft.length - 1 : 1)) % aircraft.length]!.id); setSnap(world.snapshot());
      } else if (event.key === "Escape") { world.select(null); setSnap(world.snapshot()); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [session, routeOpen, helpOpen, planOpen, layoutEditing]);

  useEffect(() => {
    if (!snap || !sound || review) return;
    const line = snap.radio.at(-1);
    if (line && line.id > playedRadio.current) { playedRadio.current = line.id; if (line.tone === "warn" || line.seat === "PILOT") audio.current?.play(line.tone === "warn" ? "alert" : "readback"); }
  }, [snap?.radio.at(-1)?.id, sound, review]);

  useEffect(() => {
    if (!session || snap?.status !== "finished" || savedWorld.current === session.world) return;
    savedWorld.current = session.world;
    const movements = snap.score.landings + snap.score.takeoffs;
    const record = { grade: rateShift(snap.score, session.world.level, session.world.mode).grade, points: snap.score.points, movements, violations: snap.score.violations, delaySec: snap.score.totalDelaySec };
    const key = recordKey(session.levelId, session.world.mode, session.world.level.seed);
    setRecords((previous) => {
      const old = previous[key];
      const rank = (grade: string) => "CBAS".indexOf(grade);
      if (old && (rank(old.grade) > rank(record.grade) || rank(old.grade) === rank(record.grade) && (old.points > record.points || old.points === record.points && (old.delaySec ?? Infinity) <= record.delaySec))) return previous;
      const updated = { ...previous, [key]: record }; writeRecords(updated); return updated;
    });
  }, [session, snap?.status]);

  function backToMenu() { setSession(null); setReview(null); reviewRef.current = null; setReviewPlaying(false); setSnap(null); setToast(null); setRouteOpen(false); setHelpOpen(false); setPlanOpen(false); setLayoutEditing(false); }
  function pick(id: string) { const world = activeWorld.current; world?.select(id); if (world) setSnap(world.snapshot()); if (innerWidth <= 760) setCompactPane(null); }
  const selected = snap ? selectedAircraft(snap) : null;
  useLayoutEffect(() => {
    const root = appRef.current, panel = root?.querySelector(review ? ".replay-transport" : ".strip");
    if (!root || !panel) return;
    let frame: number | null = null, measured = -1;
    const measure = () => {
      const height = Math.ceil(panel.getBoundingClientRect().height);
      if (height !== measured) { measured = height; root.style.setProperty("--command-height", `${height}px`); }
    };
    // Defer layout writes out of the observer delivery cycle; stage resizing must not feed back into it.
    const observer = new ResizeObserver(() => { if (frame === null) frame = requestAnimationFrame(() => { frame = null; measure(); }); });
    measure(); observer.observe(panel); return () => { observer.disconnect(); if (frame !== null) cancelAnimationFrame(frame); };
  }, [session, selected?.id, review]);
  function issue(command: Command) {
    const world = activeWorld.current;
    if (!world || reviewRef.current || !world.selectedId) return;
    const ac = world.aircraft.get(world.selectedId); if (!ac) return;
    const result = world.issue(ac.id, command);
    if (!result.ok) { showToast(result.reason, "danger"); audio.current?.play("alert"); }
    else { showToast(`${ac.callsign} · 已发送，等待复诵${result.warning ? ` · ⚠ ${result.warning}` : ""}`, result.warning ? "warning" : "success"); audio.current?.play("command"); }
    setSnap(world.snapshot());
  }
  function changePlan(id: string, action: PlanAction) {
    if (!session) return;
    const result = session.world.changeRunwayPlan(id, action);
    if (!result.ok) showToast(result.reason);
    setSnap(session.world.snapshot());
  }
  function reorderPlan(id: string, targetId: string) {
    if (!session || id === targetId) return;
    const world = session.world, list = world.runwayPlan.snapshot(world);
    const from = list.findIndex((item) => item.aircraftId === id), to = list.findIndex((item) => item.aircraftId === targetId);
    if (from < 0 || to < 0) return;
    for (let i = 0; i < Math.abs(to - from); i++) {
      const result = world.changeRunwayPlan(id, to > from ? "down" : "up");
      if (!result.ok) { showToast(result.reason); break; }
    }
    setSnap(world.snapshot());
  }
  function advance() {
    if (!session || reviewRef.current) return;
    const result = advanceToDecision(session.world);
    if (result.aircraftId) session.world.select(result.aircraftId);
    setPaused(true); setSnap(session.world.snapshot());
    showToast(session.world.status === "finished" ? "本班处理完成，查看调度复盘" : result.operationChanged ? `已推进 ${fmtDuration(result.advanced)}，运行窗口有变化，请检查预告与限制` : result.aircraftId ? result.advanced > .01 ? `已推进 ${fmtDuration(result.advanced)}，请处理新的请求` : "当前已有待办，已选中需要处理的航班" : `已推进 ${fmtDuration(result.advanced)}，暂无新的许可请求`);
  }
  function startInspection(id: string) {
    if (!session || reviewRef.current) return;
    const result = session.world.startInspection(id);
    showToast(result.ok ? "检查已开始。先安排地面与空中等待，倒计时结束后自动恢复。" : result.reason, result.ok ? "success" : "danger");
    setSnap(session.world.snapshot());
  }
  function beginReview() {
    if (!session) return;
    const player = new ReplayPlayer(session.world.exportReplay());
    player.seek(Math.min(player.record.endedAt, 1)); player.world.select(player.world.aircraftList()[0]?.id ?? null);
    reviewRef.current = player; activeWorld.current = player.world; setReview(player); setReviewPlaying(false); setPaused(true); setSnap(player.world.snapshot()); setView("top");
  }
  function seekReview(time: number) {
    if (!review) return;
    const selectedId = review.world.selectedId;
    review.seek(time); review.world.select(selectedId ?? review.world.aircraftList()[0]?.id ?? null);
    activeWorld.current = review.world; setReviewPlaying(false); setSnap(review.world.snapshot());
  }
  function closeReview() { reviewRef.current = null; setReview(null); setReviewPlaying(false); activeWorld.current = session?.world ?? null; if (session) setSnap(session.world.snapshot()); }
  function exportReview() {
    if (!session) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(session.world.exportReplay(), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `kestrel-${session.levelId}-${session.world.level.seed ?? "shift"}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function toggleSound() {
    const value = !sound; audio.current ??= new RadioAudio();
    try { await audio.current.setEnabled(value); setSound(value); } catch { showToast("当前浏览器无法启用提示音"); }
  }
  function changeQuality() {
    const next = quality === "balanced" ? "high" : quality === "high" ? "low" : "balanced";
    setQuality(next); try { localStorage.setItem("kestrel.quality", next); } catch { /* Session preference still applies. */ }
  }
  const next = session ? LEVELS[LEVELS.findIndex((level) => level.id === session.levelId) + 1] : null;

  return <div ref={appRef} className={`app ${session ? "in-session" : "in-menu"} ${review ? "review-mode" : ""} ${selected || review ? "has-selection" : ""} ${focused ? "focus-mode" : ""} focus-${focusPane ?? "none"} compact-${compactPane ?? "none"}`}><div className="stage" ref={stageRef} /><div className="labels" ref={labelsRef} />
    {session && snap && world && <>
      <TopBar readOnly={!!review} onSafety={() => { const nextMode: SafetyMode = world.safetyMode === "guarded" ? "consequence" : "guarded"; if (world.setSafetyMode(nextMode).ok) { setSafetyMode(nextMode); try { localStorage.setItem("kestrel.safety", nextMode); } catch {} setSnap(world.snapshot()); } }} snap={snap} paused={review ? !reviewPlaying : paused} speed={speed} view={view} onPause={() => review ? setReviewPlaying((value) => !value) : setPaused((value) => !value)} onSpeed={setSpeed} onView={(value) => { setView(value); sceneRef.current?.setView(value); }} onBack={backToMenu} onHelp={openHelp} editing={layoutEditing} onLayout={() => { setFocused(false); setFocusPane(null); setLayoutEditing((value) => !value); }} onReset={() => { setLayoutEditing(false); setLayoutReset((value) => value + 1); }} onAdvance={advance} canAdvance={!review && snap.status === "running" && decisionFlights(world).length === 0} sound={sound} onSound={() => void toggleSound()} quality={({ low: "节能", balanced: "均衡", high: "精细" })[quality]} onQuality={changeQuality} focused={focused} onFocus={() => { setFocused((value) => !value); setFocusPane(null); setLayoutEditing(false); }} />
      <div className="scene-caption"><span className="live-dot" />{review ? "REPLAY" : "LIVE"} / {view === "follow" && !selected ? "选机后跟随" : ({ tower: "机场总览", follow: "航班跟随", top: "地面态势" })[view]}<span>KEKS · {world.level.name}</span></div>
      {focused && <div className="scene-tools" aria-label="场景工具">{[["ground", "地面"], ["radar", "雷达"], ["radio", "无线电"]].map(([id, label]) => <button key={id} className={focusPane === id ? "on" : ""} aria-expanded={focusPane === id} onClick={() => setFocusPane((value) => value === id ? null : id!)}>{label}</button>)}<span>V 恢复工作台</span></div>}
      <Operations world={world} snap={snap} onPick={pick} onPlan={review ? () => {} : openPlan} onInspect={startInspection} readOnly={!!review} focusToken={operationFocus} /><WorkspaceWindow id="flights" editing={layoutEditing} resetToken={layoutReset}><FlightList world={world} snap={snap} onPick={pick} /></WorkspaceWindow>
      <div className={`workbench ${selected || review ? "with-selection" : ""}`}>
        <WorkspaceWindow id="ground" editing={layoutEditing} resetToken={layoutReset}><GroundMap world={world} snap={snap} onPick={pick} onOpenRoute={review ? () => {} : openRoute} /></WorkspaceWindow>
        <WorkspaceWindow id="radar" editing={layoutEditing} resetToken={layoutReset}><Radar world={world} snap={snap} onPick={pick} /></WorkspaceWindow>
        <WorkspaceWindow id="radio" editing={layoutEditing} resetToken={layoutReset}><RadioLog snap={snap} baseClock={world.level.startClockMin} /></WorkspaceWindow>
      </div>
      <nav className="mobile-navigation" aria-label="工作台面板">{[["flights", "航班"], ["radar", "雷达"], ["ground", "地面"], ["radio", "无线电"]].map(([id, label]) => <button key={id} className={compactPane === id ? "on" : ""} aria-pressed={compactPane === id} onClick={() => setCompactPane((current) => current === id ? null : id!)}>{label}</button>)}{snap.operations.length > 0 && <button className={`mobile-operations ${compactPane === "operations" ? "on" : ""} ${snap.operations.some((event) => event.stage === "active" || event.stage === "announced" || event.stage === "pending") ? "has-event" : ""}`} aria-controls="operation-board" aria-pressed={compactPane === "operations"} onClick={() => { setCompactPane("operations"); setOperationFocus((value) => value + 1); }}>运行<small>{snap.operations.filter((event) => event.stage === "active" || event.stage === "announced" || event.stage === "pending").length || "·"}</small></button>}</nav>
      {!review && (selected ? <CommandStrip ac={selected} world={world} options={world.commandOptions(selected)} onCmd={issue} onPlanRoute={openRoute} /> : <div className="hint">选择航班开始调度 · <kbd>N</kbd> 下个待办 · <kbd>Tab</kbd> 切换航班</div>)}
      {!selected && !review && <ShiftGoals snap={snap} world={world} />}
      {!review && paused && snap.status === "running" && !routeOpen && !helpOpen && !planOpen && <div className="pause-banner"><b>已暂停</b><span>{session.world.level.lesson ? "高亮按钮是当前下一步；E 下达，N 选择待办。" : "可以下达指令、预览路线和安排顺序。"}</span><button onClick={() => setPaused(false)}>继续值班</button></div>}
      {routeOpen && <RouteEditor world={session.world} snap={snap} onPick={pick} onClose={closeOverlay} onCmd={issue} />}
      {helpOpen && <Help onClose={closeOverlay} />}
      {planOpen && <RunwayPlan world={session.world} snap={snap} onClose={closeOverlay} onPick={pick} onChange={changePlan} onReorder={reorderPlan} />}
      {review && <ReplayTransport record={review.record} time={snap.time} playing={reviewPlaying} onPlay={() => { if (review.ended) seekReview(0); setReviewPlaying((value) => !value); }} onSeek={seekReview} onClose={closeReview} />}
      {!review && snap.status !== "running" && <Result world={session.world} snap={snap} onRestart={() => start(levelId)} onMenu={backToMenu} onNext={next && snap.status !== "failed" ? () => start(next.id) : undefined} onReplay={beginReview} onExport={exportReview} />}
    </>}
    {!session && <StartScreen levelId={levelId} mode={mode} records={records} seed={challengeSeed} onSeed={setChallengeSeed} onNewSeed={() => setChallengeSeed(`KEKS-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36).toUpperCase()}`)} onNormalizeSeed={() => setChallengeSeed(normalizeChallengeSeed(challengeSeed))} onPick={setLevelId} onMode={setMode} onStart={() => start(levelId)} />}
    {toast && <div className={`toast ${toastTone}`} role={toastTone === "danger" ? "alert" : "status"}>{toast}</div>}
  </div>;
}
