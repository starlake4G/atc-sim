import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const base = process.argv[2] ?? "http://localhost:5174";
const executablePath = [process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((path) => path && existsSync(path));
assert(executablePath, "找不到 Chrome/Edge，可用 CHROME_PATH 指定浏览器");
mkdirSync(".tmp", { recursive: true });
const browser = await puppeteer.launch({ executablePath, headless: true,
  args: ["--enable-unsafe-swiftshader", "--disable-gpu"], defaultViewport: { width: 1280, height: 720 } });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
const wait = (selector) => page.waitForSelector(selector, { timeout: 25000 });
const clickText = async (selector, text) => {
  for (const element of await page.$$(selector)) {
    if ((await element.evaluate((el) => el.textContent)).includes(text)) { await element.click(); return; }
  }
  throw new Error(`找不到 ${selector}: ${text}`);
};
const planOrder = () => page.$$eval(".plan-row .plan-callsign", (items) => items.map((item) => item.firstChild.textContent));
const assertPaused = async (paused) => {
  assert.equal(await page.$$eval(".topbar button", (buttons) => buttons.some((button) => button.textContent === "继续")), paused);
};
async function assertModalFits(selector) {
  for (const [width, height] of [[1280, 720], [1024, 768]]) {
    await page.setViewport({ width, height });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.$eval(selector, (modal) => {
      const rect = modal.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        viewportWidth: innerWidth, viewportHeight: innerHeight,
        horizontalOverflow: modal.scrollWidth > modal.clientWidth + 2 };
    });
    assert(bounds.left >= 0 && bounds.right <= width + 1 && bounds.top >= 0 && bounds.bottom <= height + 1 && !bounds.horizontalOverflow,
      `${selector} 在 ${width}×${height} 溢出：${JSON.stringify(bounds)}`);
  }
  await page.setViewport({ width: 1280, height: 720 });
}

