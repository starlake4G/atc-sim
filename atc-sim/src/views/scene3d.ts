import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { makeAircraftMesh, updateAircraftModel } from "./aircraft-model";
import { buildAirportModel } from "./airport-model";
import type { World } from "../sim/world";
import { toFt, toKt } from "../sim/units";
import { EnvironmentModel } from "./environment-model";
import { LIGHT_LOOKS, lightPeriod, skyTexture, type LightPeriod } from "./lighting";

export type ViewMode = "tower" | "follow" | "top";

const wx = (x: number) => x;
const wz = (y: number) => -y;

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
  private disposed = false;
  private tmp = new THREE.Vector3();
  private onSelect: (id: string | null) => void;
  private boundClick: (e: MouseEvent) => void;
  private resizeObs: ResizeObserver;
  private resizeFrame: number | null = null;
  private renderWidth = 0;
  private renderHeight = 0;
  private el: HTMLElement;
  private shadows: boolean;
  private pointerStart = { x: 0, y: 0 };
  private boundPointerDown: (e: PointerEvent) => void;
  private routeLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x9ae9cc, transparent: true, opacity: .7, depthWrite: false }));
  private halo = new THREE.Mesh(new THREE.RingGeometry(14, 14.35, 80), new THREE.MeshBasicMaterial({ color: 0xb7ebd8, transparent: true, opacity: .38, side: THREE.DoubleSide, depthWrite: false }));
  private routeRefresh = 0;
  private quality: "low" | "balanced" | "high";
  private environment = new EnvironmentModel();
  private period: LightPeriod;
  private skyMap: THREE.Texture | null = null;
  private reflection: THREE.WebGLRenderTarget | null = null;
  private sun: THREE.DirectionalLight | null = null;
  private sunOffset = new THREE.Vector3();
  private shadowRadius = 1800;

  constructor(
    el: HTMLElement,
    labelsEl: HTMLDivElement,
    world: World,
    onSelect: (id: string | null) => void,
    opts: { shadows?: boolean; quality?: "low" | "balanced" | "high" } = {},
  ) {
    this.el = el;
    this.world = world;
    this.onSelect = onSelect;
    this.labels = labelsEl;
    this.shadows = opts.shadows !== false;
    this.quality = opts.quality ?? "balanced";
    this.period = lightPeriod(world.level.startClockMin + world.time / 60);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(this.shadows ? Math.min(window.devicePixelRatio, this.quality === "high" ? 2 : 1.5) : 1);
    this.renderer.setSize(el.clientWidth, el.clientHeight);
    this.renderer.shadowMap.enabled = this.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = LIGHT_LOOKS[this.period].exposure;
    el.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(48, el.clientWidth / Math.max(1, el.clientHeight), 1, 60000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 60;
    this.controls.maxDistance = 9000;

    this.buildSky();
    this.buildLights();
    this.buildAirport();
    this.scene.add(this.environment.root);
    this.scene.add(this.aircraftLayer);
    this.routeLine.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(256 * 3), 3)); this.routeLine.geometry.setDrawRange(0, 0); this.routeLine.frustumCulled = false;
    this.halo.rotation.x = -Math.PI / 2; this.halo.visible = false; this.scene.add(this.routeLine, this.halo);
    this.setView("tower");

    this.boundClick = (e: MouseEvent) => this.handleClick(e);
    this.boundPointerDown = (e) => { this.pointerStart = { x: e.clientX, y: e.clientY }; };
    this.renderer.domElement.addEventListener("pointerdown", this.boundPointerDown);
    this.renderer.domElement.addEventListener("click", this.boundClick);
    this.resizeObs = new ResizeObserver(() => { if (this.resizeFrame === null) this.resizeFrame = requestAnimationFrame(() => { this.resizeFrame = null; this.resize(); }); });
    this.resizeObs.observe(el);
    this.resize();
  }

  private buildSky(): void {
    this.skyMap = skyTexture(this.period); this.scene.background = this.skyMap;
    if (this.shadows && this.quality !== "low") {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.reflection = pmrem.fromEquirectangular(this.skyMap); this.scene.environment = this.reflection.texture; pmrem.dispose();
    }
    this.scene.fog = new THREE.Fog(LIGHT_LOOKS[this.period].fog, 4800, 26000);
  }

  private buildLights(): void {
    const look = LIGHT_LOOKS[this.period], evening = this.period !== "day";
    const hemi = new THREE.HemisphereLight(evening ? 0xa9c4e7 : 0xd8eafa, 0x596249, look.skyLight);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(look.sun, look.sunlight);
    sun.position.set(900, evening ? 600 : 1700, 1300); this.sunOffset.copy(sun.position); this.sun = sun;
    sun.castShadow = this.shadows;
    sun.shadow.mapSize.set(this.quality === "high" ? 4096 : 2048, this.quality === "high" ? 4096 : 2048);
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    cam.left = -1800;
    cam.right = 1800;
    cam.top = 1800;
    cam.bottom = -1800;
    cam.near = 100;
    cam.far = 6000;
    sun.shadow.bias = -0.00015;
    sun.shadow.normalBias = .12;
    this.scene.add(sun, sun.target);
    if (evening) {
      for (const stand of this.world.idx.def.stands) {
        const apronLight = new THREE.SpotLight(0xffe8c7, this.period === "night" ? 42000 : 7000, 260, Math.PI / 3, .6, 2);
        apronLight.position.set(stand.pos.x - 55, 46, wz(550));
        apronLight.target.position.set(stand.pos.x, 0, wz(475));
        this.scene.add(apronLight, apronLight.target);
      }
    }
  }

  private buildAirport(): void {
    this.scene.add(buildAirportModel(this.world.idx, this.period, this.shadows && this.quality !== "low"));
  }

  setView(view: ViewMode): void {
    this.view = view;
    this.camera.up.set(0, 1, 0);
    this.controls.enableRotate = view !== "top";
    this.controls.mouseButtons.LEFT = view === "top" ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.controls.touches.ONE = view === "top" ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE;
    if (view === "tower") {
      this.controls.enabled = true;
      this.camera.position.set(1450, 930, 1250);
      this.controls.target.set(-80, 0, wz(210));
    } else if (view === "top") {
      this.controls.enabled = true;
      this.camera.up.set(0, 0, -1);
      this.camera.position.set(0, 3000, wz(250));
      this.controls.target.set(0, 0, wz(250));
    } else {
      this.controls.enabled = true;
      const ac = this.followId ? this.world.aircraft.get(this.followId) : null;
      if (ac) {
        const p = new THREE.Vector3(wx(ac.pos.x), Math.max(0, ac.altM - this.world.idx.def.elevationM), wz(ac.pos.y));
        p.y += 4;
        this.camera.position.copy(p).add(this.chaseOffset(ac.hdg, ac.lengthM));
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

  private chaseOffset(hdg: number, length = 40): THREE.Vector3 {
    const r = (hdg * Math.PI) / 180;
    const fwd = new THREE.Vector3(Math.sin(r), 0, -Math.cos(r));
    const side = new THREE.Vector3(Math.cos(r), 0, Math.sin(r));
    const scale = THREE.MathUtils.clamp(length / 40, .8, 1.75);
    return fwd.multiplyScalar(-78 * scale).addScaledVector(side, 58 * scale).add(new THREE.Vector3(0, 29 * scale, 0));
  }

  private resize(): void {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (w === 0 || h === 0) return;
    if (w === this.renderWidth && h === this.renderHeight) return;
    this.renderWidth = w; this.renderHeight = h;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private handleClick(e: MouseEvent): void {
    if (Math.hypot(e.clientX - this.pointerStart.x, e.clientY - this.pointerStart.y) > 5) return;
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
    this.environment.update(world);
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
      mesh.scale.setScalar(1);
      updateAircraftModel(mesh, ac, dtReal, world.idx.def.elevationM, world.time);
      void isSel;
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
        p.y += 4;
        this.camera.position.copy(p).add(this.chaseOffset(ac.hdg, ac.lengthM));
        this.controls.target.copy(p);
        this.lastFollowId = ac.id;
      }
      if (ac) {
        const p = new THREE.Vector3(wx(ac.pos.x), Math.max(0, ac.altM - world.idx.def.elevationM), wz(ac.pos.y));
        p.y += 4;
        const delta = p.clone().sub(this.controls.target);
        this.controls.target.copy(p);
        this.camera.position.add(delta);
      }
    } else if (view === "follow" && !this.followId && this.lastFollowId) {
      this.lastFollowId = null; this.setView("tower"); this.view = "follow";
    }

    this.routeRefresh += dtReal;
    const selectedAc = selected ? world.aircraft.get(selected) : null;
    this.halo.visible = !!selectedAc && selectedAc.altM - world.idx.def.elevationM < 5;
    if (selectedAc) { this.halo.position.set(selectedAc.pos.x, .35, -selectedAc.pos.y); this.halo.scale.setScalar(Math.max(.85, selectedAc.lengthM / 40)); }
    if (this.sun && this.shadows) {
      const local = selectedAc && selectedAc.altM - world.idx.def.elevationM < 150;
      const radius = local ? 300 : 1800, target = this.sun.target.position;
      target.set(local ? Math.round(selectedAc.pos.x / 4) * 4 : 0, 0, local ? -Math.round(selectedAc.pos.y / 4) * 4 : 0);
      this.sun.position.copy(target).add(this.sunOffset);
      if (radius !== this.shadowRadius) {
        this.shadowRadius = radius; const camera = this.sun.shadow.camera;
        camera.left = camera.bottom = -radius; camera.right = camera.top = radius; camera.updateProjectionMatrix();
      }
    }
    if (this.routeRefresh > .1) {
      this.routeRefresh = 0;
      const attribute = this.routeLine.geometry.getAttribute("position") as THREE.BufferAttribute;
      let count = 0;
      if (selectedAc?.route) {
        const route = selectedAc.route, remaining = Math.max(0, route.total - route.minS), samples = Math.min(255, Math.ceil(remaining / 120));
        for (let i = 0; i <= samples; i++) { const point = route.pointAt(route.minS + remaining * i / Math.max(1, samples)); attribute.setXYZ(count++, point.x, Math.max(.6, selectedAc.altM - world.idx.def.elevationM - 15), -point.y); }
      }
      this.routeLine.geometry.setDrawRange(0, count); attribute.needsUpdate = true;
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

    const occupied: { x: number; y: number; width: number }[] = [];
    const conflicts = new Set(world.conflicts.flatMap((pair) => pair.split("|")));
    const aircraft = [...world.aircraft.values()].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || Number(conflicts.has(b.id)) - Number(conflicts.has(a.id)));
    for (const ac of aircraft) {
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
      this.tmp.set(wx(ac.pos.x), Math.max(0, ac.altM - world.idx.def.elevationM) + (ac.lengthM > 60 ? 18 : 12), wz(ac.pos.y));
      this.tmp.project(this.camera);
      if (this.tmp.z > 1 || this.tmp.z < -1 || this.tmp.x < -0.98 || this.tmp.x > 0.98 || this.tmp.y < -0.98 || this.tmp.y > 0.98) {
        el.style.display = "none";
        continue;
      }
      const conflict = conflicts.has(ac.id), important = ac.id === selected || conflict, width = important ? 150 : 80;
      const x = THREE.MathUtils.clamp(((this.tmp.x + 1) / 2) * w, width / 2 + 5, w - width / 2 - 5), anchorY = ((1 - this.tmp.y) / 2) * h;
      let y = anchorY, found = false;
      for (const offset of [0, 28, 56]) {
        const candidate = anchorY - offset;
        if (candidate < 22 || candidate > h - 4) continue;
        if (occupied.some((box) => Math.abs(box.x - x) < (box.width + width) / 2 + 6 && Math.abs(box.y - candidate) < 26)) continue;
        y = candidate; found = true; break;
      }
      if (!found && !important) { el.style.display = "none"; continue; }
      occupied.push({ x, y, width });
      el.style.display = "flex"; el.style.setProperty("--leader-height", `${8 + Math.max(0, anchorY - y)}px`);
      el.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObs.disconnect();
    if (this.resizeFrame !== null) cancelAnimationFrame(this.resizeFrame);
    this.renderer.domElement.removeEventListener("click", this.boundClick);
    this.renderer.domElement.removeEventListener("pointerdown", this.boundPointerDown);
    this.controls.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.Line) && !(obj instanceof THREE.Points)) return;
      geometries.add(obj.geometry);
      for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    geometries.forEach((g) => g.dispose());
    textures.forEach((t) => t.dispose());
    this.skyMap?.dispose(); this.reflection?.dispose();
    materials.forEach((m) => m.dispose());
    this.labelEls.forEach((el) => el.remove());
    this.labelEls.clear();
    this.meshes.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
