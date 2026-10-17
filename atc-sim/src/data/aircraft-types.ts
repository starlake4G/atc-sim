import type { AircraftTypeDef } from "../sim/types";

/** 机型表：取公开典型值，用于手感标定，不作为性能手册。 */
export const AIRCRAFT_TYPES: Record<string, AircraftTypeDef> = {
  A320: {
    id: "A320", name: "Airbus A320", wake: "M",
    vappKt: 135, rotationKt: 145, climbFpm: 2400, descentFpm: 2000,
    accelKt: 1.5, decelKt: 1.2, lengthM: 37, shape: "narrow",
  },
  B738: {
    id: "B738", name: "Boeing 737-800", wake: "M",
    vappKt: 140, rotationKt: 148, climbFpm: 2400, descentFpm: 2000,
    accelKt: 1.5, decelKt: 1.2, lengthM: 39, shape: "narrow",
  },
  A21N: {
    id: "A21N", name: "Airbus A321neo", wake: "M",
    vappKt: 138, rotationKt: 150, climbFpm: 2300, descentFpm: 2000,
    accelKt: 1.4, decelKt: 1.1, lengthM: 44, shape: "narrow",
  },
  B77W: {
    id: "B77W", name: "Boeing 777-300ER", wake: "H",
    vappKt: 148, rotationKt: 160, climbFpm: 1900, descentFpm: 1800,
    accelKt: 1.1, decelKt: 0.9, lengthM: 74, shape: "wide",
  },
  E190: {
    id: "E190", name: "Embraer E190", wake: "M",
    vappKt: 130, rotationKt: 140, climbFpm: 2600, descentFpm: 2200,
    accelKt: 1.6, decelKt: 1.3, lengthM: 36, shape: "narrow",
  },
  AT72: {
    id: "AT72", name: "ATR 72-600", wake: "L",
    vappKt: 110, rotationKt: 110, climbFpm: 1500, descentFpm: 1200,
    accelKt: 1.2, decelKt: 1.0, lengthM: 27, shape: "turboprop",
  },
};

export function getType(id: string): AircraftTypeDef {
  const t = AIRCRAFT_TYPES[id];
  if (!t) throw new Error(`未知机型 ${id}`);
  return t;
}
