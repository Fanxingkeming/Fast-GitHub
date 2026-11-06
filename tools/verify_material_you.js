#!/usr/bin/env node
/**
 * Material You UI 视觉验证：加载最新 gh-accelerator 扩展，截图
 *   1) 设置页浅色  2) 设置页深色  3) 弹窗浅色  4) GitHub 注入面板
 * 用本地 fake 页面验证注入（不访问真实 github.com、不常驻浏览器）。
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node tools/verify_material_you.js
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const BASE = path.join(__dirname, "..");
const SRC = path.join(BASE, "gh-accelerator");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** 把临时副本的 matches 放开到 localhost，让 content script 注入 fake 页。
 * content.js 用动态 import(chrome.runtime.getURL(...)) 加载 ESM，
 * 所以 web_accessible_resources 的 matches 也必须一起放开，否则静默失败。 */
function relaxMatches(extDir) {
  const p = path.join(extDir, "manifest.json");
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.content_scripts = (m.content_scripts || []).map((c) => ({
    ...c,
    matches: ["http://127.0.0.1/*"],
  }));
  m.web_accessible_resources = (m.web_accessible_resources || []).map((r) => ({
    ...r,
    matches: ["http://127.0.0.1/*"],
  }));
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
}

function startFakeGithub() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>torvalds/linux</title>
      <style>body{font-family:system-ui;margin:0;background:#fff;color:#1f2328}
      header{padding:14px 24px;border-bottom:1px solid #d0d7de;font-size:15px}
      main{padding:28px 32px}h1{font-size:20px;margin:0 0 18px}
      .file-navigation{margin-top:22px}</style></head>
      <body><header>github.com / <b>torvalds</b> / <b>linux</b></header>
      <main><h1>Linux kernel source tree</h1>
      <p>Public repository used for injection preview.</p>
      <div class="file-navigation"><a href="/torvalds/linux/archive/refs/heads/master.zip">Download ZIP</a></div>
      </main></body></html>`);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

async function findExtensionId(browser) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const t of browser.targets()) {
      const m = /^chrome-extension:\/\/([a-z]{32})\//.exec(t.url());
      if (m) return m[1];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fg-m3-"));
  const ext = path.join(tmp, "gh-accelerator");
  copyDir(SRC, ext);
  relaxMatches(ext);

  const server = await startFakeGithub();
  const port = server.address().port;

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    protocolTimeout: 90000,
    defaultViewport: { width: 1400, height: 900, deviceScaleFactor: 1 },
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });

  const extId = await findExtensionId(browser);
  if (!extId) {
    console.log("未探测到扩展 ID");
    await browser.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("扩展 ID:", extId);

  // ONLY_INJECT=1 时只生成注入面板截图（前三张已完成，避免重复耗时）
  const onlyInject = process.env.ONLY_INJECT === "1";

  if (!onlyInject) {
    // 1) 设置页浅色
    const opt = await browser.newPage();
    await opt.goto(`chrome-extension://${extId}/options/options.html`, {
      waitUntil: "networkidle2",
    });
    await opt.waitForSelector("#nodeList .node-item", { timeout: 15000 });
    await opt.screenshot({ path: path.join(BASE, "tools", "m3_options_light.png") });
    console.log("截图: m3_options_light.png");

    // 2) 设置页深色：用 CDP 切换系统配色，触发主题引擎实时重算整套变量
    const optCdp = await opt.createCDPSession();
    await optCdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await new Promise((r) => setTimeout(r, 700));
    await opt.screenshot({ path: path.join(BASE, "tools", "m3_options_dark.png") });
    console.log("截图: m3_options_dark.png");

    // 3) 弹窗浅色
    const pop = await browser.newPage();
    await pop.setViewport({ width: 400, height: 620, deviceScaleFactor: 1 });
    await pop.goto(`chrome-extension://${extId}/popup/popup.html`, {
      waitUntil: "networkidle2",
    });
    await new Promise((r) => setTimeout(r, 500));
    await pop.screenshot({
      path: path.join(BASE, "tools", "m3_popup.png"),
      captureBeyondViewport: false,
    });
    console.log("截图: m3_popup.png");
  }

  // 4) GitHub 注入面板
  const gh = await browser.newPage();
  await gh.goto(`http://127.0.0.1:${port}/torvalds/linux`, {
    waitUntil: "networkidle2",
  });
  await gh.waitForSelector("#fg-speed-btn .fg-trigger", { timeout: 12000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 600));
  const hasTrigger = await gh.evaluate(() => {
    const btn = document.querySelector("#fg-speed-btn .fg-trigger");
    if (btn) btn.click();
    return Boolean(btn);
  });
  await new Promise((r) => setTimeout(r, 500));
  await gh.screenshot({ path: path.join(BASE, "tools", "m3_injected.png") });
  console.log("截图: m3_injected.png", hasTrigger ? "(注入按钮已点击展开)" : "(未探测到注入按钮)");

  await browser.close();
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✅ 视觉验证完成，临时目录已清理");
})().catch((e) => {
  console.error("视觉验证失败:", e);
  process.exit(1);
});
