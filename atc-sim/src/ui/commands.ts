/**
 * 情境化指令条（Command Layer）
 *
 * 注意：这是 Command Layer，不是 View —— 它是唯一被允许写入世界状态的地方。
 * 视图层只读，这里负责把玩家操作翻译成指令。
 *
 * 形态对标《机场管制27》的底部指令条：浮动在视图之上，按飞机当前阶段
 * 给出对应的管制用语选项（而不是把所有指令平铺成表单）。
 */

import type { Aircraft, Command } from '../sim/types';
import type { World } from '../sim/world';
import { commandAircraft, selectedAircraft, runwayOccupant, nearestRunwayIdent } from '../sim/world';
import { ft2m, kt2ms, m2ft, m2nm, ms2kt, norm360 } from '../sim/units';
import { findRunway, reciprocalIdent } from '../sim/airport';

/** 3° 下滑剖面：每海里约 318 ft */
const PROFILE_FT_PER_NM = 318;
/** 速度预设（节）—— 只留三档，五档里那三个数字没人分得清该点哪个 */
const SPD_PRESETS = [250, 210, 180];

const PHASE_LABEL: Record<string, string> = {
  GROUND: '跑道外等待',
  TAKEOFF: '起飞滑跑',
  CLIMB: '爬升',
  CRUISE: '巡航',
  DESCENT: '下降',
  APPROACH: '进近',
  LANDED: '已落地',
  GO_AROUND: '复飞',
};

interface Btn {
  text: string;
  act: string;
  value?: string;
  cls?: string;
}

/**
 * 进近许可的可用条件：进场航班且已在空中（含复飞）。
 * 不能写成 `phase === 'APPROACH'` —— APPROACH 阶段本身要靠这条许可才会出现，
 * 那样按钮永远点不到，落地链路从 UI 侧锁死。
 */
export function canClearApproach(ac: Aircraft): boolean {
  if (ac.isDeparture) return false;
  return ac.phase !== 'GROUND' && ac.phase !== 'TAKEOFF' && ac.phase !== 'LANDED';
}

export class CommandBar {
  private world: World;
  private root: HTMLElement;
  private callsignEl: HTMLElement;
  private metaEl: HTMLElement;
  private phaseEl: HTMLElement;
  private stateEl: HTMLElement;
  private groupsEl: HTMLElement;
  /** 指令组随 (选中机, 阶段, 是否建立ILS, 剖面建议) 变化而重建 */
  private builtKey = '';
  /** 直飞/等待 位置下拉的当前选择，跨重建保留 */
  private lastWp = '';

  constructor(world: World) {
    this.world = world;

    this.root = el('div', 'cbar');

    const head = el('div', 'cbar-head');
    this.callsignEl = el('span', 'cbar-callsign');
    this.metaEl = el('span', 'cbar-meta');
    this.phaseEl = el('span', 'cbar-phase');
    head.append(this.callsignEl, this.metaEl, this.phaseEl);

    this.stateEl = el('div', 'cbar-state');
    this.groupsEl = el('div', 'cbar-groups');

    this.root.append(head, this.stateEl, this.groupsEl);
    this.groupsEl.addEventListener('click', (e) => this.onClick(e));
  }

  mount(parent: HTMLElement): void {
    parent.appendChild(this.root);
  }

  unmount(): void {
    this.root.remove();
  }

  private send(cmd: Command): void {
    const ac = selectedAircraft(this.world);
    if (ac) commandAircraft(this.world, ac.id, cmd);
  }

