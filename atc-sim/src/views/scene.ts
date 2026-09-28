/**
 * 3D 场景视图
 *
 * 两种相机模式：
 *   tower  —— 塔台视景：机位固定在塔冠，可拖动环视，看向跑道
 *   follow —— 跟机视角：跟在选中飞机后上方
 *
 * 坐标转换：世界 ENU（x 东 / y 北 / z 高度）→ Three.js（Y 轴向上）
 *   three.x =  world.x
 *   three.y =  world.z   （高度）
 *   three.z = -world.y   （北指向 -z）
 *
 * 航向与朝向：世界航向 0 = 北（-z），因此模型绕 Y 轴旋转 -heading。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Aircraft, Airport, Runway } from '../sim/types';
import type { World } from '../sim/world';
import { selectedAircraft, TICK_DT } from '../sim/world';
import { angleDiff, deg2rad, m2ft, m2nm, ms2kt, norm360, rad2deg } from '../sim/units';
import { along, headingToVec } from '../sim/vec';
import { skyAt, type SkyState } from './daycycle';
import { scaledPixelRatio } from './stage';

export type SceneMode = 'tower' | 'follow';

export interface SceneViewCallbacks {
  onSelect: (id: number | null) => void;
}

const toThree = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, z, -y);

/** 每帧复用的临时对象，免得在渲染循环里制造垃圾 */
const scratchPos = new THREE.Vector3();
const scratchNdc = new THREE.Vector3();
const scratchOff = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** 一帧的渲染变换：世界坐标（米）+ 航向（度） */
interface RenderTf {
  x: number;
  y: number;
  z: number;
  heading: number;
}

const COLOR_ARRIVAL = 0x6fe3c4;
const COLOR_DEPARTURE = 0xef9f27;
const COLOR_SELECTED = 0xffffff;

export class SceneView {
  private airport: Airport;
  private callbacks: SceneViewCallbacks;

  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private mode: SceneMode = 'tower';
  private visible = false;

  private models = new Map<number, THREE.Group>();
  /** 3D 主视图下的飞机标牌（HTML 浮层，由相机投影定位） */
  private labelLayer = document.createElement('div');
  private labels = new Map<number, HTMLElement>();
  private materials: {
    arrival: THREE.Material[];
    departure: THREE.Material[];
    selected: THREE.Material[];
    parked: THREE.Material[];
  };
  private selectionRing: THREE.Mesh;

  // ---- 昼夜与灯光（P1） ----
  private skyMat: THREE.ShaderMaterial | null = null;
  private starsMat: THREE.PointsMaterial | null = null;
  private hemiLight: THREE.HemisphereLight | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private moonLight: THREE.DirectionalLight | null = null;
  /** 场内灯（跑道/滑行道/进近）共用一个点云材质，夜晚提亮 */
  private fieldLightsMat: THREE.PointsMaterial | null = null;
  /** 航站楼亮窗材质，夜晚提亮 */
  private windowMats: THREE.MeshBasicMaterial[] = [];
  private skyState: SkyState = skyAt(0, false);

  /**
   * 塔台机位。
   * 3 km 长的跑道如果站在端头附近看，张角会超过 70°，视野里只剩一条线；
   * 所以机位退到机场西北侧约 2.2 km、高 96 m，才能同框罩住两条平行跑道的全场。
   * 塔台本体也建在这个位置，机位必须落在塔冠玻璃环（世界高度 94–99 m）之内、
   * 塔冠底盖（92 m）之上 —— 低于底盖会被塔冠地板挡住整片天空。
   */
  private towerAnchor = new THREE.Vector3(-600, 96, -2200);
  private towerTarget = new THREE.Vector3(0, 0, 100);

  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  constructor(airport: Airport, callbacks: SceneViewCallbacks) {
    this.airport = airport;
    this.callbacks = callbacks;

    this.container = document.createElement('div');
    this.container.className = 'scene-host';

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x0d1a21, 1);
    this.container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'scene-view';

