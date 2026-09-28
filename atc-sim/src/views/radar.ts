/**
 * 2D 雷达视图
 *
 * 这是游戏的主交互面。渲染用 Canvas2D 而不是 DOM —— 上百个标牌要每帧跟随、
 * 每帧改字，DOM 在这个量级会成为瓶颈。
 *
 * 视图只读世界状态，绝不回写。
 */

import type { Aircraft, Airport, Runway, Waypoint } from '../sim/types';
import type { World } from '../sim/world';
import { findAircraft } from '../sim/world';
import { m2ft, m2nm, ms2kt, norm360 } from '../sim/units';
import { reciprocalIdent } from '../sim/airport';
import { getStageScale, scaledPixelRatio } from './stage';

const COLORS = {
  bg: '#070C0E',
  ring: '#173029',
  ringLabel: '#3D6B5C',
  sector: '#1B4A3D',
  runway: '#C8D6D1',
  runwayDim: '#4A6660',
  waypoint: '#4E6B63',
  waypointText: '#5E8378',
  arrival: '#6FE3C4',
  departure: '#EF9F27',
  selected: '#FFFFFF',
  conflictLoss: '#E24B4A',
  conflictCrit: '#F09595',
  conflictPred: '#BA7517',
  text: '#9FE1CB',
  dim: '#3D5B52',
};

export interface RadarViewCallbacks {
  onSelect: (id: number | null) => void;
}

export class RadarView {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private airport: Airport;
  private callbacks: RadarViewCallbacks;

  private width = 0;
  private height = 0;
  private dpr = 1;

  /** 当前视野半径（米） */
  private rangeM: number;
  /** 平移偏移（米） */
  private panX = 0;
  private panY = 0;

  private dragging = false;
  private dragStart = { x: 0, y: 0, panX: 0, panY: 0 };
  private hitTargets: { id: number; x: number; y: number }[] = [];

