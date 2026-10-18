import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { testBase } from "./test-base.mjs";
const base = testBase;
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((p) => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-gpu"], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage(), errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const wait = (selector) => page.waitForSelector(selector, { timeout: 20000 });
const click = async (selector, text) => { for (const el of await page.$$(selector)) if ((await el.evaluate((e) => e.textContent)).includes(text) && !(await el.evaluate((e) => e.disabled))) { await el.click(); return; } throw new Error(`按钮不可用: ${text}`); };
async function capture() {
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource").find((r) => r.name.includes("/src/views/scene3d.ts"));
    const { Scene3D } = await import(resource.name), original = Scene3D.prototype.update;
    Scene3D.prototype.update = function (...args) { window.testWorld = args[0]; window.testScene = this; return original.apply(this, args); };
  });
  await page.waitForFunction(() => window.testWorld);
}
async function drainRadio() {
  await page.evaluate(() => { const w = window.testWorld; for (let i = 0; i < 900 && w.aircraftList().some((a) => a.pendingClearance) && w.status === "running"; i++) w.step(); });
  await page.waitForFunction(() => !document.querySelector(".clearance-progress"));
}
mkdirSync(".tmp", { recursive: true });
try {
  await page.goto(`${base}/?level=ground-school&mode=standard&paused=1&lite=1`); await wait(".topbar"); await capture(); await click(".flights .row", "KST101");
  assert.equal(await page.$eval(".safety-toggle", (el) => el.getAttribute("aria-checked")), "false");
  await page.click(".safety-toggle"); assert.equal(await page.evaluate(() => localStorage.getItem("kestrel.safety")), "guarded");
  await page.reload(); await wait(".topbar"); await capture(); assert.equal(await page.$eval(".safety-toggle", (el) => el.getAttribute("aria-checked")), "true");
  await click(".flights .row", "KST101"); await click(".strip button", "机头朝南"); await wait(".clearance-progress");
  assert.equal(await page.evaluate(() => window.testWorld.aircraftList()[0].phase), "parked");
  assert(await page.$$eval(".strip .cmd-group button", (buttons) => buttons.every((button) => button.disabled)));
  await page.evaluate(() => { const w = window.testWorld, a = w.aircraftList()[0]; while (w.time < a.pendingClearance.readbackAt + .1) w.step(); });
  await page.waitForFunction(() => document.querySelector(".clearance-progress")?.textContent.includes("飞行员复诵中"));
  assert.equal(await page.evaluate(() => window.testWorld.aircraftList()[0].phase), "parked"); await page.screenshot({ path: ".tmp/control-radio.png" });
  await drainRadio(); assert.equal(await page.evaluate(() => window.testWorld.aircraftList()[0].phase), "pushback");
  console.log("✓ 原生安全开关可切换且持久保存；完整复诵前按钮锁定、飞机不动");

  await page.evaluate(() => { const w = window.testWorld, a = w.aircraftList()[0]; Object.assign(a, { phase: "hold_short", controller: "TWR", pos: { ...w.idx.nodes.get(w.idx.holdingNode).pos }, gs: 0, hdg: 180, route: null, pendingClearance: null }); w.lastRunwayUse = { callsign: "HEAVY", typeId: "B77W", at: w.time }; });
  await page.waitForFunction(() => document.querySelector(".strip")?.textContent.includes("尾流"));
  assert(await page.$$eval(".strip button", (els) => els.some((el) => el.textContent.includes("可以起飞") && el.disabled)));
  await page.click(".safety-toggle"); await page.waitForFunction(() => document.querySelector(".departure-opportunity")?.dataset.blocked === "false");
  assert(await page.$$eval(".strip button", (els) => els.some((el) => el.textContent.includes("可以起飞") && !el.disabled && el.title.includes("尾流"))));
  await page.screenshot({ path: ".tmp/control-warnings.png" }); await click(".strip button", "可以起飞"); await wait(".toast.warning");
  assert.equal(await page.evaluate(() => window.testWorld.aircraftList()[0].phase), "hold_short"); await drainRadio();
  console.log("✓ 同一尾流风险在保护开时拒绝、关时可执行，警告和通话进度均显示");

  await page.goto(`${base}/?level=ground-school&mode=standard&paused=1&lite=1`); await wait(".topbar"); await capture();
  await page.evaluate(() => { const w = window.testWorld, a = w.aircraftList()[0]; Object.assign(a, { phase: "hold_short", controller: "TWR", pos: { ...w.idx.nodes.get(w.idx.holdingNode).pos }, gs: 0, hdg: 180 }); w.select(a.id); });
  await wait(".strip"); await click(".strip button", "预移交离场"); await drainRadio(); await wait(".handoff-pending");
  assert.equal(await page.evaluate(() => window.testWorld.aircraftList()[0].controller), "TWR"); assert.match(await page.$eval(".handoff-pending", (e) => e.textContent), /1500 ft/);
  assert(await page.$$eval(".strip button", (els) => els.some((el) => el.textContent.includes("可以起飞") && !el.disabled)));
  console.log("✓ 提前移交显示待生效条件，复诵后仍保留塔台起飞许可");

  await page.evaluate(async () => {
    const { spawnDeparture } = await import("/src/sim/aircraft.ts"), w = window.testWorld, a = w.aircraftList()[0];
    Object.assign(a, { phase: "takeoff", pos: { x: 1000, y: 0 }, hdg: 270, gs: 30, altM: w.idx.def.elevationM, route: null, pendingHandoff: null });
    const b = spawnDeparture(w, { id: "block", callsign: "BLOCK", airline: "测试", typeId: "A320", kind: "dep", standId: "S4" }); Object.assign(b, { phase: "lineup", pos: { x: 900, y: 0 }, hdg: 270, gs: 0, route: null }); w.aircraft.set(b.id, b); w.setSafetyMode("consequence");
    w.occupyRunway(a); w.occupyRunway(b); for (let i = 0; i < 100 && w.status === "running"; i++) w.step();
  });
  await wait(".result"); assert.equal(await page.$eval(".result h2", (e) => e.textContent), "本班失败"); assert.match(await page.$eval(".result .sub", (e) => e.textContent), /BLOCK.*碰撞/); assert.equal(await page.$eval(".grade", (e) => e.textContent), "×");
  assert(!(await page.$$eval(".result button", (els) => els.some((el) => el.textContent.includes("下一班"))))); await page.screenshot({ path: ".tmp/control-failure.png" });
  console.log("✓ 实际碰撞出现失败结算、具体航班与重试入口，不显示成功评级");

  await page.goto(`${base}/?level=morning-rush&mode=standard&fast=450&bot=1&paused=1&lite=1&view=top`); await wait(".topbar"); await capture();
  assert.equal(await page.evaluate(() => window.testWorld.idx.def.nodes.some((n) => /^C-?\d/.test(n.id))), false);
  assert.equal(await page.$$eval(".map-caption", (els) => els.some((el) => el.textContent.includes("C →"))), false);
  await page.screenshot({ path: ".tmp/control-airport.png" });
  await page.setViewport({ width: 390, height: 844 }); await page.reload(); await wait(".topbar");
  assert(await page.$(".safety-toggle")); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []); console.log("✓ 双滑行道与西侧出口同步出现在场景和地图，手机没有页面横向溢出，浏览器无异常");
} catch (error) { try { await page.screenshot({ path: ".tmp/control-ui-failure.png" }); } catch {} throw error; }
finally { await browser.close(); }
