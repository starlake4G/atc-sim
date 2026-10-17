import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { getType } from "../data/aircraft-types";
import type { World } from "../sim/world";
import { toFt, toKt } from "../sim/units";

export type ViewMode = "tower" | "follow" | "top";

const AIRLINE_COLORS = [0x2f6fbf, 0xd9a02a, 0xc9453f, 0x2f9e7a, 0x8a5bbf, 0xcf6f2e, 0x5d7f8f];

function airlineColor(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AIRLINE_COLORS[h % AIRLINE_COLORS.length] as number;
}

/** 世界坐标（x 东 / y 北 / z 高，米）→ three.js（y 上，z 指向南） */
const wx = (x: number) => x;
const wz = (y: number) => -y;

function runwayTexture(lengthM: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "#2f3238";
  g.fillRect(0, 0, 2048, 96);
  g.fillStyle = "#d9dbe0";
  g.fillRect(0, 5, 2048, 2);
  g.fillRect(0, 89, 2048, 2);
  for (let x = 70; x < 1990; x += 96) g.fillRect(x, 46, 46, 4);

  for (let i = 0; i < 8; i++) {
    g.fillRect(46, 14 + i * 10, 44, 6);
    g.fillRect(1958, 14 + i * 10, 44, 6);
  }

  g.save();
  g.fillStyle = "#eceef2";
  g.font = "700 46px system-ui, sans-serif";
  g.translate(210, 48);
  g.rotate(-Math.PI / 2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("27", 0, 0);
  g.restore();

  g.save();
  g.translate(1838, 48);
  g.rotate(-Math.PI / 2);
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("09", 0, 0);
  g.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  void lengthM;
  return tex;
}

function makeAircraftMesh(typeId: string, airline: string): THREE.Group {
  const t = getType(typeId);
  const g = new THREE.Group();
  const L = t.lengthM;
  const span = L * (t.shape === "wide" ? 0.9 : 0.95);
  const bodyR = t.shape === "wide" ? 2.9 : t.shape === "turboprop" ? 1.3 : 1.9;
  const white = new THREE.MeshStandardMaterial({ color: 0xe7e9ee, roughness: 0.55, metalness: 0.1 });
  const accent = new THREE.MeshStandardMaterial({ color: airlineColor(airline), roughness: 0.5, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(bodyR, bodyR, L * 0.74, 12), white);
  body.rotation.z = Math.PI / 2;
  g.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(bodyR, L * 0.16, 12), white);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = L * 0.45;
  g.add(nose);

  const tailCone = new THREE.Mesh(new THREE.ConeGeometry(bodyR, L * 0.14, 12), white);
  tailCone.rotation.z = Math.PI / 2;
  tailCone.position.x = -L * 0.44;
  g.add(tailCone);

  const wings = new THREE.Mesh(new THREE.BoxGeometry(L * 0.2, 0.5, span), white);
  wings.position.set(L * 0.02, -bodyR * 0.25, 0);
  g.add(wings);

  const tailPlane = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, 0.35, span * 0.36), white);
  tailPlane.position.set(-L * 0.36, 0.2, 0);
  g.add(tailPlane);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(L * 0.12, L * 0.14, 0.4), accent);
  fin.position.set(-L * 0.37, L * 0.09, 0);
  g.add(fin);

  const engineCount = t.shape === "turboprop" ? 0 : 2;
  for (let i = 0; i < engineCount; i++) {
    const s = i === 0 ? -1 : 1;
    const eng = new THREE.Mesh(new THREE.CylinderGeometry(bodyR * 0.5, bodyR * 0.5, L * 0.11, 10), dark);
    eng.rotation.z = Math.PI / 2;
    eng.position.set(L * 0.05, -bodyR * 0.55, s * span * 0.24);
    g.add(eng);
  }
  if (t.shape === "turboprop") {
    for (const s of [-1, 1]) {
      const eng = new THREE.Mesh(new THREE.BoxGeometry(L * 0.13, bodyR * 0.8, bodyR * 0.8), accent);
      eng.position.set(L * 0.03, -0.2, s * span * 0.26);
      g.add(eng);
    }
  }

  for (const s of [-1, 1]) {
    const gear = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.2, 2.2), dark);
    gear.position.set(L * 0.06, -bodyR - 0.8, s * span * 0.18);
    g.add(gear);
  }

  const windshield = new THREE.Mesh(new THREE.BoxGeometry(L * 0.055, bodyR * 0.42, bodyR * 1.15), dark);
  windshield.position.set(L * 0.355, bodyR * 0.42, 0);
  g.add(windshield);

  for (const s of [-1, 1]) {
    const winglet = new THREE.Mesh(new THREE.BoxGeometry(L * 0.02, bodyR * 1.1, 0.25), accent);
    winglet.position.set(L * 0.02, bodyR * 0.55, s * span * 0.5);
    g.add(winglet);
  }

  const belly = new THREE.Mesh(new THREE.BoxGeometry(L * 0.6, 0.3, bodyR * 1.6), dark);
  belly.position.set(-L * 0.02, -bodyR * 0.92, 0);
  g.add(belly);

  return g;
}

