import { alongRunway, distanceToThreshold, findTaxiPath } from "./airport";
import type { SimEnv } from "./env";
import { goAround, isAirborne, isGroundPhase, routeViaFix } from "./aircraft";
import { makeRoute } from "./route";
import type { Aircraft, Command, CommandOption, CommandResult, Seat } from "./types";
import { ft, kt, norm360, toFt } from "./units";

const pad3 = (n: number) => String(Math.round(norm360(n))).padStart(3, "0");

/** 情境化指令条：选项就是管制用语，按飞机当前状态生成 */
export function availableCommands(ac: Aircraft, env: SimEnv): CommandOption[] {
  const out: CommandOption[] = [];
  const idx = env.idx;
  const distThr = distanceToThreshold(idx, ac.pos);

  if (ac.phase === "parked" && ac.kind === "dep") {
    const dirs: { hdg: number; label: string }[] = [
      { hdg: 0, label: "推出 · 机头朝北" },
      { hdg: 90, label: "推出 · 机头朝东" },
      { hdg: 180, label: "推出 · 机头朝南" },
      { hdg: 270, label: "推出 · 机头朝西" },
    ];
    for (const d of dirs) {
      out.push({ key: `push-${d.hdg}`, label: d.label, group: "地面", command: { kind: "pushback", hdg: d.hdg }, tone: "primary" });
    }
    return out;
  }

  if (ac.phase === "taxi_out" || ac.phase === "taxi_in" || ac.phase === "pushback") {
    out.push({
      key: "hold",
      label: ac.holding ? "继续滑行" : "原地等待",
      group: "地面",
      command: ac.holding ? { kind: "resume" } : { kind: "hold" },
    });
    return out;
  }

  if (ac.phase === "hold_short") {
    out.push({ key: "lineup", label: "进跑道等待", group: "跑道", command: { kind: "lineup" } });
    out.push({ key: "takeoff", label: "可以起飞", group: "跑道", command: { kind: "takeoff" }, tone: "primary" });
    return out;
  }

  if (ac.phase === "lineup") {
    out.push({ key: "takeoff", label: "可以起飞", group: "跑道", command: { kind: "takeoff" }, tone: "primary" });
    return out;
  }

  if (ac.phase === "landing") {
    for (const ex of idx.exitsByDistance) {
      out.push({ key: `exit-${ex.node}`, label: `从 ${ex.name} 脱离`, group: "跑道", command: { kind: "exit", nodeId: ex.node } });
    }
    return out;
  }

  if (ac.phase === "approach" && ac.approach) {
    if (!ac.landCleared) {
      out.push({ key: "land", label: `跑道 ${idx.runway.id}，可以落地`, group: "跑道", command: { kind: "land" }, tone: "primary" });
    }
    out.push({ key: "goaround", label: "执行复飞", group: "跑道", command: { kind: "goAround" }, tone: "danger" });
    out.push({ key: "speed-160", label: "减速 160", group: "速度", command: { kind: "speed", kt: 160 } });
    out.push({ key: "speed-180", label: "减速 180", group: "速度", command: { kind: "speed", kt: 180 } });
    return out;
  }

  if (isAirborne(ac)) {
    out.push({ key: "left30", label: "左转 30°", group: "引导", command: { kind: "heading", hdg: norm360(ac.hdg - 30) } });
    out.push({ key: "right30", label: "右转 30°", group: "引导", command: { kind: "heading", hdg: norm360(ac.hdg + 30) } });

    const alts = [3000, 5000, 7000].filter((a) => Math.abs(ft(a) - ac.altM) > 60);
    for (const a of alts) {
      const isClimb = ft(a) > ac.altM;
      out.push({
        key: `alt-${a}`,
        label: `${isClimb ? "上升到" : "下降到"} ${a} ft`,
        group: "高度",
        command: { kind: "altitude", altFt: a },
      });
    }

    for (const s of [180, 220, 250]) {
      if (Math.abs(kt(s) - ac.targetGs) < 1) continue;
      out.push({ key: `spd-${s}`, label: `速度 ${s}`, group: "速度", command: { kind: "speed", kt: s } });
    }

    if (ac.kind === "arr" && (ac.phase === "arrival" || ac.phase === "approach")) {
      if (distThr < 32000 && alongRunway(idx, ac.pos) < -2000) {
        out.push({
          key: "ils",
          label: `ILS 进近 跑道 ${idx.runway.id}`,
          group: "进近",
          command: { kind: "approach", runwayId: idx.runway.id },
          tone: ac.phase === "approach" ? "muted" : "primary",
        });
      }
      if (ac.phase === "arrival") {
        out.push({ key: "direct-iaf", label: `直飞 ${idx.def.arrival.iafFix}`, group: "引导", command: { kind: "direct", fix: idx.def.arrival.iafFix } });
      }
    }
  }

  return out;
}

