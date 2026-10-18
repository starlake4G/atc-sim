import { TICK } from "./constants";
import { aircraftCollide } from "./collision";
import { isAirborne } from "./aircraft";
import type { Aircraft } from "./types";
import { ft, nm } from "./units";
import { dist } from "./vec";

/**
 * 安全判据抽成纯函数：只回答"发生了什么"，不负责扣分、不改世界。
 * 这样这些判据可以单独测，world 只保留"应用后果"的部分。
 */

export interface AirConflict {
  /** `idA|idB`，给 UI 高亮用 */
  key: string;
  a: Aircraft;
  b: Aircraft;
  /** 已经进入失去间隔的距离/高度门限 */
  severe: boolean;
}

/** 空中间隔：3 NM / 1000 ft 提示，2 NM / 600 ft 视为失去间隔。 */
export function findAirConflicts(aircraft: Aircraft[]): AirConflict[] {
  const air = aircraft.filter((a) => isAirborne(a) && a.altM > 40);
  const out: AirConflict[] = [];
  for (let i = 0; i < air.length; i++) {
    for (let j = i + 1; j < air.length; j++) {
      const a = air[i]!;
      const b = air[j]!;
      const h = dist(a.pos, b.pos);
      const v = Math.abs(a.altM - b.altM);
      if (h >= nm(3) || v >= ft(1000)) continue;
      const key = [a.id, b.id].sort().join("|");
      out.push({ key, a, b, severe: h < nm(2) && v < ft(600) });
    }
  }
  return out;
}

/** 机体近似形状相交即碰撞（已包含一帧的扫掠）。 */
export function findCollision(aircraft: Aircraft[]): [Aircraft, Aircraft] | null {
  for (let i = 0; i < aircraft.length; i++) {
    for (let j = i + 1; j < aircraft.length; j++) {
      const a = aircraft[i]!;
      const b = aircraft[j]!;
      if (Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) > a.lengthM + b.lengthM + (a.gs + b.gs) * TICK) continue;
      if (aircraftCollide(a, b)) return [a, b];
    }
  }
  return null;
}

export function findSectorViolations(aircraft: Aircraft[], radiusM = 42000): Aircraft[] {
  return aircraft.filter((ac) => ac.phase !== "done" && dist(ac.pos, { x: 0, y: 0 }) > radiusM);
}

export function findParkedToRemove(aircraft: Aircraft[], time: number): Aircraft[] {
  return aircraft.filter((ac) => ac.phase === "parked" && ac.kind === "arr" && ac.removeAt !== null && time >= ac.removeAt);
}