  constructor(airport: Airport, callbacks: RadarViewCallbacks) {
    this.airport = airport;
    this.callbacks = callbacks;
    this.rangeM = airport.radarRange * 1.08;

    this.container = document.createElement('div');
    this.container.className = 'radar-view';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'radar-canvas';
    this.container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 上下文');
    this.ctx = ctx;

    this.bindEvents();
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.container);
  }

  private observer: ResizeObserver | null = null;

  unmount(): void {
    this.observer?.disconnect();
    this.container.remove();
  }

  /** 视角切换时显示/隐藏；隐藏时不再重绘（3D 主视图下小窗可能被 M 键收起） */
  setVisible(v: boolean): void {
    this.visible = v;
    this.container.style.display = v ? 'block' : 'none';
    if (v) this.resize();
  }

  private visible = true;

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  private bindEvents(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.dragStart = { x: e.clientX, y: e.clientY, panX: this.panX, panY: this.panY };
      this.canvas.setPointerCapture(e.pointerId);
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      // 屏幕像素 → 舞台像素要除掉缩放比
      const scale = this.pxPerMeter() * getStageScale();
      this.panX = this.dragStart.panX - (e.clientX - this.dragStart.x) / scale;
      this.panY = this.dragStart.panY + (e.clientY - this.dragStart.y) / scale;
    });

    this.canvas.addEventListener('pointerup', (e) => {
      const moved = Math.hypot(e.clientX - this.dragStart.x, e.clientY - this.dragStart.y);
      this.dragging = false;
      if (moved < 5) this.handleClick(e);
    });

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
        this.rangeM = Math.max(this.airport.radarRange * 0.15, Math.min(this.airport.radarRange * 2.2, this.rangeM * factor));
      },
      { passive: false },
    );
  }

  private handleClick(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const s = getStageScale();
    const mx = (e.clientX - rect.left) / s;
    const my = (e.clientY - rect.top) / s;
    let best: number | null = null;
    let bestD = 26;
    for (const t of this.hitTargets) {
      const d = Math.hypot(t.x - mx, t.y - my);
      if (d < bestD) {
        bestD = d;
        best = t.id;
      }
    }
    this.callbacks.onSelect(best);
  }

  /** 视图中心对准某架飞机（跟随时用） */
  centerOn(x: number, y: number): void {
    this.panX = -x;
    this.panY = -y;
  }

  resetView(): void {
    this.panX = 0;
    this.panY = 0;
    this.rangeM = this.airport.radarRange * 1.08;
  }

  // -------------------------------------------------------------------------
  // 坐标变换
  // -------------------------------------------------------------------------

  private resize(): void {
    // 用 offsetWidth/Height：getBoundingClientRect 会被舞台的 transform 一起放大，
    // 而 canvas 的 CSS 尺寸要的是未缩放布局尺寸，只有后备缓冲才按缩放比放大
    this.width = Math.max(1, this.container.offsetWidth);
    this.height = Math.max(1, this.container.offsetHeight);
    this.dpr = scaledPixelRatio();
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** 舞台缩放比变了（窗口改变大小）后重建后备缓冲 */
  rescale(): void {
    this.resize();
  }

  private pxPerMeter(): number {
    const half = Math.min(this.width, this.height) / 2;
    return (half * 0.92) / this.rangeM;
  }

  private project(x: number, y: number): [number, number] {
    const s = this.pxPerMeter();
    const cx = this.width / 2;
    const cy = this.height / 2;
    return [cx + (x + this.panX) * s, cy - (y + this.panY) * s];
  }

  // -------------------------------------------------------------------------
  // 渲染
  // -------------------------------------------------------------------------

  update(world: World): void {
    if (!this.visible) return;
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.width, this.height);

    this.hitTargets = [];

    this.drawRangeRings();
    this.drawSector();
    this.drawRunways();
    this.drawWaypoints();

    // 拖尾画在飞机下面
    for (const ac of world.aircraft) this.drawTrail(world, ac);

    for (const ac of world.aircraft) this.drawAircraft(world, ac);

    this.drawScaleBar();
  }

  private drawRangeRings(): void {
    const ctx = this.ctx;
    const [cx, cy] = this.project(0, 0);
    const s = this.pxPerMeter();

    ctx.save();
    ctx.strokeStyle = COLORS.ring;
    ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = COLORS.ringLabel;

    const maxNm = Math.ceil(m2nm(this.rangeM));
    for (let nm = 10; nm <= maxNm; nm += 10) {
      const r = nm * 1852 * s;
      if (r > Math.max(this.width, this.height)) break;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      // 沿正北方向标数字
      ctx.fillText(`${nm}`, cx + 4, cy - r + 12);
    }

    // 十字方位线
    ctx.strokeStyle = 'rgba(23,48,41,0.8)';
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, this.height);
    ctx.moveTo(0, cy);
    ctx.lineTo(this.width, cy);
    ctx.stroke();

    ctx.restore();
  }

  private drawSector(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = COLORS.sector;
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    for (const sector of this.airport.sectors) {
      ctx.beginPath();
      sector.boundary.forEach((p, i) => {
        const [sx, sy] = this.project(p.x, p.y);
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawRunways(): void {
    const ctx = this.ctx;
    ctx.save();
    for (const rw of this.airport.runways) {
      this.strokeRunway(rw, COLORS.runway);
      // 反向跑道用暗色，表示两个方向的物理同一条
      const back: Runway = {
        ...rw,
        ident: reciprocalIdent(rw.ident),
        heading: norm360(rw.heading + 180),
        threshold: {
          x: rw.threshold.x + Math.sin((rw.heading * Math.PI) / 180) * rw.length,
          y: rw.threshold.y + Math.cos((rw.heading * Math.PI) / 180) * rw.length,
        },
      };
      this.strokeRunway(back, COLORS.runwayDim);
    }
    ctx.restore();
  }

  private strokeRunway(rw: Runway, color: string): void {
    const ctx = this.ctx;
    const rad = (rw.heading * Math.PI) / 180;
    const endX = rw.threshold.x + Math.sin(rad) * rw.length;
    const endY = rw.threshold.y + Math.cos(rad) * rw.length;
    const [x1, y1] = this.project(rw.threshold.x, rw.threshold.y);
    const [x2, y2] = this.project(endX, endY);

    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // 跑道号
    ctx.fillStyle = color;
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(rw.ident, x1, y1 - 8);
    // 延长线（进近方向）
    const ux = (x1 - x2) / rw.length;
    const uy = (y1 - y2) / rw.length;
    ctx.strokeStyle = 'rgba(200,214,209,0.18)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + ux * this.rangeM * 0.9, y1 + uy * this.rangeM * 0.9);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.textAlign = 'left';
  }

  private drawWaypoints(): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = COLORS.waypointText;
    for (const wp of this.airport.waypoints) {
      const [x, y] = this.project(wp.pos.x, wp.pos.y);
      if (x < -50 || x > this.width + 50 || y < -50 || y > this.height + 50) continue;
      ctx.fillStyle = COLORS.waypoint;
      ctx.beginPath();
      if (wp.type === 'IAF' || wp.type === 'FAF') {
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      } else {
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 4, y + 3);
        ctx.lineTo(x - 4, y + 3);
        ctx.closePath();
      }
      ctx.fill();
      ctx.fillStyle = COLORS.waypointText;
      ctx.fillText(wp.name, x + 6, y - 4);
    }
    ctx.restore();
  }

  private drawTrail(world: World, ac: Aircraft): void {
    if (ac.trail.length < 2) return;
    const ctx = this.ctx;
    const base = ac.isDeparture ? COLORS.departure : COLORS.arrival;
    ctx.save();
    ctx.lineWidth = 1.5;
    for (let i = 1; i < ac.trail.length; i++) {
      const a = ac.trail[i - 1];
      const b = ac.trail[i];
      const age = world.time - b.t;
      const alpha = Math.max(0, 1 - age / 120);
      if (alpha <= 0.02) continue;
      const [x1, y1] = this.project(a.x, a.y);
      const [x2, y2] = this.project(b.x, b.y);
      ctx.strokeStyle = this.hexAlpha(base, alpha * 0.55);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawAircraft(world: World, ac: Aircraft): void {
    const ctx = this.ctx;
    const [x, y] = this.project(ac.pos.x, ac.pos.y);
    const selected = world.selectedId === ac.id;

    const conflict = world.conflicts.find((c) => c.a === ac.id || c.b === ac.id);
    let color = ac.isDeparture ? COLORS.departure : COLORS.arrival;
    if (conflict) {
      color =
        conflict.severity === 'LOSS'
          ? COLORS.conflictLoss
          : conflict.severity === 'CRITICAL'
            ? COLORS.conflictCrit
            : COLORS.conflictPred;
    }

    // 位置符号：按航向旋转的箭头
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.5;

    if (selected) {
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.selected;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
    }

    if (ac.phase === 'LANDED') {
      ctx.fillRect(-3, -3, 6, 6);
    } else {
      ctx.rotate(((ac.heading + 180) * Math.PI) / 180);
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4.5, 5);
      ctx.lineTo(0, 2.5);
      ctx.lineTo(-4.5, 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 冲突圈
    if (conflict) {
      const rpz = 3 * 1852 * this.pxPerMeter();
      ctx.save();
      ctx.strokeStyle = this.hexAlpha(color, conflict.severity === 'LOSS' ? 0.9 : 0.45);
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(rpz, 14), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    this.drawDataBlock(ac, x, y, color, selected);
    this.hitTargets.push({ id: ac.id, x, y });
  }

  /** 飞机标牌：呼号 / 高度 / 速度 */
  private drawDataBlock(ac: Aircraft, x: number, y: number, color: string, selected: boolean): void {
    const ctx = this.ctx;
    const lines: [string, string][] = [];

    const altFt = Math.round(m2ft(ac.pos.z) / 100) * 100;
    const spdKt = Math.round(ms2kt(ac.ias) / 10) * 10;
    const altStr = altFt >= 10000 ? `FL${String(Math.round(altFt / 100)).padStart(3, '0')}` : String(altFt);
    const trend = ac.vs > 1 ? '↑' : ac.vs < -1 ? '↓' : ' ';
    const spdTrend = ac.intent.speed > ac.ias + 1 ? '↑' : ac.intent.speed < ac.ias - 1 ? '↓' : ' ';

    lines.push(['callsign', ac.callsign]);
    lines.push(['alt', `${altStr}${trend}`]);
    lines.push(['spd', `${spdKt}${spdTrend}`]);

    const blockW = 74;
    const lineH = 12;
    const blockH = lines.length * lineH + 4;
    let bx = x + 12;
    if (bx + blockW > this.width) bx = x - 12 - blockW;
    const by = y - blockH / 2;

    ctx.save();
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'top';

    // 引线
    ctx.strokeStyle = this.hexAlpha(color, 0.5);
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(bx, by + blockH / 2);
    ctx.stroke();

    // 文字
    lines.forEach(([, text], i) => {
      const ty = by + 2 + i * lineH;
      for (let k = 0; k < text.length; k++) {
        ctx.fillStyle = 'rgba(6,12,14,0.85)';
        ctx.fillRect(bx + 6 * k - 1, ty, 7, lineH);
      }
      ctx.fillStyle = selected ? COLORS.selected : color;
      ctx.fillText(text, bx, ty);
    });

    if (selected) {
      ctx.strokeStyle = this.hexAlpha(COLORS.selected, 0.5);
      ctx.lineWidth = 0.8;
      ctx.strokeRect(bx - 3, by, blockW + 3, blockH);
    }
    ctx.restore();
  }

  private drawScaleBar(): void {
    const ctx = this.ctx;
    const s = this.pxPerMeter();
    const nm = 5;
    const px = nm * 1852 * s;
    const x0 = 16;
    const y0 = this.height - 20;
    ctx.save();
    ctx.strokeStyle = COLORS.ringLabel;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + px, y0);
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0 + 4);
    ctx.moveTo(x0 + px, y0 - 4);
    ctx.lineTo(x0 + px, y0 + 4);
    ctx.stroke();
    ctx.fillStyle = COLORS.ringLabel;
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillText(`${nm} NM`, x0 + px + 6, y0 + 4);
    ctx.restore();
  }

  private hexAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}

/** 供外部工具使用 */
export function findById(world: World, id: number): Aircraft | undefined {
  return findAircraft(world, id);
}

export type { Waypoint };
