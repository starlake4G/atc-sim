import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AirportIndex } from "../sim/airport";
import { pavementMaterial, projectPavementUV, rubberMarks, terminalGlassMaterial } from "./surface-textures";
import type { LightPeriod } from "./lighting";

export function buildAirportModel(idx: AirportIndex, period: LightPeriod = "day", detailed = true): THREE.Group {
  const root = new THREE.Group();
  const cache = new Map<string, THREE.MeshStandardMaterial>();
  const mat = (color: number, roughness = .8, metalness = 0) => {
    const key = `${color}/${roughness}/${metalness}`;
    if (!cache.has(key)) cache.set(key, new THREE.MeshStandardMaterial({ color, roughness, metalness }));
    return cache.get(key)!;
  };
  const asphalt = pavementMaterial("asphalt", detailed), runwayMat = pavementMaterial("runway", detailed), concrete = pavementMaterial("concrete", detailed);
  const white = mat(0xe5e5db), yellow = mat(0xe6bb50), wall = mat(0xc3c8c7), metal = mat(0x667b88, .42, .55);
  function box(w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); mesh.position.set(x, y, -z); mesh.castShadow = h > 2; mesh.receiveShadow = true; root.add(mesh); return mesh;
  }
  function line(a: { x: number; y: number }, b: { x: number; y: number }, width: number, material: THREE.Material, height = .12) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const mesh = box(width, .04, Math.hypot(dx, dy), (a.x + b.x) / 2, height, (a.y + b.y) / 2, material);
    mesh.rotation.y = -Math.atan2(dx, dy); mesh.castShadow = false; return mesh;
  }
  function label(text: string, x: number, z: number, width: number, depth: number, color = "#e9e7d2") {
    const c = document.createElement("canvas"); c.width = 256; c.height = 96;
    const g = c.getContext("2d")!; g.fillStyle = color; g.font = "bold 62px sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 128, 48);
    const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(x, .18, -z); root.add(mesh);
  }
  const pixels = new Uint8Array(128 * 128 * 4);
  let seed = 71421;
  for (let i = 0; i < 128 * 128; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const value = 155 + (seed >>> 26) * .32 + Math.sin(i % 128 / 7) * 3;
    pixels.set([value * .93, value, value * .82, 255], i * 4);
  }
  const grassTexture = new THREE.DataTexture(pixels, 128, 128);
  grassTexture.colorSpace = THREE.SRGBColorSpace; grassTexture.wrapS = grassTexture.wrapT = THREE.RepeatWrapping;
  grassTexture.magFilter = THREE.LinearFilter; grassTexture.minFilter = THREE.LinearMipmapLinearFilter; grassTexture.generateMipmaps = true; grassTexture.needsUpdate = true;
  const grass = new THREE.MeshStandardMaterial({ color: 0x9eae87, map: grassTexture, roughness: 1, vertexColors: true });
  grass.userData.worldTile = 52;
  // Large two-triangle ground planes lose depth interpolation precision at low
  // camera angles. Tessellation keeps nearby pavement above the terrain.
  const terrain = new THREE.Mesh(new THREE.PlaneGeometry(90000, 90000, 256, 256), grass);
  const groundPoints = terrain.geometry.getAttribute("position"), colors = new Float32Array(groundPoints.count * 3);
  for (let i = 0; i < groundPoints.count; i++) {
    const x = groundPoints.getX(i), z = groundPoints.getY(i);
    const shade = .89 + Math.sin(x / 1100 + Math.cos(z / 670)) * .06 + Math.sin(z / 550 + x / 1700) * .035;
    colors.set([shade, shade, shade], i * 3);
  }
  terrain.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  terrain.name = "terrain";
  terrain.rotation.x = -Math.PI / 2; terrain.position.y = -.18; terrain.receiveShadow = true; root.add(terrain);
  // Quiet bands of mown grass express scale without noisy repeated texture.
  const mownGrass = grass.clone(); mownGrass.color.setHex(0xa1b18a); mownGrass.vertexColors = false;
  for (let i = -3; i <= 5; i++) box(2900, .02, 72, 0, -.12, i * 144, mownGrass);
  box(2480, .04, 85, 0, -.03, 0, mat(0x777c70));
  box(2400, .04, 45, 0, .02, 0, runwayMat);
  line({ x: -1190, y: 20 }, { x: 1190, y: 20 }, .7, white);
  line({ x: -1190, y: -20 }, { x: 1190, y: -20 }, .7, white);
  for (let x = -1060; x <= 1060; x += 110) box(48, .035, 1, x, .11, 0, white);
  for (const side of [-1, 1]) {
    for (const y of [-15, -11, -7, 7, 11, 15]) box(38, .04, 2, side * 1160, .12, y, white);
    for (const y of [-10, 10]) box(45, .04, 5, side * 900, .12, y, white);
    label(side > 0 ? "27" : "09", side * 1070, 0, 35, 18);
    const rubber = rubberMarks(); rubber.position.x = side * 810; root.add(rubber);
  }
  const drawn = new Set<string>();
  for (const edge of idx.def.edges) {
    const key = [edge.a, edge.b].sort().join("|"); if (drawn.has(key)) continue; drawn.add(key);
    const a = idx.nodes.get(edge.a)!.pos, b = idx.nodes.get(edge.b)!.pos;
    line(a, b, 25, concrete, .02); line(a, b, 21, asphalt, .06); line(a, b, .65, yellow, .12);
  }
  box(1300, .035, 175, -200, .015, 450, concrete);
  // Texture slabs use an 8 m grid; a few repair strips break up the larger apron.
  for (const x of [-620, -220, 160]) line({ x, y: 370 }, { x, y: 531 }, .2, asphalt, .09);

  const signCanvasAtlas = document.createElement("canvas"); signCanvasAtlas.width = 1024; signCanvasAtlas.height = 640;
  const sg = signCanvasAtlas.getContext("2d")!;
  const signTexts = [...idx.def.stands.map((s) => `GATE ${s.id.slice(1)}`), "← A · APRON", "B · RWY 27 →", "C · BYPASS →", "H27 | 27-09"];
  for (let i = 0; i < signTexts.length; i++) {
    const x = i % 2 * 512, y = Math.floor(i / 2) * 128;
    sg.fillStyle = i < 6 ? "#173b4c" : "#1b2225"; sg.fillRect(x, y, 512, 128);
    sg.strokeStyle = i < 6 ? "#b2d6df" : "#e9bf55"; sg.lineWidth = 5; sg.strokeRect(x + 7, y + 7, 498, 114);
    sg.fillStyle = i < 6 ? "#e2eceb" : "#f4d274"; sg.font = "600 54px sans-serif"; sg.textAlign = "center"; sg.textBaseline = "middle"; sg.fillText(signTexts[i]!, x + 256, y + 65);
  }
  const signsMap = new THREE.CanvasTexture(signCanvasAtlas); signsMap.colorSpace = THREE.SRGBColorSpace; signsMap.anisotropy = 4;
  const signs = new THREE.MeshStandardMaterial({ map: signsMap, roughness: .65, emissiveMap: signsMap, emissive: 0xffffff, emissiveIntensity: period === "day" ? .08 : .6 });
  function board(index: number, x: number, y: number, z: number, width: number, height: number) {
    const geometry = new THREE.PlaneGeometry(width, height), uv = geometry.getAttribute("uv"), column = index % 2, row = Math.floor(index / 2);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (column + uv.getX(i)) / 2, 1 - (row + 1 - uv.getY(i)) / 5);
    const mesh = new THREE.Mesh(geometry, signs); mesh.position.set(x, y, -z); root.add(mesh);
  }
  for (const stand of idx.def.stands) {
    line({ x: stand.pos.x, y: 422 }, stand.pos, .8, yellow, .13);
    line({ x: stand.pos.x - 9, y: stand.pos.y }, { x: stand.pos.x + 9, y: stand.pos.y }, .9, yellow, .13);
    label(stand.id, stand.pos.x, stand.pos.y + 26, 17, 8, "#ead271");
    box(7, 4.2, 55, stand.pos.x - 10, 7, 554, metal);
    const head = box(12, 5.6, 9, stand.pos.x - 6, 7, 529, wall); head.rotation.y = -.25;
    box(5, 3, .12, stand.pos.x - 7, 7.3, 524, metal);
    board(idx.def.stands.indexOf(stand), stand.pos.x - 7, 11.8, 524, 10, 2.5);
    box(4.8, 1.8, 48, stand.pos.x - 10, 7.5, 553, metal);
    for (let z = 533; z <= 574; z += 7) box(7.4, .2, .3, stand.pos.x - 10, 9.2, z, white);
    box(1.8, 7, 1.8, stand.pos.x - 10, 3.5, 550, metal);
    // Equipment sits outside the stand's pushback corridor.
    box(4, 1.8, 7, stand.pos.x - 58, 1.5, 506, white);
    box(3.8, 2.2, 2.5, stand.pos.x - 58, 2.5, 503, mat(0x527783));
    for (const offset of [-2.3, 2.3]) box(7, .75, 1, stand.pos.x - 58, .5, 506 + offset, runwayMat);
    for (let i = 0; i < 3; i++) { box(2.8, .7, 4, stand.pos.x - 72, .8, 503 + i * 5, metal); box(2.2, .6, 3, stand.pos.x - 72, 1.4, 503 + i * 5, white); }
  }
  // Explicit dimensions avoid the old 720 m stretched cylinder roof.
  for (const x of [-760, -460, -160]) {
    box(140, 22, 95, x, 11, -260, wall);
    const roofShape = new THREE.Shape([new THREE.Vector2(-75, 0), new THREE.Vector2(0, 12), new THREE.Vector2(75, 0)]);
    const roof = new THREE.Mesh(new THREE.ExtrudeGeometry(roofShape, { depth: 104, bevelEnabled: false }), metal);
    roof.name = "hangar-roof";
    roof.position.set(x, 22, 208); roof.castShadow = true; root.add(roof);
    box(105, 15, .8, x, 7.5, -211.7, mat(0x4c5f66));
    for (let i = -2; i <= 2; i++) box(1, 15, 1, x + i * 21, 7.5, -211, wall);
    for (let offset = -60; offset <= 60; offset += 15) box(.5, .4, 104, x + offset, 22 + 12 * (1 - Math.abs(offset) / 75) + .2, -260, wall);
  }
  box(1370, 17, 72, -200, 8.5, 605, wall);
  box(1390, 1.2, 82, -200, 18, 605, metal);
  box(1394, .5, 84, -200, 18.8, 605, white);
  const glass = terminalGlassMaterial(period !== "day");
  box(1340, 10.5, 1, -200, 10, 568.5, glass);
  for (let x = -850; x < 480; x += 25) box(.7, 11, 1.5, x, 10, 567.6, metal);
  box(1340, .35, 2, -200, 7.8, 567, metal);
  for (const x of [-760, -360, 40, 400]) {
    box(28, 23, 67, x, 11.5, 607, wall);
    box(24, 17, 1.2, x, 12.5, 572.5, glass);
    box(33, .8, 72, x, 23.4, 607, metal);
  }
  for (let x = -850; x <= 475; x += 40) box(.45, .35, 76, x, 19.3, 605, white);
  for (let x = -700; x <= 300; x += 200) box(35, 3, 20, x, 21, 605, metal);
  const signCanvas = document.createElement("canvas"); signCanvas.width = 1024; signCanvas.height = 128;
  const signContext = signCanvas.getContext("2d")!; signContext.font = "600 72px sans-serif"; signContext.fillStyle = "#d5e9e4"; signContext.textAlign = "center"; signContext.fillText("K E S T R E L", 512, 90);
  const signTexture = new THREE.CanvasTexture(signCanvas); signTexture.colorSpace = THREE.SRGBColorSpace;
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(130, 16), new THREE.MeshBasicMaterial({ map: signTexture, transparent: true, depthWrite: false }));
  sign.position.set(-200, 12, -567.5); root.add(sign);
  const lightFace = new THREE.MeshStandardMaterial({ color: 0xfff1db, emissive: 0xffe3b5, emissiveIntensity: period === "day" ? .03 : 2, roughness: .5 });
  for (const stand of idx.def.stands) { const x = stand.pos.x - 55; box(.7, 46, .7, x, 23, 550, metal); box(5, .5, 3, x, 46, 550, metal); box(4.5, .1, 2.7, x, 45.7, 550, lightFace); }
  const tw = idx.def.tower;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(5, 9, tw.heightM, 12), wall); shaft.position.set(tw.pos.x, tw.heightM / 2, -tw.pos.y); root.add(shaft);
  const cab = new THREE.Mesh(new THREE.CylinderGeometry(12, 8, 7, 8), glass); cab.position.set(tw.pos.x, tw.heightM, -tw.pos.y); root.add(cab);
  box(25, 2, 25, tw.pos.x, tw.heightM + 4, tw.pos.y, metal);
  box(.6, 11, .6, tw.pos.x, tw.heightM + 10, tw.pos.y, white);
  for (const [text, x, z] of [["A ←", -850, 150], ["B →", -850, 330], ["C →", 800, 250], ["H27", 1080, 145]] as const) label(text, x, z, 32, 10, "#f2ce67");
  for (const [i, x, z] of [[6, -730, 174], [7, -550, 354], [8, 745, 273], [9, 1074, 178]]) {
    board(i!, x!, 2.2, z!, i === 9 ? 8 : 10, 2.2);
    box(.16, 1.5, .16, x! - 3, .8, z!, metal); box(.16, 1.5, .16, x! + 3, .8, z!, metal);
  }
  for (let i = 0; i < 4; i++) line({ x: 1075 + i * 2, y: 104 }, { x: 1100 + i * 2, y: 108 }, .75, yellow);
  // One draw call per lamp color, instead of hundreds of dynamic light sources.
  const lamps: { x: number; z: number; color: string }[] = [];
  for (let x = -1190; x <= 1190; x += 60) for (const z of [-24, 24]) lamps.push({ x, z, color: "white" });
  for (let x = 1230; x <= 1650; x += 45) for (const z of [-4, 0, 4]) lamps.push({ x, z, color: "white" });
  for (let x = -1150; x <= 1150; x += 70) for (const z of [138, 162, 318, 342]) lamps.push({ x, z, color: "blue" });
  for (let x = -1150; x <= 1090; x += 70) for (const z of [238, 262]) lamps.push({ x, z, color: "blue" });
  for (let z = -18; z <= 18; z += 4.5) { lamps.push({ x: 1195, z, color: "green" }); lamps.push({ x: -1195, z, color: "red" }); }
  const lampColors: Record<string, number> = { white: 0xffe6b3, blue: 0x419ce1, green: 0x63e6aa, red: 0xff7663 };
  for (const color of Object.keys(lampColors)) {
    const positions = lamps.filter((p) => p.color === color);
    const instanced = new THREE.InstancedMesh(new THREE.SphereGeometry(.3, 5, 4), new THREE.MeshBasicMaterial({ color: lampColors[color] }), positions.length);
    positions.forEach((p, i) => instanced.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, .55, -p.z))); root.add(instanced);
  }
  if (period !== "day") {
    // Small screen-sized halos keep distant runway lights readable; one draw call for all colors.
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32; const g = canvas.getContext("2d")!;
    const radial = g.createRadialGradient(16, 16, 0, 16, 16, 16); radial.addColorStop(0, "rgba(255,255,255,1)"); radial.addColorStop(.2, "rgba(255,255,255,.65)"); radial.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = radial; g.fillRect(0, 0, 32, 32);
    const geometry = new THREE.BufferGeometry(), positions: number[] = [], colors: number[] = [];
    for (const lamp of lamps) { positions.push(lamp.x, .8, -lamp.z); const color = new THREE.Color(lampColors[lamp.color]); colors.push(color.r, color.g, color.b); }
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    root.add(new THREE.Points(geometry, new THREE.PointsMaterial({ map: new THREE.CanvasTexture(canvas), size: period === "night" ? 5 : 3, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: period === "night" ? .9 : .35 })));
  }
  for (let i = 0; i < 18; i++) {
    const x = -3500 + i * 440 + Math.sin(i * 19) * 170; const h = 12 + (i % 5) * 9;
    box(110 + i % 3 * 60, h, 100 + i % 4 * 20, x, h / 2, 2600 + (i % 4) * 190, mat(0x81918e));
  }
  const hills = mat(0x69816a);
  for (let i = 0; i < 9; i++) {
    const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), hills);
    hill.position.set(-10500 + i * 2500, -60, (i % 2 ? 1 : -1) * (6500 + (i % 3) * 1100)); hill.scale.set(2000, 180 + i % 4 * 80, 1700); root.add(hill);
  }
  // Landside circulation and parking add scale without entering operational pavement.
  const road = mat(0x596363), roadMark = mat(0xaeb6a8);
  const roadPoints = [{ x: -1430, y: -530 }, { x: 1440, y: -530 }, { x: 1440, y: 850 }, { x: -1430, y: 850 }, { x: -1430, y: -530 }];
  for (let i = 1; i < roadPoints.length; i++) { line(roadPoints[i - 1]!, roadPoints[i]!, 14, road, .01); line(roadPoints[i - 1]!, roadPoints[i]!, .3, roadMark, .07); }
  line({ x: -1100, y: 688 }, { x: 850, y: 688 }, 18, road, .01);
  line({ x: -1050, y: 688 }, { x: -1050, y: 850 }, 14, road, .01);
  box(1150, .04, 110, -220, .02, 770, asphalt);
  for (let x = -775; x <= 335; x += 14) for (const y of [735, 795]) line({ x, y: y - 12 }, { x, y: y + 12 }, .3, roadMark, .08);
  for (let i = 0; i < 35; i++) { const x = -755 + i * 29, y = i % 3 ? 737 : 794; box(2.6, 1.5, 5.5, x, .9, y, i % 3 ? wall : metal); box(2.3, .7, 3, x, 1.9, y, glass); }
  const treeCount = 420;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(.9, 1.4, 7, 5), mat(0x685e49), treeCount);
  const crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat(0x3e624e), treeCount);
  const dummy = new THREE.Object3D();
  const groves = [[-1800, 1250], [-900, 1300], [400, 1200], [1700, 1350], [-1900, -1400], [500, -1500]];
  for (let i = 0; i < treeCount; i++) {
    const center = groves[Math.floor(i / 70)]!, angle = i * 2.39996, radius = Math.sqrt((i % 70 + .5) / 70) * 260;
    const x = center[0]! + Math.cos(angle) * radius, z = center[1]! + Math.sin(angle) * radius;
    const scale = 5 + i % 7, stretch = .8 + (i % 5) * .11;
    dummy.position.set(x + Math.sin(i * 13) * 24, 3.5, -z + Math.cos(i * 7) * 18); dummy.scale.set(1, 1, 1); dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.y = 8 + scale * .45; dummy.rotation.y = i * 1.7; dummy.scale.set(scale, scale * stretch, scale * .8); dummy.updateMatrix(); crowns.setMatrixAt(i, dummy.matrix);
    crowns.setColorAt(i, new THREE.Color().setHSL(.27 + (i % 9) * .006, .2 + (i % 3) * .03, .24 + (i % 5) * .015));
  }
  trunks.castShadow = crowns.castShadow = true; root.add(trunks, crowns);
  // Merge static structures by material to keep the richer airport affordable on integrated GPUs.
  const batches = new Map<string, THREE.Mesh[]>();
  for (const child of [...root.children]) {
    if (child instanceof THREE.Mesh) projectPavementUV(child);
    if (!(child instanceof THREE.Mesh) || child.name || child instanceof THREE.InstancedMesh || Array.isArray(child.material) || child.material instanceof THREE.MeshBasicMaterial) continue;
    const key = `${child.material.uuid}/${child.castShadow}`;
    batches.set(key, [...batches.get(key) ?? [], child]);
  }
  for (const group of batches.values()) {
    if (group.length < 2) continue;
    const geometries = group.map((mesh) => { mesh.updateMatrix(); const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone(); return geometry.applyMatrix4(mesh.matrix); });
    const merged = mergeGeometries(geometries);
    if (merged) {
      const mesh = new THREE.Mesh(merged, group[0]!.material); mesh.castShadow = group[0]!.castShadow; mesh.receiveShadow = true;
      group.forEach((original) => { root.remove(original); original.geometry.dispose(); }); root.add(mesh);
    }
    geometries.forEach((geometry) => geometry.dispose());
  }
  return root;
}
