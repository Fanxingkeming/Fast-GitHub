#!/usr/bin/env node
/**
 * 真实 Edge 验证：无 Logo / 左对齐 / 浏览器主题色实时跟随。
 *   1) 设置页不渲染 .brand-logo，标题与导航项左边距一致
 *   2) 动态 --fg-* 变量已写入，外观卡片显示当前主色来源
 *   3) 用 CDP 切换 prefers-color-scheme，验证深浅主题实时重算并截图
 *   4) 关闭跟随 + 自定义主色，验证整套配色改由自定义色生成
 *   5) 重新开启跟随，验证恢复
 *   6) 弹窗同样无 Logo 且共用动态配色
 *
 * 用法：
 *   NODE_PATH=<workspace>/node_modules node tools/verify_theme_ui.js
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const BASE = path.join(__dirname, "..");
const SRC = path.join(BASE, "gh-accelerator");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

let passed = 0;
let failed = 0;
function check(name, ok, extra) {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  -> ${extra}` : ""}`);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function snapshot(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const name = document.querySelector(".brand-name, .ph-title");
    const nav = document.querySelector(".nav-item");
    return {
      logos: document.querySelectorAll(".brand-logo").length,
      nameLeft: name?.getBoundingClientRect().left ?? -1,
      navLeft: nav?.getBoundingClientRect().left ?? -1,
      align: name ? getComputedStyle(name.parentElement).textAlign : "",
      primary: root.style.getPropertyValue("--fg-primary"),
      bg: root.style.getPropertyValue("--fg-bg"),
      container: root.style.getPropertyValue("--fg-primary-container"),
      theme: root.getAttribute("data-theme"),
      colorScheme: root.style.colorScheme,
      source: document.getElementById("themeColorSource")?.textContent ?? "",
      swatch: document.getElementById("themeSwatch")?.style.background ?? "",
      seedVisible: !document.getElementById("themeSeedField")?.hidden,
    };
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fg-theme-"));
  const ext = path.join(tmp, "gh-accelerator");
  copyDir(SRC, ext);

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

  try {
    const extId = await findExtensionId(browser);
    if (!extId) throw new Error("未探测到扩展 ID");
    console.log("扩展 ID:", extId);

    const opt = await browser.newPage();
    await opt.goto(`chrome-extension://${extId}/options/options.html`, {
      waitUntil: "networkidle2",
    });
    await opt.waitForSelector("#nodeList .node-item", { timeout: 15000 });
    await wait(700);

    console.log("\n[1] 无 Logo 与左对齐");
    const light = await snapshot(opt);
    check("设置页已无 .brand-logo", light.logos === 0, `${light.logos} 个`);
    check(
      "标题与导航项左边界一致（≤2px）",
      Math.abs(light.nameLeft - light.navLeft) <= 2,
      `${light.nameLeft} vs ${light.navLeft}`,
    );
    check("标题容器为左对齐", light.align === "left", light.align);

    console.log("\n[2] 浏览器主题色已实时应用");
    check("动态 --fg-primary 已写入", /^#[0-9a-f]{6}$/.test(light.primary), light.primary);
    check("动态 --fg-bg 已写入", /^#[0-9a-f]{6}$/.test(light.bg), light.bg);
    check("外观卡片显示来源与色值", /取自/.test(light.source), light.source);
    check("色块已同步为当前主色", Boolean(light.swatch), light.swatch);
    check("跟随模式下隐藏自定义色控件", light.seedVisible === false);
    check("浅色方案标记为 light", light.theme === "light", String(light.theme));
    await opt.screenshot({ path: path.join(BASE, "tools", "theme_light.png") });
    console.log("  截图: theme_light.png");

    console.log("\n[3] 切换系统深色：实时重算");
    const cdp = await opt.createCDPSession();
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await wait(900);
    const dark = await snapshot(opt);
    check("data-theme 实时切到 dark", dark.theme === "dark", String(dark.theme));
    check("主色随深浅主题重算", dark.primary !== light.primary, `${light.primary} → ${dark.primary}`);
    check("背景色随深浅主题重算", dark.bg !== light.bg, `${light.bg} → ${dark.bg}`);
    check("color-scheme 同步为 dark", dark.colorScheme === "dark", dark.colorScheme);
    await opt.screenshot({ path: path.join(BASE, "tools", "theme_dark.png") });
    console.log("  截图: theme_dark.png");

    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await wait(900);
    const back = await snapshot(opt);
    check("切回浅色后恢复", back.theme === "light" && back.primary === light.primary, back.primary);

    console.log("\n[4] 关闭跟随并使用自定义主色");
    await opt.evaluate(async () => {
      const mod = await import("/lib/store.js");
      await mod.FGStore.set({ followBrowserColor: false, themeSeed: "#d32f2f" });
    });
    await wait(900);
    const custom = await snapshot(opt);
    const hue = await opt.evaluate(async () => {
      const m = await import("/lib/theme.js");
      const c = document.documentElement.style.getPropertyValue("--fg-primary");
      return m.rgbToHsl(m.parseColor(c))[0];
    });
    check("自定义色生效（主色色相为红色系）", hue < 20 || hue > 340, `${hue.toFixed(1)}°`);
    check("来源文案标注自定义主色", /自定义主色/.test(custom.source), custom.source);
    check("自定义色控件已显示", custom.seedVisible === true);
    check("浅深两套色都由自定义色生成", custom.container !== back.container);

    console.log("\n[5] 重新开启跟随");
    await opt.evaluate(async () => {
      const mod = await import("/lib/store.js");
      await mod.FGStore.set({ followBrowserColor: true });
    });
    await wait(900);
    const restored = await snapshot(opt);
    check("主色恢复为浏览器 / 系统色", restored.primary === light.primary, restored.primary);
    check("自定义色控件重新隐藏", restored.seedVisible === false);

    console.log("\n[6] 弹窗");
    const pop = await browser.newPage();
    await pop.setViewport({ width: 400, height: 620, deviceScaleFactor: 1 });
    await pop.goto(`chrome-extension://${extId}/popup/popup.html`, {
      waitUntil: "networkidle2",
    });
    await wait(700);
    const popup = await snapshot(pop);
    check("弹窗已无 .brand-logo", popup.logos === 0, `${popup.logos} 个`);
    check("弹窗标题左对齐", popup.align === "left", popup.align);
    check("弹窗写入同一套动态主色", /^#[0-9a-f]{6}$/.test(popup.primary), popup.primary);
    await pop.screenshot({
      path: path.join(BASE, "tools", "theme_popup.png"),
      captureBeyondViewport: false,
    });
    console.log("  截图: theme_popup.png");
  } catch (error) {
    failed += 1;
    console.log("  FAIL  验证脚本异常 ->", error.message);
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  process.exitCode = failed ? 1 : 0;
})();
