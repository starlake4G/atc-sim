import type { FixDef, FlightPlanDef, LevelDef } from "./types";
import { Rng } from "./rng";

export const CHALLENGE_ID = "seed-challenge";
export const DEFAULT_CHALLENGE_SEED = "KESTREL-2026";
/** Change this when the generator changes, so a shared challenge identifies its rules too. */
export const CHALLENGE_VERSION = 1;

export interface ChallengeFlightPlan extends FlightPlanDef {
  entryFix?: string;
  arrivalRoute?: string[];
  initialAltFt?: number;
  initialSpeedKt?: number;
}

export interface ChallengeLevel extends LevelDef {
  seed: string;
  flights: ChallengeFlightPlan[];
}

export interface ArrivalEntry {
  id: string;
  label: string;
  route: readonly string[];
  altitudeFt: number;
}

/** Additional fixes for RWY 27. ORVIN and KAVLA retain their existing positions. */
export const CHALLENGE_FIXES: readonly FixDef[] = [
  { name: "ESTRA", pos: { x: 33500, y: 0 } },
  { name: "SOVIN", pos: { x: 30000, y: -11000 } },
  { name: "SAVLA", pos: { x: 19000, y: -6000 } },
  { name: "MERGE", pos: { x: 16500, y: 0 } },
];

export const ARRIVAL_ENTRIES: readonly ArrivalEntry[] = [
  { id: "ORVIN", label: "北侧 ORVIN", route: ["KAVLA", "MERGE"], altitudeFt: 7000 },
  { id: "ESTRA", label: "东侧 ESTRA", route: ["MERGE"], altitudeFt: 6000 },
  { id: "SOVIN", label: "南侧 SOVIN", route: ["SAVLA", "MERGE"], altitudeFt: 8000 },
];

/** Normalization is also used by the menu, URL, best records, and restart. */
export function normalizeChallengeSeed(value: string | number | null | undefined): string {
  const normalized = String(value ?? "").normalize("NFKC").trim().toUpperCase().replace(/\s+/g, "-").slice(0, 40);
  return normalized || DEFAULT_CHALLENGE_SEED;
}

export function challengeSeedHash(value: string | number | null | undefined): number {
  const seed = `kestrel-challenge-v${CHALLENGE_VERSION}:${normalizeChallengeSeed(value)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 0x01000193);
  }
  return hash >>> 0 || 1;
}

function shuffle<T>(rng: Rng, values: readonly T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.min(i, rng.int(0, i));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

const AIRLINES = [
  { prefix: "AUR", name: "极光航空" },
  { prefix: "VLT", name: "北风航空" },
  { prefix: "NRD", name: "北欧航空" },
  { prefix: "SKY", name: "天穹航空" },
  { prefix: "KST", name: "清风航空" },
] as const;

/**
 * A complete, bounded schedule rather than unconstrained random spawns.
 * Six arrivals enter in separated waves; six departures compete for the gaps.
 * Every entry is used twice and every departure stand is used once. Arrival
 * waves finish early enough to leave a recovery window for ground queues.
 */
export function createChallenge(value: string | number | null | undefined = DEFAULT_CHALLENGE_SEED): ChallengeLevel {
  const seed = normalizeChallengeSeed(value);
  const rng = new Rng(challengeSeedHash(seed));
  const entries = [...shuffle(rng, ARRIVAL_ENTRIES), ...shuffle(rng, ARRIVAL_ENTRIES)];
  const stands = shuffle(rng, ["S1", "S2", "S3", "S4", "S5", "S6"]);
  const mediumTypes = ["A320", "B738", "A21N", "E190"] as const;
  const arrivalTypes: string[] = Array.from({ length: 6 }, () => rng.pick(mediumTypes));
  arrivalTypes[rng.int(1, 2)] = "B77W";
  // The slow turboprop closes the arrival wave. This leaves the player choices
  // at the merge without generating an unavoidable fast-behind-slow catch-up.
  arrivalTypes[5] = "AT72";
  const callsignStart = rng.int(100, 780);
  const flights: ChallengeFlightPlan[] = [];
  const makeIdentity = (index: number) => {
    const airline = rng.pick(AIRLINES);
    return { callsign: `${airline.prefix}${callsignStart + index}`, airline: airline.name };
  };
  const minute = (base: number, jitterSeconds: number) => Math.round((base * 60 + rng.range(-jitterSeconds, jitterSeconds)) / 3) * 3 / 60;

  for (let i = 0; i < 6; i++) {
    const entry = entries[i]!;
    const typeId = arrivalTypes[i]!;
    flights.push({
      ...makeIdentity(i * 2), kind: "arr", typeId,
      atMin: minute(.45 + i * 2.7, 8),
      entryFix: entry.id,
      arrivalRoute: [...entry.route],
      // A turboprop cannot reliably lose 8000 ft in a short final sequence.
      initialAltFt: typeId === "AT72" ? 6000 : entry.altitudeFt,
      initialSpeedKt: typeId === "AT72" ? 220 : 250,
    });
    const standId = stands[i]!;
    const typePool = standId === "S1" || standId === "S4"
      ? [...mediumTypes, "B77W", "AT72"]
      : [...mediumTypes, "AT72"];
    flights.push({
      ...makeIdentity(i * 2 + 1), kind: "dep", typeId: rng.pick(typePool), standId,
      atMin: i === 0 ? 0 : minute([0, 2.2, 5.6, 9.5, 13, 17.8][i]!, 10),
    });
  }
  flights.sort((a, b) => a.atMin - b.atMin || a.callsign.localeCompare(b.callsign));
  return {
    id: CHALLENGE_ID, name: "挑战 · 三向合流", airportId: "kestrel", seed,
    startClockMin: rng.pick([8 * 60, 15 * 60 + 10, 18 * 60 + 25]),
    durationMin: 35, runwayId: "27", wind: { dirDeg: 260, speedKt: rng.int(6, 10) },
    maxAircraft: 12, targetMovements: 12,
    description: "三处入口、混合机型与交错离场。安排合流次序，在落地波次之间放行；相同种子可重复挑战。",
    flights,
  };
}
