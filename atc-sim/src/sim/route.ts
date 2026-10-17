import type { Route } from "./types";
import { add, dist, len, scale, sub, type Vec2 } from "./vec";

/**
 * 折线航路，按弧长参数化。
 * 用「最近点投影 + 前视点」而不是「到点判定」，从根上避免飞机绕着航路点转圈。
 */
class PolylineRoute implements Route {
  readonly points: Vec2[];
  readonly total: number;
  minS = 0;
  private cum: number[];

  constructor(points: Vec2[]) {
    const pts: Vec2[] = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (!last || dist(last, p) > 0.5) pts.push(p);
    }
    this.points = pts;
    this.cum = [0];
    for (let i = 1; i < pts.length; i++) {
      this.cum.push((this.cum[i - 1] as number) + dist(pts[i - 1] as Vec2, pts[i] as Vec2));
    }
    this.total = this.cum[this.cum.length - 1] ?? 0;
  }

  private projectRaw(p: Vec2): number {
    let best = Infinity;
    let bestS = 0;
    for (let i = 0; i < this.points.length - 1; i++) {
      const a = this.points[i] as Vec2;
      const b = this.points[i + 1] as Vec2;
      const ab = sub(b, a);
      const l2 = ab.x * ab.x + ab.y * ab.y;
      const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2));
      const q = add(a, scale(ab, t));
      const d = dist(p, q);
      if (d < best) {
        best = d;
        bestS = (this.cum[i] as number) + Math.sqrt(l2) * t;
      }
    }
    return bestS;
  }

  project(p: Vec2): number {
    const s = this.projectRaw(p);
    return Math.max(s, this.minS - 12);
  }

  pointAt(s: number): Vec2 {
    const clamped = Math.max(0, Math.min(this.total, s));
    if (this.points.length === 0) return { x: 0, y: 0 };
    if (this.points.length === 1) return this.points[0] as Vec2;
    for (let i = 0; i < this.points.length - 1; i++) {
      const s0 = this.cum[i] as number;
      const s1 = this.cum[i + 1] as number;
      if (clamped <= s1 || i === this.points.length - 2) {
        const segLen = s1 - s0;
        const t = segLen < 1e-9 ? 0 : (clamped - s0) / segLen;
        const a = this.points[i] as Vec2;
        const b = this.points[i + 1] as Vec2;
        return add(a, scale(sub(b, a), t));
      }
    }
    return this.points[this.points.length - 1] as Vec2;
  }

  follow(pos: Vec2, lookaheadM: number) {
    const s = this.project(pos);
    this.minS = Math.max(this.minS, s);
    const targetS = Math.min(this.total, this.minS + lookaheadM);
    return {
      target: this.pointAt(targetS),
      s: this.minS,
      finished: this.minS >= this.total - 1,
      total: this.total,
    };
  }

  remaining(pos: Vec2): number {
    return Math.max(0, this.total - this.project(pos));
  }
}

export function makeRoute(points: Vec2[]): Route {
  return new PolylineRoute(points);
}

/** 沿折线取一串等距采样点（3D 画引导线用） */
export function sampleRoute(route: Route, stepM: number): Vec2[] {
  const out: Vec2[] = [];
  for (let s = 0; s <= route.total; s += stepM) out.push(route.pointAt(s));
  return out;
}

/** 折线总长 */
export function routeLength(points: Vec2[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += len(sub(points[i] as Vec2, points[i - 1] as Vec2));
  return l;
}