    this.labelLayer.className = 'labels';
    this.container.append(this.labelLayer);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a1418, 3000, 26000);

    // 视场角放宽一些，塔台机位才能同时罩住两条平行跑道
    this.camera = new THREE.PerspectiveCamera(65, 1, 1, 60000);
    this.camera.position.copy(this.towerAnchor);
    this.camera.lookAt(this.towerTarget);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this.towerTarget);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 4000;
    this.controls.update();

    this.materials = {
      arrival: this.buildMaterialSet(COLOR_ARRIVAL),
      departure: this.buildMaterialSet(COLOR_DEPARTURE),
      selected: this.buildMaterialSet(COLOR_SELECTED),
      parked: this.buildMaterialSet(0xd9dee3),
    };

    const ringGeo = new THREE.TorusGeometry(45, 2.5, 8, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.selectionRing = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({ color: COLOR_SELECTED, transparent: true, opacity: 0.75 }),
    );
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);

    this.buildEnvironment();
    this.bindPointer();
  }

  private buildMaterialSet(color: number): THREE.Material[] {
    // 每套材质复用一个实例，避免每架飞机都新建
    const body = new THREE.MeshLambertMaterial({ color });
    const dark = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.55) });
    const glass = new THREE.MeshLambertMaterial({ color: new THREE.Color(color).multiplyScalar(0.3) });
    return [body, dark, glass];
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  mount(parent: HTMLElement): void {
    parent.appendChild(this.container);
    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.container);
  }

  private observer: ResizeObserver | null = null;

  unmount(): void {
    this.observer?.disconnect();
    this.renderer.dispose();
    this.container.remove();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.container.style.display = v ? 'block' : 'none';
    this.labelLayer.style.display = v ? 'block' : 'none';
    if (v) this.resize();
  }

  setMode(mode: SceneMode): void {
    this.mode = mode;
    if (mode === 'tower') {
      this.controls.enabled = true;
      this.controls.enablePan = true;
      this.controls.minDistance = 20;
      this.controls.maxDistance = 4000;
      this.camera.position.copy(this.towerAnchor);
      this.controls.target.copy(this.towerTarget);
      this.controls.update();
    } else {
      // 跟机视角同样交给 OrbitControls：玩家要能绕着飞机转、能拉远拉近。
      // 每帧只做一件事 —— 把轨道中心平移到飞机上，于是玩家选定的相对角度保持不变。
      this.controls.enabled = true;
      this.controls.enablePan = false;
      this.controls.minDistance = 45;
      this.controls.maxDistance = 1500;
      this.followId = null; // 换目标时重给一个标准机后机位
    }
  }

  /**
   * 渲染插值用：逻辑是 20 Hz 离散步进，渲染是自由帧率。
   * 不做插值的话，跟机视角里飞机和背景都是 50 ms 一跳。
   */
  private prevTf = new Map<number, RenderTf>();
  private curTf = new Map<number, RenderTf>();
  private lastSimTime = -1;
  /** 跟机视角：当前跟的飞机与上一帧航向（用来让相机随机头一起转） */
  private followId: number | null = null;
  private followHeading = 0;

  private resize(): void {
    // clientWidth/Height 是未缩放的布局尺寸：canvas 靠 CSS 铺满容器，
    // 只有绘制缓冲要按舞台缩放比放大，否则放大档位下发虚
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(scaledPixelRatio());
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 舞台缩放比变了（窗口改变大小）后重建后备缓冲 */
  rescale(): void {
    this.resize();
  }

  // -------------------------------------------------------------------------
  // 场景搭建
  // -------------------------------------------------------------------------

  private buildEnvironment(): void {
    // 昼夜驱动的主光组：半环境光 + 太阳 + 月亮（颜色与强度由 applySky 每帧覆盖）
    this.hemiLight = new THREE.HemisphereLight(0x9db8cc, 0x1c2b24, 2.3);
    this.sunLight = new THREE.DirectionalLight(0xfff2dd, 3.4);
    this.moonLight = new THREE.DirectionalLight(0x8fb0d8, 0);
    this.scene.add(this.hemiLight, this.sunLight, this.moonLight);

    // 地面
    const groundGeo = new THREE.PlaneGeometry(60000, 60000);
    groundGeo.rotateX(-Math.PI / 2);
    const ground = new THREE.Mesh(
      groundGeo,
      new THREE.MeshLambertMaterial({ color: 0x1c2b24 }),
    );
    ground.position.y = this.airport.elevation - 1;
    this.scene.add(ground);

    // 跑道
    for (const rw of this.airport.runways) {
      this.scene.add(this.buildRunway(rw));
    }

    // 滑行道：给跑道之间一点参照物，否则整个场景只有两条孤线
    this.scene.add(this.buildTaxiways());

    // 塔台
    this.scene.add(this.buildTower());

    // 场内灯（跑道边灯/入口灯/进近灯/PAPI/滑行道蓝灯）+ 航站楼与停靠机
    this.scene.add(this.buildAirportLights());
    this.buildTerminal();

    // 天空穹顶与星空（最后加，大半径 + 不写深度，渲染顺序在场景之后即可）
    this.buildSky();
    this.buildStars();

    // 机场参考网格（帮助判断距离）
    const grid = new THREE.GridHelper(40000, 40, 0x2f5560, 0x22383e);
    const gridMat = grid.material as THREE.Material;
    gridMat.transparent = true;
    gridMat.opacity = 0.45;
    grid.position.y = this.airport.elevation + 0.2;
    this.scene.add(grid);
  }

  /** 渐变天空穹顶：上/下两色由昼夜循环每帧写入 uniform */
  private buildSky(): void {
    const geo = new THREE.SphereGeometry(46000, 24, 14);
    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x4a8ac2) },
        bottomColor: { value: new THREE.Color(0xb9d3e2) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        varying vec3 vDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottomColor, topColor, pow(h, 0.55)), 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const sky = new THREE.Mesh(geo, this.skyMat);
    sky.position.y = this.airport.elevation;
    sky.renderOrder = -2;
    this.scene.add(sky);
  }

  /** 夜空星星：上半球随机点云，透明度由昼夜循环控制 */
  private buildStars(): void {
    const N = 700;
    const pos = new Float32Array(N * 3);
    let seed = 20260928;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < N; i++) {
      const y = 0.06 + 0.94 * rnd();
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const ang = rnd() * Math.PI * 2;
      pos[i * 3] = Math.cos(ang) * r * 44000;
      pos[i * 3 + 1] = y * 44000;
      pos[i * 3 + 2] = Math.sin(ang) * r * 44000;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starsMat = new THREE.PointsMaterial({
      color: 0xcfd8ff,
      size: 110,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
    });
    const stars = new THREE.Points(geo, this.starsMat);
    stars.position.y = this.airport.elevation;
    stars.renderOrder = -1;
    this.scene.add(stars);
  }

  /**
   * 场内灯点云（世界坐标直算，不依赖跑道组的旋转）：
   *   跑道边灯（末端 600m 黄）/ 入口绿排 / 末端红排 / 简化进近灯串 + 300m 横排 /
   *   PAPI（2 白 2 红）/ 滑行道与机坪边缘蓝灯。
   */
  private buildAirportLights(): THREE.Points {
    const pos: number[] = [];
    const col: number[] = [];
    const color = new THREE.Color();
    const y = this.airport.elevation + 0.8;
    const push = (wx: number, wy: number, hex: number): void => {
      const p = toThree(wx, wy, 0);
      pos.push(p.x, y, p.z);
      color.set(hex);
      col.push(color.r, color.g, color.b);
    };

    for (const rw of this.airport.runways) {
      const h = rw.heading;
      const hv = headingToVec(h);
      const pv = { x: hv.y, y: -hv.x }; // 顺航向的右侧垂直向量
      const L = rw.length;
      const W = rw.width;

      // 边灯
      for (let d = 0; d <= L; d += 60) {
        const base = along(rw.threshold, h, d);
        for (const sign of [-1, 1]) {
          push(
            base.x + sign * pv.x * (W / 2 + 3),
            base.y + sign * pv.y * (W / 2 + 3),
            d > L - 600 ? 0xffc860 : 0xd8dce8,
          );
        }
      }
      // 入口绿排 + 末端红排
      for (let lat = -W / 2; lat <= W / 2; lat += 3.5) {
        push(rw.threshold.x + pv.x * lat, rw.threshold.y + pv.y * lat, 0x2bff88);
        const end = along(rw.threshold, h, L - 2);
        push(end.x + pv.x * lat, end.y + pv.y * lat, 0xff3b30);
      }
      // 简化进近灯：入口外 900m 中线 + 300m 处横排
      for (let d = 30; d <= 900; d += 30) {
        const p = along(rw.threshold, (h + 180) % 360, d);
        push(p.x, p.y, 0xeef2ff);
      }
      const cross = along(rw.threshold, (h + 180) % 360, 300);
      for (let lat = -30; lat <= 30; lat += 15) {
        push(cross.x + pv.x * lat, cross.y + pv.y * lat, 0xeef2ff);
      }
      // PAPI：入口内 300m、跑道左侧
      const papi = along(rw.threshold, h, 300);
      for (let i = 0; i < 4; i++) {
        const off = W / 2 + 18 + i * 9;
        push(papi.x + pv.x * off, papi.y + pv.y * off, i < 2 ? 0xffffff : 0xff3b30);
      }
    }

    // 滑行道 / 机坪边缘蓝灯（与 buildTaxiways 的程序化几何对齐，世界坐标）
    const edge = (x0: number, y0: number, x1: number, y1: number): void => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * 18;
      const ny = (dx / len) * 18;
      const steps = Math.max(1, Math.ceil(len / 60));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const px = x0 + dx * t;
        const py = y0 + dy * t;
        push(px + nx, py + ny, 0x2f7bff);
        push(px - nx, py - ny, 0x2f7bff);
      }
    };
    edge(-206, -1350, -206, 1350);
    edge(174, -1350, 174, 1350);
    for (const y2 of [-1050, -350, 350, 1050]) edge(-395, y2, 395, y2);
    edge(550, -550, 550, 150);
    edge(970, -550, 970, 150);
    edge(550, -550, 970, -550);
    edge(550, 150, 970, 150);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.fieldLightsMat = new THREE.PointsMaterial({
      size: 7,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      toneMapped: false,
    });
    return new THREE.Points(geo, this.fieldLightsMat);
  }

  /** 航站楼 + 廊桥 + 机坪停靠机（东侧，与滑行道的机坪板对齐） */
  private buildTerminal(): void {
    const g = new THREE.Group();
    const y0 = this.airport.elevation;
    const wall = new THREE.MeshLambertMaterial({ color: 0x5d6a70 });
    const roof = new THREE.MeshLambertMaterial({ color: 0x414c52 });

    const main = new THREE.Mesh(new THREE.BoxGeometry(64, 20, 780), wall);
    main.position.set(1010, y0 + 10, 200);
    g.add(main);
    const roofBand = new THREE.Mesh(new THREE.BoxGeometry(72, 3, 792), roof);
    roofBand.position.set(1010, y0 + 21.5, 200);
    g.add(roofBand);

    // 夜间亮窗：一条暖色光带（透明度随昼夜变）
    const winMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.3,
    });
    this.windowMats.push(winMat);
    const windows = new THREE.Mesh(new THREE.BoxGeometry(66.5, 5, 770), winMat);
    windows.position.set(1010, y0 + 6, 200);
    g.add(windows);

    const bridgeMat = new THREE.MeshLambertMaterial({ color: 0x6b7880 });
    const gates = [-40, 120, 280, 440];
    gates.forEach((gz, i) => {
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(60, 3.2, 5), bridgeMat);
      bridge.position.set(965, y0 + 6.5, gz);
      g.add(bridge);
      const post = new THREE.Mesh(new THREE.BoxGeometry(2.5, 6, 2.5), bridgeMat);
      post.position.set(940, y0 + 3, gz);
      g.add(post);

      // 停靠机：机头朝东顶桥，大小略有差异
      const ac = this.buildAircraftModel(this.materials.parked);
      ac.scale.setScalar(0.88 + i * 0.06);
      ac.position.set(885, y0 + 2.6, gz);
      ac.rotation.y = -deg2rad(90);
      g.add(ac);
    });

    this.scene.add(g);
  }

  private buildRunway(rw: Runway): THREE.Group {
    const g = new THREE.Group();
    const rad = deg2rad(rw.heading);
    const cx = rw.threshold.x + Math.sin(rad) * (rw.length / 2);
    const cy = rw.threshold.y + Math.cos(rad) * (rw.length / 2);

    // 道面
    const surfaceGeo = new THREE.PlaneGeometry(rw.width, rw.length);
    surfaceGeo.rotateX(-Math.PI / 2);
    const surface = new THREE.Mesh(
      surfaceGeo,
      new THREE.MeshLambertMaterial({ color: 0x3b4548 }),
    );
    surface.position.y = 0.6;
    g.add(surface);

    // 中线
    const centerGeo = new THREE.PlaneGeometry(0.9, rw.length - 60);
    centerGeo.rotateX(-Math.PI / 2);
    const center = new THREE.Mesh(
      centerGeo,
      new THREE.MeshBasicMaterial({ color: 0xcfd8d4 }),
    );
    center.position.y = 1.1;
    g.add(center);

    // 两侧边线
    for (const sign of [-1, 1]) {
      const edgeGeo = new THREE.PlaneGeometry(1.2, rw.length);
      edgeGeo.rotateX(-Math.PI / 2);
      const edge = new THREE.Mesh(edgeGeo, new THREE.MeshBasicMaterial({ color: 0x9aa8a4 }));
      edge.position.set((sign * rw.width) / 2, 1.0, 0);
      // PlaneGeometry 平放后宽度沿 x，这里用 z 方向偏移更直观
      edge.position.x = (sign * rw.width) / 2;
      g.add(edge);
    }

    // 接地带标记：入口前 300 m 的斑马线
    for (let i = 0; i < 8; i++) {
      const stripeGeo = new THREE.PlaneGeometry(rw.width * 0.55, 12);
      stripeGeo.rotateX(-Math.PI / 2);
      const stripe = new THREE.Mesh(stripeGeo, new THREE.MeshBasicMaterial({ color: 0xb8c4c0 }));
      stripe.position.set(0, 1.05, -rw.length / 2 + 150 + i * 34);
      g.add(stripe);
    }

    g.position.set(cx, this.airport.elevation, -cy);
    g.rotation.y = -rad;
    return g;
  }

  private buildTaxiways(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x353f42 });

    // 两条纵向平行滑行道，位于跑道之间
    for (const x of [-190, 190]) {
      const geo = new THREE.PlaneGeometry(32, 2700);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, 0.4, 0);
      g.add(m);
    }

    // 横向联络道，把两条跑道与滑行道连起来
    for (const z of [-1050, -350, 350, 1050]) {
      const geo = new THREE.PlaneGeometry(790, 34);
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, 0.4, z);
      g.add(m);
    }

    // 停机坪（跑道东侧）
    const apronGeo = new THREE.PlaneGeometry(420, 700);
    apronGeo.rotateX(-Math.PI / 2);
    const apron = new THREE.Mesh(apronGeo, mat);
    apron.position.set(760, 0.35, 200);
    g.add(apron);

    g.position.y = this.airport.elevation;
    return g;
  }

  private buildTower(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x46585c });

    // 塔身：机位所在高度，所以建得比常规塔台高
    const shaftGeo = new THREE.CylinderGeometry(6, 12, 80, 12);
    const shaft = new THREE.Mesh(shaftGeo, mat);
    shaft.position.y = 40;
    g.add(shaft);

    const cabGeo = new THREE.CylinderGeometry(16, 13, 8, 12);
    const cab = new THREE.Mesh(cabGeo, new THREE.MeshLambertMaterial({ color: 0x5a7075 }));
    cab.position.y = 84;
    g.add(cab);

    const glassGeo = new THREE.CylinderGeometry(16.6, 16.6, 5, 12, 1, true);
    const glass = new THREE.Mesh(
      glassGeo,
      new THREE.MeshLambertMaterial({
        color: 0x6fe3c4,
        transparent: true,
        opacity: 0.18,
        side: THREE.DoubleSide,
      }),
    );
    glass.position.y = 84.5;
    g.add(glass);

    // 塔台本体建在机位处
    g.position.set(this.towerAnchor.x, this.airport.elevation, this.towerAnchor.z);
    return g;
  }

  private buildAircraftModel(mats: THREE.Material[] = this.materials.arrival): THREE.Group {
    const g = new THREE.Group();

    /** 0=机体主色 1=深色翼面 2=驾驶舱暗色；slot=-1 的是航行灯，不参与换色 */
    const tag = (mesh: THREE.Mesh, slot: number): THREE.Mesh => {
      mesh.userData.slot = slot;
      return mesh;
    };

    // 机身（沿 -z 为机头方向）
    const bodyGeo = new THREE.CylinderGeometry(2.0, 2.0, 36, 8);
    bodyGeo.rotateX(Math.PI / 2);
    g.add(tag(new THREE.Mesh(bodyGeo, mats[0]), 0));

    // 机头
    const noseGeo = new THREE.ConeGeometry(2.0, 7, 8);
    noseGeo.rotateX(-Math.PI / 2);
    const nose = tag(new THREE.Mesh(noseGeo, mats[0]), 0);
    nose.position.z = -21.5;
    g.add(nose);

    // 主翼
    const wingGeo = new THREE.BoxGeometry(34, 0.9, 5.5);
    const wing = tag(new THREE.Mesh(wingGeo, mats[1]), 1);
    wing.position.set(0, -0.6, 0.5);
    g.add(wing);

    // 平尾
    const tailGeo = new THREE.BoxGeometry(13, 0.8, 3.5);
    const tail = tag(new THREE.Mesh(tailGeo, mats[1]), 1);
    tail.position.set(0, 0.5, 15);
    g.add(tail);

    // 垂尾
    const finGeo = new THREE.BoxGeometry(0.9, 7.5, 5.5);
    const fin = tag(new THREE.Mesh(finGeo, mats[1]), 1);
    fin.position.set(0, 4.2, 15.5);
    g.add(fin);

    // 驾驶舱（暗色块，便于一眼分辨机头方向）
    const cockpitGeo = new THREE.BoxGeometry(3.2, 1.6, 4);
    const cockpit = tag(new THREE.Mesh(cockpitGeo, mats[2]), 2);
    cockpit.position.set(0, 1.4, -14);
    g.add(cockpit);

    // 航行灯：左翼尖红 / 右翼尖绿 / 尾部白（自发光小球，不受色调映射压暗，昼夜醒目）
    const navGeo = new THREE.SphereGeometry(0.6, 6, 6);
    const nav = (color: number, x: number, y: number, z: number): void => {
      const m = new THREE.Mesh(
        navGeo,
        new THREE.MeshBasicMaterial({ color, toneMapped: false }),
      );
      m.position.set(x, y, z);
      m.userData.slot = -1;
      g.add(m);
    };
    nav(0xff4545, -17, -0.4, 0.5);
    nav(0x45ff7d, 17, -0.4, 0.5);
    nav(0xffffff, 0, 8.2, 15.8);

    return g;
  }

  /** 切换模型材质（进场 / 离场 / 选中）—— 只换引用，不重建几何 */
  private applyMaterials(group: THREE.Group, set: THREE.Material[]): void {
    group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const slot = (mesh.userData.slot as number) ?? 0;
      if (slot < 0) return; // 航行灯保持自发光
      const mat = set[slot] ?? set[0];
      if (mesh.material !== mat) mesh.material = mat;
    });
  }

  // -------------------------------------------------------------------------
  // 点击选中
  // -------------------------------------------------------------------------

  private bindPointer(): void {
    const dom = this.renderer.domElement;
    let downAt = { x: 0, y: 0 };

    dom.addEventListener('pointerdown', (e) => {
      downAt = { x: e.clientX, y: e.clientY };
    });

    dom.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);

      const candidates: THREE.Object3D[] = [];
      for (const [, group] of this.models) candidates.push(group);
      const hits = this.raycaster.intersectObjects(candidates, true);
      if (hits.length === 0) {
        this.callbacks.onSelect(null);
        return;
      }
      // 向上找到属于哪架飞机
      for (const hit of hits) {
        let node: THREE.Object3D | null = hit.object;
        while (node) {
          for (const [id, group] of this.models) {
            if (group === node) {
              this.callbacks.onSelect(id);
              return;
            }
          }
          node = node.parent;
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // 每帧更新
  // -------------------------------------------------------------------------

  update(world: World): void {
    if (!this.visible) return;

    // 逻辑 20 Hz、渲染自由帧率：每来一个新 tick 就把"当前"降级为"上一帧位置"，
    // 再按累积器余量在两者之间插值。不做这步，跟机视角里一切都 50 ms 一跳。
    if (world.time !== this.lastSimTime) {
      const fresh = new Map<number, RenderTf>();
      for (const ac of world.aircraft) {
        fresh.set(ac.id, { x: ac.pos.x, y: ac.pos.y, z: ac.pos.z, heading: ac.heading });
      }
      // 只往前走了一个 tick 才插值；中间跳了帧（切过视角、暂停过、新出现的飞机）
      // 就拿当前值当上一帧，否则会从现在的位置"糊"回很久以前的位置
      const stepped = this.lastSimTime >= 0 && world.time - this.lastSimTime <= TICK_DT * 1.5;
      this.lastSimTime = world.time;
      this.prevTf = stepped ? this.curTf : fresh;
      this.curTf = fresh;
    }
    const alpha = Math.max(0, Math.min(1, world.accumulator / TICK_DT));

    this.applySky(world);
    this.syncAircraft(world, alpha);
    this.updateCamera(world, alpha);

    // 两种模式都要 update()：塔台是阻尼环视，跟机是"绕着飞机转"
    this.controls.update();
    this.updateLabels(world, alpha);
    this.renderer.render(this.scene, this.camera);
  }

  /** 某机本帧该画在哪儿：上一 tick 与本 tick 之间按余量插值 */
  private renderTf(ac: Aircraft, alpha: number): RenderTf {
    const p = this.prevTf.get(ac.id);
    if (!p) return { x: ac.pos.x, y: ac.pos.y, z: ac.pos.z, heading: ac.heading };
    return {
      x: p.x + (ac.pos.x - p.x) * alpha,
      y: p.y + (ac.pos.y - p.y) * alpha,
      z: p.z + (ac.pos.z - p.z) * alpha,
      heading: norm360(p.heading + angleDiff(ac.heading, p.heading) * alpha),
    };
  }

  /** 把昼夜循环的快照应用到天空/灯光/雾/航站楼亮窗 */
  private applySky(world: World): void {
    const storm = !!world.weather.storm;
    const s = skyAt(world.time, storm, this.skyState);

    if (this.skyMat) {
      this.skyMat.uniforms.topColor.value.copy(s.zenith);
      this.skyMat.uniforms.bottomColor.value.copy(s.horizon);
    }
    if (this.sunLight) {
      this.sunLight.position.copy(s.sunDir).multiplyScalar(30000);
      this.sunLight.color.copy(s.sunColor);
      this.sunLight.intensity = s.sunIntensity;
    }
    if (this.moonLight) {
      this.moonLight.position.copy(s.moonDir).multiplyScalar(30000);
      this.moonLight.intensity = s.moonIntensity;
    }
    if (this.hemiLight) {
      this.hemiLight.color.copy(s.ambientColor);
      this.hemiLight.intensity = s.ambientIntensity;
    }
    if (this.starsMat) this.starsMat.opacity = s.starOpacity;
    if (this.fieldLightsMat) {
      // 白天灯光隐约可见，夜晚全亮
      this.fieldLightsMat.opacity = 0.55 + 0.45 * s.airportLights;
    }
    // 选中环夜晚压暗，避免刺眼
    const ringMat = this.selectionRing.material as THREE.MeshBasicMaterial;
    ringMat.opacity = 0.8 - 0.5 * s.airportLights;
    for (const m of this.windowMats) {
      m.opacity = 0.15 + 0.8 * s.airportLights;
    }

    // 雾：颜色随昼夜，浓度与天气能见度联动
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(s.fog);
    const vis = world.weather.visibility;
    let far = Math.min(42000, Math.max(9000, vis * 2.2));
    if (storm) far = Math.min(far, 10000);
    fog.near = far * 0.12;
    fog.far = far;
  }

  private syncAircraft(world: World, alpha: number): void {
    const seen = new Set<number>();

    for (const ac of world.aircraft) {
      seen.add(ac.id);
      let group = this.models.get(ac.id);
      if (!group) {
        group = this.buildAircraftModel();
        this.scene.add(group);
        this.models.set(ac.id, group);
      }

      const tf = this.renderTf(ac, alpha);
      group.position.set(tf.x, tf.z, -tf.y);
      group.rotation.y = -deg2rad(tf.heading);
      // 转弯时轻微压坡度，视觉上更自然
      const bank = Math.max(-0.45, Math.min(0.45, -ac.turnRate * 0.09));
      group.rotation.z = bank;

      const selected = world.selectedId === ac.id;
      const matSet = selected
        ? this.materials.selected
        : ac.isDeparture
          ? this.materials.departure
          : this.materials.arrival;
      this.applyMaterials(group, matSet);
    }

    // 回收已消失的飞机
    for (const [id, group] of this.models) {
      if (!seen.has(id)) {
        this.scene.remove(group);
        this.models.delete(id);
        this.labels.get(id)?.remove();
        this.labels.delete(id);
        this.prevTf.delete(id);
        this.curTf.delete(id);
      }
    }

    // 选中环
    const sel = selectedAircraft(world);
    if (sel) {
      const tf = this.renderTf(sel, alpha);
      this.selectionRing.visible = true;
      this.selectionRing.position.set(tf.x, tf.z, -tf.y);
    } else {
      this.selectionRing.visible = false;
    }
  }

  /**
   * 标牌层。3D 当主视图后这是"能不能拿来玩"的分水岭 ——
   * 光看几何体分辨不出高度和速度，玩家就没法在 3D 里下指令。
   *
   * 两种形态：在画内是跟随飞机的信息牌；出画则贴到屏幕边缘变成方位标
   * （塔台视角只看得到本场附近，远端待管制的航班全在画外，不给指向就找不到）。
   */
  private updateLabels(world: World, alpha: number): void {
    this.camera.updateMatrixWorld();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const halfV = deg2rad(this.camera.fov / 2);
    const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);

    for (const ac of world.aircraft) {
      const el = this.labelFor(ac.id);
      const bad = world.conflicts.some((c) => c.a === ac.id || c.b === ac.id);
      const base = bad
        ? 'label label-bad'
        : world.selectedId === ac.id
          ? 'label label-sel'
          : ac.isDeparture
            ? 'label label-dep'
            : 'label label-air';

      const tf = this.renderTf(ac, alpha);
      scratchPos.set(tf.x, tf.z, -tf.y);
      const p = scratchNdc.copy(scratchPos).project(this.camera);
      if (p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1) {
        el.className = base;
        el.style.display = 'block';
        el.style.left = `${((p.x + 1) / 2) * w}px`;
        el.style.top = `${((1 - p.y) / 2) * h}px`;
        const altFt = Math.round(m2ft(ac.pos.z) / 100) * 100;
        const trend = ac.vs > 1 ? '↑' : ac.vs < -1 ? '↓' : '';
        el.textContent = `${ac.callsign} ${altFt}${trend} ${Math.round(ms2kt(ac.ias))}kt`;
        continue;
      }

      // 地面等待与落地滑跑不做方位标：它们就在场里，列表里看得到
      if (ac.phase === 'GROUND' || ac.phase === 'LANDED') {
        el.style.display = 'none';
        continue;
      }

      // 相机空间方向 → 偏航/俯仰角，按"几个半视场"折算成屏幕坐标再夹到边缘
      const rel = scratchNdc
        .copy(scratchPos)
        .sub(this.camera.position)
        .transformDirection(this.camera.matrixWorldInverse);
      const yaw = Math.atan2(rel.x, -rel.z);
      const pitch = Math.asin(Math.min(1, Math.max(-1, rel.y)));
      const cx = yaw / halfH;
      const cy = pitch / halfV;
      const k = Math.min(0.93 / Math.max(Math.abs(cx), Math.abs(cy)), 1);
      el.className = `${base} label-edge`;
      el.style.display = 'block';
      el.style.left = `${((cx * k + 1) / 2) * w}px`;
      el.style.top = `${((1 - cy * k) / 2) * h}px`;
      el.style.setProperty('--a', `${rad2deg(Math.atan2(cx, cy))}deg`);
      el.textContent = `${ac.callsign} ${Math.round(m2nm(Math.hypot(ac.pos.x, ac.pos.y)))}NM`;
    }
  }

  private labelFor(id: number): HTMLElement {
    let el = this.labels.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'label';
      this.labelLayer.append(el);
      this.labels.set(id, el);
    }
    return el;
  }

  /**
   * 跟机相机。
   *
   * 不再"追"飞机 —— 那是抖动的根源：目标每 50 ms 跳一步，而相机用固定 lerp
   * 系数去追，永远差着一截，距离和高低就在两帧之间来回摆。
   * 改成把轨道中心平移到飞机的插值位置、相机保持与中心的相对偏移：
   * 飞机在画面里纹丝不动，而那个偏移归 OrbitControls 管，
   * 玩家照样能拖着转角度、滚轮拉距离。
   * 偏移再随机头一起转，所以飞机转向时相机跟着绕过去，不会变成侧视或前视。
   */
  private updateCamera(world: World, alpha: number): void {
    if (this.mode !== 'follow') return;

    const ac = selectedAircraft(world);
    if (!ac) {
      // 没选中就退回塔台机位
      this.followId = null;
      this.controls.target.copy(this.towerTarget);
      this.camera.position.copy(this.towerAnchor);
      return;
    }

    const tf = this.renderTf(ac, alpha);
    scratchPos.set(tf.x, tf.z, -tf.y);

    if (this.followId !== ac.id) {
      // 换目标：直接给一个机后标准机位，不做过渡（过渡会晃半秒）
      this.followId = ac.id;
      this.followHeading = tf.heading;
      const back = headingToVec(tf.heading + 180);
      this.controls.target.copy(scratchPos);
      this.camera.position.set(scratchPos.x + back.x * 150, scratchPos.y + 45, scratchPos.z - back.y * 150);
      return;
    }

    scratchOff.copy(this.camera.position).sub(this.controls.target);
    const dHdg = angleDiff(tf.heading, this.followHeading);
    this.followHeading = tf.heading;
    if (dHdg !== 0) scratchOff.applyAxisAngle(WORLD_UP, -deg2rad(dHdg));
    if (scratchOff.lengthSq() < 1) scratchOff.set(0, 40, -150);
    // 相机不许钻到地面以下
    const minY = this.airport.elevation + 6 - scratchPos.y;
    if (scratchOff.y < minY) scratchOff.y = minY;

    this.controls.target.copy(scratchPos);
    this.camera.position.copy(scratchPos).add(scratchOff);
  }
}