function reject(reason: string): CommandResult {
  return { ok: false, reason };
}

/** 执行指令：先校验，再改状态。所有拒绝都必须有可读原因。 */
export function executeCommand(env: SimEnv, ac: Aircraft, cmd: Command): CommandResult {
  const idx = env.idx;
  const rwy = idx.runway.id;

  switch (cmd.kind) {
    case "heading": {
      if (!isAirborne(ac)) return reject("地面飞机不接受航向指令");
      ac.clearedHdg = norm360(cmd.hdg);
      ac.route = null;
      if (ac.approach) ac.approach = null;
      ac.landCleared = false;
      return { ok: true, seat: "APP", radio: `航向 ${pad3(cmd.hdg)}` };
    }

    case "altitude": {
      if (!isAirborne(ac)) return reject("地面飞机不接受高度指令");
      ac.clearedAltM = ft(cmd.altFt);
      ac.expedite = cmd.expedite ?? false;
      return { ok: true, seat: "APP", radio: `${Math.abs(cmd.altFt - Math.round(toFt(ac.altM))) < 100 ? "保持" : cmd.altFt > toFt(ac.altM) ? "上升到" : "下降到"} ${cmd.altFt} 英尺` };
    }

    case "speed": {
      if (!isAirborne(ac)) return reject("地面飞机不接受速度指令");
      ac.targetGs = kt(cmd.kt);
      return { ok: true, seat: "APP", radio: `速度 ${cmd.kt} 节` };
    }

    case "direct": {
      if (!isAirborne(ac)) return reject("地面飞机不能直飞");
      if (!routeViaFix(env, ac, cmd.fix)) return reject(`没有航路点 ${cmd.fix}`);
      if (ac.approach) ac.approach = null;
      ac.landCleared = false;
      return { ok: true, seat: "APP", radio: `直飞 ${cmd.fix}` };
    }

    case "approach": {
      if (ac.kind !== "arr") return reject("离场飞机不进近");
      if (ac.phase !== "arrival" && ac.phase !== "approach") return reject("当前阶段无法进近");
      if (alongRunway(idx, ac.pos) > -2500) return reject("已过进近点，无法截获航向道");
      if (distanceToThreshold(idx, ac.pos) > 34000) return reject("距离太远，先引导进场");
      ac.approach = { runwayId: cmd.runwayId, established: false };
      ac.phase = "approach";
      ac.route = null;
      ac.clearedHdg = null;
      ac.landCleared = false;
      if (ac.clearedAltM === null) ac.clearedAltM = ft(4000);
      return { ok: true, seat: "APP", radio: `跑道 ${rwy}，可以进近` };
    }

    case "land": {
      if (ac.phase !== "approach" || !ac.approach) return reject("还没建立进近");
      if (env.runwayOccupantId && env.runwayOccupantId !== ac.id) {
        const other = env.aircraftList().find((a) => a.id === env.runwayOccupantId);
        return reject(`跑道 ${rwy} 被 ${other?.callsign ?? "其他飞机"} 占用`);
      }
      ac.landCleared = true;
      return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，可以落地` };
    }

    case "goAround": {
      if (ac.phase !== "approach") return reject("只有进近中的飞机可以复飞");
      goAround(ac, env);
      return { ok: true, seat: "TWR", radio: "执行复飞" };
    }

    case "lineup": {
      if (ac.phase !== "hold_short") return reject("飞机不在跑道外等待点");
      if (env.runwayOccupantId && env.runwayOccupantId !== ac.id) {
        const other = env.aircraftList().find((a) => a.id === env.runwayOccupantId);
        return reject(`跑道 ${rwy} 被 ${other?.callsign ?? "其他飞机"} 占用`);
      }
      ac.phase = "lineup";
      ac.route = makeRoute([ac.pos, idx.nodes.get(idx.lineupNode)!.pos]);
      env.occupyRunway(ac);
      return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，进跑道等待` };
    }

    case "takeoff": {
      if (ac.phase !== "hold_short" && ac.phase !== "lineup") return reject("飞机还没到跑道外等待点");
      if (env.runwayOccupantId && env.runwayOccupantId !== ac.id) {
        const other = env.aircraftList().find((a) => a.id === env.runwayOccupantId);
        return reject(`跑道 ${rwy} 被 ${other?.callsign ?? "其他飞机"} 占用`);
      }
      env.occupyRunway(ac);
      ac.takeoffPending = true;
      if (ac.phase === "hold_short") {
        ac.phase = "lineup";
        ac.route = makeRoute([ac.pos, idx.nodes.get(idx.lineupNode)!.pos]);
        return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，可以起飞` };
      }
      ac.phase = "takeoff";
      ac.gs = Math.max(ac.gs, 2);
      return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，可以起飞` };
    }

    case "pushback": {
      if (ac.phase !== "parked") return reject("飞机已经推出");
      if (ac.kind !== "dep") return reject("进场飞机不推出");
      const stand = idx.stands.get(ac.standId ?? "");
      if (!stand) return reject("没有分配机位");
      const path = findTaxiPath(idx, stand.node, idx.holdingNode);
      if (!path) return reject("机位与滑行道不连通");
      ac.phase = "pushback";
      ac.route = makeRoute([ac.pos, ...path.map((id) => idx.nodes.get(id)!.pos)]);
      ac.clearedHdg = cmd.hdg;
      ac.gs = 0;
      return { ok: true, seat: "GND", radio: `可以推出，机头朝${compass(cmd.hdg)}` };
    }

    case "hold": {
      if (!isGroundPhase(ac)) return reject("空中飞机不能用等待指令");
      ac.holding = true;
      return { ok: true, seat: ac.kind === "dep" ? "GND" : "TWR", radio: "原地等待" };
    }

    case "resume": {
      ac.holding = false;
      return { ok: true, seat: "GND", radio: "继续滑行" };
    }

    case "exit": {
      if (ac.phase !== "landing") return reject("还没接地");
      const ex = idx.exitsByDistance.find((e) => e.node === cmd.nodeId);
      if (!ex) return reject("没有这个脱离口");
      ac.exitNodeId = ex.node;
      return { ok: true, seat: "TWR", radio: `从 ${ex.name} 脱离` };
    }
  }
}