try {
  await page.goto(`${base}/?level=intersection&mode=standard&fast=65&lite=1`);
  await wait(".topbar"); await clickText(".topbar button", "暂停"); await assertPaused(true);
  await page.click(".plan-open"); await wait(".plan-modal");
  assert.equal(await page.$$eval(".plan-candidate", (items) => items.length), 3);
  for (let i = 0; i < 3; i++) await page.click('.plan-candidate button[aria-label$="加入计划"]');
  assert.deepEqual(await planOrder(), ["AUR201", "SKY310", "KST106"]);
  await page.click('button[aria-label="KST106 前移"]');
  assert.deepEqual(await planOrder(), ["AUR201", "KST106", "SKY310"]);
  await page.click('button[aria-label="AUR201 后移"]');
  assert.deepEqual(await planOrder(), ["KST106", "AUR201", "SKY310"]);
  await page.click('button[aria-label="AUR201 移出计划"]');
  assert.deepEqual(await planOrder(), ["KST106", "SKY310"]);
  assert.equal(await page.$$eval(".plan-candidate", (items) => items.length), 1);
  await page.click('button[aria-label="AUR201 加入计划"]');
  assert.deepEqual(await planOrder(), ["KST106", "SKY310", "AUR201"]);
  await page.setDragInterception(true);
  const rows = await page.$$(".plan-row");
  await rows[2].dragAndDrop(rows[0]);
  assert.deepEqual(await planOrder(), ["AUR201", "KST106", "SKY310"]);
  await page.setDragInterception(false);
  await page.click('button[aria-label="SKY310 前移"]'); await page.click('button[aria-label="SKY310 前移"]');
  assert.deepEqual(await planOrder(), ["SKY310", "AUR201", "KST106"]);
  const windows = await page.$$eval(".plan-track > span", (bars) => bars.map((bar) => ({ left: parseFloat(bar.style.left), right: parseFloat(bar.style.left) + parseFloat(bar.style.width) })));
  assert.equal(windows.length, 3);
  for (let i = 1; i < windows.length; i++) assert(windows[i].left >= windows[i - 1].right - .01, "预计跑道占用窗口不得包含等待前机时的时间");
  await assertModalFits(".plan-modal");
  await page.screenshot({ path: ".tmp/plan-workbench.png" });
  await page.keyboard.press("Escape");
  assert.equal(await page.$(".plan-modal"), null); await assertPaused(true); await wait(".pause-banner");
  await clickText(".topbar button", "继续"); await assertPaused(false);
  await page.click(".plan-open"); await wait(".plan-modal"); await assertPaused(true);
  await page.keyboard.press("Escape"); await assertPaused(false);
  console.log("✓ 跑道计划三机加入/移除、箭头与原生拖动改序、两种尺寸及 Esc 恢复暂停状态");

  await page.goto(`${base}/?level=tutorial&mode=standard&fast=340&bot=1&lite=1`);
  await wait(".topbar"); await clickText(".topbar button", "暂停");
  await page.click(".plan-open"); await wait(".plan-modal");
  await page.click('button[aria-label="AUR102 加入计划"]');
  await wait(".plan-row.locked");
  assert.equal(await page.$eval(".plan-row.locked", (row) => row.draggable), false);
  assert(await page.$$eval(".plan-row.locked .plan-controls button", (buttons) => buttons.length === 3 && buttons.every((button) => button.disabled)));
  console.log("✓ 已获落地许可的计划位置锁定，禁用移动、移出和拖动");

  await page.goto(`${base}/?lite=1`); await wait(".cards");
  assert.equal(await page.$$eval(".card", (cards) => cards.length), 8);
  await clickText(".card", "三向合流"); await wait("#challenge-seed");
  await page.click("#challenge-seed"); await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control"); await page.keyboard.type("  ui   alpha  ");
  await page.click(".scenario-detail h2");
  assert.equal(await page.$eval("#challenge-seed", (input) => input.value), "UI-ALPHA");
  await assertModalFits(".start-modal"); await page.screenshot({ path: ".tmp/challenge-menu.png" });
  await clickText(".start-modal > .primary", "开始值班"); await wait(".seed-label");
  assert.match(await page.$eval(".seed-label", (item) => item.textContent), /UI-ALPHA/);
  await clickText(".topbar button", "退出"); await wait("#challenge-seed");
  assert.equal(await page.$eval("#challenge-seed", (input) => input.value), "UI-ALPHA");
  await page.click(".seed-picker button");
  const randomSeed = await page.$eval("#challenge-seed", (input) => input.value);
  assert.match(randomSeed, /^KEKS-[A-Z0-9]+$/); assert.notEqual(randomSeed, "UI-ALPHA");
  console.log("✓ 八关菜单、种子规范化、开始/退出保留种子和换一组；两种尺寸无溢出");

  const helperAudit = await page.evaluate(async () => {
    const { recordKey } = await import("/src/ui/session.tsx");
    const { createChallenge, normalizeChallengeSeed, CHALLENGE_ID } = await import("/src/sim/challenge.ts");
    return { normalized: normalizeChallengeSeed("  ui  alpha  "),
      same: recordKey(CHALLENGE_ID, "standard", "  ui  alpha  ") === recordKey(CHALLENGE_ID, "standard", "UI-ALPHA"),
      first: recordKey(CHALLENGE_ID, "standard", "UI-ALPHA"), second: recordKey(CHALLENGE_ID, "standard", "UI-BETA"),
      sameSchedule: JSON.stringify(createChallenge("ui-alpha")) === JSON.stringify(createChallenge("UI-ALPHA")) };
  });
  assert.equal(helperAudit.normalized, "UI-ALPHA"); assert(helperAudit.same && helperAudit.sameSchedule);
  assert.notEqual(helperAudit.first, helperAudit.second);

  await page.goto(`${base}/?level=seed-challenge&mode=standard&seed=%20ui%20%20alpha%20&fast=999999&bot=1&lite=1`);
  await wait(".result"); assert.match(await page.$eval(".challenge-code", (item) => item.textContent), /UI-ALPHA/);
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem("kestrel.records.v2") ?? "{}")[key], {}, helperAudit.first);
  const firstRecord = await page.evaluate((key) => JSON.parse(localStorage.getItem("kestrel.records.v2"))[key], helperAudit.first);
  await clickText(".result button", "再值一班"); await wait(".seed-label");
  assert.match(await page.$eval(".seed-label", (item) => item.textContent), /UI-ALPHA/);
  assert.equal(await page.$(".result"), null);
  await clickText(".topbar button", "退出"); await wait("#challenge-seed");
  assert.equal(await page.$eval("#challenge-seed", (input) => input.value), "UI-ALPHA");
  await page.goto(`${base}/?level=seed-challenge&mode=standard&seed=ui-beta&fast=999999&bot=1&lite=1`);
  await wait(".result"); assert.match(await page.$eval(".challenge-code", (item) => item.textContent), /UI-BETA/);
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem("kestrel.records.v2") ?? "{}")[key], {}, helperAudit.second);
  const retained = await page.evaluate((key) => JSON.parse(localStorage.getItem("kestrel.records.v2"))[key], helperAudit.first);
  assert.deepEqual(retained, firstRecord);
  assert.deepEqual(errors, [], "浏览器出现运行错误");
  console.log("✓ URL 种子规范化、同种子重启、版本成绩 key 隔离和真实双种子成绩保存；无浏览器错误");
} catch (error) {
  await page.screenshot({ path: ".tmp/planning-ui-failure.png" });
  console.log(await page.$eval(".app", (app) => app.innerText));
  throw error;
} finally { await browser.close(); }
