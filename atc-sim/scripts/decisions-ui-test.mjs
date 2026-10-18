import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:5174";
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((file) => file && existsSync(file));
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--enable-unsafe-swiftshader", "--disable-gpu"], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage(), errors = [];
page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
await page.evaluateOnNewDocument(() => { window.browserErrors = []; window.addEventListener("error", (event) => window.browserErrors.push(event.message)); });
const wait = (selector) => page.waitForSelector(selector, { timeout: 20000 });
const settle = () => page.evaluate(() => new Promise((resolve) => { let frames = 0; const next = () => ++frames === 4 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next); }));
const clickText = async (selector, text) => { for (const element of await page.$$(selector)) if ((await element.evaluate((el) => el.textContent)).includes(text)) { await element.click(); return; } throw new Error(`找不到 ${selector}: ${text}`); };
const order = () => page.$$eval(".plan-row .plan-callsign", (elements) => elements.map((el) => el.firstChild.textContent));
async function capture() {
  await page.evaluate(async () => {
    const resource = performance.getEntriesByType("resource").find((entry) => entry.name.includes("/src/views/scene3d.ts"));
    const { Scene3D } = await import(resource.name), original = Scene3D.prototype.update;
    Scene3D.prototype.update = function (...args) { window.testWorld = args[0]; return original.apply(this, args); };
  });
  await page.waitForFunction(() => window.testWorld);
}
mkdirSync(".tmp", { recursive: true });
try {
  await page.goto(`${base}/?level=intersection&mode=standard&safety=guarded&fast=65&paused=1&lite=1`); await wait(".plan-open"); await capture();
  await page.click(".plan-open"); await wait(".plan-modal");
  for (let i = 0; i < 3; i++) await page.click('.plan-candidate button[aria-label$="加入计划"]');
  const originalOrder = await order(), before = await page.evaluate(() => JSON.stringify(window.testWorld.exportReplay()));
  await page.click('button[aria-label="比较 KST106 前移"]'); await wait(".plan-comparison");
  assert.deepEqual(await order(), originalOrder); assert.equal(await page.evaluate(() => JSON.stringify(window.testWorld.exportReplay())), before);
  assert.match(await page.$eval(".comparison-order", (el) => el.textContent), /试排 AUR201 → KST106 → SKY310/);
  await page.click(".comparison-apply"); await page.waitForFunction(() => !document.querySelector(".plan-comparison"));
  assert.deepEqual(await order(), ["AUR201", "KST106", "SKY310"]);
  assert.equal(await page.evaluate(() => window.testWorld.exportReplay().actions.length), JSON.parse(before).actions.length + 1);
  const reproduced = await page.evaluate(async () => { const { ReplayPlayer } = await import("/src/sim/replay.ts"); const w = window.testWorld, p = new ReplayPlayer(w.exportReplay()); p.seek(w.time); return JSON.stringify(p.world.snapshot().runwayPlan) === JSON.stringify(w.snapshot().runwayPlan); });
  assert(reproduced); console.log("✓ 真实班次原生试排不改变顺序/记录，采用只写一次改序，回放一致");

  // Isolated, paused scenario used to expose the heavy/light timing tradeoff in the actual UI.
  await page.goto(`${base}/?level=ground-school&mode=standard&safety=guarded&paused=1&lite=1`); await wait(".plan-open"); await capture();
  await page.evaluate(async () => {
    const { spawnDeparture } = await import("/src/sim/aircraft.ts"), w = window.testWorld; w.aircraft.clear(); w.select(null); w.time = 500;
    for (const [id, typeId, standId] of [["heavy", "B77W", "S1"], ["light", "AT72", "S5"]]) {
      const ac = spawnDeparture(w, { id, callsign: id.toUpperCase(), airline: "清风航空", typeId, kind: "dep", standId });
      ac.phase = "hold_short"; ac.controller = "TWR"; ac.pos = { ...w.idx.nodes.get(w.idx.holdingNode).pos }; ac.groundNodeId = w.idx.holdingNode; ac.scheduledMovementAt = 360; w.aircraft.set(id, ac);
    }
  });
  await page.waitForFunction(() => document.querySelector(".flights").textContent.includes("HEAVY"));
  await page.click(".plan-open"); await wait(".plan-modal"); await page.click('button[aria-label="HEAVY 加入计划"]'); await page.click('button[aria-label="LIGHT 加入计划"]');
  const baseState = await page.evaluate(() => JSON.stringify(window.testWorld.snapshot())), baseJournal = await page.evaluate(() => window.testWorld.exportReplay().actions.length);
  for (let i = 0; i < 3; i++) { await page.click('button[aria-label="比较 LIGHT 前移"]'); await wait(".plan-comparison"); await clickText(".comparison-heading button", "收起"); }
  assert.equal(await page.evaluate(() => JSON.stringify(window.testWorld.snapshot())), baseState); assert.equal(await page.evaluate(() => window.testWorld.exportReplay().actions.length), baseJournal);
  await page.click('button[aria-label="比较 LIGHT 前移"]'); await wait('.plan-comparison[data-comparable="true"]');
  assert.match(await page.$eval(".comparison-metrics > div:last-child b", (el) => el.textContent), /−1:50/);
  await page.$eval(".plan-comparison", (el) => el.scrollIntoView({ block: "center" })); await settle(); await page.screenshot({ path: ".tmp/decisions-heavy-comparison.png" });
  for (const [width, height] of [[1280, 720], [1024, 768], [390, 844]]) {
    await page.setViewport({ width, height }); await settle();
    assert(await page.$eval(".plan-modal", (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && el.scrollWidth <= el.clientWidth + 1; }), `试排工作台溢出 ${width}×${height}`);
  }
  assert(await page.$eval(".comparison-apply", (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === el; }), "手机采用按钮应完整可见并可直接点击");
  await page.screenshot({ path: ".tmp/decisions-comparison-mobile.png" });
  await page.click(".comparison-apply"); await page.waitForFunction(() => !document.querySelector(".plan-comparison")); assert.deepEqual(await order(), ["LIGHT", "HEAVY"]);
  await page.setViewport({ width: 1440, height: 900 }); await settle();
  console.log("✓ 重型/轻型显示约110秒释放差，反复取消不污染世界，三种尺寸可比较和采用");

  await page.evaluate(() => { window.testWorld.aircraft.get("heavy").holding = true; });
  await page.click('button[aria-label="比较 HEAVY 前移"]'); await wait('.plan-comparison[data-comparable="false"]');
  assert.match(await page.$eval(".comparison-uncertain", (el) => el.textContent), /等待继续滑行/);
  assert(await page.$$eval(".comparison-metrics b", (elements) => elements.every((el) => el.textContent === "暂不可比较" && el.className === "neutral")));
  await clickText(".comparison-heading button", "收起");
  await page.evaluate(() => { const w = window.testWorld, heavy = w.aircraft.get("heavy"); heavy.holding = false; heavy.phase = "lineup"; w.runwayOccupantId = heavy.id; });
  await page.waitForFunction(() => document.querySelector(".plan-row.locked")); assert.equal(await page.$(".plan-try"), null);
  await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector(".plan-modal"));
  console.log("✓ 待定方案不虚假比较，已承诺顺序不提供交换预览");

  await page.evaluate(async () => {
    const { spawnArrival } = await import("/src/sim/aircraft.ts"), { kt } = await import("/src/sim/units.ts"), w = window.testWorld;
    w.finish(w.aircraft.get("heavy")); const ac = spawnArrival(w, { id: "arr", callsign: "ARRIVAL", airline: "极光航空", typeId: "A320", kind: "arr", standId: null });
    ac.phase = "approach"; ac.approach = { runwayId: "27", established: true }; ac.controller = "TWR"; ac.pos = { x: 15000, y: 0 }; ac.hdg = 270; ac.gs = kt(180); ac.altM = 700; w.aircraft.set(ac.id, ac);
  });
  await clickText(".flights .row", "LIGHT"); await wait(".departure-opportunity");
  assert(await page.$eval(".departure-opportunity", (el) => Number(el.dataset.margin) > 0 && el.dataset.blocked === "false"));
  await clickText(".opportunity-heading button", "计算详情"); await wait(".opportunity-calculation"); assert.match(await page.$eval(".opportunity-calculation", (el) => el.textContent), /爬升释放.*2 NM/);
  for (const [width, height] of [[1280, 720], [1024, 768], [390, 844]]) {
    await page.setViewport({ width, height }); await settle();
    assert(await page.evaluate(() => { const strip = document.querySelector(".strip").getBoundingClientRect(), cmd = document.querySelector(".recommended-command").getBoundingClientRect(); return cmd.left >= strip.left && cmd.right <= strip.right && cmd.top >= strip.top && cmd.bottom <= strip.bottom && strip.bottom <= innerHeight && document.documentElement.scrollWidth <= innerWidth; }), `展开计算后许可按钮被裁切 ${width}×${height}`);
  }
  await page.setViewport({ width: 1440, height: 900 }); await clickText(".opportunity-heading button", "收起"); await settle(); await page.screenshot({ path: ".tmp/decisions-window.png" });
  await page.evaluate(() => { window.testWorld.aircraft.get("arr").pos = { x: 4000, y: 0 }; }); await page.waitForFunction(() => Number(document.querySelector(".departure-opportunity").dataset.margin) < 0);
  assert.match(await page.$eval(".guidance", (el) => el.textContent), /起飞窗口需/); assert(await page.$$eval(".strip .cmd", (buttons) => buttons.some((button) => button.textContent.includes("可以起飞") && button.disabled)));
  await page.evaluate(() => { window.testWorld.aircraft.get("arr").pos = { x: 19000, y: 0 }; }); await wait(".recommended-command");
  const commandCount = await page.evaluate(() => window.testWorld.exportReplay().actions.length); await page.click(".recommended-command"); await wait(".clearance-progress");
  await page.evaluate(() => { const w = window.testWorld; while (w.aircraft.get("light").pendingClearance) w.step(); });
  await page.waitForFunction(() => document.querySelector(".opportunity-heading b")?.textContent.includes("执行中"));
  await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press("e"); assert.equal(await page.evaluate(() => window.testWorld.exportReplay().actions.length), commandCount + 1);
  console.log("✓ 正负余量与真实许可一致，计算含爬升和缓冲，展开详情不挡许可，已许可不重复提示");

  await page.goto(`${base}/?level=operating-windows&mode=standard&safety=guarded&fast=715&bot=1&paused=1&lite=1`); await wait(".flights"); await clickText(".flights .row", "OPS204"); await wait(".departure-opportunity");
  assert(await page.$eval(".departure-opportunity", (el) => Number(el.dataset.margin) > 0 && el.dataset.blocked === "true")); assert.match(await page.$eval(".guidance", (el) => el.textContent), /侧风.*恢复/);
  assert(await page.$$eval(".strip .cmd", (buttons) => buttons.some((button) => button.textContent.includes("可以起飞") && button.disabled)));
  await page.setViewport({ width: 390, height: 844 }); await settle(); await page.screenshot({ path: ".tmp/decisions-wind-mobile.png" });
  assert.equal(await page.$("vite-error-overlay"), null); assert.deepEqual(await page.evaluate(() => window.browserErrors), []); assert.deepEqual(errors, []);
  console.log("✓ 正余量仍显示真实侧风限制并禁止起飞，窄屏无运行错误");
} catch (error) {
  await page.screenshot({ path: ".tmp/decisions-ui-failure.png" }); console.log(await page.$eval(".app", (el) => el.innerText)); throw error;
} finally { await browser.close(); }
