/**
 * 一键体检端到端验证：同步 → 去重 → 测速/能力标注 → 结论落盘。
 * 为避免真实网络等待太久，先把节点池收敛到 3 个并关闭远端仓库拉取。
 *
 * 用法：NODE_PATH=<workspace>/node_modules node tools/verify_checkup.js
 */

const path = require("node:path");
const puppeteer = require("puppeteer-core");

const BASE = path.join(__dirname, "..");
const EXT = path.join(BASE, "gh-accelerator");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

let failed = 0;
function check(name, ok, extra) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  -> ${extra}` : ""}`);
}

async function findExtensionId(browser) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const target of browser.targets()) {
      const match = /^chrome-extension:\/\/([a-z]{32})\//.exec(target.url());
      if (match) return match[1];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    protocolTimeout: 120000,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });

  const extId = await findExtensionId(browser);
  if (!extId) throw new Error("未探测到扩展 ID");
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  await page.goto(`chrome-extension://${extId}/options/options.html`, {
    waitUntil: "networkidle2",
  });
  await page.waitForSelector("#btnCheckup", { timeout: 15000 });

  // 收敛节点池，避免对 81 个节点做真实网络探测
  await page.evaluate(async () => {
    const mod = await import("/lib/store.js");
    const s = await mod.FGStore.get();
    const all = mod.FGStore.allNodes(s).map((n) => n.value);
    const keep = new Set(["gh-proxy.com", "ghfast.top", "ghproxy.net"]);
    await mod.FGStore.set({
      disabledNodes: all.filter((v) => !keep.has(v)),
      repoEnabled: {},
      updateSources: [],
      autoUpdate: false,
    });
  });
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector("#btnCheckup", { timeout: 15000 });

  const before = await page.$eval("#checkupSummary", (el) => el.textContent ?? "");
  check("初始状态显示尚未体检", before.includes("尚未体检"), before.trim());

  await page.click("#btnCheckup");
  // 等待体检结束（按钮文案从「停止体检」恢复）
  await page.waitForFunction(
    () => document.getElementById("btnCheckup")?.textContent?.includes("开始体检"),
    { timeout: 90000, polling: 500 },
  );

  const summary = await page.$eval("#checkupSummary", (el) => el.textContent ?? "");
  check(
    "体检摘要含节点分类统计",
    summary.includes("上次体检") && summary.includes("可加速仓库") && summary.includes("最优"),
    summary.replace(/\s+/g, " ").trim().slice(0, 100),
  );

  const status = await page.$eval("#testStatus", (el) => el.textContent ?? "");
  check("体检状态给出完成结论", status.includes("体检完成"), status.slice(0, 80));

  const stored = await page.evaluate(async () => {
    const mod = await import("/lib/store.js");
    const s = await mod.FGStore.get();
    return {
      lastCheckup: s.lastCheckup ?? 0,
      statCount: Object.keys(s.stats ?? {}).length,
      stateCount: Object.keys(s.nodeState ?? {}).length,
      capsCount: Object.keys(s.capabilities ?? {}).length,
    };
  });
  check("体检时间已落盘", stored.lastCheckup > 0, String(stored.lastCheckup));
  check("测速结果写入节点状态", stored.statCount >= 3 && stored.stateCount >= 3,
    `stats ${stored.statCount} · nodeState ${stored.stateCount} · caps ${stored.capsCount}`);

  // 弹窗应显示最近体检时间
  const pop = await browser.newPage();
  await pop.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 400));
  const syncInfo = await pop.$eval("#syncInfo", (el) => el.textContent ?? "");
  check("弹窗展示最近体检时间", syncInfo.includes("最近体检"), syncInfo.trim());

  check("体检过程无运行时报错", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  console.log(`\n结果：${6 - failed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
})().catch((err) => {
  console.error("验证失败:", err);
  process.exit(1);
});
