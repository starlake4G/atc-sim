/**
 * HUD —— 顶部状态栏：分数、容量、流量、风、倍速与视角切换
 */

import type { World } from '../sim/world';
import { worldStats } from '../sim/world';
import { rankLabel } from '../sim/score';

export type ViewMode = 'radar' | 'tower' | 'follow';

function chip(label: string, cls: string): HTMLElement {
  const c = document.createElement('span');
  c.className = `hud-chip ${cls}`;
  c.textContent = `${label} 0`;
  return c;
}

export interface HudCallbacks {
  onTimeScale: (scale: number) => void;
  onTogglePause: () => void;
  onViewChange: (mode: ViewMode) => void;
  onResetView: () => void;
}

export class Hud {
  private world: World;
  private cb: HudCallbacks;
  private root: HTMLElement;

  private scoreEl: HTMLElement;
  private rankEl: HTMLElement;
  private timeEl: HTMLElement;
  private trafficEl: HTMLElement;
  private windEl: HTMLElement;
  private chipLanding: HTMLElement;
  private chipDeparted: HTMLElement;
  private chipYellow: HTMLElement;
  private chipRed: HTMLElement;
  private alertEl: HTMLElement;
  private viewButtons = new Map<ViewMode, HTMLElement>();
  private speedButtons = new Map<number, HTMLElement>();
  private pauseBtn: HTMLElement;

  private currentView: ViewMode = 'radar';

  constructor(world: World, cb: HudCallbacks) {
    this.world = world;
    this.cb = cb;

    this.root = document.createElement('div');
    this.root.className = 'hud';

    // ---- 左：分数 ----
    const left = document.createElement('div');
    left.className = 'hud-group';
    this.scoreEl = document.createElement('span');
    this.scoreEl.className = 'hud-score';
    this.rankEl = document.createElement('span');
    this.rankEl.className = 'hud-rank';
    left.append(this.scoreEl, this.rankEl);

    // ---- 中：状态 ----
    const mid = document.createElement('div');
    mid.className = 'hud-group';
    this.timeEl = document.createElement('span');
    this.trafficEl = document.createElement('span');
    this.windEl = document.createElement('span');
    // 计分牌：落地 / 起飞 / 黄牌 / 红牌（对标《机场管制27》顶部计数）
    this.chipLanding = chip('落地', 'good');
    this.chipDeparted = chip('起飞', 'good');
    this.chipYellow = chip('黄牌', 'yellow');
    this.chipRed = chip('红牌', 'red');
    mid.append(
      this.timeEl,
      this.trafficEl,
      this.windEl,
      this.chipLanding,
      this.chipDeparted,
      this.chipYellow,
      this.chipRed,
    );

    // ---- 右：控制 ----
    const right = document.createElement('div');
    right.className = 'hud-group';

    for (const s of [1, 2, 4]) {
      const b = document.createElement('button');
      b.className = 'hud-btn';
      b.textContent = `${s}×`;
      b.addEventListener('click', () => this.cb.onTimeScale(s));
      this.speedButtons.set(s, b);
      right.append(b);
    }

    this.pauseBtn = document.createElement('button');
    this.pauseBtn.className = 'hud-btn';
    this.pauseBtn.textContent = '暂停';
    this.pauseBtn.addEventListener('click', () => this.cb.onTogglePause());
    right.append(this.pauseBtn);

    const sep = document.createElement('span');
    sep.className = 'hud-sep';
    right.append(sep);

    const views: [ViewMode, string][] = [
      ['radar', '雷达'],
      ['tower', '塔台'],
      ['follow', '跟随'],
    ];
    for (const [mode, label] of views) {
      const b = document.createElement('button');
      b.className = 'hud-btn';
      b.textContent = label;
      b.addEventListener('click', () => {
        this.currentView = mode;
        this.cb.onViewChange(mode);
      });
      this.viewButtons.set(mode, b);
      right.append(b);
    }

    this.root.append(left, mid, right);

    // ---- 告警条 ----
    this.alertEl = document.createElement('div');
    this.alertEl.className = 'hud-alert';
    this.alertEl.style.display = 'none';
  }

  mount(parent: HTMLElement): void {
    parent.append(this.root, this.alertEl);
  }

  unmount(): void {
    this.root.remove();
    this.alertEl.remove();
  }

  /** 外部切换视角时同步按钮状态 */
  setView(mode: ViewMode): void {
    this.currentView = mode;
  }

  update(): void {
    const w = this.world;
    const st = worldStats(w);

    this.scoreEl.textContent = String(st.score);
    this.rankEl.textContent = rankLabel(st.score);

    const mm = Math.floor(st.time / 60);
    const ss = Math.floor(st.time % 60);
    this.timeEl.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    this.trafficEl.textContent = `空中 ${st.airborne} · 地面 ${st.onGround} · 在场 ${st.trafficLoaded}/${st.spawnCeiling} · 容量 ${st.capacity}`;
    this.windEl.textContent = `风 ${String(Math.round(st.windDir)).padStart(3, '0')}° / ${st.windSpeedKt.toFixed(0)} kt`;
    this.chipLanding.textContent = `落地 ${st.landings}`;
    this.chipDeparted.textContent = `起飞 ${st.departuresDone}`;
    this.chipYellow.textContent = `黄牌 ${st.yellow}`;
    this.chipRed.textContent = `红牌 ${st.red}`;

    for (const [s, btn] of this.speedButtons) {
      btn.classList.toggle('active', w.timeScale === s && !w.paused);
    }
    this.pauseBtn.classList.toggle('active', w.paused);
    this.pauseBtn.textContent = w.paused ? '继续' : '暂停';

    for (const [mode, btn] of this.viewButtons) {
      btn.classList.toggle('active', mode === this.currentView);
    }

    // 告警
    if (w.paused) {
      this.alertEl.style.display = 'none';
    } else if (st.conflicts > 0) {
      const worst = st.worstConflict;
      this.alertEl.style.display = 'block';
      this.alertEl.className =
        'hud-alert ' +
        (worst === 'LOSS' ? 'alert-loss' : worst === 'CRITICAL' ? 'alert-crit' : 'alert-pred');
      this.alertEl.textContent =
        worst === 'LOSS'
          ? `失去间隔！${st.conflicts} 对冲突`
          : worst === 'CRITICAL'
            ? `严重冲突 ${st.conflicts} 对`
            : `预测冲突 ${st.conflicts} 对`;
    } else {
      this.alertEl.style.display = 'none';
      // 最近一条日志用作提示
      const last = w.log[w.log.length - 1];
      if (last && w.time - last.t < 6) {
        this.alertEl.style.display = 'block';
        this.alertEl.className = 'hud-alert ' + (last.kind === 'bad' ? 'alert-crit' : last.kind === 'good' ? 'alert-ok' : 'alert-info');
        this.alertEl.textContent = last.text;
      }
    }
  }
}
