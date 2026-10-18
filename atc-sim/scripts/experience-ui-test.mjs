import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { testBase } from "./test-base.mjs";

const base = testBase;
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((file) => file && existsSync(file));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-gpu"], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage(), errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const wait = (selector) => page.waitForSelector(selector, { timeout: 20000 });
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const clickText = async (selector, text) => { for (const element of await page.$$(selector)) if ((await element.evaluate((el) => el.textContent)).includes(text)) { await element.click(); return; } throw new Error(`找不到 ${selector}: ${text}`); };
const pause = async () => { const label = await page.$$eval(".topbar button", (buttons) => buttons.find((button) => button.textContent === "暂停")?.textContent); if (label) await clickText(".topbar button", "暂停"); };
mkdirSync(".tmp", { recursive: true });
try {
  if (!process.argv.includes("--mobile-only")) {
  await page.goto(`${base}/?lite=1`); await wait(".cards");
  await clickText(".card", "三向合流");
  for (const [width, height] of [[1280, 720], [1024, 768]]) {
    await page.setViewport({ width, height }); await settle();
    const box = await page.$eval(".start-modal > .primary", (el) => { const rect = el.getBoundingClientRect(); return [rect.left, rect.right, rect.bottom]; });
    assert(box[0] >= 0 && box[1] <= width && box[2] <= height, `菜单开始按钮未完整显示 ${width}×${height}`);
  }
  await page.setViewport({ width: 1280, height: 720 });
  console.log("✓ 新菜单与挑战输入在两种桌面尺寸中可直接开始");

  await page.goto(`${base}/?level=ground-school&mode=standard&lite=1`); await wait(".topbar"); await pause();
  await clickText(".flights .row", "KST101"); await wait(".recommended-command");
  assert.match(await page.$eval(".recommended-command", (el) => el.textContent), /机头朝南/);
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press("e");
  await page.waitForFunction(() => !document.querySelector(".recommended-command") && document.querySelector(".advance-button") && !document.querySelector(".advance-button").disabled);
  assert.match(await page.$eval(".toast.success", (el) => el.textContent), /KST101.*推出/);
  await page.click(".advance-button"); await wait(".recommended-command");
  assert.match(await page.$eval(".recommended-command", (el) => el.textContent), /经 B 滑行/);
  assert.match(await page.$eval(".guidance", (el) => el.textContent), /路线/);
  assert(await page.$(".pause-banner"));
  console.log("✓ E 下一步许可及成功反馈，推进至滑行请求后停止并保持暂停");

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/?level=intersection&mode=standard&fast=160&bot=1&lite=1`); await wait(".topbar"); await pause();
  await page.evaluate(async () => {
    const source = performance.getEntriesByType("resource").find((entry) => entry.name.includes("/src/views/scene3d.ts"));
    const { Scene3D } = await import(source.name), original = Scene3D.prototype.update;
    Scene3D.prototype.update = function (...args) {
      const result = original.apply(this, args);
      if (args[2] === "top") {
        const east = this.camera.position.clone().set(100, 0, -250).project(this.camera), north = this.camera.position.clone().set(0, 0, -350).project(this.camera);
        window.topOrientation = { east: east.x, north: north.y };
      }
      const ac = args[0].aircraft.get(args[3]);
      if (args[2] === "follow" && ac?.phase === "taxi_out") {
        const p = this.camera.position.clone().set(ac.pos.x - 55, .1, -ac.pos.y + 6).project(this.camera);
        const gl = this.renderer.getContext(), pixel = new Uint8Array(4);
        gl.readPixels(Math.round((p.x + 1) * .5 * this.renderer.domElement.width), Math.round((p.y + 1) * .5 * this.renderer.domElement.height), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        window.pavementPixel = [...pixel];
      }
      return result;
    };
  });
  await clickText(".flights .row", "AUR201"); await clickText(".topbar button", "跟机");
  await page.waitForFunction(() => window.pavementPixel?.[3] === 255);
  const color = await page.evaluate(() => window.pavementPixel);
  assert(color[2] > color[1] * .75 && Math.abs(color[0] - color[1]) < 35, `近景道面被草地遮挡：${color}`);
  await page.screenshot({ path: ".tmp/experience-play.png" });
  console.log(`✓ 跟机近景实际绘制道面，像素 ${color.join(",")}，不再被大地形遮挡`);
  await clickText(".topbar button", "俯瞰"); await page.waitForFunction(() => window.topOrientation?.east > 0 && window.topOrientation?.north > 0);
  await clickText(".topbar button", "跟机"); await settle();
  console.log("✓ 俯瞰保持北朝上、东朝右，与地面图和雷达方向一致");
  for (const [width, height] of [[1280, 720], [1024, 768]]) {
    await page.setViewport({ width, height }); await settle();
    assert(await page.evaluate(() => { const strip = document.querySelector(".strip").getBoundingClientRect(), radio = document.querySelector(".radio").getBoundingClientRect(), bar = document.querySelector(".topbar"); return strip.bottom <= innerHeight && strip.left >= 0 && strip.right <= innerWidth && radio.bottom <= strip.top && bar.scrollWidth <= bar.clientWidth + 1; }), `工作台重叠或顶部溢出 ${width}×${height}`);
  }
  await clickText(".topbar button", "画质"); await settle(); await clickText(".topbar button", "画质"); await settle();
  assert.equal(await page.$$eval(".stage canvas", (canvases) => canvases.length), 1);
  assert.equal(await page.evaluate(() => localStorage.getItem("kestrel.quality")), "low");
  await clickText(".topbar button", "提示音"); await page.waitForFunction(() => document.querySelector(".sound-button").getAttribute("aria-pressed") === "true");
  await clickText(".topbar button", "提示音");
  console.log("✓ 两尺寸工作台无遮挡，切换画质只保留一个渲染器，提示音可开关");

  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${base}/?level=tutorial&mode=standard&fast=80&lite=1`); await wait(".topbar"); await pause();
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press("n"); await wait(".recommended-command");
  await page.click(".vector-toggle"); assert.match(await page.$eval(".strip", (el) => el.textContent), /下降到/); await page.click(".vector-toggle");
  for (let i = 0; i < 15 && !(await page.$(".result")); i++) {
    if (await page.$(".recommended-command")) await page.click(".recommended-command");
    else if (await page.$eval(".advance-button", (button) => !button.disabled)) await page.click(".advance-button");
    else throw new Error(await page.$eval(".strip", (el) => el.innerText));
    await settle();
  }
  await wait(".result"); assert.equal(await page.$eval(".grade", (el) => el.textContent), "S");
  assert.equal(await page.$$eval(".delay-legend span", (items) => items.length), 5);
  assert.match(await page.$eval(".debrief-coach", (el) => el.textContent), /准时完成/);
  const records = await page.evaluate(() => localStorage.getItem("kestrel.records.v2"));
  await page.screenshot({ path: ".tmp/experience-debrief.png" });
  console.log("✓ 新手可用明确下一步与请求推进完成手动进场，获得 S 并查看延误复盘");

  const downloadDir = path.resolve(".tmp", `replay-download-${Date.now()}`); mkdirSync(downloadDir, { recursive: true });
  const cdp = await page.createCDPSession(); await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await page.click(".export-replay");
  for (let i = 0; i < 30 && !readdirSync(downloadDir).some((file) => file.endsWith(".json")); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const filename = readdirSync(downloadDir).find((file) => file.endsWith(".json")); assert(filename, "调度记录没有导出");
  const record = JSON.parse(readFileSync(path.join(downloadDir, filename), "utf8")); assert(record.actions.length >= 5 && record.version === 1);
  await clickText(".debrief button", "回看调度"); await wait(".replay-transport"); assert.equal(await page.$(".result"), null);
  await page.click('input[aria-label="回放时间"]'); await page.keyboard.press("End");
  await page.waitForFunction(() => Number(document.querySelector('input[aria-label="回放时间"]').value) >= Number(document.querySelector('input[aria-label="回放时间"]').max) - 1);
  await page.waitForFunction(() => document.querySelector(".replay-controls button").textContent === "从头播放");
  await page.keyboard.press("Home"); await page.waitForFunction(() => Number(document.querySelector('input[aria-label="回放时间"]').value) === 0);
  await clickText(".replay-action button", "下一条操作"); await settle();
  assert.match(await page.$eval(".replay-action p", (el) => el.textContent), /AUR102/);
  await clickText(".replay-controls button", "播放回放");
  await page.waitForFunction(() => Number(document.querySelector('input[aria-label="回放时间"]').value) > 2);
  await clickText(".replay-controls button", "暂停回放"); await page.screenshot({ path: ".tmp/experience-replay.png" });
  await clickText(".replay-heading button", "返回复盘"); await wait(".result");
  assert.equal(await page.$eval(".grade", (el) => el.textContent), "S"); assert.equal(await page.evaluate(() => localStorage.getItem("kestrel.records.v2")), records);
  console.log("✓ 导出真实记录，回放拖动/逐条/播放/暂停/退出均正常，成绩不受回放影响");

  }
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${base}/?level=ground-school&mode=standard&lite=1`); await wait(".mobile-navigation"); await pause();
  await clickText(".flights .row", "KST101"); await wait(".recommended-command");
  assert.equal(await page.$eval(".flights", (el) => getComputedStyle(el).display), "none");
  for (const [label, selector] of [["雷达", ".radar"], ["地面", ".ground-panel"], ["无线电", ".radio"]]) {
    await clickText(".mobile-navigation button", label); await page.waitForFunction((selector) => document.querySelector(selector).getBoundingClientRect().width > 0, {}, selector);
    await clickText(".mobile-navigation button", label); await settle();
  }
  assert(await page.evaluate(() => { const strip = document.querySelector(".strip").getBoundingClientRect(), nav = document.querySelector(".mobile-navigation").getBoundingClientRect(); return strip.right <= innerWidth && strip.bottom <= innerHeight && nav.bottom <= strip.top; }));
  await page.screenshot({ path: ".tmp/experience-mobile.png" });
  assert.deepEqual(errors, [], "浏览器运行错误");
  console.log("✓ 手机可切换单一面板、选机后看场景与许可，界面无横向溢出");
} catch (error) {
  await page.screenshot({ path: ".tmp/experience-ui-failure.png" }); console.log(await page.$eval(".app", (el) => el.innerText)); throw error;
} finally { await browser.close(); }
