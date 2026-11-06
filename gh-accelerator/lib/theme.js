/**
 * 浏览器主题色引擎（Material You 动态配色）
 *
 * Chrome / Edge 不提供读取浏览器主题的扩展 API（theme.getCurrent 仅 Firefox 支持），
 * 因此采用三层实时来源，并按可用性依次降级：
 *   1. Firefox：chrome.theme.getCurrent().colors.frame + onUpdated（真正的浏览器主题色）
 *   2. Chromium：CSS 系统色 AccentColor / Highlight，随 Windows / 浏览器强调色变化
 *   3. 注入面板：GitHub 页面的 --color-accent-fg / meta[theme-color]
 *   4. 兜底：默认紫罗兰种子色，或用户在设置页指定的自定义色
 *
 * 明暗由 prefers-color-scheme 实时驱动；注入面板优先跟随页面自身的
 * data-color-mode。种子色经 HSL tonal 映射生成一整套 M3 变量，内联写到
 * <html> 上覆盖 ui.css / content.css 的静态值，避免重复维护两套主题。
 *
 * 顶层不触碰 document / chrome / window，纯函数可在 Node 里直接单测。
 */

/** Chromium 无系统强调色时的默认 M3 紫罗兰 */
export const DEFAULT_SEED = "#6750a4";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * 解析 #rgb / #rrggbb / rgb() / rgba() / color(srgb ...) 为 RGB 数组。
 * @param {string} text
 * @returns {[number, number, number] | null}
 */
export function parseColor(text) {
  const s = String(text ?? "")
    .trim()
    .toLowerCase();
  if (!s) return null;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    return [
      Number.parseInt(h.slice(0, 2), 16),
      Number.parseInt(h.slice(2, 4), 16),
      Number.parseInt(h.slice(4, 6), 16),
    ];
  }

  const fn = /^(rgb|rgba|color)\(([^)]+)\)$/.exec(s);
  if (!fn) return null;
  const raw = fn[2]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));
  if (raw.length < 3) return null;
  const scale = fn[1] === "color" && Math.max(...raw.slice(0, 3)) <= 1 ? 255 : 1;
  return [0, 1, 2].map((i) => Math.round(clamp(raw[i] * scale, 0, 255)));
}

/**
 * @param {[number, number, number]} rgb
 * @returns {string}
 */
