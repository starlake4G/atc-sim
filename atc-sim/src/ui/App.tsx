import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_LEVEL_ID, LEVELS, getLevel } from "../data/levels";
import { distanceToThreshold } from "../sim/airport";
import { botTick } from "../sim/bot";
import type { Aircraft, SimState } from "../sim/types";
import { TIME_SCALE, TICK, World } from "../sim/world";
import { Scene3D, type ViewMode } from "../views/scene3d";
import { fmtAlt, fmtClock, fmtDist, fmtHdg, fmtSpd, gradeFor, phaseLabel } from "../format";

interface Session {
  world: World;
  levelId: string;
}

const SPEEDS = [1, 2, 4];
const VIEW_LABEL: Record<ViewMode, string> = { tower: "塔台", follow: "跟机", top: "俯瞰" };

export default function App() {
  const [levelId, setLevelId] = useState(DEFAULT_LEVEL_ID);
  const [session, setSession] = useState<Session | null>(null);
  const [snap, setSnap] = useState<SimState | null>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<ViewMode>("tower");
  const [toast, setToast] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const pausedRef = useRef(paused);
  const speedRef = useRef(speed);
  const viewRef = useRef(view);
  const toastTimer = useRef<number | null>(null);

  pausedRef.current = paused;
  speedRef.current = speed;
  viewRef.current = view;

  const showToast = (text: string) => {
    setToast(text);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  };

  function start(id: string) {
    const lvl = getLevel(id);
    setLevelId(id);
    setSession({ world: new World(lvl), levelId: id });
    setSnap(null);
    setPaused(false);
    setSpeed(1);
    setView("tower");
  }

  // 调试/截图入口：?level=morning-rush&fast=540&bot=1 直接进入指定进度
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("level");
    if (!id) return;
    const lvl = getLevel(id);
    const w = new World(lvl);
    const fast = Number(q.get("fast") ?? "0");
    if (fast > 0) {
      const useBot = q.get("bot") === "1";
      const n = Math.floor(fast / TICK);
      for (let i = 0; i < n; i++) {
        w.step();
        if (useBot && i % 20 === 0) botTick(w);
      }
    }
    setLevelId(id);
    setSession({ world: w, levelId: id });
    const v = q.get("view");
    if (v === "tower" || v === "follow" || v === "top") setView(v);
  }, []);

  function restart() {
    start(levelId);
  }

  function backToMenu() {
    sceneRef.current?.dispose();
    sceneRef.current = null;
    setSession(null);
    setSnap(null);
  }

  // 3D 场景随 session 创建
  useEffect(() => {
    if (!session || !stageRef.current || !labelsRef.current) return;
    const scene = new Scene3D(stageRef.current, labelsRef.current, session.world, (id) => {
      session.world.select(id);
      setSnap(session.world.snapshot());
    }, { shadows: !new URLSearchParams(window.location.search).has("lite") });
    sceneRef.current = scene;
    scene.start();
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, [session]);

  // 主循环：定步长推进 + 自由帧率渲染
  useEffect(() => {
    if (!session) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let lastUi = 0;
    const w = session.world;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const realDt = Math.min(0.25, (now - last) / 1000);
      last = now;

      if (!pausedRef.current && w.status === "running") {
        acc += realDt * TIME_SCALE * speedRef.current;
        let steps = 0;
        while (acc >= TICK && steps < 80) {
          w.step();
          acc -= TICK;
          steps += 1;
        }
        if (steps >= 80) acc = 0;
      }

      sceneRef.current?.update(w, realDt, viewRef.current, w.selectedId, w.selectedId);
      if (now - lastUi > 100) {
        lastUi = now;
        setSnap(w.snapshot());
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [session]);

  // 键盘
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      const w = session.world;
      if (e.code === "Space") {
        e.preventDefault();
        setPaused((p) => !p);
      } else if (e.key === "1") setSpeed(1);
      else if (e.key === "2") setSpeed(2);
      else if (e.key === "4") setSpeed(4);
      else if (e.key === "F1") {
        e.preventDefault();
        setView("tower");
      } else if (e.key === "F2") {
        e.preventDefault();
        setView("follow");
      } else if (e.key === "F3") {
        e.preventDefault();
        setView("top");
      } else if (e.key === "Tab") {
        e.preventDefault();
        const list = w.aircraftList();
        if (list.length === 0) return;
        const i = list.findIndex((a) => a.id === w.selectedId);
        const next = list[(i + 1) % list.length]!;
        w.select(next.id);
        setSnap(w.snapshot());
      } else if (e.key === "Escape") {
        w.select(null);
        setSnap(w.snapshot());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session]);

  const selected = useMemo(() => {
    if (!snap || !snap.selectedId) return null;
    return snap.aircraft.find((a) => a.id === snap.selectedId) ?? null;
  }, [snap]);

  const issue = (cmd: Parameters<World["issue"]>[1]) => {
    if (!session || !selected) return;
    const res = session.world.issue(selected.id, cmd);
    if (!res.ok) showToast(res.reason);
    setSnap(session.world.snapshot());
  };

  return (
    <div className="app">
      <div className="stage" ref={stageRef} />
      <div className="labels" ref={labelsRef} />

      {session && snap && (
        <>
          <TopBar
            snap={snap}
            paused={paused}
            speed={speed}
            view={view}
            onPause={() => setPaused((p) => !p)}
            onSpeed={setSpeed}
            onView={(v) => {
              setView(v);
              sceneRef.current?.setView(v);
            }}
            onBack={backToMenu}
          />
          <FlightList snap={snap} world={session.world} onPick={(id) => {
            session.world.select(id);
            setSnap(session.world.snapshot());
          }} />
          <RadioLog snap={snap} baseClock={session.world.level.startClockMin} />
          <GroundMap world={session.world} snap={snap} />
          {selected && (
            <CommandStrip
              ac={selected}
              snap={snap}
              distM={distanceToThreshold(session.world.idx, selected.pos)}
              options={session.world.commandOptions(selected)}
              onCmd={issue}
            />
          )}
          {!selected && <div className="hint">点击飞机或列表选择航班 · Tab 循环选择</div>}
          {snap.status === "finished" && (
            <Result
              snap={snap}
              onRestart={restart}
              onMenu={backToMenu}
            />
          )}
        </>
      )}

      {!session && <StartScreen levelId={levelId} onPick={setLevelId} onStart={() => start(levelId)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function TopBar(props: {
  snap: SimState;
  paused: boolean;
  speed: number;
  view: ViewMode;
  onPause: () => void;
  onSpeed: (n: number) => void;
  onView: (v: ViewMode) => void;
  onBack: () => void;
}) {
  const { snap } = props;
  const movements = snap.score.landings + snap.score.takeoffs;
  return (
    <div className="topbar">
      <button className="ghost" onClick={props.onBack} title="返回关卡选择">退出</button>
      <div className="clock">{fmtClock(snap.clockMin)}</div>
      <div className="stat"><b>{snap.score.landings}</b><span>落地</span></div>
      <div className="stat"><b>{snap.score.takeoffs}</b><span>起飞</span></div>
      <div className="stat"><b>{movements}/{snap.movementsTarget}</b><span>目标</span></div>
      <div className={`stat ${snap.score.violations > 0 ? "bad" : ""}`}><b>{snap.score.violations}</b><span>违规</span></div>
      <div className="spacer" />
      <button className="ghost" onClick={props.onPause}>{props.paused ? "继续" : "暂停"}</button>
      {SPEEDS.map((s) => (
        <button key={s} className={`ghost ${props.speed === s ? "on" : ""}`} onClick={() => props.onSpeed(s)}>{s}×</button>
      ))}
      {(Object.keys(VIEW_LABEL) as ViewMode[]).map((v) => (
        <button key={v} className={`ghost ${props.view === v ? "on" : ""}`} onClick={() => props.onView(v)}>{VIEW_LABEL[v]}</button>
      ))}
    </div>
  );
}

function FlightList({ snap, world, onPick }: { snap: SimState; world: World; onPick: (id: string) => void }) {
  const arrivals = snap.aircraft.filter((a) => a.kind === "arr");
  const departures = snap.aircraft.filter((a) => a.kind === "dep");
  const sortArr = [...arrivals].sort((a, b) => distanceToThreshold(world.idx, a.pos) - distanceToThreshold(world.idx, b.pos));
  return (
    <div className="panel flights">
      <div className="panel-title">航班 <span>{snap.aircraft.length}</span></div>
      <div className="group-label">进场</div>
      {sortArr.length === 0 && <div className="empty">暂无</div>}
      {sortArr.map((ac) => (
        <FlightRow key={ac.id} ac={ac} world={world} selected={snap.selectedId === ac.id} onPick={onPick} />
      ))}
      <div className="group-label">离场</div>
      {departures.length === 0 && <div className="empty">暂无</div>}
      {departures.map((ac) => (
        <FlightRow key={ac.id} ac={ac} world={world} selected={snap.selectedId === ac.id} onPick={onPick} />
      ))}
    </div>
  );
}

function FlightRow({ ac, world, selected, onPick }: { ac: Aircraft; world: World; selected: boolean; onPick: (id: string) => void }) {
  const conflict = world.conflicts.some((c) => c.split("|").includes(ac.id));
  const right = ac.kind === "arr" ? fmtDist(distanceToThreshold(world.idx, ac.pos)) : fmtAlt(ac.altM);
  return (
    <button className={`row ${selected ? "sel" : ""} ${conflict ? "conflict" : ""}`} onClick={() => onPick(ac.id)}>
      <span className="cs">{ac.callsign}</span>
      <span className="ty">{ac.typeId}</span>
      <span className="ph">{phaseLabel(ac)}</span>
      <span className="rt">{right}</span>
    </button>
  );
}

function RadioLog({ snap, baseClock }: { snap: SimState; baseClock: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [snap.radio.length]);
  return (
    <div className="panel radio">
      <div className="panel-title">无线电 <span>118.1</span></div>
      <div className="radio-body" ref={ref}>
        {snap.radio.map((line) => (
          <div key={line.id} className={`line ${line.tone}`}>
            <span className="t">{fmtClock(baseClock + Math.floor(line.t / 60))}</span>
            <span className="from">{line.seat}</span>
            <span className="txt">{line.callsign !== "—" ? `${line.callsign} ` : ""}{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommandStrip({ ac, snap, distM, options, onCmd }: {
  ac: Aircraft;
  snap: SimState;
  distM: number;
  options: ReturnType<World["commandOptions"]>;
  onCmd: (cmd: Parameters<World["issue"]>[1]) => void;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, typeof options>();
    for (const o of options) {
      const arr = m.get(o.group) ?? [];
      arr.push(o);
      m.set(o.group, arr);
    }
    return [...m.entries()];
  }, [options]);

  const runwayBusy = snap.runwayOccupant !== null && snap.runwayOccupant !== ac.id;

  return (
    <div className="strip">
      <div className="strip-info">
        <div className="strip-head">
          <b>{ac.callsign}</b>
          <span>{ac.typeId}</span>
          <span className="phase">{phaseLabel(ac)}</span>
          {runwayBusy && <span className="busy">跑道被占</span>}
        </div>
        <div className="strip-metrics">
          <Metric label="高度" value={fmtAlt(ac.altM)} />
          <Metric label="地速" value={`${fmtSpd(ac.gs)}kt`} />
          <Metric label="航向" value={fmtHdg(ac.hdg)} />
          <Metric label="距场" value={fmtDist(distM)} />
        </div>
      </div>
      <div className="strip-cmds">
        {options.length === 0 && <span className="none">暂无可用指令</span>}
        {groups.map(([g, list]) => (
          <div className="cmd-group" key={g}>
            <span className="gname">{g}</span>
            {list.map((o) => (
              <button key={o.key} className={`cmd ${o.tone ?? ""}`} onClick={() => onCmd(o.command)}>{o.label}</button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function GroundMap({ world, snap }: { world: World; snap: SimState }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    const W = 236;
    const H = 132;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "#0e1014";
    g.fillRect(0, 0, W, H);

    const idx = world.idx;
    const sx = (W - 16) / 2700;
    const sy = (H - 12) / 800;
    const s = Math.min(sx, sy);
    const px = (x: number) => W / 2 + x * s;
    const py = (y: number) => H / 2 - (y - 250) * s;

    g.strokeStyle = "#3a424c";
    g.lineWidth = 3;
    const runway = idx.runway;
    g.beginPath();
    g.moveTo(px(runway.threshold.x), py(0));
    g.lineTo(px(runway.end.x), py(0));
    g.stroke();

    g.strokeStyle = "#2b3138";
    g.lineWidth = 1.4;
    for (const e of idx.def.edges) {
      const a = idx.nodes.get(e.a);
      const b = idx.nodes.get(e.b);
      if (!a || !b) continue;
      g.beginPath();
      g.moveTo(px(a.pos.x), py(a.pos.y));
      g.lineTo(px(b.pos.x), py(b.pos.y));
      g.stroke();
    }

    g.fillStyle = "#4a525c";
    for (const st of idx.def.stands) {
      g.fillRect(px(st.pos.x) - 1.5, py(st.pos.y) - 1.5, 3, 3);
    }

    for (const ac of snap.aircraft) {
      const hot = snap.conflicts.some((x) => x.split("|").includes(ac.id));
      g.fillStyle = hot ? "#e24b4a" : ac.id === snap.selectedId ? "#ffffff" : "#7fe3e0";
      g.beginPath();
      g.arc(px(ac.pos.x), py(ac.pos.y), ac.id === snap.selectedId ? 3 : 2, 0, Math.PI * 2);
      g.fill();
    }

    g.fillStyle = "#6b7480";
    g.font = "9px ui-monospace, monospace";
    g.fillText("地面图", 6, 11);
  }, [world, snap]);
  return <canvas className="panel map" ref={ref} style={{ width: 236, height: 132 }} />;
}

function StartScreen({ levelId, onPick, onStart }: { levelId: string; onPick: (id: string) => void; onStart: () => void }) {
  return (
    <div className="overlay">
      <div className="modal">
        <div className="brand">KESTREL APPROACH</div>
        <div className="sub">机场管制模拟 · 塔台席位</div>
        <div className="cards">
          {LEVELS.map((lvl) => (
            <button key={lvl.id} className={`card ${levelId === lvl.id ? "sel" : ""}`} onClick={() => onPick(lvl.id)}>
              <div className="card-name">{lvl.name}</div>
              <div className="card-meta">
                {lvl.durationMin} 分钟 · {lvl.flights.length} 个航班 · 目标 {lvl.targetMovements} 架次
              </div>
              <div className="card-meta">跑道 {lvl.runwayId} · 风 {lvl.wind.dirDeg}° {lvl.wind.speedKt}kt</div>
            </button>
          ))}
        </div>
        <button className="primary" onClick={onStart}>开始值班</button>
        <div className="help">
          选中飞机后，底部指令条会给出当前阶段可用的管制用语。<br />
          进场：下高度 → 清 ILS → 可以落地 → 选脱离口。<br />
          离场：推出 → 自动滑行 → 跑道外等待 → 可以起飞。<br />
          空格暂停 · 1/2/4 倍速 · F1 塔台 / F2 跟机 / F3 俯瞰 · Tab 切换飞机
        </div>
      </div>
    </div>
  );
}

function Result({ snap, onRestart, onMenu }: { snap: SimState; onRestart: () => void; onMenu: () => void }) {
  const movements = snap.score.landings + snap.score.takeoffs;
  const { grade, note } = gradeFor(movements, snap.movementsTarget, snap.score.violations);
  return (
    <div className="overlay">
      <div className="modal result">
        <div className="grade">{grade}</div>
        <div className="sub">{note}</div>
        <div className="result-grid">
          <Metric label="落地" value={String(snap.score.landings)} />
          <Metric label="起飞" value={String(snap.score.takeoffs)} />
          <Metric label="违规" value={String(snap.score.violations)} />
          <Metric label="目标" value={`${movements}/${snap.movementsTarget}`} />
        </div>
        <div className="row-btns">
          <button className="primary" onClick={onRestart}>再值一班</button>
          <button className="ghost" onClick={onMenu}>选择关卡</button>
        </div>
      </div>
    </div>
  );
}
