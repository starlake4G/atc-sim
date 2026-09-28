/**
 * Aurora Approach —— 入口
 *
 * 组装：世界模型 + 视图层 + 指令层。渲染循环只负责把真实经过时间喂给世界，
 * 其余全部由定步长 tick 驱动。
 *
 * 主舞台固定 16:9，3D 视景是主视图（塔台 / 跟机），雷达屏缩成舞台内的方形小窗，
 * 需要精确引导时用 F1 把雷达放大成全屏。
 */

import './styles.css';
import { AIRPORT } from './data/airports/aurora';
import { createWorld, stepWorld, selectedAircraft, commandAircraft } from './sim/world';
import { RadarView } from './views/radar';
import { SceneView } from './views/scene';
import { STAGE_H, STAGE_W, setStageScale } from './views/stage';
import { CommandBar } from './ui/commands';
import { AircraftList } from './ui/list';
import { RadioLog } from './ui/radio';
import { Hud, type ViewMode } from './ui/hud';

const app = document.getElementById('app');
if (!app) throw new Error('缺少 #app 容器');

const world = createWorld({
  airport: AIRPORT,
  windDirection: 195,
  windSpeed: 8,
  seed: 20260927,
});

// ---------------------------------------------------------------- 16:9 舞台

const stage = document.createElement('div');
stage.className = 'stage';

const viewLayer = document.createElement('div');
viewLayer.className = 'stage-view mode-3d';

const radarHost = document.createElement('div');
radarHost.className = 'radar-host';

const side = document.createElement('div');
side.className = 'side';

stage.append(viewLayer, side);
app.append(stage);

// ---------------------------------------------------------------- 视图

const radar = new RadarView(AIRPORT, {
  onSelect: (id) => {
    world.selectedId = id;
  },
});

const scene = new SceneView(AIRPORT, {
  onSelect: (id) => {
    world.selectedId = id;
  },
});

// 挂载顺序即叠放顺序：3D 铺满 → 雷达小窗 → 指令条
scene.mount(viewLayer);
radar.mount(radarHost);
viewLayer.append(radarHost);

const commandBar = new CommandBar(world);
commandBar.mount(viewLayer);

const aircraftList = new AircraftList(world);
aircraftList.mount(side);

const radioLog = new RadioLog(world);
radioLog.mount(side);

const hud = new Hud(world, {
  onTimeScale: (s) => {
    world.timeScale = s;
    world.paused = false;
  },
  onTogglePause: () => {
    world.paused = !world.paused;
  },
  onViewChange: (mode) => setView(mode),
  onResetView: () => resetView(),
});
hud.mount(stage);

/** 3D 主视图下雷达小窗是否露出 */
let radarInset = true;
let currentView: ViewMode = 'tower';

function setView(mode: ViewMode): void {
  currentView = mode;
  hud.setView(mode);
  const is3d = mode !== 'radar';
  viewLayer.classList.toggle('mode-3d', is3d);
  viewLayer.classList.toggle('mode-radar', !is3d);
  scene.setVisible(is3d);
  radar.setVisible(is3d ? radarInset : true);
  if (is3d) scene.setMode(mode === 'tower' ? 'tower' : 'follow');
}

function resetView(): void {
  if (currentView === 'radar' || radarInset) radar.resetView();
  if (currentView === 'tower') scene.setMode('tower');
}

/**
 * 舞台缩放：1600×900 虚拟分辨率整体 scale 到窗口内，比例恒定 16:9。
 * 缩放比要先写进 stage.ts，再让两个视图重建后备缓冲，否则放大档位下发虚。
 */
function fitStage(): void {
  const s = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
  setStageScale(s);
  stage.style.transform = `scale(${s})`;
  radar.rescale();
  scene.rescale();
}

window.addEventListener('resize', fitStage);
fitStage();

setView('tower');

// ---------------------------------------------------------------- 键盘

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  switch (e.key) {
    case ' ':
      e.preventDefault();
      world.paused = !world.paused;
      break;
    case '1':
      world.timeScale = 1;
      world.paused = false;
      break;
    case '2':
      world.timeScale = 2;
      world.paused = false;
      break;
    case '4':
      world.timeScale = 4;
      world.paused = false;
      break;
    case 'Escape':
      world.selectedId = null;
      break;
    case 'r':
    case 'R':
      resetView();
      break;
    case 'm':
    case 'M':
      radarInset = !radarInset;
      viewLayer.classList.toggle('hide-radar', !radarInset);
      radar.setVisible(currentView === 'radar' || radarInset);
      break;
    case 'Tab':
      e.preventDefault();
      cycleSelection();
      break;
    case 'F1':
      e.preventDefault();
      setView('radar');
      break;
    case 'F2':
      e.preventDefault();
      setView('tower');
      break;
    case 'F3':
      e.preventDefault();
      setView('follow');
      break;
  }
});

function cycleSelection(): void {
  if (world.aircraft.length === 0) {
    world.selectedId = null;
    return;
  }
  const ids = world.aircraft.map((a) => a.id);
  const idx = world.selectedId === null ? -1 : ids.indexOf(world.selectedId);
  world.selectedId = ids[(idx + 1) % ids.length];
}

// ---------------------------------------------------------------- 主循环

let last = performance.now();

function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;

  stepWorld(world, dt);

  radar.update(world);
  scene.update(world);
  commandBar.update();
  aircraftList.update();
  radioLog.update();
  hud.update();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// 支持 ?view=radar|tower|follow 直接进入指定视角（调试与分享用）
{
  const params = new URLSearchParams(location.search);
  const v = params.get('view');
  if (v === 'radar' || v === 'tower' || v === 'follow') {
    // 跟机视角必须有一架选中飞机，没选就自动选第一架
    if (v === 'follow' && world.selectedId === null && world.aircraft.length > 0) {
      world.selectedId = world.aircraft[0].id;
    }
    setView(v);
  }
}

// 便于在控制台调试与自动化验证（rAF 被挂起时可同步驱动）
Object.assign(window as unknown as Record<string, unknown>, {
  __world: world,
  __scene: scene,
  __radar: radar,
  __hud: hud,
  __stage: stage,
  __setView: setView,
  __command: (id: number, cmd: unknown) => commandAircraft(world, id, cmd as never),
  __selected: () => selectedAircraft(world),
  __step(seconds: number): void {
    stepWorld(world, seconds);
    radar.update(world);
    scene.update(world);
    commandBar.update();
    aircraftList.update();
    radioLog.update();
    hud.update();
  },
});
