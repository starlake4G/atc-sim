import type { AirportDef, TaxiEdgeDef, TaxiNodeDef } from "../../sim/types";
import { CHALLENGE_FIXES } from "../../sim/challenge";

const ELEV_M = 8;
const TAXIWAY_Y = 150;
const APRON_Y = 420;
const STAND_Y = 500;

/** 平行滑行道上的节点（x 坐标），含两个脱离口、六个机位口与跑道外等待点 */
const SPINE_X = [-1150, -700, -500, -400, -300, -100, 0, 100, 300, 400, 700, 1000, 1090, 1150];

/** 机位所在 x 坐标（与滑行道节点对齐，便于一眼看懂图） */
const STAND_X = [-700, -500, -300, -100, 100, 300];

const nodes: TaxiNodeDef[] = [];
const edges: TaxiEdgeDef[] = [];
for (const [prefix, y, reverse] of [["P", TAXIWAY_Y, true], ["B", 330, false], ["C", 250, false]] as const) {
  SPINE_X.forEach((x) => nodes.push({ id: `${prefix}${x}`, pos: { x, y },
    kind: prefix === "P" && x === 1090 ? "holding" : "taxi",
    label: prefix === "P" && x === 1090 ? "H27" : [0, -700, 700].includes(x) ? `${prefix === "P" ? "A" : prefix}${x === 0 ? "2" : x < 0 ? "1" : "3"}` : undefined }));
  for (let i = 0; i < SPINE_X.length - 1; i++) {
    const a = `${prefix}${SPINE_X[i]}`;
    const b = `${prefix}${SPINE_X[i + 1]}`;
    edges.push({ a: reverse ? b : a, b: reverse ? a : b, oneWay: true, maxKt: prefix === "P" ? 12 : 15,
      traffic: prefix === "C" ? "dep" : undefined });
  }
}
edges.push({ a: "P-1150", b: "B-1150", oneWay: true, maxKt: 10, traffic: "arr" });
edges.push({ a: "B1150", b: "P1150", oneWay: true, maxKt: 10, traffic: "arr" });
edges.push({ a: "B1090", b: "C1090", oneWay: true, maxKt: 10, traffic: "dep" });
edges.push({ a: "C1090", b: "P1090", oneWay: true, maxKt: 10, traffic: "dep" });
edges.push({ a: "B700", b: "C700", oneWay: true, maxKt: 10, traffic: "dep" });

STAND_X.forEach((x, i) => {
  const n = i + 1;
  nodes.push({ id: `ST${n}`, pos: { x, y: STAND_Y }, kind: "stand", label: `S${n}` });
  nodes.push({ id: `AP${n}`, pos: { x, y: APRON_Y }, kind: "apron" });
  edges.push({ a: `ST${n}`, b: `AP${n}`, maxKt: 5, oneWay: true, traffic: "dep" });
  edges.push({ a: `AP${n}`, b: `ST${n}`, maxKt: 5, oneWay: true, traffic: "arr" });
  edges.push({ a: `AP${n}`, b: `B${x}`, maxKt: 8, oneWay: true, traffic: "dep" });
  edges.push({ a: `B${x}`, b: `AP${n}`, maxKt: 8, oneWay: true, traffic: "arr" });
  edges.push({ a: `P${x}`, b: `C${x}`, maxKt: 10, oneWay: true, traffic: "arr" });
  edges.push({ a: `C${x}`, b: `B${x}`, maxKt: 10, oneWay: true, traffic: "arr" });
});

/** 三个脱离口，落在跑道中线上、再向北接到滑行道 */
const exits = [
  { name: "A1", x: 400, atM: 800, highSpeed: true },
  { name: "A2", x: 0, atM: 1200, highSpeed: false },
  { name: "A3", x: -400, atM: 1600, highSpeed: true },
];
for (const ex of exits) {
  nodes.push({ id: `E_${ex.name}`, pos: { x: ex.x, y: 0 }, kind: "exit", label: ex.name });
  edges.push({ a: `E_${ex.name}`, b: `P${ex.x}`, maxKt: ex.highSpeed ? 20 : 12, oneWay: true, traffic: "arr" });
}

nodes.push({ id: "LINEUP", pos: { x: 1120, y: 0 }, kind: "lineup", label: "27" });
edges.push({ a: "P1090", b: "LINEUP", maxKt: 10, oneWay: true, traffic: "dep" });

export const KESTREL: AirportDef = {
  id: "kestrel",
  icao: "KEKS",
  name: "Kestrel International",
  elevationM: ELEV_M,
  tower: { pos: { x: 650, y: 670 }, heightM: 34 },
  runways: [
    {
      id: "27",
      hdg: 270,
      lengthM: 2400,
      widthM: 45,
      threshold: { x: 1200, y: 0 },
      end: { x: -1200, y: 0 },
      exits: exits.map((e) => ({ name: e.name, atM: e.atM, node: `E_${e.name}`, highSpeed: e.highSpeed })),
    },
    {
      id: "09",
      hdg: 90,
      lengthM: 2400,
      widthM: 45,
      threshold: { x: -1200, y: 0 },
      end: { x: 1200, y: 0 },
      exits: [
        { name: "B1", atM: 800, node: "E_A3", highSpeed: true },
        { name: "B2", atM: 1200, node: "E_A2", highSpeed: false },
        { name: "B3", atM: 1600, node: "E_A1", highSpeed: true },
      ],
    },
  ],
  nodes,
  edges,
  stands: STAND_X.map((x, i) => ({
    id: `S${i + 1}`,
    node: `ST${i + 1}`,
    pos: { x, y: STAND_Y },
    hdg: 0,
    size: i === 0 || i === 3 ? "L" as const : "M" as const,
  })),
  fixes: [
    { name: "ORVIN", pos: { x: 30000, y: 11000 } },
    { name: "KAVLA", pos: { x: 19000, y: 6000 } },
    { name: "BEKTO", pos: { x: -18000, y: 3000 } },
    { name: "LUSAK", pos: { x: -34000, y: 8000 } },
    ...CHALLENGE_FIXES,
  ],
  arrival: { entryFix: "ORVIN", iafFix: "KAVLA" },
  departure: ["BEKTO", "LUSAK"],
};
