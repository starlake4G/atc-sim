import type { Aircraft } from "./types";
import { fromBearing, type Vec2 } from "./vec";

type Segment = { a: Vec2; b: Vec2; r: number };
const pointDistance = (p: Vec2, a: Vec2, b: Vec2) => {
  const x = b.x - a.x, y = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / Math.max(1e-9, x * x + y * y)));
  return Math.hypot(p.x - a.x - t * x, p.y - a.y - t * y);
};
function segmentDistance(a: Segment, b: Segment): number {
  const cross = (p: Vec2, q: Vec2, r: Vec2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a.a, a.b, b.a) * cross(a.a, a.b, b.b) < 0 && cross(b.a, b.b, a.a) * cross(b.a, b.b, a.b) < 0) return 0;
  return Math.min(pointDistance(a.a, b.a, b.b), pointDistance(a.b, b.a, b.b), pointDistance(b.a, a.a, a.b), pointDistance(b.b, a.a, a.b));
}
function shape(ac: Aircraft, p: Vec2): Segment[] {
  const axis = fromBearing(ac.hdg, ac.lengthM * .43), wing = fromBearing(ac.hdg + 90, ac.lengthM * .43);
  return [{ a: { x: p.x - axis.x, y: p.y - axis.y }, b: { x: p.x + axis.x, y: p.y + axis.y }, r: ac.lengthM * .065 },
    { a: { x: p.x - wing.x, y: p.y - wing.y }, b: { x: p.x + wing.x, y: p.y + wing.y }, r: ac.lengthM * .045 }];
}
/** Fuselage + wings, sampled across the fixed tick to catch fast runway crossings. */
export function aircraftCollide(a: Aircraft, b: Aircraft): boolean {
  if (Math.abs(a.altM - b.altM) > 7) return false;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const p = (ac: Aircraft) => ({ x: ac.lastPos.x + (ac.pos.x - ac.lastPos.x) * t, y: ac.lastPos.y + (ac.pos.y - ac.lastPos.y) * t });
    const sa = shape(a, p(a)), sb = shape(b, p(b));
    if (sa.some((x) => sb.some((y) => segmentDistance(x, y) <= x.r + y.r))) return true;
  }
  return false;
}

export function hitsGroundObstacle(ac: Aircraft, point: Vec2, elevation: number, radius = 3): boolean {
  if (ac.altM - elevation > 7) return false;
  for (let i = 0; i <= 4; i++) {
    const t = i / 4, pos = { x: ac.lastPos.x + (ac.pos.x - ac.lastPos.x) * t, y: ac.lastPos.y + (ac.pos.y - ac.lastPos.y) * t };
    if (shape(ac, pos).some((segment) => pointDistance(point, segment.a, segment.b) <= segment.r + radius)) return true;
  }
  return false;
}