  private onClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null;
    if (!target) return;
    const ac = selectedAircraft(this.world);
    if (!ac) return;
    this.dispatch(ac, target.dataset.act ?? '', target.dataset.value ?? null);
  }

  private dispatch(ac: Aircraft, act: string, value: string | null): void {
    switch (act) {
      case 'hdg-rel': {
        const d = Number(value);
        const target = norm360(ac.heading + d);
        this.send(d < 0 ? { kind: 'turnLeft', value: target } : { kind: 'turnRight', value: target });
        break;
      }
      case 'hdg-abs': {
        const n = Number(value);
        if (Number.isFinite(n)) this.send({ kind: 'heading', value: norm360(n) });
        break;
      }
      case 'alt':
        this.send({ kind: 'altitude', value: ft2m(Number(value)) });
        break;
      case 'expedite':
        this.send({ kind: 'expedite' });
        break;
      case 'spd':
        this.send({ kind: 'speed', value: kt2ms(Number(value)) });
        break;
      case 'resume':
        this.send({ kind: 'resumeNormalSpeed' });
        break;
      case 'direct':
        if (value) this.send({ kind: 'direct', waypoint: value });
        break;
      case 'hold':
        if (value) this.send({ kind: 'hold', fix: value });
        break;
      case 'ils':
        if (value) this.send({ kind: 'clearedApproach', runway: value });
        break;
      case 'goaround':
        this.send({ kind: 'goAround' });
        break;
      case 'takeoff':
        this.send({ kind: 'takeoff' });
        break;
    }
  }

  /** 每帧刷新：头部与态势行只改文本；指令组按 key 重建 */
  update(): void {
    const ac = selectedAircraft(this.world);
    if (!ac) {
      this.root.style.display = 'none';
      this.builtKey = '';
      return;
    }
    this.root.style.display = 'flex';

    const established = ac.approach?.slopeCaptured ?? false;
    const busy = this.busyRunways(ac);
    // 剖面建议高度：它是高度按钮的内容，所以必须进 key，否则数字会过期
    const rec = ac.isDeparture ? 0 : (this.profileAltFt(ac) ?? 0);
    this.callsignEl.textContent = ac.callsign;
    // 尾流类别与席位标签都先去掉：前者没有任何玩法作用（wakeSeparation 零调用），
    // 后者只有一个值 —— 对新手这两样都是纯噪声
    this.metaEl.textContent = `${ac.type} · ${ac.isDeparture ? '离场' : '进场'}`;
    this.phaseEl.textContent = PHASE_LABEL[ac.phase] ?? ac.phase;

    const altFt = Math.round(m2ft(ac.pos.z) / 100) * 100;
    const spdKt = Math.round(ms2kt(ac.ias));
    const tgtAlt = Math.round(m2ft(ac.intent.altitude) / 100) * 100;
    const tgtSpd = Math.round(ms2kt(ac.intent.speed));
    const hdg = String(Math.round(ac.heading)).padStart(3, '0');
    this.stateEl.textContent =
      `高度 ${altFt} → ${tgtAlt} · 速度 ${spdKt} → ${tgtSpd} kt · 航向 ${hdg}` +
      (ac.lastInstruction ? `　« ${ac.lastInstruction}` : '');

    const key = `${ac.id}:${ac.phase}:${established}:${rec}:${[...busy].sort().join(',')}`;
    if (key !== this.builtKey) {
      this.builtKey = key;
      this.rebuildGroups(ac, established, busy, rec);
    }
  }

  /**
   * 剖面基准跑道：已清进近就用指定的那条，否则取几何上最近的跑道入口。
   *
   * 不能复用 nearestRunwayIdent —— 它按"航向差 < 60°"过滤，而进场机在 STAR
   * 各段上的航向常常与四个跑道方向都差得更远（例如切向飞过的 281°），
   * 于是返回 null，建议高度就退化成爬升档。
   */
  private refRunwayIdent(ac: Aircraft): string | null {
    if (ac.assignedRunway) return ac.assignedRunway;
    let best: string | null = null;
    let bestD = Infinity;
    for (const rw of this.world.airport.runways) {
      for (const ident of [rw.ident, reciprocalIdent(rw.ident)]) {
        const r = findRunway(this.world.airport, ident);
        if (!r) continue;
        const d = Math.hypot(ac.pos.x - r.threshold.x, ac.pos.y - r.threshold.y);
        if (d < bestD) {
          bestD = d;
          best = ident;
        }
      }
    }
    return best;
  }

  /**
   * 相对所选跑道入口的 3° 剖面建议高度（英尺，取整到千），进场机专用。
   *
   * 用斜距而不是中心线轴向投影：进场机早期在进近走廊外侧，轴向投影会算出
   * "已经在跑道上方"，于是建议值变成叫它爬升。
   * 另外建议值永远不低于"当前许可再往下一千"，保证它是往下按的。
   */
  private profileAltFt(ac: Aircraft): number | null {
    if (ac.isDeparture) return null;
    const ident = this.refRunwayIdent(ac);
    if (!ident) return null;
    const rw = findRunway(this.world.airport, ident);
    if (!rw) return null;
    const dNm = m2nm(Math.hypot(ac.pos.x - rw.threshold.x, ac.pos.y - rw.threshold.y));
    const profile = Math.max(3000, Math.round((dNm * PROFILE_FT_PER_NM) / 1000) * 1000);
    const cur = Math.round(m2ft(ac.intent.altitude) / 1000) * 1000;
    return Math.max(3000, Math.min(profile, cur - 2000));
  }

  /**
   * 此刻被别的飞机占着的跑道（含反向）。
   * 指令条要把它标出来 —— 互锁只驳回不给提示，玩家就只能挨个试。
   */
  private busyRunways(ac: Aircraft): Set<string> {
    const busy = new Set<string>();
    for (const rw of this.world.airport.runways) {
      for (const ident of [rw.ident, reciprocalIdent(rw.ident)]) {
        if (runwayOccupant(this.world, ident, ac.id)) busy.add(ident);
      }
    }
    return busy;
  }

  // ---------------------------------------------------------------- 指令组

  private rebuildGroups(ac: Aircraft, established: boolean, busy: Set<string>, rec: number): void {
    const g = this.groupsEl;
    g.innerHTML = '';

    if (ac.phase === 'LANDED' || ac.phase === 'TAKEOFF') {
      g.append(noneHint('无可用指令'));
      return;
    }

    // 已建立下滑道：垂直剖面交给 sim，只保留复飞
    if (established) {
      g.append(
        this.group('进近', [{ text: '复飞', act: 'goaround', cls: 'warn' }]),
        noneHint('已建立 ILS，航向与下滑道自动跟随'),
      );
      return;
    }

    if (ac.phase === 'GROUND') {
      const ident = nearestRunwayIdent(this.world.airport, ac);
      const blocked = ident !== null && busy.has(ident);
      g.append(
        this.group('起飞', [
          { text: blocked ? `等待（${ident}占用）` : '可以起飞', act: 'takeoff', cls: blocked ? 'busy' : 'ok' },
        ]),
      );
      return;
    }

    // 空中：引导 + 高度 + 速度；进近/复飞阶段追加进近许可
    g.append(this.buildGuideGroup(), this.buildAltGroup(ac, rec), this.buildSpdGroup());

    if (canClearApproach(ac)) {
      const btns: Btn[] = [];
      // 两个方向都可清：跑道构型随风向变
      for (const rw of this.world.airport.runways) {
        for (const ident of [rw.ident, reciprocalIdent(rw.ident)]) {
          const occ = busy.has(ident);
          btns.push({ text: occ ? `ILS ${ident}·占` : `ILS ${ident}`, act: 'ils', value: ident, cls: occ ? 'busy' : 'ils' });
        }
      }
      btns.push({ text: '复飞', act: 'goaround', cls: 'warn' });
      g.append(this.group('进近', btns));
    }
  }

  /** 雷达引导组：相对转向 / 输入航向 / 直飞 / 等待 */
  private buildGuideGroup(): HTMLElement {
    const wrap = el('div', 'cbar-group');
    wrap.append(el('span', 'cbar-label', '引导'));
    for (const d of [-20, -10, 10, 20]) {
      const b = el('button', 'btn', d < 0 ? `←${-d}` : `→${d}`);
      b.dataset.act = 'hdg-rel';
      b.dataset.value = String(d);
      wrap.append(b);
    }
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '360';
    input.placeholder = '航向';
    input.className = 'cbar-input';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const ac = selectedAircraft(this.world);
        if (ac && input.value !== '') this.dispatch(ac, 'hdg-abs', input.value);
        input.value = '';
        input.blur();
      }
      e.stopPropagation();
    });
    wrap.append(input);

    const sel = document.createElement('select');
    sel.className = 'cbar-select';
    sel.title = '直飞 / 等待 位置';
    for (const wp of this.world.airport.waypoints) {
      const opt = document.createElement('option');
      opt.value = wp.name;
      opt.textContent = wp.name;
      sel.append(opt);
    }
    // 指令条会因为剖面建议高度变化而重建，玩家选好的位置不能被冲掉
    if (this.lastWp) sel.value = this.lastWp;
    sel.addEventListener('change', () => {
      this.lastWp = sel.value;
    });
    const directBtn = el('button', 'btn', '直飞');
    directBtn.dataset.act = 'direct';
    // 点击时读取下拉当前值
    directBtn.addEventListener('click', () => {
      directBtn.dataset.value = sel.value;
    });
    const holdBtn = el('button', 'btn', '等待');
    holdBtn.dataset.act = 'hold';
    holdBtn.addEventListener('click', () => {
      holdBtn.dataset.value = sel.value;
    });
    wrap.append(sel, directBtn, holdBtn);
    return wrap;
  }

  /**
   * 高度组只给三档，且第一档就是"照 3° 剖面该去的高度"（绿色高亮）。
   * 六个数字按钮对新手是选择题，三个带建议值的按钮才是操作。
   */
  private buildAltGroup(ac: Aircraft, rec: number): HTMLElement {
    const cur = m2ft(ac.intent.altitude);
    let steps: number[];
    if (ac.isDeparture || rec === 0) {
      const base = Math.max(4000, Math.round(cur / 2000) * 2000);
      steps = [base + 2000, base + 4000, base + 8000];
    } else {
      steps = [rec, rec + 2000, rec + 4000];
    }
    const btns: Btn[] = steps.map((ft, i) => ({
      text: ft >= 10000 ? `FL${ft / 100}` : String(ft),
      act: 'alt',
      value: String(ft),
      cls: i === 0 ? 'ok' : undefined,
    }));
    const up = ac.intent.altitude >= ac.pos.z;
    if (Math.abs(ac.intent.altitude - ac.pos.z) > ft2m(1500)) {
      btns.push({ text: up ? '加速爬升' : '加速下降', act: 'expedite', cls: 'warn' });
    }
    return this.group('高度', btns);
  }

  private buildSpdGroup(): HTMLElement {
    const btns: Btn[] = SPD_PRESETS.map((kt) => ({ text: String(kt), act: 'spd', value: String(kt) }));
    btns.push({ text: '恢复正常', act: 'resume' });
    return this.group('速度', btns);
  }

  private group(label: string, btns: Btn[]): HTMLElement {
    const wrap = el('div', 'cbar-group');
    wrap.append(el('span', 'cbar-label', label));
    for (const b of btns) {
      const btn = el('button', 'btn' + (b.cls ? ` btn-${b.cls}` : ''), b.text);
      btn.dataset.act = b.act;
      if (b.value !== undefined) btn.dataset.value = b.value;
      wrap.append(btn);
    }
    return wrap;
  }
}

function noneHint(text: string): HTMLElement {
  return el('div', 'cbar-none', text);
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
