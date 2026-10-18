import * as THREE from "three";

/** Local, seeded surfaces. World-space UVs keep a slab/grain the same size on every taxi segment. */
export function pavementMaterial(kind: "concrete" | "asphalt" | "runway", detailed = true): THREE.MeshStandardMaterial {
  const size = 512, canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!, pixels = context.createImageData(size, size);
  const roughCanvas = document.createElement("canvas"); roughCanvas.width = roughCanvas.height = size;
  const roughContext = roughCanvas.getContext("2d")!, roughPixels = roughContext.createImageData(size, size);
  const base = kind === "concrete" ? [164, 169, 167] : kind === "asphalt" ? [66, 73, 77] : [48, 54, 58];
  let seed = kind === "concrete" ? 1917 : 7319;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const slabs = Array.from({ length: 16 }, () => (random() - .5) * 9);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4, grain = (random() - .5) * (kind === "concrete" ? 9 : 15);
    const slab = kind === "concrete" ? slabs[Math.floor(y / 128) * 4 + Math.floor(x / 128)]! : 0;
    const seam = kind === "concrete" && (x % 128 < 2 || y % 128 < 2) ? -22 : 0;
    const variation = grain + slab + seam;
    for (let c = 0; c < 3; c++) pixels.data[i + c] = base[c]! + variation;
    pixels.data[i + 3] = 255;
    const rough = (kind === "concrete" ? 220 : 235) + grain;
    roughPixels.data.set([rough, rough, rough, 255], i);
  }
  context.putImageData(pixels, 0, 0); roughContext.putImageData(roughPixels, 0, 0);
  // Broad, low contrast wear survives a distant view without a noisy tile pattern.
  for (let i = 0; i < 22; i++) {
    const x = random() * size, y = random() * size, r = 15 + random() * 50;
    const gradient = context.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, "rgba(47,43,35,.035)"); gradient.addColorStop(1, "rgba(47,43,35,0)");
    context.fillStyle = gradient; context.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  for (const texture of [map, roughnessMap]) { texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.anisotropy = 8; texture.generateMipmaps = true; texture.minFilter = THREE.LinearMipmapLinearFilter; }
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, map, roughnessMap: detailed ? roughnessMap : null, bumpMap: detailed ? roughnessMap : null, bumpScale: .018, roughness: 1, metalness: 0 });
  if (!detailed) roughnessMap.dispose();
  material.userData.worldTile = kind === "concrete" ? 32 : 9;
  return material;
}

export function projectPavementUV(mesh: THREE.Mesh): void {
  if (Array.isArray(mesh.material)) return;
  const tile = mesh.material.userData.worldTile as number | undefined;
  if (!tile) return;
  mesh.updateMatrix();
  const position = mesh.geometry.getAttribute("position"), uv = mesh.geometry.getAttribute("uv"), point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrix);
    uv.setXY(i, point.x / tile, -point.z / tile);
  }
  uv.needsUpdate = true;
}

export function terminalGlassMaterial(evening: boolean): THREE.MeshStandardMaterial {
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 128;
  const g = canvas.getContext("2d")!;
  const gradient = g.createLinearGradient(0, 0, 0, 128);
  gradient.addColorStop(0, evening ? "#536d7e" : "#809aa5"); gradient.addColorStop(.52, "#3b5868"); gradient.addColorStop(1, evening ? "#525951" : "#253d48");
  g.fillStyle = gradient; g.fillRect(0, 0, 512, 128);
  for (let i = 0; i < 16; i++) {
    g.fillStyle = evening && i % 5 !== 0 ? "rgba(255,215,144,.28)" : "rgba(195,223,231,.06)";
    g.fillRect(i * 32 + 2, 12, 29, 100);
    g.fillStyle = "rgba(15,30,38,.5)"; g.fillRect(i * 32, 0, 2, 128);
    g.fillStyle = "rgba(211,225,227,.15)"; g.fillRect(i * 32 + 2, 52, 29, 2);
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping; map.repeat.x = 12; map.anisotropy = 4;
  return new THREE.MeshStandardMaterial({ color: 0xffffff, map, roughness: .23, metalness: .28, envMapIntensity: .7, emissive: evening ? 0xe1b77b : 0x000000, emissiveMap: map, emissiveIntensity: evening ? .22 : 0 });
}

export function rubberMarks(): THREE.Mesh {
  const canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 128;
  const g = canvas.getContext("2d")!;
  for (let i = 0; i < 70; i++) {
    const x = (i * 149) % 850, y = 25 + (i * 31) % 78;
    const fade = g.createLinearGradient(x, 0, x + 160, 0);
    fade.addColorStop(0, "rgba(15,20,23,0)"); fade.addColorStop(.4, "rgba(15,20,23,.13)"); fade.addColorStop(1, "rgba(15,20,23,0)");
    g.fillStyle = fade; g.fillRect(x, y, 160, 1 + i % 3);
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(410, 23), new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }));
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = .2;
  return mesh;
}
