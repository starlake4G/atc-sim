import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:5174";
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((file) => file && existsSync(file));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-gpu"], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage(), errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
await page.evaluateOnNewDocument(() => { window.browserErrors = []; window.addEventListener("error", (event) => window.browserErrors.push(event.message)); });
const wait = (selector) => page.waitForSelector(selector, { timeout: 20000 });
const clickText = async (selector, text) => { for (const element of await page.$$(selector)) if ((await element.evaluate((el) => el.textContent)).includes(text)) { await element.click(); return; } throw new Error(`找不到 ${selector}: ${text}`); };
const pause = async () => { if (await page.$$eval(".topbar button", (buttons) => buttons.some((button) => button.textContent === "暂停"))) await clickText(".topbar button", "暂停"); };
const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function capture() {
  await page.evaluate(async () => {
    const source = performance.getEntriesByType("resource").find((entry) => entry.name.includes("/src/views/scene3d.ts"));
    const { Scene3D } = await import(source.name), original = Scene3D.prototype.update;
    Scene3D.prototype.update = function (...args) { window.testWorld = args[0]; window.environment = this.environment; return original.apply(this, args); };
  });
  await page.waitForFunction(() => window.testWorld && window.environment);
}
mkdirSync(".tmp", { recursive: true });
try {
  await page.goto(`${base}/?lite=1`); await wait(".cards");
  assert.equal(await page.$$eval(".card", (cards) => cards.length), 8);
  await clickText(".card", "运行窗口"); assert.match(await page.$eval(".scenario-operations", (el) => el.textContent), /跑道例行检查.*西南阵风/);
  for (const [width, height] of [[1280, 720], [1024, 768], [390, 844]]) {
    await page.setViewport({ width, height }); await settle();
    const box = await page.$eval(".start-modal > .primary", (el) => { const r = el.getBoundingClientRect(); return [r.left, r.right, r.bottom]; });
    assert(box[0] >= 0 && box[1] <= width && box[2] <= height, `运行窗口开始按钮被裁切 ${width}×${height}`);
  }
  console.log("✓ 八关菜单与事件预览在桌面、平板和手机均可直接开始");

  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${base}/?level=operating-windows&mode=standard&fast=65&lite=1&view=top&paused=1`); await wait(".inspection-start"); await pause(); await capture();
  assert.equal(await page.$eval(".inspection-start", (el) => el.disabled), false);
  await page.click(".inspection-start"); await wait(".runway-state.closed"); await wait(".map-closure");
  assert.match(await page.$eval(".operation-item.kind-inspection", (el) => el.textContent), /进行中.*后恢复/);
  assert.equal(await page.evaluate(() => window.testWorld.exportReplay().actions.filter((action) => action.kind === "operation").length), 1);
  assert(await page.evaluate(() => window.environment.root.children.slice(-2).every((object) => object.visible)));
  await page.screenshot({ path: ".tmp/operations-inspection.png" });
  await page.click(".operation-heading"); assert.equal(await page.$(".operation-body"), null); await page.click(".operation-heading");
  await page.evaluate(() => { const w = window.testWorld, end = w.operations.snapshot().find((event) => event.kind === "inspection").endsAt; while (w.time < end + .1) w.step(); });
  await page.waitForFunction(() => !document.querySelector(".runway-state.closed") && !document.querySelector(".map-closure"));
  assert(await page.evaluate(() => window.environment.root.children.slice(-2).every((object) => !object.visible)));
  console.log("✓ 手动提前检查、倒计时、三维巡查/关闭标记和自动开放一致，面板可收起");

  await page.evaluate(async () => {
    const { botTick } = await import("/src/sim/bot.ts"), w = window.testWorld;
    for (let tick = 0; tick < w.level.durationMin * 600 && w.status === "running"; tick++) { w.step(); if (tick % 20 === 0) botTick(w); }
    window.originalScore = JSON.stringify(w.score); window.originalOperations = JSON.stringify(w.snapshot().operations);
  });
  await wait(".operation-review"); assert.match(await page.$eval(".operation-review", (el) => el.textContent), /提前.*西南阵风/);
  assert.equal(await page.evaluate(() => window.testWorld.score.landings + window.testWorld.score.takeoffs), 8);
  await clickText(".debrief button", "回看调度"); await wait(".replay-transport");
  await page.$eval('input[aria-label="回放时间"]', (el) => { el.focus(); }); await page.keyboard.press("End");
  await page.waitForFunction(() => JSON.stringify(window.testWorld.score) === window.originalScore && JSON.stringify(window.testWorld.snapshot().operations) === window.originalOperations);
  await clickText(".replay-heading button", "返回复盘"); await wait(".operation-review");
  assert.equal(await page.evaluate(() => JSON.stringify(window.testWorld.score)), await page.evaluate(() => window.originalScore));
  console.log("✓ 运行复盘显示实际检查策略，回放重建提前检查与天气，返回后成绩不变");

  await page.goto(`${base}/?level=operating-windows&mode=standard&fast=715&bot=1&lite=1&paused=1`); await wait(".operation-item.kind-weather.active"); await pause(); await capture();
  await clickText(".flights .row", "OPS204"); await wait(".guidance");
  assert.match(await page.$eval(".guidance", (el) => el.textContent), /阵风侧风.*AT72.*15kt.*恢复/);
  assert.match(await page.$eval(".weather", (el) => el.textContent), /18G26kt/);
  assert(await page.$$eval(".strip .cmd", (buttons) => buttons.some((el) => el.textContent.includes("可以起飞") && el.disabled)));
  assert.match(await page.$$eval(".flights .row", (rows) => rows.find((row) => row.textContent.includes("OPS204")).textContent), /阵风侧风/);
  assert(await page.$eval(".strip .cmd.primary:disabled", (el) => getComputedStyle(el).backgroundColor !== "rgb(165, 229, 206)"), "受限按钮不应保持可放行的高亮色");
  await page.click(".plan-open"); await wait(".plan-modal"); await page.click('button[aria-label="OPS204 加入计划"]');
  assert.match(await page.$eval(".plan-reason", (el) => el.textContent), /西南阵风.*结束/); await clickText(".plan-modal .editor-head button", "关闭");
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await page.setViewport({ width, height }); await settle();
    if (width === 390) await clickText(".mobile-navigation button", "运行");
    const fits = await page.evaluate(() => { const r = document.querySelector(".operation-board").getBoundingClientRect(), strip = document.querySelector(".strip").getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= strip.top && document.documentElement.scrollWidth <= innerWidth; });
    assert(fits, `运行事件面板越界或覆盖许可区 ${width}×${height}`);
    assert.equal(await page.$eval(".operation-item", (el) => getComputedStyle(el).display), "block", "事件行不可继承通用天气标签的横排样式");
    assert.equal(await page.$("vite-error-overlay"), null, "不应出现运行时错误浮层");
    assert.deepEqual(await page.evaluate(() => window.browserErrors), [], "缩放时出现浏览器错误");
    await page.screenshot({ path: `.tmp/operations-${width === 390 ? "mobile" : width === 1024 ? "compact" : "wind"}.png` });
  }
  console.log("✓ 受风许可与跑道计划显示相同恢复窗口，三种尺寸事件面板不遮挡许可区域");

  await page.goto(`${base}/?level=operating-windows&mode=standard&fast=65&lite=1&paused=1`); await wait(".mobile-operations.has-event");
  assert.equal(await page.$eval(".flights", (el) => getComputedStyle(el).display), "flex");
  assert(await page.$eval(".mobile-operations", (el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(".mobile-operations") === el; }), "航班面板展开时运行入口仍应可点击");
  await page.click(".mobile-operations"); await page.waitForFunction(() => getComputedStyle(document.querySelector(".flights")).display === "none");
  await page.click(".operation-heading"); assert.equal(await page.$(".operation-body"), null); await page.click(".mobile-operations"); await wait(".operation-body");
  assert(await page.$eval(".inspection-start", (el) => { const r = el.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; }), "运行入口必须使提前检查按钮真正可点击");
  await page.click(".inspection-start"); await wait(".runway-state.closed"); await page.screenshot({ path: ".tmp/operations-mobile-inspection.png" });
  assert.equal(await page.$("vite-error-overlay"), null); assert.deepEqual(await page.evaluate(() => window.browserErrors), []); assert.deepEqual(errors, []);
  console.log("✓ 手机默认航班面板展开时仍能从固定运行入口查看预告、展开卡片并实际提前检查");
} catch (error) {
  await page.screenshot({ path: ".tmp/operations-ui-failure.png" }); console.log(await page.$eval(".app", (el) => el.innerText)); throw error;
} finally { await browser.close(); }
