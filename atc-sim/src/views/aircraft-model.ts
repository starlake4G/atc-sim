import * as THREE from "three";
import { getType } from "../data/aircraft-types";
import type { Aircraft } from "../sim/types";
import { angleDiff, clamp } from "../sim/units";
import { batchStaticParts } from "./mesh-batch";

function wing(points: [number, number][], thickness: number, material: THREE.Material) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelSize: .04, bevelThickness: .04, bevelSegments: 1 });
  geometry.rotateX(Math.PI / 2);
  const position = geometry.getAttribute("position");
  for (let i = 0; i < position.count; i++) position.setY(i, position.getY(i) + Math.abs(position.getZ(i)) * .035);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/** Shared proportions, separate silhouettes. Root height is the tire contact plane. */
export function makeAircraftMesh(typeId: string, airline: string): THREE.Group {
  const type = getType(typeId);
  const length = type.lengthM;
  const wide = type.shape === "wide", prop = type.shape === "turboprop";
  const radius = wide ? 3.05 : prop ? 1.35 : typeId === "E190" ? 1.5 : 1.98;
  const span = wide ? 64.8 : prop ? 27 : typeId === "E190" ? 28.7 : 35.8;
  let hash = 0; for (const c of airline) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const colors = [0x186b92, 0xba493b, 0x287c68, 0xc79b35, 0x665295];
  const paint = new THREE.MeshStandardMaterial({ color: 0xf1f3f1, roughness: .3, metalness: .08, envMapIntensity: .65 });
  const accent = new THREE.MeshStandardMaterial({ color: colors[hash % colors.length], roughness: .34, metalness: .12, envMapIntensity: .65 });
  const metal = new THREE.MeshStandardMaterial({ color: 0x8e9a9e, roughness: .3, metalness: .7 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x17222d, roughness: .45 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x202327, roughness: .92 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x122b3d, roughness: .16, metalness: .3, envMapIntensity: 1.1 });
  const root = new THREE.Group();
  const bodyY = radius + 2.05;
  const profile: [number, number][] = [[0, 0], [.12, .025], [.38, .07], [.72, .12], [.94, .18], [1, .23], [1, .76], [.98, .83], [.9, .885], [.72, .94], [.42, .978], [.17, .994], [0, 1]];
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r * radius, x * length)), 36), paint);
  body.rotation.z = -Math.PI / 2; body.position.set(-length / 2, bodyY, 0); root.add(body);
  function skinRadius(x: number) {
    const t = x / length + .5;
    const end = profile.findIndex((point) => point[1] >= t);
    if (end <= 0) return 0;
    const [r0, x0] = profile[end - 1]!, [r1, x1] = profile[end]!;
    return radius * (r0 + (r1 - r0) * (t - x0) / (x1 - x0));
  }
  function skinPatch(x0: number, x1: number, top: number, bottom: number, side: number, material: THREE.Material) {
    const points: number[] = [], indices: number[] = [], steps = 6;
    for (let j = 0; j <= steps; j++) for (let i = 0; i <= steps; i++) {
      const x = x0 + (x1 - x0) * i / steps, angle = top + (bottom - top) * j / steps, r = skinRadius(x) + .018;
      points.push(x, bodyY + Math.cos(angle) * r, side * Math.sin(angle) * r);
      if (i < steps && j < steps) {
        const a = j * (steps + 1) + i, b = a + 1, c = a + steps + 1, d = c + 1;
        if (side > 0) indices.push(a, c, b, b, c, d); else indices.push(a, b, c, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
    // Batched geometries share the same attributes, even when a material has no texture.
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(points.length / 3 * 2), 2));
    root.add(new THREE.Mesh(geometry, material));
  }
  for (const side of [-1, 1]) {
    skinPatch(-length * .32, length * .30, 1.9, Math.PI, side, accent);
    skinPatch(-length * .29, length * .28, 1.72, 1.76, side, accent);
  }

  for (const side of [-1, 1]) {
    const main = wing([[length * .13, 0], [-length * .11, side * span / 2], [-length * .19, side * span / 2], [-length * .17, side * span * .12], [-length * .23, 0]], .28, paint);
    main.position.y = prop ? bodyY + radius * .35 : bodyY - radius * .42; root.add(main);
    const tail = wing([[-length * .31, 0], [-length * .43, side * span * .22], [-length * .49, side * span * .22], [-length * .46, 0]], .18, metal);
    tail.position.y = bodyY + radius * .25; root.add(tail);
    if (!prop) {
      const tipShape = new THREE.Shape([new THREE.Vector2(-length * .04, 0), new THREE.Vector2(-length * .023, wide ? 2.3 : 1.7), new THREE.Vector2(length * .008, wide ? 2.1 : 1.5), new THREE.Vector2(length * .02, 0)]);
      const tip = new THREE.Mesh(new THREE.ExtrudeGeometry(tipShape, { depth: .12, bevelEnabled: false }), accent);
      tip.position.set(-length * .14, main.position.y + span * .0175, side * span / 2); tip.rotation.x = side * -.18; root.add(tip);
    }
    const engineR = prop ? .65 : wide ? 1.65 : 1.05;
    const engineL = prop ? 3.5 : wide ? 7 : 4.5;
    const engineProfile = [[.56, -.5], [.84, -.32], [.98, -.1], [1, .32], [.95, .48], [.86, .5]];
    const engine = new THREE.Mesh(new THREE.LatheGeometry(engineProfile.map(([r, x]) => new THREE.Vector2(r! * engineR, x! * engineL)), 28), paint);
    engine.rotation.z = -Math.PI / 2;
    engine.position.set(length * .04, prop ? bodyY : bodyY - radius * .9, side * span * .24); root.add(engine);
    const intake = new THREE.Mesh(new THREE.CylinderGeometry(engineR * .86, engineR * .86, .1, 18), dark);
    intake.rotation.z = Math.PI / 2; intake.position.copy(engine.position); intake.position.x += engineL / 2 + .03; root.add(intake);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(engineR * .93, .08, 6, 20), metal);
    rim.rotation.y = Math.PI / 2; rim.position.copy(intake.position); root.add(rim);
    if (!prop) {
      const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(engineR * .57, engineR * .4, engineL * .22, 18), metal);
      exhaust.rotation.z = Math.PI / 2; exhaust.position.copy(engine.position); exhaust.position.x -= engineL * .45; root.add(exhaust);
      const fan = new THREE.Mesh(new THREE.ConeGeometry(engineR * .22, engineR * .65, 10), metal);
      fan.rotation.z = -Math.PI / 2; fan.position.copy(intake.position); fan.position.x += .05; root.add(fan);
      const bladeShape = new THREE.BoxGeometry(.04, engineR * .62, .1);
      for (let i = 0; i < 10; i++) { const blade = new THREE.Mesh(bladeShape, metal); const angle = i * Math.PI / 5; blade.rotation.x = angle; blade.position.set(intake.position.x + .06, intake.position.y + Math.cos(angle) * engineR * .48, intake.position.z + Math.sin(angle) * engineR * .48); root.add(blade); }
    }
    if (!prop) {
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(engineL * .55, 1.25, .35), paint);
      pylon.position.copy(engine.position); pylon.position.y += engineR * .8; root.add(pylon);
    }
    if (prop) {
      const rotor = new THREE.Group(); rotor.position.copy(intake.position); rotor.position.x += .2;
      for (let i = 0; i < 6; i++) {
        const blade = new THREE.Mesh(new THREE.BoxGeometry(.12, 2.7, .2), dark);
        blade.rotation.x = i * Math.PI / 3; rotor.add(blade);
      }
      root.add(rotor); (root.userData.rotors ??= []).push(rotor);
    }
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(.22, 6, 4), new THREE.MeshBasicMaterial({ color: side < 0 ? 0xf54c4c : 0x63e9b8 }));
    lamp.position.set(-length * .15, main.position.y + span * .0175, side * span / 2); root.add(lamp);
  }
  const finHeight = wide ? 9.8 : prop ? 5.3 : 6.5;
  const finShape = new THREE.Shape([new THREE.Vector2(-length * .13, 0), new THREE.Vector2(-length * .08, finHeight), new THREE.Vector2(-length * .025, finHeight * .94), new THREE.Vector2(length * .065, 0)]);
  const fin = new THREE.Mesh(new THREE.ExtrudeGeometry(finShape, { depth: .3, bevelEnabled: true, bevelSize: .08, bevelThickness: .08, bevelSegments: 1 }), accent);
  fin.position.set(-length * .32, bodyY + radius * .55, -.15); root.add(fin);
  const crestPaint = paint.clone(); crestPaint.side = THREE.DoubleSide;
  for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
    const baseX = -length * .32, baseY = bodyY + radius * .55, offset = i * .009;
    const crest = new THREE.Shape([new THREE.Vector2(baseX + length * (-.085 + offset), baseY + finHeight * .28), new THREE.Vector2(baseX + length * (-.065 + offset), baseY + finHeight * .65), new THREE.Vector2(baseX + length * (-.045 + offset), baseY + finHeight * .56)]);
    const feather = new THREE.Mesh(new THREE.ShapeGeometry(crest), crestPaint); feather.position.z = side > 0 ? .255 : -.255;
    root.add(feather);
  }

  const windowCount = Math.max(12, Math.round(length * .65));
  const windowGeometry = new THREE.CapsuleGeometry(.19, .16, 3, 6); windowGeometry.scale(.9, 1, .14);
  const windows = new THREE.InstancedMesh(windowGeometry, glass, windowCount * 2);
  const matrix = new THREE.Matrix4();
  for (const side of [-1, 1]) for (let i = 0; i < windowCount; i++) {
    matrix.makeTranslation(-length * .27 + i / windowCount * length * .58, bodyY + radius * .32, side * radius * .955);
    windows.setMatrixAt((side < 0 ? 0 : windowCount) + i, matrix);
  }
  root.add(windows);
  for (const side of [-1, 1]) {
    for (const [start, end] of [[.325, .36], [.366, .401], [.407, .44]]) skinPatch(length * start!, length * end!, .48, 1.15, side, glass);
    for (const x of [length * .28, -length * .29]) {
      skinPatch(x - .4, x - .35, .95, 1.98, side, metal); skinPatch(x + .35, x + .4, .95, 1.98, side, metal);
      skinPatch(x - .4, x + .4, .95, .98, side, metal); skinPatch(x - .4, x + .4, 1.95, 1.98, side, metal);
    }
  }

  const gear = new THREE.Group();
  for (const [x, z] of [[length * .31, 0], [-length * .12, -radius * 1.25], [-length * .12, radius * 1.25]]) {
    const gearTop = z === 0 ? bodyY - skinRadius(x!) + .12 : prop ? bodyY - radius * .75 : bodyY - radius * .42 - .25 + Math.abs(z!) * .035;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(.12, .17, gearTop - .8, 8), metal); strut.position.set(x!, (gearTop + .8) / 2, z!); gear.add(strut);
    if (prop && z !== 0) { const pod = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), paint); pod.scale.set(1.6, .5, .45); pod.position.set(x!, gearTop, Math.sign(z!) * radius * 1.08); root.add(pod); }
    for (const side of [-1, 1]) for (let axle = 0; axle < (wide && z !== 0 ? 3 : 1); axle++) {
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(.64, .64, .34, 12), rubber);
      tire.rotation.x = Math.PI / 2; tire.position.set(x! + (axle - (wide && z !== 0 ? 1 : 0)) * 1.2, .64, z! + side * .34); gear.add(tire);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(.27, .27, .36, 10), metal); hub.rotation.x = Math.PI / 2; hub.position.copy(tire.position); gear.add(hub);
    }
  }
  root.userData.gear = gear; root.add(gear);
  for (const y of [bodyY + radius + .15, bodyY - radius - .15]) {
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(.2, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff5449, transparent: true }));
    beacon.position.set(-length * .03, y, 0); root.add(beacon); (root.userData.beacons ??= []).push(beacon);
  }
  batchStaticParts(gear);
  for (const rotor of root.userData.rotors ?? []) batchStaticParts(rotor);
  batchStaticParts(root, new Set(root.userData.beacons ?? []));
  root.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } });
  return root;
}

