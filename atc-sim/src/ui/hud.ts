/**
 * HUD —— 顶部状态栏：分数、容量、流量、风、倍速与视角切换
 */

import type { World } from '../sim/world';
import { worldStats } from '../sim/world';
import { rankLabel } from '../sim/score';
import { clockString } from '../sim/clock';

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
  private chipStreak: HTMLElement;
  private alertEl: HTMLElement;
  private viewButtons = new Map<ViewMode, HTMLElement>();
  private speedButtons = new Map<number, HTMLElement>();
  private pauseBtn: HTMLElement;

  private currentView: ViewMode = 'radar';

  /** 舞台浮层宿主（分数弹字要贴着画面中心，不是贴着文档） */
  private popHost: HTMLElement | null = null;
  private lastEventCount = 0;
  private lastCapacity: number | null = null;
  private lastYellow = 0;
  private lastRed = 0;

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
    this.chipStreak = chip('连击', 'streak');
    mid.append(
      this.timeEl,
      this.trafficEl,
      this.windEl,
      this.chipLanding,
      this.chipDeparted,
      this.chipStreak,
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
    this.popHost = parent;
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

    // 游戏内钟表（1 现实分钟 = 1 游戏小时）：比"开局第几分第几秒"更能让人
    // 把天黑、开灯、班次这些因果串起来
    this.timeEl.textContent = clockString(st.time);
    this.trafficEl.textContent = `空中 ${st.airborne} · 地面 ${st.onGround} · 在场 ${st.trafficLoaded}/${st.spawnCeiling} · 容量 ${st.capacity}`;
    this.windEl.textContent = `风 ${String(Math.round(st.windDir)).padStart(3, '0')}° / ${st.windSpeedKt.toFixed(0)} kt`;
    this.chipLanding.textContent = `落地 ${st.landings}`;
    this.chipDeparted.textContent = `起飞 ${st.departuresDone}`;
    this.chipStreak.textContent = `连击 ×${w.score.streak}`;
    this.chipStreak.classList.toggle('hot', w.score.streak >= 3);
    this.chipYellow.textContent = `黄牌 ${st.yellow}`;
    this.chipRed.textContent = `红牌 ${st.red}`;

    // 正反馈弹字：只给加分事件，违规已经有告警条与牌子闪动
    const ev = w.score.events;
    if (ev.length > this.lastEventCount) {
      const newest = ev.slice(this.lastEventCount).reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
      if (newest.delta > 0) this.pop(`+${newest.delta} ${newest.reason}`, 'pop-good');
    }
    this.lastEventCount = ev.length;

    // 容量是这套玩法的进度条，得让玩家知道它为什么涨
    if (this.lastCapacity !== null && st.capacity > this.lastCapacity) {
      this.pop(`容量提升 · 可同时管 ${st.capacity} 架`, 'pop-up');
    }
    this.lastCapacity = st.capacity;

    if (st.yellow > this.lastYellow) this.flash(this.chipYellow);
    if (st.red > this.lastRed) this.flash(this.chipRed);
    this.lastYellow = st.yellow;
    this.lastRed = st.red;

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
            : `间隔提醒 ${st.conflicts} 对`;
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

  /** 画面中央的短促弹字（落地 +18、容量提升…），游戏性最便宜的一档投入 */
  private pop(text: string, cls: string): void {
    const host = this.popHost;
    if (!host) return;
    const el = document.createElement('div');
    el.className = `pop ${cls}`;
    el.textContent = text;
    host.append(el);
    window.setTimeout(() => el.remove(), 1700);
  }

  private flash(el: HTMLElement): void {
    el.classList.remove('flash');
    // 强制一次重排，否则连续吃两张同色牌时动画不会重放
    void el.offsetWidth;
    el.classList.add('flash');
  }
}
