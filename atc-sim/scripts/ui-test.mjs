import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:5173";
const executablePath = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((path) => path && existsSync(path));
assert(executablePath, "找不到 Chrome/Edge，可用 CHROME_PATH 指定浏览器");
const browser = await puppeteer.launch({ executablePath, headless: true,
  args: ["--enable-unsafe-swiftshader", "--disable-gpu"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
try {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const wait = (selector) => page.waitForSelector(selector, { timeout: 15000 });
  const clickText = async (selector, text) => {
    const elements = await page.$$(selector);
    for (const element of elements) {
      if ((await element.evaluate((el) => el.textContent)).includes(text)) { await element.click(); return; }
    }
    throw new Error(`找不到 ${selector}: ${text}`);
  };
  if (!process.argv.includes("--manual-only")) {
  await page.goto(`${base}/?level=unknown&lite=1`);
  await wait(".cards");
  assert.match(await page.$eval(".toast", (el) => el.textContent), /关卡不存在/);
  for (let i = 0; i < 3; i++) {
    await page.click(".card");
    await page.click(".modal > .primary");
    await wait(".topbar");
    assert.equal(await page.$$eval(".stage canvas", (els) => els.length), 1);
    await clickText(".topbar button", "退出");
    await wait(".cards");
    await page.waitForFunction(() => document.querySelectorAll(".stage canvas, .ac-label").length === 0);
  }
  console.log("✓ 无效关卡可恢复，重复退出/重开清理场景及标签");

  await page.goto(`${base}/?level=morning-rush&fast=540&bot=1&lite=1`);
  await wait(".radar-aircraft");
  await clickText(".topbar button", "暂停");
  await page.click(".radar-aircraft");
  await wait(".strip");
  assert(await page.$(".radar-aircraft.selected"));
  await clickText(".topbar button", "4×");
  await clickText(".topbar button", "跟机");
  await clickText(".topbar button", "俯瞰");
  await clickText(".topbar button", "塔台");
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("Escape");
  await page.keyboard.press("Tab");
  await wait(".strip");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => [...document.querySelectorAll(".topbar button")].some((el) => el.textContent === "暂停"));
  await clickText(".topbar button", "暂停");
  // 选择选项最多的进场机，验证指令栏与左侧窗口不相交。
  await clickText(".flights .row", "SKY118");
  for (const [width, height] of [[1280, 720], [1024, 768]]) {
    await page.setViewport({ width, height });
    await page.waitForFunction(() => document.querySelector(".stage canvas").width > 0);
    const layout = await page.evaluate(() => {
      const strip = document.querySelector(".strip").getBoundingClientRect();
      const radio = document.querySelector(".radio").getBoundingClientRect();
      return { inViewport: strip.left >= 0 && strip.right <= innerWidth && strip.bottom <= innerHeight,
        separate: radio.bottom <= strip.top };
    });
    assert(layout.inViewport && layout.separate, `面板溢出或重叠：${width}×${height}`);
  }
  await page.setViewport({ width: 1280, height: 720 });
  mkdirSync(".tmp", { recursive: true });
  await clickText(".topbar button", "布局编辑");
  const header = await page.$('.workspace-window[data-window="ground"] .panel-title');
  const before = await header.boundingBox();
  await page.mouse.move(before.x + 30, before.y + 12); await page.mouse.down();
  await page.mouse.move(before.x + 90, before.y + 42, { steps: 8 }); await page.mouse.up();
  const moved = await header.boundingBox(); assert(moved.x > before.x + 40 && moved.y > before.y + 20);
  const handle = await page.$('.workspace-window[data-window="ground"] .window-resize'); const handleBox = await handle.boundingBox();
  await page.mouse.move(handleBox.x + 8, handleBox.y + 8); await page.mouse.down();
  await page.mouse.move(handleBox.x + 48, handleBox.y + 28, { steps: 6 }); await page.mouse.up();
  const savedLayout = await page.evaluate(() => JSON.parse(localStorage.getItem("kestrel.window.v1.ground")));
  assert(savedLayout.width > before.width + 25);
  await page.reload(); await wait(".topbar");
  const restoredLayout = await page.$eval('.workspace-window[data-window="ground"]', (element) => ({ x: element.getBoundingClientRect().x, width: element.getBoundingClientRect().width }));
  assert(Math.abs(restoredLayout.x - savedLayout.x) < 2 && Math.abs(restoredLayout.width - savedLayout.width) < 2);
  await clickText(".topbar button", "布局编辑"); await clickText(".topbar button", "恢复布局");
  await page.waitForFunction(() => document.querySelectorAll(".workspace-window.floating").length === 0);
  await clickText(".flights .row", "SKY118");
  await page.screenshot({ path: ".tmp/ui-verified.png" });
  console.log("✓ 雷达选机、倍速、视角、快捷键、两种尺寸及浮窗拖动/缩放/保存/恢复");

  const roofAudit = await page.evaluate(async () => {
    const { buildAirportModel } = await import("/src/views/airport-model.ts");
    const { buildAirport } = await import("/src/sim/airport.ts");
    const { KESTREL } = await import("/src/data/airports/kestrel.ts");
    const root = buildAirportModel(buildAirport(KESTREL, "27")); root.updateMatrixWorld(true);
    const roofs = root.children.filter((child) => child.name === "hangar-roof").map((roof) => {
      roof.geometry.computeBoundingBox();
      const box = roof.geometry.boundingBox.clone().applyMatrix4(roof.matrixWorld);
      return { size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z], runwayClearance: box.min.z };
    });
    const drawObjects = root.children.length;
    root.traverse((object) => { if (object.geometry) object.geometry.dispose(); });
    return { roofs, drawObjects };
  });
  assert.equal(roofAudit.roofs.length, 3);
  for (const roof of roofAudit.roofs) assert(roof.size[0] < 160 && roof.size[2] < 110 && roof.runwayClearance > 150);
  assert(roofAudit.drawObjects < 50, "静态机场几何合批失效");
  console.log("✓ 机库屋顶尺寸/跑道净空及静态机场几何合批");

  await page.goto(`${base}/?level=tutorial&fast=999999999&bot=1&lite=1`);
  await wait(".result");
  assert.equal(await page.$eval(".grade", (el) => el.textContent), "S");
  await clickText(".result button", "再值一班");
  await wait(".topbar");
  assert.equal(await page.$$eval(".stage canvas", (els) => els.length), 1);
  await clickText(".topbar button", "退出");
  await wait(".cards");
  assert.deepEqual(errors, [], "浏览器出现运行错误");
  console.log("✓ 快进有上限，班次结算、重开及退出正常；无浏览器错误");
  }

  // Issue real UI clearances while paused. Wall-clock rendering/CDP latency must not become simulated permission delay.
  const waitCommand = async (text) => {
    for (let i = 0; i < 12; i++) {
      if (await page.$$eval(".strip button", (buttons, label) => buttons.some((button) => button.textContent.includes(label) && !button.disabled), text)) return;
      assert(await page.$eval(".advance-button", (button) => !button.disabled), `等待 ${text} 时存在未处理的决定`);
      await page.click(".advance-button");
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    throw new Error(`推进后仍没有 ${text}`);
  };
  await page.goto(`${base}/?level=ground-school&mode=standard&lite=1`);
  await wait(".topbar");
  await clickText(".topbar button", "暂停");
  await clickText(".flights .row", "KST101");
  await clickText(".topbar button", "跟机");
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: ".tmp/model-follow.png" });
  await clickText(".strip button", "机头朝南");
  await clickText(".topbar button", "4×");
  await waitCommand("经 B 滑行至跑道外");
  await clickText(".strip button", "规划滑行路线");
  await wait(".route-modal");
  await page.click('.map-node[aria-label="经过 B3"]');
  assert.match(await page.$eval(".route-string", (el) => el.textContent), /B3/);
  await page.screenshot({ path: ".tmp/route-editor.png" });
  await page.click(".route-modal .primary");
  await waitCommand("联系塔台");
  await clickText(".strip button", "联系塔台");
  await waitCommand("进跑道等待");
  await clickText(".strip button", "进跑道等待");
  await waitCommand("可以起飞");
  await clickText(".strip button", "可以起飞");
  await waitCommand("移交离场");
  await clickText(".strip button", "移交离场");
  if (!(await page.$(".result"))) await page.click(".advance-button");
  await wait(".result");
  assert.equal(await page.$eval(".grade", (el) => el.textContent), "S");
  assert.match(await page.$eval(".review-events", (el) => el.textContent), /移交 DEP/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("kestrel.records.v2"))["ground-school:standard"].grade), "S");
  console.log("✓ 手动离场：推出、地图节点规划 B、确认滑行、移交塔台、对正起飞、移交离场及成绩保存");

  await page.goto(`${base}/?level=tutorial&mode=standard&fast=80&lite=1`);
  await wait(".flights .row");
  await clickText(".topbar button", "暂停");
  await clickText(".flights .row", "AUR102");
  await waitCommand("ILS 进近");
  await clickText(".strip button", "ILS 进近");
  await clickText(".topbar button", "4×");
  await waitCommand("联系塔台");
  await clickText(".strip button", "联系塔台");
  await waitCommand("可以落地");
  await clickText(".strip button", "可以落地");
  await waitCommand("联系地面");
  await clickText(".strip button", "联系地面");
  await waitCommand("滑入机位");
  await clickText(".strip button", "滑入机位");
  for (let i = 0; i < 12 && !(await page.$(".result")); i++) {
    assert(await page.$eval(".advance-button", (button) => !button.disabled), "滑入后存在未处理的决定");
    await page.click(".advance-button");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await wait(".result");
  assert.equal(await page.$eval(".grade", (el) => el.textContent), "S");
  assert.match(await page.$eval(".review-events", (el) => el.textContent), /服务完成/);
  await page.screenshot({ path: ".tmp/shift-review.png" });
  console.log("✓ 手动进场：ILS、塔台移交、落地许可、脱离、地面移交、滑入及完整结算");
  await clickText(".result button", "选择关卡");
  await wait(".cards");
  assert.equal(await page.$$eval(".card", (cards) => cards.length), 8);
  await page.screenshot({ path: ".tmp/scenario-menu.png" });
  assert.deepEqual(errors, [], "手动流程出现浏览器运行错误");
} catch (error) {
  mkdirSync(".tmp", { recursive: true });
  await page.screenshot({ path: ".tmp/ui-failure.png" });
  console.log(await page.$eval(".app", (element) => element.innerText));
  throw error;
} finally {
  await browser.close();
}
