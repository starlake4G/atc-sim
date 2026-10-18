import * as THREE from "three";

export type LightPeriod = "day" | "dusk" | "night";
export function lightPeriod(clockMin: number): LightPeriod {
  const hour = ((clockMin / 60) % 24 + 24) % 24;
  return hour < 5.5 || hour >= 20 ? "night" : hour < 7 || hour >= 17 ? "dusk" : "day";
}

export const LIGHT_LOOKS = {
  day: { sky: "#4382ae", horizon: "#c6d6dc", ground: "#606c5b", sun: 0xfff1db, sunlight: 2.5, skyLight: 1.35, fog: 0xb8cdd4, exposure: 1.03 },
  dusk: { sky: "#344b68", horizon: "#e4b79d", ground: "#424d4e", sun: 0xffc08a, sunlight: 1.65, skyLight: 1.2, fog: 0xa9a5ae, exposure: 1.08 },
  night: { sky: "#091827", horizon: "#263d52", ground: "#111e24", sun: 0xb7cde8, sunlight: .42, skyLight: .7, fog: 0x1c2c3b, exposure: 1.18 },
} as const;

/** Equirectangular sky also provides broad, coherent reflections on paint and glass. */
export function skyTexture(period: LightPeriod): THREE.CanvasTexture {
  const look = LIGHT_LOOKS[period], canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 512;
  const g = canvas.getContext("2d")!, grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, look.sky); grad.addColorStop(.3, look.sky); grad.addColorStop(.5, look.horizon); grad.addColorStop(.55, look.ground); grad.addColorStop(1, look.ground);
  g.fillStyle = grad; g.fillRect(0, 0, 1024, 512);
  if (period !== "night") for (let i = 0; i < 22; i++) {
    const x = (i * 193) % 1100 - 40, y = 150 + (i * 17) % 75;
    const cloud = g.createRadialGradient(x, y, 2, x, y, 76);
    cloud.addColorStop(0, period === "day" ? "rgba(241,248,249,.16)" : "rgba(236,210,195,.11)"); cloud.addColorStop(1, "rgba(240,245,249,0)");
    g.save(); g.translate(0, y); g.scale(1, .24); g.translate(0, -y); g.fillStyle = cloud; g.fillRect(x - 80, y - 80, 160, 160); g.restore();
  }
  if (period === "night") {
    g.fillStyle = "rgba(212,229,242,.55)";
    for (let i = 0; i < 85; i++) g.fillRect((i * 233 + 51) % 1024, 20 + (i * 71) % 180, 1, 1);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}
