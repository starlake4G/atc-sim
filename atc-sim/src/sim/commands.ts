import { alongRunway, distanceToThreshold, findTaxiPath, usableExit } from "./airport";
import type { SimEnv } from "./env";
import { goAround, isAirborne, routeViaFix } from "./aircraft";
import { makeRoute } from "./route";
import { taxiRoute } from "./ground";
import { fromBearing } from "./vec";
import { runwayBlockReason } from "./runway";
import type { Aircraft, Command, CommandOption, CommandResult, Seat } from "./types";
import { ft, kt, norm360, toFt } from "./units";

const pad3 = (n: number) => String(Math.round(norm360(n))).padStart(3, "0");

/** 情境化指令条：选项就是管制用语，按飞机当前状态生成 */
export function availableCommands(ac: Aircraft, env: SimEnv): CommandOption[] {
  const out: CommandOption[] = [];
  const idx = env.idx;
  const distThr = distanceToThreshold(idx, ac.pos);

  if (ac.controller === "DEP") return out;
  if (ac.phase === "taxi_ready") {
    if (ac.kind === "arr" && env.mode === "standard" && ac.controller !== "GND") {
      return [{ key: "contact-gnd", label: "联系地面 121.7", group: "移交", command: { kind: "handoff", controller: "GND" }, tone: "primary" }];
    }
    out.push({ key: "taxi-main", label: ac.kind === "dep" ? "经 B 滑行至跑道外" : `经 A 滑入机位 ${ac.standId ?? "待分配"}`, group: "滑行", command: { kind: "taxi", route: "main" }, tone: "primary", disabledReason: ac.kind === "arr" && !ac.standId ? "等待兼容的空闲机位" : undefined });
    if (ac.kind === "dep") out.push({ key: "taxi-bypass", label: "经 B、C 旁通道滑行", group: "滑行", command: { kind: "taxi", route: "bypass" } });
    return out;
  }

  if (ac.phase === "parked" && ac.kind === "dep") {
    const dirs: { hdg: number; label: string }[] = [
      { hdg: 0, label: "推出 · 机头朝北" },
      { hdg: 90, label: "推出 · 机头朝东" },
      { hdg: 180, label: "推出 · 机头朝南" },
      { hdg: 270, label: "推出 · 机头朝西" },
    ];
    for (const d of dirs) {
      out.push({ key: `push-${d.hdg}`, label: d.label, group: "地面", command: { kind: "pushback", hdg: d.hdg }, tone: d.hdg === 180 ? "primary" : undefined });
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
    if (env.mode === "standard" && ac.controller !== "TWR") return [{ key: "contact-twr", label: "联系塔台 118.1", group: "移交", command: { kind: "handoff", controller: "TWR" }, tone: "primary" }];
    out.push({ key: "lineup", label: "进跑道等待", group: "跑道", command: { kind: "lineup" }, disabledReason: runwayBlockReason(env, ac) });
    out.push({ key: "takeoff", label: "可以起飞", group: "跑道", command: { kind: "takeoff" }, tone: "primary", disabledReason: runwayBlockReason(env, ac) });
    return out;
  }

  if (ac.phase === "lineup") {
    out.push({ key: "takeoff", label: "可以起飞", group: "跑道", command: { kind: "takeoff" }, tone: "primary", disabledReason: runwayBlockReason(env, ac) });
    return out;
  }

  if (ac.phase === "landing") {
    for (const ex of idx.exitsByDistance.filter((ex) => usableExit(ex, alongRunway(idx, ac.pos), ac.gs))) {
      out.push({ key: `exit-${ex.node}`, label: `从 ${ex.name} 脱离`, group: "跑道", command: { kind: "exit", nodeId: ex.node } });
    }
    return out;
  }

  if (ac.phase === "approach" && ac.approach) {
    if (env.mode === "standard" && ac.controller !== "TWR") {
      out.push({ key: "contact-twr", label: "联系塔台 118.1", group: "移交", command: { kind: "handoff", controller: "TWR" }, tone: "primary", disabledReason: ac.approach.established ? undefined : "等待建立进近" });
      out.push({ key: "goaround", label: "执行复飞", group: "进近", command: { kind: "goAround" }, tone: "danger" });
      return out;
    }
    if (!ac.landCleared) {
      out.push({ key: "land", label: `跑道 ${idx.runway.id}，可以落地`, group: "跑道", command: { kind: "land" }, tone: "primary", disabledReason: !ac.approach.established ? "等待建立进近" : runwayBlockReason(env, ac) });
    } else {
      out.push({ key: "cancel-land", label: "取消落地许可", group: "跑道", command: { kind: "cancelLanding" } });
    }
    out.push({ key: "goaround", label: "执行复飞", group: "跑道", command: { kind: "goAround" }, tone: "danger" });
    out.push({ key: "speed-160", label: "减速 160", group: "速度", command: { kind: "speed", kt: 160 } });
    out.push({ key: "speed-180", label: "减速 180", group: "速度", command: { kind: "speed", kt: 180 } });
    return out;
  }

  if (isAirborne(ac)) {
    if (ac.phase === "departure" && env.mode === "standard") out.push({ key: "contact-dep", label: "移交离场 124.6", group: "移交", command: { kind: "handoff", controller: "DEP" }, tone: "primary", disabledReason: ac.altM - idx.def.elevationM < ft(1500) ? "爬升至 1500 ft 以上再移交" : undefined });
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
      if (ac.phase === "arrival" && !ac.airHolding) out.push({ key: "hold-air", label: "进入空中等待", group: "排序", command: { kind: "holdAir" } });
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
  if (ac.controller === "DEP") return reject("航班已移交离场，不再接受本席指令");

  if (cmd.kind === "heading" || cmd.kind === "pushback") {
    if (!Number.isFinite(cmd.hdg)) return reject("航向必须为有限数值");
  }
  if (cmd.kind === "altitude" && (!Number.isFinite(cmd.altFt) || ft(cmd.altFt) < idx.def.elevationM || cmd.altFt > 40000)) return reject("高度必须在机场标高至 40000 英尺之间");
  if (cmd.kind === "speed" && (!Number.isFinite(cmd.kt) || cmd.kt < 100 || cmd.kt > 350)) return reject("速度必须在 100 至 350 节之间");

  switch (cmd.kind) {
    case "heading": {
      if (!isAirborne(ac)) return reject("地面飞机不接受航向指令");
      ac.clearedHdg = norm360(cmd.hdg);
      ac.route = null;
      ac.airHolding = false;
      if (ac.approach) { ac.approach = null; ac.phase = "arrival"; }
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
      if (ac.approach) { ac.approach = null; ac.phase = "arrival"; }
      ac.landCleared = false;
      return { ok: true, seat: "APP", radio: `直飞 ${cmd.fix}` };
    }

    case "approach": {
      if (cmd.runwayId !== rwy) return reject(`当前使用跑道 ${rwy}`);
      if (ac.kind !== "arr") return reject("离场飞机不进近");
      if (ac.phase !== "arrival" && ac.phase !== "approach") return reject("当前阶段无法进近");
      if (alongRunway(idx, ac.pos) > -2500) return reject("已过进近点，无法截获航向道");
      if (distanceToThreshold(idx, ac.pos) > 34000) return reject("距离太远，先引导进场");
      ac.approach = { runwayId: cmd.runwayId, established: false };
      ac.airHolding = false;
      ac.phase = "approach";
      ac.route = null;
      ac.clearedHdg = null;
      ac.landCleared = false;
      ac.missedApproachNotified = false;
      if (ac.clearedAltM === null) ac.clearedAltM = ft(4000);
      return { ok: true, seat: "APP", radio: `跑道 ${rwy}，可以进近` };
    }

    case "land": {
      if (env.mode === "standard" && ac.controller !== "TWR") return reject("先联系塔台，再下达落地许可");
      if (ac.phase !== "approach" || !ac.approach?.established) return reject("还没建立进近");
      const reason = runwayBlockReason(env, ac);
      if (reason) return reject(reason);
      ac.landCleared = true;
      return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，可以落地` };
    }

    case "cancelLanding": {
      if (ac.phase !== "approach" || !ac.landCleared) return reject("没有可取消的落地许可");
      ac.landCleared = false;
      return { ok: true, seat: "TWR", radio: "取消落地许可，继续进近，等待指令" };
    }

    case "goAround": {
      if (ac.phase !== "approach") return reject("只有进近中的飞机可以复飞");
      goAround(ac, env);
      return { ok: true, seat: "TWR", radio: "执行复飞" };
    }

    case "lineup": {
      if (env.mode === "standard" && ac.controller !== "TWR") return reject("先联系塔台");
      if (ac.phase !== "hold_short") return reject("飞机不在跑道外等待点");
      const reason = runwayBlockReason(env, ac);
      if (reason) return reject(reason);
      ac.phase = "lineup";
      ac.route = makeRoute([ac.pos, idx.nodes.get(idx.lineupNode)!.pos]);
      env.occupyRunway(ac);
      return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，进跑道等待` };
    }

    case "takeoff": {
      if (env.mode === "standard" && ac.controller !== "TWR") return reject("先联系塔台");
      if (ac.phase !== "hold_short" && ac.phase !== "lineup") return reject("飞机还没到跑道外等待点");
      const reason = runwayBlockReason(env, ac);
      if (reason) return reject(reason);
      env.occupyRunway(ac);
      ac.takeoffPending = true;
      if (ac.phase === "hold_short") {
        ac.phase = "lineup";
        ac.route = makeRoute([ac.pos, idx.nodes.get(idx.lineupNode)!.pos]);
        return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，可以起飞` };
      }
      if (ac.route === null) {
        ac.phase = "takeoff";
        ac.gs = Math.max(ac.gs, 2);
      }
      return { ok: true, seat: "TWR", radio: `跑道 ${rwy}，可以起飞` };
    }

    case "pushback": {
      if (ac.phase !== "parked") return reject("飞机已经推出");
      if (ac.kind !== "dep") return reject("进场飞机不推出");
      const stand = idx.stands.get(ac.standId ?? "");
      if (!stand) return reject("没有分配机位");
      const apron = idx.adjacency.get(stand.node)?.find((edge) => idx.nodes.get(edge.to)?.kind === "apron");
      const path = findTaxiPath(idx, stand.node, env.mode === "standard" ? apron?.to ?? stand.node : idx.holdingNode, "dep");
      if (!path) return reject("机位与滑行道不连通");
      ac.phase = "pushback";
      ac.route = makeRoute([ac.pos, ...path.map((id) => idx.nodes.get(id)!.pos)]);
      ac.clearedHdg = cmd.hdg;
      ac.gs = 0;
      return { ok: true, seat: "GND", radio: `可以推出，机头朝${compass(cmd.hdg)}` };
    }

    case "taxi": {
      if (ac.phase !== "taxi_ready") return reject("请在推出或脱离完成后申请滑行");
      if (env.mode === "standard" && ac.controller !== "GND") return reject("请先联系地面");
      if (ac.kind === "arr" && !ac.standId) ac.standId = env.assignStand(ac);
      const route = taxiRoute(env, ac, cmd);
      if (!route) return reject("这条路线不可通行，或尚无兼容机位");
      ac.route = route; ac.holding = false; ac.blockedBy = null;
      ac.phase = ac.kind === "dep" ? "taxi_out" : "taxi_in";
      ac.groundGoal = ac.kind === "dep" ? "runway" : "stand";
      return { ok: true, seat: "GND", radio: ac.kind === "dep" ? `沿 ${cmd.route === "main" ? "B" : "B、C"} 滑行，跑道 ${rwy} 外等待` : `沿 A 滑入机位 ${ac.standId}` };
    }

    case "handoff": {
      const valid = cmd.controller === "TWR" ? ac.phase === "hold_short" || ac.phase === "approach" && ac.approach?.established :
        cmd.controller === "GND" ? ac.kind === "arr" && ac.phase === "taxi_ready" && env.runwayOccupantId !== ac.id :
        cmd.controller === "DEP" ? ac.phase === "departure" && ac.altM - idx.def.elevationM >= ft(1500) : false;
      if (!valid || ac.controller === cmd.controller) return reject("当前阶段不满足移交条件");
      ac.controller = cmd.controller; env.countHandoff(ac);
      return { ok: true, seat: cmd.controller === "DEP" ? "APP" : cmd.controller, radio: `联系${cmd.controller === "GND" ? "地面 121.7" : cmd.controller === "DEP" ? "离场 124.6" : "塔台 118.1"}` };
    }

    case "holdAir": {
      if (ac.kind !== "arr" || ac.phase !== "arrival" || ac.airHolding) return reject("只有进场引导中的飞机可以进入等待");
      const radius = 2800;
      const side = fromBearing(ac.hdg + 90, radius);
      const center = { x: ac.pos.x + side.x, y: ac.pos.y + side.y };
      const points = Array.from({ length: 17 }, (_, i) => {
        const offset = fromBearing(ac.hdg - 90 + i * 360 / 16, radius);
        return { x: center.x + offset.x, y: center.y + offset.y };
      });
      if (points.some((p) => Math.hypot(p.x, p.y) > 40000)) return reject("靠近扇区边界，先向机场引导后再等待");
      ac.route = makeRoute(points); ac.airHolding = true; ac.clearedHdg = null; ac.targetGs = kt(180);
      return { ok: true, seat: "APP", radio: "进入右转等待，保持当前高度" };
    }

    case "hold": {
      if (!["pushback", "taxi_out", "taxi_in"].includes(ac.phase)) return reject("只有推出或滑行中的飞机可以原地等待");
      ac.holding = true;
      return { ok: true, seat: ac.kind === "dep" ? "GND" : "TWR", radio: "原地等待" };
    }

    case "resume": {
      if (!["pushback", "taxi_out", "taxi_in"].includes(ac.phase)) return reject("当前阶段无法继续滑行");
      ac.holding = false;
      return { ok: true, seat: "GND", radio: "继续滑行" };
    }

    case "exit": {
      if (ac.phase !== "landing") return reject("还没接地");
      const ex = idx.exitsByDistance.find((e) => e.node === cmd.nodeId);
      if (!ex) return reject("没有这个脱离口");
      if (!usableExit(ex, alongRunway(idx, ac.pos), ac.gs)) return reject("已错过脱离口或剩余距离不足以安全减速");
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
    case "cancelLanding":
      return `取消落地许可，${cs}`;
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
    case "taxi": return `按许可路线滑行，${cs}`;
    case "handoff": return `联系 ${cmd.controller}，${cs}`;
    case "holdAir": return `右转等待，${cs}`;
  }
}

/** 指令条被拒时的态度：直接说明原因，不做"操作无效" */
export function seatOf(cmd: Command): Seat {
  switch (cmd.kind) {
    case "pushback":
    case "hold":
    case "resume":
    case "taxi":
      return "GND";
    case "lineup":
    case "takeoff":
    case "land":
    case "cancelLanding":
    case "goAround":
    case "exit":
      return "TWR";
    default:
      return "APP";
  }
}