function compass(hdg: number): string {
  const names = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"];
  return names[Math.round(norm360(hdg) / 45) % 8] as string;
}

/** 飞行员复诵文本 */
export function readbackText(ac: Aircraft, cmd: Command): string {
  const cs = ac.callsign;
  switch (cmd.kind) {
    case "heading":
      return `航向 ${pad3(cmd.hdg)}，${cs}`;
    case "altitude":
      return `${cmd.altFt} 英尺，${cs}`;
    case "speed":
      return `速度 ${cmd.kt} 节，${cs}`;
    case "direct":
      return `直飞 ${cmd.fix}，${cs}`;
    case "approach":
      return `跑道 ${cmd.runwayId} 进近，${cs}`;
    case "land":
      return `跑道 ${ac.approach?.runwayId ?? ""}，可以落地，${cs}`;
    case "goAround":
      return `复飞，${cs}`;
    case "lineup":
      return `进跑道等待，${cs}`;
    case "takeoff":
      return `可以起飞，${cs}`;
    case "pushback":
      return `机头朝${compass(cmd.hdg)}，推出，${cs}`;
    case "hold":
      return `原地等待，${cs}`;
    case "resume":
      return `继续滑行，${cs}`;
    case "exit":
      return `脱离，${cs}`;
  }
}

/** 指令条被拒时的态度：直接说明原因，不做"操作无效" */
export function seatOf(cmd: Command): Seat {
  switch (cmd.kind) {
    case "pushback":
    case "hold":
    case "resume":
      return "GND";
    case "lineup":
    case "takeoff":
    case "land":
    case "goAround":
    case "exit":
      return "TWR";
    default:
      return "APP";
  }
}
