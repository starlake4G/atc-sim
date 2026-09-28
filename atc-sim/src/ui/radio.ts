/**
 * 电台记录面板 —— [席位] ↔ [呼号] 的双向无线电流
 *
 * atc   = 管制员指令（白亮）
 * pilot = 飞行员复诵 / 请求（暗、斜体）
 * 其余为系统事件（好/坏着色）。按时间正序排列，自动滚到最底。
 */

import type { World } from '../sim/world';

const TAIL = 60;

export class RadioLog {
  private world: World;
  private root: HTMLElement;
  private body: HTMLElement;
  private lastLen = -1;

  constructor(world: World) {
    this.world = world;
    this.root = el('div', 'rl-panel');
    this.root.append(el('div', 'rl-head', '无线电记录'));
    this.body = el('div', 'rl-body');
    this.root.append(this.body);
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  update(): void {
    if (this.world.log.length === this.lastLen) return;
    this.lastLen = this.world.log.length;

    this.body.innerHTML = '';
    for (const e of this.world.log.slice(-TAIL)) {
      const line = el('div', `rl-line rl-${e.kind}`);
      line.append(el('span', 'rl-t', clock(e.t)));
      line.append(el('span', 'rl-text', e.text));
      this.body.append(line);
    }
    this.body.scrollTop = this.body.scrollHeight;
  }
}

function clock(t: number): string {
  const s = Math.floor(t % 60);
  const m = Math.floor(t / 60) % 60;
  const h = Math.floor(t / 3600);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
