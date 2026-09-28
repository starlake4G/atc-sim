/**
 * Aurora Approach —— 入口
 *
 * 组装：世界模型 + 视图层 + 指令层。渲染循环只负责把真实经过时间喂给世界，
 * 其余全部由定步长 tick 驱动。
 */

import './styles.css';
import { AIRPORT } from './data/airports/aurora';
import { createWorld, stepWorld, selectedAircraft, commandAircraft } from './sim/world';
import { RadarView } from './views/radar';
import { SceneView } from './views/scene';
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

// ---------------------------------------------------------------- 布局

const shell = document.createElement('div');
shell.className = 'shell';

const viewHost = document.createElement('div');
viewHost.className = 'radar-host';

const sidebar = document.createElement('div');
sidebar.className = 'sidebar';

shell.append(viewHost, sidebar);
app.append(shell);

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

let currentView: ViewMode = 'radar';

radar.mount(viewHost);
scene.mount(viewHost);
scene.setVisible(false);

// 指令条浮动在视图层之上（两个视角共用），飞机列表与电台记录放侧栏
const commandBar = new CommandBar(world);
commandBar.mount(viewHost);

const aircraftList = new AircraftList(world);
aircraftList.mount(sidebar);

const radioLog = new RadioLog(world);
radioLog.mount(sidebar);

const hud = new Hud(world, {
  onTimeScale: (s) => {
    world.timeScale = s;
    world.paused = false;
  },
  onTogglePause: () => {
    world.paused = !world.paused;
  },
  onViewChange: (mode) => setView(mode),
  onResetView: () => {
    if (currentView === 'radar') radar.resetView();
  },
});
hud.mount(app);

function setView(mode: ViewMode): void {
  currentView = mode;
  hud.setView(mode);
  radar.setVisible(mode === 'radar');
  scene.setVisible(mode !== 'radar');
  if (mode !== 'radar') scene.setMode(mode === 'tower' ? 'tower' : 'follow');
}

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
      if (currentView === 'radar') radar.resetView();
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

// 支持 ?view=tower / ?view=follow 直接进入指定视角（调试与分享用）
{
  const params = new URLSearchParams(location.search);
  const v = params.get('view');
  if (v === 'tower' || v === 'follow') {
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
  __hud: hud,
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
