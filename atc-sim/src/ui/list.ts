/**
 * 飞机列表面板 —— 按 离场 / 进场 分组，状态着色，点击选中
 *
 * 进场按距机场距离排序（最近的在前 = 落地顺序），离场按生成顺序。
 */

import type { Aircraft } from '../sim/types';
import type { World } from '../sim/world';
import { m2ft, ms2kt } from '../sim/units';

const PHASE_LABEL: Record<string, string> = {
  GROUND: '等待',
  TAKEOFF: '滑跑',
  CLIMB: '爬升',
  CRUISE: '巡航',
  DESCENT: '下降',
  APPROACH: '进近',
  LANDED: '落地',
  GO_AROUND: '复飞',
};

export class AircraftList {
  private world: World;
  private root: HTMLElement;
  private body: HTMLElement;
  private sig = '';
  private lastRebuild = 0;

  constructor(world: World) {
    this.world = world;
    this.root = el('div', 'al-panel');
    this.root.append(el('div', 'al-head', '飞机列表'));
    this.body = el('div', 'al-body');
    this.root.append(this.body);
    this.body.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest('[data-id]') as HTMLElement | null;
      if (!row) return;
      const id = Number(row.dataset.id);
      this.world.selectedId = this.world.selectedId === id ? null : id;
    });
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  update(): void {
    const acs = this.world.aircraft;
    const conflicts = new Set<number>();
    for (const c of this.world.conflicts) {
      conflicts.add(c.a);
      conflicts.add(c.b);
    }
    const sig =
      `${acs.length}|${this.world.selectedId}|${acs.map((a) => `${a.id}:${a.phase}:${a.pos.z | 0}`).join(',')}` +
      `|${[...conflicts].join(',')}`;

    const now = performance.now();
    // 结构（选中/阶段/冲突/数量）变化立即重建，否则 1Hz 刷新读数
    if (sig !== this.sig || now - this.lastRebuild > 1000) {
      this.sig = sig;
      this.lastRebuild = now;
      this.rebuild(acs, conflicts);
    }
  }

  private rebuild(acs: Aircraft[], conflicts: Set<number>): void {
    this.body.innerHTML = '';
    const deps = acs.filter((a) => a.isDeparture);
    const arrs = acs
      .filter((a) => !a.isDeparture)
      .sort((a, b) => Math.hypot(a.pos.x, a.pos.y) - Math.hypot(b.pos.x, b.pos.y));

    if (deps.length) {
      this.body.append(el('div', 'al-group', `离场 ${deps.length}`));
      for (const ac of deps) this.body.append(this.row(ac, conflicts));
    }
    if (arrs.length) {
      this.body.append(el('div', 'al-group', `进场 ${arrs.length}`));
      for (const ac of arrs) this.body.append(this.row(ac, conflicts));
    }
    if (!acs.length) this.body.append(el('div', 'al-empty', '暂无飞机'));
  }

  private row(ac: Aircraft, conflicts: Set<number>): HTMLElement {
    const row = el('div', 'al-row');
    row.dataset.id = String(ac.id);
    if (this.world.selectedId === ac.id) row.classList.add('sel');
    if (conflicts.has(ac.id)) row.classList.add('bad');

    const dot = el('span', 'al-dot');
    dot.style.background =
      conflicts.has(ac.id) ? 'var(--danger)' : ac.isDeparture ? 'var(--accent-2)' : 'var(--accent)';
    row.append(dot);
    row.append(el('span', 'al-cs', ac.callsign));
    row.append(el('span', 'al-type', ac.type));

    const altFt = Math.round(m2ft(ac.pos.z) / 100) * 100;
    const trend = ac.vs > 2 ? '↑' : ac.vs < -2 ? '↓' : '→';
    row.append(el('span', 'al-info', `${altFt}${trend} ${Math.round(ms2kt(ac.ias))}kt`));
    row.append(el('span', 'al-phase', PHASE_LABEL[ac.phase] ?? ac.phase));
    return row;
  }
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