export function rgbToHex(rgb) {
  return `#${rgb.map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * @param {[number, number, number]} rgb
 * @returns {[number, number, number]} 色相（度）/ 饱和度 / 亮度（0~1）
 */
export function rgbToHsl([r, g, b]) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  const l = (max + min) / 2;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max === R) h = ((G - B) / d) % 6;
  else if (max === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [(((h * 60) % 360) + 360) % 360, s, l];
}

/**
 * @param {number} h 色相（度）
 * @param {number} s 饱和度
 * @param {number} l 亮度
 * @returns {[number, number, number]}
 */
function hslToRgb(h, s, l) {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (!s) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [channel(hue + 1 / 3), channel(hue), channel(hue - 1 / 3)].map((v) =>
    Math.round(clamp(v * 255, 0, 255)),
  );
}

/** @param {number} h @param {number} s @param {number} l @returns {string} */
export function hslToHex(h, s, l) {
  return rgbToHex(hslToRgb(h, clamp(s, 0, 1), clamp(l, 0, 1)));
}

/**
 * WCAG 相对亮度与对比度，用于自动挑选可读的前景墨色。
 * @param {[number, number, number]} rgb
 */
function relLuminance(rgb) {
  const f = (c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function contrastRatio(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return 1;
  const la = relLuminance(ca);
  const lb = relLuminance(cb);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 在白色与深色墨之间选对比度更高者 */
function inkOn(bg, h, sat) {
  const white = "#ffffff";
  const darkInk = hslToHex(h, Math.min(sat, 0.55), 0.1);
  return contrastRatio(bg, white) >= contrastRatio(bg, darkInk) ? white : darkInk;
}

/**
 * 由种子色生成整套 M3 tonal 调色板（纯函数）。
 * 浅色：primary tone 40 / container tone 90；深色：primary tone 80 / container tone 30。
 * @param {string} seed 任意可解析颜色；不可解析或近灰时回退默认紫罗兰
 * @param {boolean} [dark]
 * @returns {Record<string, string>} CSS 变量 -> 颜色
 */
export function paletteFromSeed(seed, dark = false) {
  const rgb = parseColor(seed);
  let [h, s] = rgbToHsl(rgb ?? parseColor(DEFAULT_SEED));
  if (!rgb || s < 0.1) {
    const fallback = parseColor(DEFAULT_SEED);
    [h, s] = rgbToHsl(fallback);
  }
  const sat = clamp(s, 0.2, 0.82);
  const tone = (hh, ss, ll) => hslToHex(hh, ss, ll);
  const tertiaryHue = (h + 60) % 360;

  const primary = dark ? tone(h, sat * 0.65, 0.8) : tone(h, sat * 0.92, 0.42);
  const primaryContainer = dark ? tone(h, sat * 0.45, 0.32) : tone(h, sat * 0.72, 0.9);
  const onPrimary = inkOn(primary, h, sat);
  const onPrimaryContainer = inkOn(primaryContainer, h, sat);
  const secondaryContainer = dark ? tone(h, sat * 0.22, 0.28) : tone(h, sat * 0.3, 0.9);
  const onSecondaryContainer = inkOn(secondaryContainer, h, sat);
  const tertiaryContainer = dark
    ? tone(tertiaryHue, sat * 0.35, 0.3)
    : tone(tertiaryHue, sat * 0.55, 0.9);
  const tertiary = dark
    ? tone(tertiaryHue, sat * 0.5, 0.8)
    : tone(tertiaryHue, sat * 0.6, 0.42);

  const surface = dark ? tone(h, sat * 0.1, 0.12) : tone(h, sat * 0.1, 0.995);
  const surface2 = dark ? tone(h, sat * 0.1, 0.18) : tone(h, sat * 0.14, 0.945);
  const surface3 = dark ? tone(h, sat * 0.1, 0.23) : tone(h, sat * 0.14, 0.905);
  const bg = dark ? tone(h, sat * 0.1, 0.085) : tone(h, sat * 0.16, 0.975);
  const text = dark ? tone(h, sat * 0.08, 0.93) : tone(h, sat * 0.1, 0.11);
  const text2 = dark ? tone(h, sat * 0.08, 0.8) : tone(h, sat * 0.08, 0.31);
  const muted = dark ? tone(h, sat * 0.08, 0.62) : tone(h, sat * 0.08, 0.48);
  const outlineVariant = dark ? tone(h, sat * 0.08, 0.24) : tone(h, sat * 0.12, 0.88);
  const surfaceRgb = parseColor(surface);
  const glass = surfaceRgb
    ? `rgba(${surfaceRgb[0]}, ${surfaceRgb[1]}, ${surfaceRgb[2]}, 0.96)`
    : surface;

  const semantic = dark
    ? {
        green: "#a8d8b0",
        greenSoft: "#1f3b25",
        amber: "#e8c17a",
        amberSoft: "#3d2f14",
        red: "#f2b8b5",
        redSoft: "#3d1d1a",
      }
    : {
        green: "#2e6b3f",
        greenSoft: "#c4eed0",
        amber: "#7a5900",
        amberSoft: "#ffdea6",
        red: "#b3261e",
        redSoft: "#f9dedc",
      };

  /** @type {Record<string, string>} */
  const fg = {
    "--fg-primary": primary,
    "--fg-on-primary": onPrimary,
    "--fg-primary-container": primaryContainer,
    "--fg-on-primary-container": onPrimaryContainer,
    "--fg-secondary": dark ? tone(h, sat * 0.2, 0.8) : tone(h, sat * 0.24, 0.42),
    "--fg-secondary-container": secondaryContainer,
    "--fg-on-secondary-container": onSecondaryContainer,
    "--fg-tertiary": tertiary,
    "--fg-tertiary-container": tertiaryContainer,
    "--fg-surface-tint": primary,
    "--fg-bg": bg,
    "--fg-surface": surface,
    "--fg-surface-2": surface2,
    "--fg-surface-glass": glass,
    "--fg-wood": outlineVariant,
    "--fg-wood-soft": outlineVariant,
    "--fg-border": outlineVariant,
    "--fg-border-strong": muted,
    "--fg-text": text,
    "--fg-text-2": text2,
    "--fg-muted": muted,
    "--fg-accent": primary,
    "--fg-accent-2": tertiary,
    "--fg-accent-3": secondaryContainer,
    "--fg-accent-soft": primaryContainer,
    "--fg-green": semantic.green,
    "--fg-green-soft": semantic.greenSoft,
    "--fg-amber": semantic.amber,
    "--fg-amber-soft": semantic.amberSoft,
    "--fg-red": semantic.red,
    "--fg-red-soft": semantic.redSoft,
    "--fg-state-layer": text,
    "--fg-state-on-primary": onPrimary,
  };

  /** @type {Record<string, string>} */
  const fgm = {
    "--fgm-primary": primary,
    "--fgm-on-primary": onPrimary,
    "--fgm-primary-container": primaryContainer,
    "--fgm-on-primary-container": onPrimaryContainer,
    "--fgm-secondary-container": secondaryContainer,
    "--fgm-on-secondary-container": onSecondaryContainer,
    "--fgm-tertiary-container": tertiaryContainer,
    "--fgm-surface": surface,
    "--fgm-surface-2": surface2,
    "--fgm-surface-3": surface3,
    "--fgm-text": text,
    "--fgm-text-2": text2,
    "--fgm-muted": muted,
    "--fgm-outline": muted,
    "--fgm-outline-variant": outlineVariant,
  };

  return { ...fg, ...fgm };
}

/**
 * 读取 CSS 系统色（Chromium 下反映 Windows / 浏览器强调色）。
 * 扩展页面与内容脚本都可用；无彩色或不可读时返回 null。
 * @returns {string | null} 十六进制色
 */
export function systemAccent() {
  if (typeof document === "undefined") return null;
  const host = document.documentElement ?? document.body;
  if (!host || typeof getComputedStyle !== "function") return null;
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  // 标记探针：内容脚本的 DOM 观察器会忽略它，避免误判为页面变化
  probe.setAttribute("data-fg-theme-probe", "1");
  probe.style.cssText = "position:absolute;left:-99999px;top:0;width:1px;height:1px;";
  try {
    host.appendChild(probe);
    for (const name of ["AccentColor", "Highlight", "SelectedItem", "LinkText"]) {
      probe.style.color = name;
      const rgb = parseColor(getComputedStyle(probe).color);
      if (!rgb) continue;
      const [, s, l] = rgbToHsl(rgb);
      if (s >= 0.16 && l >= 0.12 && l <= 0.92) return rgbToHex(rgb);
    }
  } catch {
    // 某些上下文禁止读取系统色，交给调用方降级
  } finally {
    probe.remove();
  }
  return null;
}

/** 宿主网页声明的主题色（GitHub 用 --color-accent-fg，通用站点用 meta theme-color） */
export function pageAccent() {
  if (typeof document === "undefined") return null;
  const root = document.documentElement;
  const css =
    typeof getComputedStyle === "function"
      ? getComputedStyle(root).getPropertyValue("--color-accent-fg")
      : "";
  const meta = document
    .querySelector('meta[name="theme-color"]')
    ?.getAttribute("content");
  for (const value of [css, meta]) {
    const rgb = parseColor(value ?? "");
    if (rgb) return rgbToHex(rgb);
  }
  return null;
}

/**
 * @param {object} settings
 * @param {{ injected?: boolean }} opts
 * @returns {boolean}
 */
function resolveDark(settings, opts) {
  const mode = settings?.theme;
  if (mode === "light") return false;
  if (mode === "dark") return true;
  if (opts?.injected && typeof document !== "undefined") {
    const root = document.documentElement;
    const pageMode = root.getAttribute("data-color-mode");
    if (pageMode === "dark" || pageMode === "light") return pageMode === "dark";
    if (root.getAttribute("data-dark-theme") === "dark") return true;
  }
  return Boolean(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
}

/** @param {any} theme Firefox theme.Theme */
function themeColorsToSeed(theme) {
  const colors = theme?.colors ?? {};
  const value = colors.frame ?? colors.toolbar ?? colors.button_background;
  if (Array.isArray(value) && value.length >= 3) {
    return rgbToHex([Number(value[0]), Number(value[1]), Number(value[2])]);
  }
  const rgb = parseColor(value ?? "");
  return rgb ? rgbToHex(rgb) : null;
}

/** @type {{ settings: object; opts: object; installed?: boolean; timer?: number; accent?: string | null; observer?: MutationObserver } | null} */
let watchers = null;
/** @type {string | null} */
let browserThemeSeed = null;
let browserThemeChecked = false;
/** @type {{ dark: boolean; seed: string; source: string; colors: number } | null} */
let lastResult = null;

/** 当前已应用的主题状态，供设置页展示来源 */
export function getThemeState() {
  return (
    lastResult ?? { dark: false, seed: DEFAULT_SEED, source: "默认紫罗兰", colors: 0 }
  );
}

/** @returns {{ seed: string; source: string }} */
function resolveSeed(settings, opts) {
  const customRgb = parseColor(settings?.themeSeed ?? "");
  if (settings?.followBrowserColor === false && customRgb) {
    return { seed: rgbToHex(customRgb), source: "自定义主色" };
  }
  if (browserThemeSeed) return { seed: browserThemeSeed, source: "浏览器主题色" };
  if (opts?.injected) {
    const page = pageAccent();
    if (page) return { seed: page, source: "当前网页主题色" };
  }
  const accent = systemAccent();
  if (accent) return { seed: accent, source: "系统强调色" };
  return { seed: DEFAULT_SEED, source: "默认紫罗兰" };
}

/**
 * 应用主题并登记实时监听（幂等：多次调用只更新设置，不重复注册）。
 * @param {object} [settings]
 * @param {{ injected?: boolean }} [opts] injected=true 时只写 --fgm-*，不污染宿主页面
 * @returns {{ dark: boolean; seed: string; source: string; colors: number }}
 */
export function applyBrowserTheme(settings = {}, opts = {}) {
  if (typeof document === "undefined") return getThemeState();
  const injected = opts.injected === true;
  const dark = resolveDark(settings, opts);
  const { seed, source } = resolveSeed(settings, opts);
  const palette = paletteFromSeed(seed, dark);
  const root = document.documentElement;

  for (const [key, value] of Object.entries(palette)) {
    if (!injected || key.startsWith("--fgm-")) root.style.setProperty(key, value);
  }
  if (!injected) {
    root.setAttribute("data-theme", dark ? "dark" : "light");
    root.style.colorScheme = dark ? "dark" : "light";
  }

  const result = { dark, seed, source, colors: Object.keys(palette).length };
  lastResult = result;
  watchers = {
    ...(watchers ?? {}),
    settings: { ...settings },
    opts: { ...opts },
  };
  installWatchers();
  maybeReadBrowserTheme();
  return result;
}

function refresh() {
  if (!watchers) return;
  applyBrowserTheme(watchers.settings, watchers.opts);
}

/** Firefox：真正读取浏览器主题色；Chromium 无此 API 时静默跳过 */
function maybeReadBrowserTheme() {
  if (browserThemeChecked || typeof chrome === "undefined") return;
  const api = chrome.theme ?? globalThis.browser?.theme;
  browserThemeChecked = true;
  if (!api?.getCurrent) return;
  const read = () => {
    Promise.resolve(api.getCurrent())
      .then((theme) => {
        const next = themeColorsToSeed(theme);
        if (next && next !== browserThemeSeed) {
          browserThemeSeed = next;
          refresh();
        }
      })
      .catch(() => {});
  };
  read();
  api.onUpdated?.addListener?.(read);
}

function installWatchers() {
  if (!watchers || watchers.installed || typeof window === "undefined") return;
  watchers.installed = true;
  watchers.accent = systemAccent();

  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    ?.addEventListener?.("change", refresh);
  window.matchMedia?.("(forced-colors: active)")?.addEventListener?.("change", refresh);

  // 系统强调色变化不会派发事件，轻量轮询比对签名（1.5 秒），变化才重算
  watchers.timer = window.setInterval(() => {
    const accent = systemAccent();
    if (accent !== watchers?.accent) {
      if (watchers) watchers.accent = accent;
      refresh();
    }
  }, 1500);

  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !watchers) return;
      for (const change of Object.values(changes)) {
        const value = change?.newValue;
        if (
          value &&
          typeof value === "object" &&
          ("theme" in value || "followBrowserColor" in value || "themeSeed" in value)
        ) {
          watchers.settings = { ...watchers.settings, ...value };
          refresh();
          break;
        }
      }
    });
  } catch {
    // 内容脚本或测试环境可能没有 storage 权限
  }

  if (watchers.opts.injected) {
    watchers.observer = new MutationObserver(refresh);
    watchers.observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-color-mode", "data-dark-theme"],
    });
  }
}

/** 清理定时器与观察器（测试或页面卸载时用） */
export function stopBrowserTheme() {
  if (watchers?.timer) window.clearInterval(watchers.timer);
  watchers?.observer?.disconnect();
  watchers = null;
  browserThemeChecked = false;
  browserThemeSeed = null;
  lastResult = null;
}