export class Scene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private aircraftLayer = new THREE.Group();
  private labels: HTMLDivElement;
  private labelEls = new Map<string, HTMLDivElement>();
  private meshes = new Map<string, THREE.Group>();
  private view: ViewMode = "tower";
  private followId: string | null = null;
  private lastFollowId: string | null = null;
  private world: World;
  private raf = 0;
  private lastTime = 0;
  private tmp = new THREE.Vector3();
  private onSelect: (id: string | null) => void;
  private boundClick: (e: MouseEvent) => void;
  private resizeObs: ResizeObserver;
  private el: HTMLElement;
  private shadows: boolean;

  constructor(
    el: HTMLElement,
    labelsEl: HTMLDivElement,
    world: World,
    onSelect: (id: string | null) => void,
    opts: { shadows?: boolean } = {},
  ) {
    this.el = el;
    this.world = world;
    this.onSelect = onSelect;
    this.labels = labelsEl;
    this.shadows = opts.shadows !== false;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(this.shadows ? Math.min(window.devicePixelRatio, 2) : 1);
    this.renderer.setSize(el.clientWidth, el.clientHeight);
    this.renderer.shadowMap.enabled = this.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    el.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(58, el.clientWidth / Math.max(1, el.clientHeight), 2, 60000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 9000;

    this.buildSky();
    this.buildLights();
    this.buildAirport();
    this.scene.add(this.aircraftLayer);
    this.setView("tower");

    this.boundClick = (e: MouseEvent) => this.handleClick(e);
    this.renderer.domElement.addEventListener("click", this.boundClick);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(el);
    this.resize();
  }

  private buildSky(): void {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 256;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "#1f4f88");
    grad.addColorStop(0.42, "#7fb0d8");
    grad.addColorStop(0.56, "#cfe2ef");
    grad.addColorStop(1, "#c9d8c6");
    g.fillStyle = grad;
    g.fillRect(0, 0, 8, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(42000, 24, 16);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false });
    this.scene.add(new THREE.Mesh(geo, mat));
    this.scene.fog = new THREE.Fog(0xc4d8e8, 3000, 26000);
  }

  private buildLights(): void {
    const hemi = new THREE.HemisphereLight(0xe8f2fb, 0x4a5744, 1.25);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xfff2d8, 2.8);
    sun.position.set(1300, 1150, 1500);
    sun.castShadow = this.shadows;
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = -1800;
    cam.right = 1800;
    cam.top = 1800;
    cam.bottom = -1800;
    cam.near = 100;
    cam.far = 6000;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
  }

  private buildAirport(): void {
    const idx = this.world.idx;
    const def = idx.def;

    const grass = document.createElement("canvas");
    grass.width = 128;
    grass.height = 128;
    const gctx = grass.getContext("2d")!;
    gctx.fillStyle = "#4f6042";
    gctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 2600; i++) {
      const v = 0.82 + Math.random() * 0.36;
      gctx.fillStyle = `rgba(${Math.round(70 * v)}, ${Math.round(88 * v)}, ${Math.round(56 * v)}, 0.55)`;
      gctx.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
    const grassTex = new THREE.CanvasTexture(grass);
    grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(60, 60);
    grassTex.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(24000, 24000),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const asphalt = new THREE.MeshStandardMaterial({ color: 0x585d66, roughness: 0.95 });
    const lineYellow = new THREE.MeshStandardMaterial({ color: 0xd8b03c, roughness: 0.7 });

    // 跑道
    const rwy = def.runways.find((r) => r.id === idx.runway.id)!;
    const rwyMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(rwy.lengthM, rwy.widthM),
      new THREE.MeshStandardMaterial({ map: runwayTexture(rwy.lengthM), roughness: 0.92 }),
    );
    rwyMesh.rotation.x = -Math.PI / 2;
    rwyMesh.position.set((rwy.threshold.x + rwy.end.x) / 2, 0.05, wz((rwy.threshold.y + rwy.end.y) / 2));
    rwyMesh.receiveShadow = true;
    this.scene.add(rwyMesh);

    // 滑行道
    for (const e of def.edges) {
      const a = idx.nodes.get(e.a);
      const b = idx.nodes.get(e.b);
      if (!a || !b) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ang = Math.atan2(dx, dy);
      const slab = new THREE.Mesh(new THREE.PlaneGeometry(18, len), asphalt);
      slab.rotation.x = -Math.PI / 2;
      slab.rotation.z = -ang;
      slab.position.set((a.pos.x + b.pos.x) / 2, 0.04, wz((a.pos.y + b.pos.y) / 2));
      slab.receiveShadow = true;
      this.scene.add(slab);

      const line = new THREE.Mesh(new THREE.PlaneGeometry(1.1, len), lineYellow);
      line.rotation.x = -Math.PI / 2;
      line.rotation.z = -ang;
      line.position.set((a.pos.x + b.pos.x) / 2, 0.08, wz((a.pos.y + b.pos.y) / 2));
      this.scene.add(line);
    }

    // 机坪
    const xs = def.stands.map((s) => s.pos.x);
    const minX = Math.min(...xs) - 70;
    const maxX = Math.max(...xs) + 70;
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, 200), asphalt);
    apron.rotation.x = -Math.PI / 2;
    apron.position.set((minX + maxX) / 2, 0.03, wz(330));
    apron.receiveShadow = true;
    this.scene.add(apron);

    for (const s of def.stands) {
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 40), lineYellow);
      mark.rotation.x = -Math.PI / 2;
      mark.position.set(s.pos.x, 0.09, wz(s.pos.y - 10));
      this.scene.add(mark);
    }

    // 航站楼
    const termW = maxX - minX + 80;
    const terminal = new THREE.Mesh(
      new THREE.BoxGeometry(termW, 16, 70),
      new THREE.MeshStandardMaterial({ color: 0x59616d, roughness: 0.8 }),
    );
    terminal.position.set((minX + maxX) / 2, 8, wz(505));
    terminal.castShadow = true;
    terminal.receiveShadow = true;
    this.scene.add(terminal);

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(termW - 20, 6, 2),
      new THREE.MeshStandardMaterial({ color: 0x9fc6d8, roughness: 0.2, metalness: 0.5 }),
    );
    glass.position.set((minX + maxX) / 2, 9, wz(469));
    this.scene.add(glass);

    // 廊桥
    for (const s of def.stands) {
      const bridge = new THREE.Mesh(
        new THREE.BoxGeometry(4, 4, 60),
        new THREE.MeshStandardMaterial({ color: 0x6d7582, roughness: 0.85 }),
      );
      bridge.position.set(s.pos.x, 4, wz(s.pos.y + 60));
      bridge.castShadow = true;
      this.scene.add(bridge);
    }

    // 北侧机库与油罐（给画面一点纵深，不参与玩法）
    const hangarMat = new THREE.MeshStandardMaterial({ color: 0x7d858f, roughness: 0.85 });
    for (let i = 0; i < 3; i++) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(90, 20, 60), hangarMat);
      h.position.set(-700 + i * 130, 10, wz(-260));
      h.castShadow = true;
      h.receiveShadow = true;
      this.scene.add(h);
      const roof = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1, 60, 2, 1, false, 0, Math.PI),
        new THREE.MeshStandardMaterial({ color: 0x5f6873, roughness: 0.9 }),
      );
      roof.rotation.z = Math.PI / 2;
      roof.rotation.y = Math.PI / 2;
      roof.scale.set(45, 12, 1);
      roof.position.set(-700 + i * 130, 20, wz(-260));
      this.scene.add(roof);
    }
    // 塔台
    const tw = def.tower;
    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(5, 7, tw.heightM, 12),
      new THREE.MeshStandardMaterial({ color: 0xb9bfc7, roughness: 0.8 }),
    );
    shaft.position.set(tw.pos.x, tw.heightM / 2, wz(tw.pos.y));
    shaft.castShadow = true;
    this.scene.add(shaft);

    const cab = new THREE.Mesh(
      new THREE.CylinderGeometry(9, 8, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x8fb6c9, roughness: 0.2, metalness: 0.4 }),
    );
    cab.position.set(tw.pos.x, tw.heightM + 3, wz(tw.pos.y));
    cab.castShadow = true;
    this.scene.add(cab);

    const roof = new THREE.Mesh(
      new THREE.CylinderGeometry(10, 10, 1.2, 12),
      new THREE.MeshStandardMaterial({ color: 0x4d5561, roughness: 0.9 }),
    );
    roof.position.set(tw.pos.x, tw.heightM + 6.5, wz(tw.pos.y));
    this.scene.add(roof);
  }

  setView(view: ViewMode): void {
    this.view = view;
    if (view === "tower") {
      this.controls.enabled = true;
      this.camera.position.set(640, 285, wz(-770));
      this.controls.target.set(280, 0, wz(120));
    } else if (view === "top") {
      this.controls.enabled = true;
      this.camera.position.set(520, 900, wz(1250));
      this.controls.target.set(-40, 0, wz(120));
    } else {
      this.controls.enabled = true;
      const ac = this.followId ? this.world.aircraft.get(this.followId) : null;
      if (ac) {
        const p = new THREE.Vector3(wx(ac.pos.x), Math.max(0, ac.altM - this.world.idx.def.elevationM), wz(ac.pos.y));
        this.camera.position.copy(p).add(this.chaseOffset(ac.hdg));
        this.controls.target.copy(p);
        this.lastFollowId = ac.id;
      }
    }
    this.controls.update();
  }

  setFollow(id: string | null): void {
    this.followId = id;
    if (this.view === "follow") this.setView("follow");
  }

  private chaseOffset(hdg: number): THREE.Vector3 {
    const r = (hdg * Math.PI) / 180;
    const fwd = new THREE.Vector3(Math.sin(r), 0, -Math.cos(r));
    return fwd.multiplyScalar(-190).add(new THREE.Vector3(0, 62, 0));
  }

  private resize(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private handleClick(e: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.aircraftLayer.children, true);
    if (hits.length === 0) {
      this.onSelect(null);
      return;
    }
    let obj: THREE.Object3D | null = hits[0]!.object;
    while (obj && !obj.userData.aircraftId) obj = obj.parent;
    this.onSelect((obj?.userData.aircraftId as string) ?? null);
  }

  update(world: World, dtReal: number, view: ViewMode, selected: string | null, follow: string | null): void {
    this.world = world;
    this.followId = follow ?? selected;

    const alive = new Set<string>();
    for (const ac of world.aircraft.values()) {
      alive.add(ac.id);
      let mesh = this.meshes.get(ac.id);
      if (!mesh) {
        mesh = makeAircraftMesh(ac.typeId, ac.airline);
        mesh.userData.aircraftId = ac.id;
        mesh.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });
        this.aircraftLayer.add(mesh);
        this.meshes.set(ac.id, mesh);
      }
      const groundY = Math.max(0, ac.altM - world.idx.def.elevationM);
      mesh.position.set(wx(ac.pos.x), groundY, wz(ac.pos.y));
      mesh.rotation.y = ((90 - ac.hdg) * Math.PI) / 180;
      const isSel = ac.id === selected;
      mesh.scale.setScalar(isSel ? 1.06 : 1);
    }

    for (const [id, mesh] of this.meshes) {
      if (!alive.has(id)) {
        this.aircraftLayer.remove(mesh);
        mesh.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            const mat = m.material as THREE.Material | THREE.Material[];
            if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
            else mat.dispose();
          }
        });
        this.meshes.delete(id);
      }
    }

    if (view !== this.view) {
      this.setView(view);
    }

    if (view === "follow" && this.followId) {
      const ac = world.aircraft.get(this.followId);
      if (ac && ac.id !== this.lastFollowId) {
        const p = new THREE.Vector3(wx(ac.pos.x), Math.max(0, ac.altM - world.idx.def.elevationM), wz(ac.pos.y));
        this.camera.position.copy(p).add(this.chaseOffset(ac.hdg));
        this.controls.target.copy(p);
        this.lastFollowId = ac.id;
      }
      if (ac) {
        const p = new THREE.Vector3(wx(ac.pos.x), Math.max(0, ac.altM - world.idx.def.elevationM), wz(ac.pos.y));
        const delta = p.clone().sub(this.controls.target);
        this.controls.target.copy(p);
        this.camera.position.add(delta);
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.updateLabels(world, selected);
    void dtReal;
  }

  private updateLabels(world: World, selected: string | null): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const seen = new Set<string>();

    for (const ac of world.aircraft.values()) {
      seen.add(ac.id);
      let el = this.labelEls.get(ac.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "ac-label";
        el.innerHTML = `<span class="cs"></span><span class="meta"></span>`;
        el.addEventListener("mousedown", (ev) => {
          ev.stopPropagation();
          this.onSelect(ac.id);
        });
        this.labels.appendChild(el);
        this.labelEls.set(ac.id, el);
      }
      this.tmp.set(wx(ac.pos.x), Math.max(0, ac.altM - world.idx.def.elevationM) + 8, wz(ac.pos.y));
      this.tmp.project(this.camera);
      if (this.tmp.z > 1 || this.tmp.x < -0.98 || this.tmp.x > 0.98 || this.tmp.y < -0.98 || this.tmp.y > 0.98) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "block";
      el.style.transform = `translate(-50%, -100%) translate(${((this.tmp.x + 1) / 2) * w}px, ${((1 - this.tmp.y) / 2) * h}px)`;
      const conflict =
        world.conflicts.some((c) => c.split("|").includes(ac.id)) || ac.phase === "landing";
      el.className = `ac-label${ac.id === selected ? " sel" : ""}${conflict ? " conflict" : ""}`;
      const cs = el.firstElementChild as HTMLElement;
      const meta = el.lastElementChild as HTMLElement;
      if (cs.textContent !== ac.callsign) cs.textContent = ac.callsign;
      const altTxt = ac.altM - world.idx.def.elevationM > 30 ? `${Math.round(toFt(ac.altM) / 100) * 100}ft` : "";
      const metaTxt = `${altTxt} ${Math.round(toKt(ac.gs))}kt`;
      if (meta.textContent !== metaTxt) meta.textContent = metaTxt;
    }

    for (const [id, el] of this.labelEls) {
      if (!seen.has(id)) {
        el.remove();
        this.labelEls.delete(id);
      }
    }
  }

  start(): void {
    const loop = (t: number) => {
      this.raf = requestAnimationFrame(loop);
      this.lastTime = t;
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.renderer.domElement.removeEventListener("click", this.boundClick);
    this.controls.dispose();
    this.renderer.dispose();
    this.el.removeChild(this.renderer.domElement);
    void this.lastTime;
  }
}
