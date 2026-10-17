import puppeteer from "puppeteer-core";

/**
 * 无头截图（用于 3D 视觉回归）。
 * 用法：node scripts/shot.mjs "<url>" <out.png> [waitMs]
 * 例：  node scripts/shot.mjs "http://localhost:5173/?level=tutorial&fast=330&bot=1&lite=1" shot.png 3500
 */
const url = process.argv[2];
const out = process.argv[3] ?? "shot.png";
const wait = Number(process.argv[4] ?? 3000);

if (!url) {
  console.error("缺少 URL");
  process.exit(1);
}

const candidates = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const { existsSync } = await import("node:fs");
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) {
  console.error("找不到 Chrome/Edge");
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("favicon")) errors.push(`console: ${m.text()}`);
});
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
await new Promise((r) => setTimeout(r, wait));
await page.screenshot({ path: out });
console.log(errors.length ? errors.join("\n") : `saved ${out}`);
await browser.close();
