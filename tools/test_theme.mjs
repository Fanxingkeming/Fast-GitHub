#!/usr/bin/env node
/**
 * 浏览器主题色引擎单测：颜色解析、HSL tonal 映射、对比度可达性、降级路径。
 * 不依赖 DOM / 浏览器，纯函数直接在 Node 里跑。
 *
 * 用法：node tools/test_theme.mjs
 */
import assert from "node:assert/strict";
import {
  DEFAULT_SEED,
  applyBrowserTheme,
  contrastRatio,
  getThemeState,
  hslToHex,
  pageAccent,
  paletteFromSeed,
  parseColor,
  rgbToHex,
  rgbToHsl,
  systemAccent,
} from "../gh-accelerator/lib/theme.js";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name} -> ${error.message}`);
  }
}

console.log("\n[1] 颜色解析");
check("三位 / 六位十六进制", () => {
  assert.deepEqual(parseColor("#f0a"), [255, 0, 170]);
  assert.deepEqual(parseColor("#6750A4"), [103, 80, 164]);
});
check("rgb() / rgba() / color(srgb)", () => {
  assert.deepEqual(parseColor("rgb(0, 120, 215)"), [0, 120, 215]);
  assert.deepEqual(parseColor("rgba(255, 255, 255, 0.96)"), [255, 255, 255]);
  assert.deepEqual(parseColor("color(srgb 0.4 0.25 0.64)"), [102, 64, 163]);
});
check("非法 / 空值返回 null", () => {
  assert.equal(parseColor(""), null);
  assert.equal(parseColor("not-a-color"), null);
  assert.equal(parseColor(undefined), null);
});
check("RGB 与 HSL 往返误差 <= 3", () => {
  for (const hex of ["#6750a4", "#0078d4", "#d32f2f", "#2e7d32", "#f9a825"]) {
    const [h, s, l] = rgbToHsl(parseColor(hex));
    const back = parseColor(hslToHex(h, s, l));
    const origin = parseColor(hex);
    for (let i = 0; i < 3; i += 1) {
      assert.ok(Math.abs(back[i] - origin[i]) <= 3, `${hex} 通道 ${i} 偏差过大`);
    }
    assert.equal(rgbToHex(origin).length, 7);
  }
});

console.log("\n[2] 调色板生成");
const light = paletteFromSeed(DEFAULT_SEED, false);
const dark = paletteFromSeed(DEFAULT_SEED, true);
check("变量数量 >= 45 且同时含扩展页与注入面板前缀", () => {
  assert.ok(Object.keys(light).length >= 45, `实际 ${Object.keys(light).length}`);
  assert.ok(light["--fg-primary"]);
  assert.ok(light["--fgm-primary"]);
  assert.ok(light["--fgm-surface"]);
});
check("深浅两套变量键集合完全一致", () => {
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort());
});
check("深浅主题主色 / 背景色明显不同", () => {
  assert.notEqual(light["--fg-primary"], dark["--fg-primary"]);
  assert.notEqual(light["--fg-bg"], dark["--fg-bg"]);
  assert.ok(parseColor(light["--fg-bg"])[0] > parseColor(dark["--fg-bg"])[0] + 100);
});
check("所有颜色值可被解析（含半透明 surface-glass）", () => {
  for (const [key, value] of Object.entries({ ...light, ...dark })) {
    assert.ok(parseColor(value), `${key} = ${value} 无法解析`);
  }
});
check("不同种子色生成不同主色", () => {
  const blue = paletteFromSeed("#0078d4", false);
  const red = paletteFromSeed("#d32f2f", false);
  assert.notEqual(blue["--fg-primary"], red["--fg-primary"]);
  assert.notEqual(blue["--fg-primary-container"], red["--fg-primary-container"]);
});
check("非法 / 近灰种子回退到默认紫罗兰", () => {
  assert.deepEqual(paletteFromSeed("garbage", false), light);
  assert.deepEqual(paletteFromSeed("#808080", false), light);
  assert.deepEqual(paletteFromSeed(null, false), light);
});
check("色相接近 360 度时 tertiary 不越界", () => {
  const p = paletteFromSeed("#f0008c", false);
  assert.ok(parseColor(p["--fg-tertiary-container"]));
  assert.ok(parseColor(p["--fg-primary"]));
});

console.log("\n[3] 对比度可达性（WCAG AA 4.5:1）");
const seeds = [
  DEFAULT_SEED,
  "#0078d4",
  "#d32f2f",
  "#2e7d32",
  "#f9a825",
  "#0b57d0",
  "#8e24aa",
  "#00695c",
];
check("8 组种子 × 浅深两态：按钮 / 容器 / 正文对比度全部达标", () => {
  for (const seed of seeds) {
    for (const isDark of [false, true]) {
      const p = paletteFromSeed(seed, isDark);
      const pairs = [
        ["--fg-primary", "--fg-on-primary"],
        ["--fg-primary-container", "--fg-on-primary-container"],
        ["--fg-secondary-container", "--fg-on-secondary-container"],
        ["--fg-bg", "--fg-text"],
        ["--fg-surface", "--fg-text-2"],
      ];
      for (const [bg, fg] of pairs) {
        const ratio = contrastRatio(p[bg], p[fg]);
        assert.ok(
          ratio >= 4.5,
          `${seed} ${isDark ? "深" : "浅"} ${bg}/${fg} = ${ratio.toFixed(2)}`,
        );
      }
    }
  }
});
check("深色背景亮度低于浅色背景", () => {
  const a = parseColor(light["--fg-bg"]);
  const b = parseColor(dark["--fg-bg"]);
  assert.ok(a.reduce((x, y) => x + y, 0) > b.reduce((x, y) => x + y, 0) + 300);
});

console.log("\n[4] 无 DOM 环境的降级");
check("systemAccent / pageAccent 在 Node 下返回 null", () => {
  assert.equal(systemAccent(), null);
  assert.equal(pageAccent(), null);
});
check("applyBrowserTheme 在无 DOM 时不抛错并返回默认状态", () => {
  const result = applyBrowserTheme({ theme: "dark" });
  assert.equal(result.seed, DEFAULT_SEED);
  assert.equal(result.source, "默认紫罗兰");
});
check("getThemeState 始终返回可展示字段", () => {
  const state = getThemeState();
  assert.equal(typeof state.dark, "boolean");
  assert.match(state.seed, /^#[0-9a-f]{6}$/);
  assert.ok(state.source.length > 0);
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
process.exitCode = failed ? 1 : 0;
