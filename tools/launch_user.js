#!/usr/bin/env node
/**
 * 有界面启动器：用本机 Edge 加载最新 gh-accelerator 扩展源码（v2.8.0 / Material You），
 * 打开「扩展设置页」，保持浏览器打开供用户交互使用。
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node tools/launch_user.js
 *   WITH_GH=1 NODE_PATH=<workspace>/node_modules node tools/launch_user.js  # 额外打开 GitHub 演示页
 *
 * 说明：
 *   - 默认只开设置页，不会自动跳转到任何 GitHub 仓库；需要演示注入按钮时加 WITH_GH=1。
 *   - 使用 puppeteer-core 的本地 managed workspace 依赖。
 *   - puppeteer 默认使用临时 user-data-dir，不会触碰本机真实 Edge 配置。
 *   - defaultViewport: null 让视口跟随真实窗口，避免页面缩在 800x600 角落。
 *   - 进程保持常驻（不关闭浏览器），关闭 Edge 窗口即可退出。
 */

const path = require("node:path");
const puppeteer = require("puppeteer-core");

const BASE = path.join(__dirname, "..");
const EXT = path.join(BASE, "gh-accelerator");
const EDGE =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const WITH_GH = process.env.WITH_GH === "1";

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
  console.log("启动 Edge 并加载扩展:", EXT);
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: false,
    defaultViewport: null, // 视口跟随真实窗口大小
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--window-size=1400,900",
    ],
  });

  const extId = await findExtensionId(browser);
  console.log("扩展 ID:", extId || "(未探测到)");

  const opened = [];

  // 1) 扩展设置页（默认唯一标签页）
  const optPage = await browser.newPage();
  opened.push(["设置页", optPage]);
  if (extId) {
    try {
      await optPage.goto(
        `chrome-extension://${extId}/options/options.html`,
        { waitUntil: "networkidle2", timeout: 30000 },
      );
      console.log("已打开扩展设置页");
      await optPage.screenshot({
        path: path.join(BASE, "tools", "verify_options.png"),
      });
      console.log("已截图: tools/verify_options.png");
    } catch (e) {
      console.log("打开设置页超时（可手动访问 chrome-extension://%s/options/options.html）", extId);
    }
  }

  // 2) 可选：GitHub 仓库页（用于查看 content script 注入的「加速」按钮）
  if (WITH_GH) {
    const ghPage = await browser.newPage();
    opened.push(["GitHub页", ghPage]);
    try {
      await ghPage.goto("https://github.com/torvalds/linux", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      console.log("已打开 GitHub 演示页（torvalds/linux）");
      await ghPage.screenshot({
        path: path.join(BASE, "tools", "verify_github.png"),
      });
      console.log("已截图: tools/verify_github.png");
    } catch (e) {
      console.log("打开 GitHub 超时，可手动访问任意 GitHub 仓库页查看注入按钮");
    }
  }

  // 让设置页成为当前活动标签
  try {
    await optPage.bringToFront();
  } catch {}

  // 输出真实视口尺寸，确认与窗口一致
  for (const [name, pg] of opened) {
    try {
      const size = await pg.evaluate(() => ({
        w: window.innerWidth,
        h: window.innerHeight,
      }));
      console.log(`${name}视口: ${size.w}x${size.h}`);
    } catch {}
  }

  // 输出扩展版本，确认加载的是 v2.8.0
  if (extId) {
    try {
      const ver = await optPage.evaluate(async (id) => {
        const r = await fetch(`chrome-extension://${id}/manifest.json`);
        return (await r.json()).version;
      }, extId);
      console.log("已加载扩展版本:", ver);
    } catch {}
  }

  console.log("\n✅ 浏览器已就绪，可交互使用。关闭 Edge 窗口即可退出本程序。\n");

  // 保持进程常驻，不自动关闭浏览器
  await new Promise(() => {});
})().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
