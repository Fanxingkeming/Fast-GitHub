/**
 * 验证 Release ZIP「下载后能直接用」：解压 → 用真实 Edge 加载解压目录 → 检查页面与后台。
 * 用法：NODE_PATH=<workspace>/node_modules node tools/verify_release_zip.js
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const ZIP = path.join(__dirname, "gh-accelerator-v2.8.0.zip");
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
  check("Release ZIP 存在", fs.existsSync(ZIP), `${fs.statSync(ZIP).size} bytes`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fg-zip-"));
  execFileSync("python", [
    "-c",
    `import zipfile; zipfile.ZipFile(r"${ZIP}").extractall(r"${tmp}")`,
  ]);
  const ext = path.join(tmp, "gh-accelerator-v2.8.0");
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
  check("解压后 manifest 版本正确", manifest.version === "2.8.0", manifest.version);

  const required = [
    "background.js",
    "content.js",
    "lib/rank.js",
    "lib/sync.js",
    "lib/ui.js",
    "options/options.html",
    "popup/popup.html",
  ];
  const missing = required.filter((f) => !fs.existsSync(path.join(ext, f)));
  check("共享模块与页面文件齐全", missing.length === 0, missing.join(",") || "7/7");
  check(
    "不含构建产物或锁文件",
    !fs.existsSync(path.join(ext, "node_modules")) &&
      !fs.existsSync(path.join(ext, "package-lock.json")),
  );

  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: true,
    protocolTimeout: 90000,
    args: [
      `--disable-extensions-except=${ext}`,
      `--load-extension=${ext}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });
  const extId = await findExtensionId(browser);
  check("解压目录可被浏览器直接加载", Boolean(extId), extId ?? "");

  if (extId) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e.message)));
    await page.goto(`chrome-extension://${extId}/options/options.html`, {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector("#nodeList .node-item", { timeout: 15000 });
    const rows = await page.$$eval("#nodeList .node-item", (els) => els.length);
    check("设置页节点列表渲染", rows > 50, `${rows} 行`);
    check("一键体检按钮存在", Boolean(await page.$("#btnCheckup")));
    const title = await page.$eval(".brand-sub", (el) => el.textContent ?? "");
    check("页面版本号为 2.8.0", title.includes("2.8.0"), title.trim());
    check("加载过程无运行时报错", errors.length === 0, errors.slice(0, 2).join(" | "));
    await page.close();
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n结果：${9 - failed} 通过 / ${failed} 失败`);
  if (failed) process.exit(1);
})().catch((err) => {
  console.error("验证失败:", err);
  process.exit(1);
});
