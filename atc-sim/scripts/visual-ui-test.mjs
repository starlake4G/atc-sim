import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { testBase } from "./test-base.mjs";

const base = testBase;
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-gpu"], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage(), errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function clickText(selector, text) { for (const button of await page.$$(selector)) if ((await button.evaluate((el) => el.textContent)).includes(text)) { await button.click(); return; } throw new Error(`找不到 ${text}`); }
const area = () => page.$eval(".stage", (el) => { const r = el.getBoundingClientRect(); return r.width * r.height / (innerWidth * innerHeight); });
mkdirSync(".tmp", { recursive: true });
try {
  if (!process.argv.includes("--lighting-only")) {
  await page.goto(`${base}/?level=ground-school&mode=standard&paused=1&focus=1`); await page.waitForSelector(".flights .row");
  await page.click(".flights .row"); await page.keyboard.press("F2"); await settle();
  await page.evaluate(async () => {
    const source = performance.getEntriesByType("resource").find((e) => e.name.includes("/src/views/scene3d.ts"));
    const { Scene3D } = await import(source.name), original = Scene3D.prototype.update;
    Scene3D.prototype.update = function (...args) { const result = original.apply(this, args); window.visualScene = this; return result; };
  });
  await page.waitForFunction(() => !!window.visualScene);
  const focused = await area(); assert(focused > .56, `专注场景占比不足：${focused}`);
  await page.screenshot({ path: ".tmp/visual-day-focus.png" });
  await page.$eval(".stage", (el) => el.scrollIntoView());
  await (await page.$(".stage")).screenshot({ path: ".tmp/visual-day-scene.png" });
  await page.click(".focus-button"); await settle(); const normal = await area(); assert(focused > normal * 1.2);
  await page.screenshot({ path: ".tmp/visual-day-workbench.png" });
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press("v"); await settle();
  assert.equal(await page.$eval(".focus-button", (el) => el.getAttribute("aria-pressed")), "true");
  for (const [label, selector] of [["地面", ".ground-panel"], ["雷达", ".radar"], ["无线电", ".radio"]]) {
    await clickText(".scene-tools button", label); await settle();
    assert(await page.$eval(selector, (el) => { const r = el.getBoundingClientRect(); return r.width > 100 && r.height > 100 && r.bottom < document.querySelector(".strip").getBoundingClientRect().top; }));
    await clickText(".scene-tools button", label);
  }
  assert(await page.$eval(".recommended-command", (el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".recommended-command") !== null; }));
  const audit = await page.evaluate(() => {
    const s = window.visualScene, airport = s.scene.children.find((o) => o.children.some((child) => child.name === "terrain"));
    return { staticObjects: airport.children.length, drawCalls: s.renderer.info.render.calls, triangles: s.renderer.info.render.triangles, textures: s.renderer.info.memory.textures, sceneArea: document.querySelector(".stage").getBoundingClientRect().toJSON() };
  });
  assert(audit.staticObjects < 50, JSON.stringify(audit));
  console.log(`✓ 专注视图 ${(focused * 100).toFixed(1)}%，工作台 ${(normal * 100).toFixed(1)}%；三个工具与许可可用；机场 ${audit.staticObjects} 个静态对象`);
  await page.evaluate(async () => {
    const source = performance.getEntriesByType("resource").find((e) => e.name.includes("/src/views/scene3d.ts"));
    const { Scene3D } = await import(source.name), dispose = Scene3D.prototype.dispose; window.lightDisposals = [];
    Scene3D.prototype.dispose = function () {
      const record = { sky: false, reflection: !this.reflection };
      this.skyMap?.addEventListener("dispose", () => { record.sky = true; });
      this.reflection?.addEventListener("dispose", () => { record.reflection = true; });
      dispose.call(this); window.lightDisposals.push(record);
    };
  });
  await page.click(".quality-button"); await settle(); await page.click(".quality-button"); await settle();
  assert(await page.evaluate(() => {
    const s = window.visualScene; let bumps = 0;
    s.scene.traverse((o) => { for (const material of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) if (material.bumpMap) bumps++; });
    return s.quality === "low" && s.scene.environment === null && bumps === 0 && window.lightDisposals.length === 2 && window.lightDisposals.every((record) => record.sky && record.reflection);
  }));
  await page.click(".quality-button"); await settle();
  console.log("✓ 节能档关闭环境反射与道面凹凸，旧天空/反射资源被释放，恢复均衡画质正常");
  await page.evaluate(() => localStorage.setItem("kestrel.window.v1.flights", JSON.stringify({ x: 330, y: 160, width: 315, height: 270 })));
  await page.reload(); await page.waitForSelector(".focus-mode .topbar");
  assert(await page.$eval(".flights", (el) => { const r = el.getBoundingClientRect(); return r.right > innerWidth - 20 && r.width === 224; }));
  await page.click(".focus-button"); await settle();
  assert(await page.$eval(".flights", (el) => { const r = el.getBoundingClientRect(); return r.x === 330 && r.width === 315; }));
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("kestrel.window.v1.flights")).x), 330);
  await page.click(".focus-button"); await settle();
  console.log("✓ 已保存的浮动航班窗在专注模式临时归位，退出后恢复且不覆盖布局记录");
  await page.setViewport({ width: 390, height: 844 }); await settle();
  if (!(await page.$eval(".flights", (el) => el.getBoundingClientRect().width > 0))) await clickText(".mobile-navigation button", "航班");
  await settle(); await page.click(".flights .row");
  await clickText(".mobile-navigation button", "地面"); await settle();
  assert(await page.$eval(".ground-panel", (el) => el.getBoundingClientRect().height > 100));
  await clickText(".mobile-navigation button", "地面");
  await page.screenshot({ path: ".tmp/visual-mobile.png" });
  console.log("✓ 专注偏好保存，切到窄屏后原面板导航与许可正常");
  }

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/?level=heavy-wave&mode=standard&paused=1&focus=1`); await page.waitForSelector(".flights .row");
  await page.click(".flights .row"); await page.keyboard.press("F2"); await settle();
  await page.screenshot({ path: ".tmp/visual-dusk-focus.png" });
  // Isolated rendering fixture; night is a lighting sample, not a new shipped mission.
  await page.evaluate(async () => {
    const source = performance.getEntriesByType("resource").find((e) => e.name.includes("/src/views/scene3d.ts"));
    const { Scene3D } = await import(source.name), build = Scene3D.prototype.buildSky;
    Scene3D.prototype.buildSky = function () { this.period = "night"; this.renderer.toneMappingExposure = 1.18; this.world.level = { ...this.world.level, startClockMin: 21 * 60 }; return build.call(this); };
  });
  await page.click(".quality-button"); await settle();
  await page.screenshot({ path: ".tmp/visual-night-sample.png" });
  await page.keyboard.press("F3"); await settle(); await page.screenshot({ path: ".tmp/visual-night-top.png" });
  assert.equal(await page.$$eval(".stage canvas", (els) => els.length), 1);
  assert.equal(await page.$("vite-error-overlay"), null); assert.deepEqual(errors, []);
  console.log("✓ 白昼/黄昏/夜间样板及俯瞰渲染正常，切换画质无重复画布或浏览器错误");
} catch (e) { await page.screenshot({ path: ".tmp/visual-failure.png" }); throw e; }
finally { await browser.close(); }
