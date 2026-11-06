#!/usr/bin/env node
/**
 * 测速自动标注 —— 设置页渲染验证（确定性 UI 测试）
 *
 * 用固定的模拟探测结果写入临时 profile 的存储，验证：
 *   - 支持 git 的节点显示「可加速仓库」+「测速标注」
 *   - 有响应但不支持 git 的节点显示「仅下载」+「测速标注」
 *   - 不可达节点 / 手动标注节点不显示「测速标注」，且不被误标
 *   - 「可加速仓库 / 仅下载」筛选随自动标注结果生效
 *
 * 注意：这里注入的是**模拟数据**，仅用于验证渲染逻辑；
 * 真实探测与分类规则由 test_auto_kind.mjs（42 项）与 e2e_extension.js 覆盖。
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node tools/verify_auto_kind_ui.js
 */

const path = require("node:path");
const puppeteer = require("puppeteer-core");

const BASE = path.join(__dirname, "..");
const EXT = path.join(BASE, "gh-accelerator");
const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const OUT = path.join(BASE, "tools", "auto_kind_ui.png");

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}${detail ? "  -> " + detail : ""}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`); }
};

const PATCH = {
  capabilities: {
    "gh-proxy.com": { range: true, git: true, reachable: true, kind: "full", ts: 1 },
    "ghfast.top": { range: false, git: false, reachable: true, kind: "download", ts: 1 },
    "ghproxy.net": { range: false, git: false, reachable: false, kind: null, ts: 1 },
  },
  nodeKinds: { "gh.dpik.top": "download" },
  // 让这 4 个节点排到列表最前，便于截图与断言
  stats: {
    "gh-proxy.com": { latency: "10", speed: "999 Mbps", ts: 1 },
    "ghfast.top": { latency: "11", speed: "998 Mbps", ts: 1 },
    "ghproxy.net": { latency: "12", speed: "997 Mbps", ts: 1 },
    "gh.dpik.top": { latency: "13", speed: "996 Mbps", ts: 1 },
  },
};

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
    defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
    protocolTimeout: 30000,
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
  console.log("扩展 ID:", extId);

  const page = await browser.newPage();
  const url = `chrome-extension://${extId}/options/options.html`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
  await page.evaluate(async (patch) => {
    await chrome.storage.local.set({ fg_settings_v2: patch });
  }, PATCH);
  await page.reload({ waitUntil: "networkidle2", timeout: 30000 });
  await page.waitForSelector("#nodeList .node-item", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("#nodeList .node-item")].slice(0, 6).map((el) => ({
      value: el.dataset.value,
      text: (el.querySelector(".node-domain")?.innerText ?? "").replace(/\s+/g, " ").trim(),
      auto: Boolean(el.querySelector(".fg-kind-dot.is-auto")),
      dotFull: Boolean(el.querySelector(".fg-kind-dot.is-full")),
      dotDownload: Boolean(el.querySelector(".fg-kind-dot.is-download")),
      title: el.querySelector(".fg-kind-dot")?.getAttribute("title") ?? "",
    })),
  );
  const byValue = Object.fromEntries(rows.map((r) => [r.value, r]));
  const autoCount = await page.evaluate(
    () => document.querySelectorAll(".fg-kind-dot.is-auto").length,
  );

  console.log("\n[1] 自动标注圆点与分类提示");
  check("共 2 个自动标注圆点（不可达/手动不参与）", autoCount === 2, `实际 ${autoCount}`);
  check(
    "git 节点：可加速仓库圆点 + 体检自动标注",
    byValue["gh-proxy.com"]?.dotFull &&
      byValue["gh-proxy.com"]?.auto &&
      byValue["gh-proxy.com"]?.title.includes("可加速仓库"),
    byValue["gh-proxy.com"]?.title,
  );
  check(
    "仅下载节点：仅下载圆点 + 体检自动标注",
    byValue["ghfast.top"]?.dotDownload &&
      byValue["ghfast.top"]?.auto &&
      byValue["ghfast.top"]?.title.includes("仅下载文件"),
    byValue["ghfast.top"]?.title,
  );
  check(
    "不可达节点无自动标注圆点",
    byValue["ghproxy.net"] && !byValue["ghproxy.net"].auto,
    byValue["ghproxy.net"]?.title,
  );
  check(
    "手动覆盖节点：仅下载圆点且无自动标注",
    byValue["gh.dpik.top"] && !byValue["gh.dpik.top"].auto &&
      byValue["gh.dpik.top"].dotDownload &&
      byValue["gh.dpik.top"].title.includes("仅下载文件"),
    byValue["gh.dpik.top"]?.title,
  );

  console.log("\n[2] 分类筛选随自动标注生效");
  const setFilter = async (value) => {
    await page.evaluate((v) => {
      const sel = document.querySelector("#nodeFilter");
      sel.value = v;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate(() =>
      [...document.querySelectorAll("#nodeList .node-item")].map((e) => e.dataset.value),
    );
  };
  const full = await setFilter("full");
  const download = await setFilter("download");
  check("可加速仓库筛选不含自动标为仅下载的节点", !full.includes("ghfast.top"), `${full.length} 条`);
  check("可加速仓库筛选含自动标为 full 的节点", full.includes("gh-proxy.com"));
  check("仅下载筛选含自动标为 download 的节点", download.includes("ghfast.top"), `${download.length} 条`);
  check("仅下载筛选含手动标注节点", download.includes("gh.dpik.top"));

  await setFilter("all");
  await page.evaluate(() => {
    document.querySelector("#nodeList")?.scrollIntoView({ block: "start" });
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: OUT });
  console.log("\n截图:", OUT);

  await browser.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) process.exit(1);
})().catch((err) => {
  console.error("验证失败:", err);
  process.exit(1);
});