export function updateAircraftModel(mesh: THREE.Group, ac: Aircraft, dt: number, elevation: number, time = 0) {
  (mesh.userData.gear as THREE.Group).visible = ac.altM - elevation < 80 || ac.phase === "approach" && ac.altM - elevation < 500;
  mesh.rotation.order = "YZX";
  const airborne = ["arrival", "approach", "departure"].includes(ac.phase);
  const previous = mesh.userData.pose as { time: number; hdg: number } | undefined;
  const elapsed = previous ? time - previous.time : 0;
  for (const rotor of mesh.userData.rotors ?? []) rotor.rotation.x = (rotor.rotation.x + Math.max(0, elapsed) * (ac.gs > .5 ? 38 : 3)) % (Math.PI * 2);
  const turnRate = previous && elapsed > .001 && elapsed < 2 ? angleDiff(ac.hdg, previous.hdg) / elapsed * Math.PI / 180 : 0;
  if (!previous || elapsed < 0) mesh.userData.bankTarget = 0;
  if (elapsed > .001 && elapsed < 2) mesh.userData.bankTarget = clamp(Math.atan(turnRate * ac.gs / 9.81), -.44, .44);
  const bank = airborne ? (mesh.userData.bankTarget ?? 0) : 0;
  const flare = ac.phase === "approach" && ac.altM - elevation < 20;
  const landingPitch = ac.phase === "landing" && ac.touchdownAt !== null ? .07 * Math.max(0, 1 - (time - ac.touchdownAt) / 4) : 0;
  const pitch = flare ? .07 : airborne ? clamp(Math.atan2(ac.vs, Math.max(1, ac.gs)) + (ac.phase === "approach" ? .045 : 0), -.09, .16) : landingPitch;
  if (airborne || ac.phase === "landing" && landingPitch > 0) {
    const blend = 1 - Math.exp(-dt * 5);
    mesh.rotation.x += (bank - mesh.rotation.x) * blend; mesh.rotation.z += (pitch - mesh.rotation.z) * blend;
  } else { mesh.rotation.x = mesh.rotation.z = 0; }
  if (!previous || elapsed < 0 || elapsed > .001) mesh.userData.pose = { time, hdg: ac.hdg };
  for (const beacon of mesh.userData.beacons ?? []) beacon.material.opacity = ac.phase === "parked" ? .2 : Math.sin(time * 5) > .7 ? 1 : .12;
}
