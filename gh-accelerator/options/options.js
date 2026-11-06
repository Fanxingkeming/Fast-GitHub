/**
 * 设置页逻辑：一键体检 / 节点管理 / 登录保护 / 路由自检 / 通用设置。
 * 所有改动即时写入存储，不再需要手动保存。
 */

import { FGNet } from "../lib/net.js";
import { rankNodes } from "../lib/rank.js";
import { DEFAULT_ENABLED_REPO_IDS } from "../lib/repos.js";
import { decideRoute, HOST_PROFILES, JSDELIVR, toJsDelivr } from "../lib/routes.js";
import { DEFAULT_SENSITIVE_PATHS, FGStore, matchSensitive } from "../lib/store.js";
import { buildSyncPatch } from "../lib/sync.js";
import { applyBrowserTheme, getThemeState } from "../lib/theme.js";
import { fmtLatency, toast } from "../lib/ui.js";

/** @type {import("../lib/store.js").Settings | null} */
let settings = null;
let testing = false;
let cancelTest = false;
let showMoreRepos = false;

const $ = (/** @type {string} */ id) => document.getElementById(id);

/* ------------------------------ 通用工具 ------------------------------ */

/** @param {number} ts */
function fmtTime(ts) {
  if (!ts) return "从未";
  const d = new Date(ts);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * 统一重绘界面。节点数据变化后调用，避免各处重复罗列 render 序列。
 * @param {{ repos?: boolean }} [opts]
 */
function refresh(opts) {
  fillForm();
  fillSelects();
  renderNodes();
  renderRules();
  renderStats();
  if (opts?.repos) {
    renderRepos();
    renderMergeInfo();
  }
}

/* ------------------------------ 自动保存 ------------------------------ */

const FIELDS = /** @type {const} */ ([
  { id: "autoUpdate", key: "autoUpdate", type: "check" },
  { id: "updateIntervalHours", key: "updateIntervalHours", type: "number" },
  { id: "enabled", key: "enabled", type: "check" },
  { id: "smartKind", key: "smartKind", type: "check" },
  { id: "strategy", key: "strategy", type: "value" },
  { id: "manualNode", key: "manualNode", type: "value" },
  { id: "channelCount", key: "channelCount", type: "number" },
  { id: "autoProxyOnFailure", key: "autoProxyOnFailure", type: "check" },
  { id: "protectSensitive", key: "protectSensitive", type: "check" },
  { id: "fallbackNode", key: "fallbackNode", type: "value" },
  { id: "speedTestUrl", key: "speedTestUrl", type: "value" },
  { id: "routeMode", key: "routeMode", type: "value" },
  { id: "useJsDelivr", key: "useJsDelivr", type: "check" },
  { id: "theme", key: "theme", type: "value" },
  { id: "followBrowserColor", key: "followBrowserColor", type: "check" },
  { id: "themeSeed", key: "themeSeed", type: "value" },
]);

/** 外观卡片：展示当前主色来源，并即时反映「跟随浏览器」开关 */
function renderThemeInfo() {
  const state = getThemeState();
  const swatch = $("themeSwatch");
  const source = $("themeColorSource");
  const value = $("themeSeedValue");
  const custom = $("themeSeedField");
  if (swatch) {
    swatch.style.background = state.seed;
    swatch.title = state.seed;
  }
  if (value) value.textContent = state.seed.toUpperCase();
  if (source) {
    source.textContent =
      state.source === "自定义主色"
        ? `当前使用自定义主色 ${state.seed.toUpperCase()}`
        : `当前取自${state.source} ${state.seed.toUpperCase()}，随浏览器 / 系统主题实时变化`;
  }
  if (custom) custom.hidden = settings?.followBrowserColor !== false;
}

/** 主题相关字段变更后，重算调色板并刷新来源说明 */
function syncTheme() {
  applyBrowserTheme(settings ?? {});
  renderThemeInfo();
}

/**
 * 字段即时落盘。只更新内存中的对应键与相关视图，不重填表单，避免打断输入。
 * @param {string} key
 * @param {any} value
 */
async function saveField(key, value) {
  if (!settings) return;
  settings = await FGStore.set({ [key]: value });
  if (["theme", "followBrowserColor", "themeSeed"].includes(key)) syncTheme();
  if (key === "strategy") {
    const manual = $("manualNodeField");
    if (manual) manual.hidden = settings.strategy !== "manual";
  }
  renderStats();
  renderNodes();
  const state = $("saveState");
  if (state) state.textContent = `已自动保存 · ${new Date().toLocaleTimeString()}`;
}

let sourcesTimer = null;
function scheduleSourcesSave() {
  clearTimeout(sourcesTimer);
  sourcesTimer = setTimeout(async () => {
    const list = String($("updateSources")?.value ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    settings = await FGStore.set({ updateSources: list });
  }, 250);
}

function fillForm() {
  for (const field of FIELDS) {
    const el = $(field.id);
    if (!el || !settings) continue;
    const value = settings[/** @type {keyof typeof settings} */ (field.key)];
    if (field.type === "check") {
      el.checked = Boolean(value);
    } else {
      el.value = value === undefined || value === null ? "" : String(value);
    }
  }
  const sources = $("updateSources");
  if (sources) sources.value = (settings?.updateSources ?? []).join("\n");
  const message = $("syncMessage");
  if (message) {
    message.textContent =
      settings?.lastUpdateMessage ||
      (settings?.lastUpdate ? `上次同步：${fmtTime(settings.lastUpdate)}` : "尚未同步");
  }
  const manual = $("manualNodeField");
  if (manual) manual.hidden = settings?.strategy !== "manual";
  const summary = $("checkupSummary");
  if (summary) summary.textContent = settings?.lastCheckupMessage || "尚未体检";
}

function fillSelects() {
  const options = FGStore.allNodes(settings)
    .map((n) => `<option value="${n.value}">${n.value}</option>`)
    .join("");
  for (const [id, value] of [
    ["manualNode", settings?.manualNode],
    ["fallbackNode", settings?.fallbackNode],
  ]) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = options;
    el.value = String(value ?? "");
  }
}

/* ------------------------------ 概览数据 ------------------------------ */

function renderStats() {
  if (!settings) return;
  const all = FGStore.activeNodes(settings);
  const total = all.length;
  const best = FGStore.preferredNode(settings);
  const stat = FGStore.statOf(settings, best);
  const full = all.filter((n) => FGStore.kindOf(settings, n.value) === "full").length;
  $("statTotal").textContent = `${total} 个`;
  $("statTotal").title = `可加速仓库 ${full} 个 · 仅下载 ${total - full} 个`;
  $("statBest").textContent = best || "—";
  $("statBest").title = best ?? "";
  $("statLatency").textContent = stat?.latency
    ? (fmtLatency(stat.latency)?.text ?? stat.latency)
    : "未测速";
  $("statSync").textContent = settings.lastUpdate ? fmtTime(settings.lastUpdate) : "从未";
}

/* ------------------------------ 节点列表 ------------------------------ */

function sortNodes(list) {
  return rankNodes(list, settings);
}

function renderNodes() {
  if (!settings) return;
  const keyword = String($("nodeSearch")?.value ?? "")
    .trim()
    .toLowerCase();
  const filter = String($("nodeFilter")?.value ?? "all");
  const best = FGStore.preferredNode(settings);

  let list = FGStore.allNodes(settings);
  if (filter === "enabled") list = list.filter((n) => !n.disabled);
  if (filter === "disabled") list = list.filter((n) => n.disabled);
  if (filter === "custom") list = list.filter((n) => n.custom);
  if (filter === "full")
    list = list.filter((n) => FGStore.kindOf(settings, n.value) === "full");
  if (filter === "download")
    list = list.filter((n) => FGStore.kindOf(settings, n.value) === "download");
  if (keyword) list = list.filter((n) => n.value.toLowerCase().includes(keyword));
  list = sortNodes(list);

  $("nodeCount").textContent = String(list.length);

  $("nodeList").innerHTML =
    list
      .map((node) => {
        const stat = FGStore.statOf(settings, node.value);
        const latency = fmtLatency(stat?.latency);
        const speed = stat?.speed && stat.speed !== "-" ? stat.speed : null;
        const isBest = node.value === best;
        const kind = FGStore.kindOf(settings, node.value);
        const source = FGStore.kindSource(settings, node.value);
        const label = kind === "full" ? "可加速仓库" : "仅下载文件";
        const kindTitle =
          source === "auto"
            ? `${label} · 体检自动标注 · ${kind === "full" ? "支持 git，可直接打开 / clone 仓库" : "不支持 git，只能下载文件"}`
            : source === "manual"
              ? `${label} · 手动覆盖的分类，优先于自动标注`
              : kind === "full"
                ? `${label} · 默认按可加速仓库处理`
                : `${label} · 节点仓库清单标记`;
        const dotCls = `fg-kind-dot is-${kind}${source === "auto" ? " is-auto" : ""}`;
        return `
      <div class="node-item${node.disabled ? " is-disabled" : ""}${
        isBest ? " is-best" : ""
      }" data-value="${node.value}">
        <div class="node-domain">
          <span class="${dotCls}" title="${kindTitle}"></span>
          ${isBest ? '<span class="fg-badge fg-badge-accent">最优</span>' : ""}
          <span class="node-domain-text" title="${node.value}">${node.value}</span>
          <span class="fg-badge">${
            node.custom
              ? "自定义"
              : (node.sources ?? []).some((s) => s && s !== "builtin")
                ? repoShortName((node.sources ?? []).find((s) => s !== "builtin"))
                : "内置"
          }</span>
        </div>
        <div class="node-metric">
          ${
            latency
              ? `<span class="fg-badge ${latency.cls}">${latency.text}</span>`
              : '<span style="color:var(--fg-muted)">—</span>'
          }
        </div>
        <div class="node-metric">
          ${
            speed
              ? `<span class="fg-badge fg-badge-good">${speed}</span>`
              : '<span style="color:var(--fg-muted)">—</span>'
          }
        </div>
        <div class="node-actions">
          <button class="fg-btn fg-btn-sm" type="button" data-act="toggle">
            ${node.disabled ? "启用" : "停用"}
          </button>
          <button class="fg-btn fg-btn-sm" type="button" data-act="use">首选</button>
          <div class="node-more-wrap">
            <button class="fg-btn fg-btn-sm" type="button" data-act="more" title="更多操作">⋯</button>
            <div class="node-menu" hidden>
              <button type="button" data-act="test">单独测速并标注</button>
              <button type="button" data-act="kind-full">覆盖为可加速仓库</button>
              <button type="button" data-act="kind-download">覆盖为仅下载</button>
              <button type="button" data-act="kind-auto">恢复自动判断</button>
              ${
                node.custom
                  ? '<button type="button" data-act="del">删除自定义节点</button>'
                  : ""
              }
            </div>
          </div>
        </div>
      </div>`;
      })
      .join("") || '<div class="fg-empty">没有匹配的节点</div>';
}

/* --------------------------- 路由与诊断 --------------------------- */

function renderProbes() {
  const container = $("probeList");
  if (!container || !settings) return;
  const probes = settings.probes ?? {};

  container.innerHTML = HOST_PROFILES.map((profile) => {
    const result = probes[profile.id];
    const cls = !result
      ? "fg-badge"
      : result.reachable
        ? "fg-badge fg-badge-good"
        : "fg-badge fg-badge-bad";
    const text = !result
      ? "未探测"
      : result.reachable
        ? `可达 · ${result.latency} ms`
        : "不可达";
    return `
      <div class="probe-item">
        <div class="probe-main">
          <div class="probe-name">${profile.label}</div>
          <div class="probe-desc">${profile.desc}</div>
        </div>
        <span class="${cls}">${text}</span>
      </div>`;
  }).join("");
}

async function probeHostsNow() {
  const spinner = $("probeSpinner");
  const button = /** @type {HTMLButtonElement} */ ($("btnProbe"));
  if (spinner) spinner.hidden = false;
  if (button) button.disabled = true;

  await chrome.runtime.sendMessage({ type: "probeHosts" });
  settings = await FGStore.get();
  renderProbes();

  if (spinner) spinner.hidden = true;
  if (button) button.disabled = false;
  toast("域名连通性探测完成", "ok");
}

/** 路由模式 -> 展示用的标签与配色 */
const MODE_META = {
  direct: { label: "直连", cls: "fg-badge-good" },
  jsdelivr: { label: JSDELIVR.label, cls: "fg-badge-accent" },
  proxy: { label: "公益节点", cls: "fg-badge-mid" },
};

function routeCheck() {
  const input = /** @type {HTMLInputElement} */ ($("routeTestInput"));
  const output = $("routeTestResult");
  if (!input || !output || !settings) return;

  const url = String(input.value ?? "").trim();
  if (!url) {
    output.innerHTML = '<span style="color:var(--fg-muted)">请输入一个地址</span>';
    return;
  }

  const decision = decideRoute(url, { settings, probes: settings.probes });
  const meta = MODE_META[decision.mode] ?? MODE_META.proxy;
  const target =
    decision.mode === "jsdelivr"
      ? (toJsDelivr(url) ?? url)
      : decision.mode === "proxy"
        ? FGStore.buildProxyUrl(FGStore.preferredNode(settings), url)
        : url;

  output.innerHTML = `
    <span class="fg-badge ${meta.cls}">${meta.label}</span>
    <div class="route-reason">${decision.reason}</div>
    <div class="route-target">${target}</div>`;
}

/** 一次给出路由 / 保护 / 域名连通性 / 节点能力四项结论 */
function selfCheck() {
  const input = /** @type {HTMLInputElement} */ ($("selfCheckInput"));
  const output = $("selfCheckResult");
  if (!input || !output || !settings) return;
  const url = String(input.value ?? "").trim();
  if (!url) {
    output.innerHTML =
      '<span style="color:var(--fg-muted)">请输入一个 GitHub 地址</span>';
    return;
  }

  const decision = decideRoute(url, { settings, probes: settings.probes });
  const meta = MODE_META[decision.mode] ?? MODE_META.proxy;
  const blocked = Boolean(
    settings.protectSensitive && matchSensitive(url, settings.sensitivePaths ?? []),
  );
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* 地址不合法时按未探测展示 */
  }
  const profile =
    HOST_PROFILES.find((p) => host === new URL(p.probe).hostname) ??
    (host.endsWith(".githubusercontent.com") ? HOST_PROFILES[1] : null);
  const probe = profile ? settings.probes?.[profile.id] : null;
  const probeText = probe
    ? probe.reachable
      ? `可达 · ${probe.latency} ms`
      : "不可达"
    : "未探测";
  const node = FGStore.preferredNode(settings);
  const caps = settings.capabilities?.[node] ?? settings.nodeState?.[node]?.caps;
  const capText = caps
    ? `Git ${caps.git ? "✓" : "✗"} · Range ${caps.range ? "✓" : "✗"} · ${
        FGStore.classifyByCaps(caps) === "full" ? "可加速仓库" : "仅下载"
      }`
    : "尚未体检";

  output.innerHTML = `
    <div class="self-item"><span>路由</span><span class="fg-badge ${meta.cls}">${meta.label}</span><span>${decision.reason}</span></div>
    <div class="self-item"><span>登录保护</span><span class="fg-badge ${blocked ? "fg-badge-good" : "fg-badge-mid"}">${blocked ? "受保护" : "未命中"}</span><span>${blocked ? "不会走代理" : "失败时可能被自动代理"}</span></div>
    <div class="self-item"><span>域名连通性</span><span class="fg-badge">${profile?.label ?? (host || "未知")}</span><span>${probeText}</span></div>
    <div class="self-item"><span>当前节点</span><span class="fg-badge fg-badge-accent">${node}</span><span>${capText}</span></div>`;
}

function renderHealth() {
  const container = $("healthList");
  if (!container || !settings) return;
  const nodes = FGStore.activeNodes(settings).slice(0, 12);

  container.innerHTML = nodes
    .map((node) => {
      const health = FGStore.healthOf(settings, node.value);
      const caps =
        settings.capabilities?.[node.value] ?? settings.nodeState?.[node.value]?.caps;
      const healthCls =
        health.score === null
          ? "fg-badge"
          : health.score >= 90
            ? "fg-badge fg-badge-good"
            : health.score >= 60
              ? "fg-badge fg-badge-mid"
              : "fg-badge fg-badge-bad";
      const capHtml = caps
        ? `<span class="fg-badge ${caps.range ? "fg-badge-good" : ""}">Range ${
            caps.range ? "✓" : "✗"
          }</span>
           <span class="fg-badge ${caps.git ? "fg-badge-good" : ""}">Git ${
             caps.git ? "✓" : "✗"
           }</span>`
        : '<span class="fg-badge">未探测</span>';
      return `
      <div class="health-item">
        <span class="health-name">${node.value}</span>
        <span class="${healthCls}">${health.label}${
          health.score === null ? "" : ` ${health.score}%`
        }</span>
        <span class="fg-badge">${health.uses} 次</span>
        ${capHtml}
      </div>`;
    })
    .join("");
}

async function probeCapsNow() {
  if (!settings) return;
  const node = FGStore.preferredNode(settings);
  const result = await FGNet.probeCapabilities(node, 8000);
  settings = await FGStore.updateNode(node, { caps: result });
  renderHealth();
  renderNodes();
  toast(
    `${node} · Range ${result.range ? "支持" : "不支持"} / Git ${
      result.git ? "支持" : "不支持"
    }`,
    "ok",
  );
}

/* ------------------------------ 节点仓库 ------------------------------ */

function repoShortName(source) {
  const repo = FGStore.NODE_REPOS.find((r) => r.id === source);
  if (repo) return repo.name.split("/")[1] ?? repo.name;
  return source === "builtin" ? "内置" : (source ?? "remote");
}

function renderRepos() {
  const container = $("repoList");
  if (!container || !settings) return;
  const enabled = settings.repoEnabled ?? {};
  const counts = settings.repoCounts ?? {};
  const defaults = new Set(DEFAULT_ENABLED_REPO_IDS);

  container.innerHTML = FGStore.NODE_REPOS.map((repo) => {
    const isDefault = defaults.has(repo.id);
    return `
      <div class="repo-item${isDefault ? "" : " is-more"}${showMoreRepos ? " is-shown" : ""}">
        <div class="repo-main">
          <div class="repo-name">
            <a href="${repo.url}" target="_blank">${repo.name}</a>
            <span class="fg-badge">${counts[repo.id] ?? 0} 个</span>
            ${isDefault ? '<span class="fg-badge fg-badge-accent">默认</span>' : ""}
          </div>
          <div class="repo-desc">${repo.desc}</div>
        </div>
        <label class="fg-switch">
          <span class="fg-sr-only">启用 ${repo.name}</span>
          <input type="checkbox" data-repo="${repo.id}" ${
            enabled[repo.id] === true ? "checked" : ""
          } />
          <span class="fg-switch-track"></span>
        </label>
      </div>`;
  }).join("");
  const hint = $("repoDefaultHint");
  if (hint) hint.textContent = `默认启用 ${DEFAULT_ENABLED_REPO_IDS.length} 个`;
  const more = $("btnMoreRepos");
  if (more) more.textContent = showMoreRepos ? "收起更多来源" : "更多来源";
}

function renderMergeInfo() {
  const element = $("mergeInfo");
  if (!element || !settings) return;
  const raw = [...(settings.remoteNodes ?? []), ...(settings.customNodes ?? [])];
  const stats = FGStore.mergeStats(raw);
  const total = FGStore.mergeStats(FGStore.allNodes(settings));
  element.textContent = raw.length
    ? `仓库原始 ${stats.total} 条 → 去重后 ${stats.unique} 个（合并 ${stats.merged} 个重复项）；含内置共 ${total.unique} 个可用节点`
    : "尚未同步任何仓库";
}

/** 立即去重并写回：统一域名写法、合并重复项（保留完整 sources） */
async function dedupeNow(silent) {
  if (!settings) return { merged: 0, unique: 0 };
  const raw = [...(settings.remoteNodes ?? []), ...(settings.customNodes ?? [])];
  const stats = FGStore.mergeStats(raw);

  const remoteNodes = FGStore.dedupe(settings.remoteNodes ?? []).map((node) => ({
    value: node.value,
    label: node.label ?? "remote",
    sources: node.sources ?? [],
    source: (node.sources ?? [])[0] ?? "remote",
  }));
  const customNodes = FGStore.dedupe(settings.customNodes ?? []).map((node) => ({
    value: node.value,
    label: "custom",
  }));

  settings = await FGStore.set({ remoteNodes, customNodes });
  if (!silent) {
    refresh({ repos: true });
    toast(
      stats.merged
        ? `已合并 ${stats.merged} 个重复节点，剩余 ${stats.unique} 个`
        : "没有发现重复节点",
      "ok",
    );
  }
  return { merged: stats.merged, unique: stats.unique };
}

async function toggleRepo(id, checked) {
  settings = await FGStore.set({
    repoEnabled: { ...(settings.repoEnabled ?? {}), [id]: checked },
  });
  renderRepos();
  toast(`${checked ? "已启用" : "已停用"}仓库 ${id}`, "ok");
}

async function toggleNode(value) {
  const disabled = new Set(settings?.disabledNodes ?? []);
  if (disabled.has(value)) disabled.delete(value);
  else disabled.add(value);
  settings = await FGStore.set({ disabledNodes: [...disabled] });
  renderNodes();
  renderStats();
}

async function deleteNode(value) {
  settings = await FGStore.set({
    customNodes: (settings?.customNodes ?? []).filter((n) => n.value !== value),
  });
  renderNodes();
  renderStats();
  fillSelects();
  toast(`已删除 ${value}`, "ok");
}

async function useNode(value) {
  settings = await FGStore.set({ strategy: "manual", manualNode: value });
  fillForm();
  renderNodes();
  renderStats();
  toast(`已设为首选节点：${value}`, "ok");
}

/** 手动覆盖分类；传 null 表示恢复自动判断 */
async function overrideKind(value, kind) {
  settings = await FGStore.setNodeKind(value, kind);
  renderNodes();
  renderStats();
  toast(
    kind
      ? `${value} → ${kind === "full" ? "可加速仓库" : "仅下载文件"}`
      : "已恢复自动判断",
    "ok",
  );
}

async function addNode() {
  const input = /** @type {HTMLInputElement} */ ($("customNodeInput"));
  const value = String(input?.value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  if (!value) return;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) {
    toast("节点格式不正确", "err");
    return;
  }
  if (FGStore.allNodes(settings).some((n) => n.value === value)) {
    toast("节点已存在", "err");
    return;
  }
  settings = await FGStore.set({
    customNodes: [...(settings?.customNodes ?? []), { value, label: "custom" }],
  });
  input.value = "";
  fillSelects();
  renderNodes();
  renderStats();
  toast(`已添加 ${value}`, "ok");
}

/* ------------------------------ 节点同步 ------------------------------ */

async function syncNow() {
  if (!settings) return;
  const spinner = $("syncSpinner");
  const button = /** @type {HTMLButtonElement} */ ($("btnSyncNow"));
  if (spinner) spinner.hidden = false;
  if (button) button.disabled = true;

  const before = FGStore.allNodes(settings).length;
  const result = await buildSyncPatch(settings);
  settings = await FGStore.set(result.patch);
  refresh({ repos: true });
  toast(
    result.ok
      ? `同步成功：${before} → ${FGStore.allNodes(settings).length} 个节点（${result.okCount}/${result.totalSources} 个源）`
      : "节点同步失败，已尝试全部节点源",
    result.ok ? "ok" : "err",
  );

  if (spinner) spinner.hidden = true;
  if (button) button.disabled = false;
}

/* ------------------------------ 测速 / 体检 ------------------------------ */

async function runPool(items, limit, worker) {
  let index = 0;
  /** @type {Promise<void>[]} */
  const runners = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) {
    runners.push(
      (async () => {
        while (index < items.length) {
          if (cancelTest) return;
          const current = index;
          index += 1;
          await worker(items[current], current);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

/** @param {number} ratio */
function setBar(ratio) {
  const bar = $("testProgress")?.querySelector("i");
  if (bar) bar.style.width = `${Math.round(ratio * 100)}%`;
}

/** @param {string} text */
function setStatus(text) {
  const status = $("testStatus");
  if (status) {
    status.hidden = false;
    status.textContent = text;
  }
}

/** 测速进度 UI 的统一起止 */
function beginTest(label) {
  testing = true;
  cancelTest = false;
  const progress = $("testProgress");
  if (progress) progress.hidden = false;
  setBar(0);
  setStatus(label);
  const button = $("btnCheckup");
  if (button) button.textContent = "停止体检";
}

function endTest() {
  testing = false;
  const button = $("btnCheckup");
  if (button) button.textContent = "开始体检";
  setTimeout(() => {
    const progress = $("testProgress");
    if (progress) progress.hidden = true;
  }, 900);
}

/**
 * 测速与能力标注的共用实现。测速结果一次性写入节点状态，
 * 由 store 的串行队列保证并发写不互相覆盖，页面不再维护自己的落盘队列。
 * @param {any[]} list
 * @param {boolean} withSpeed
 * @param {number} base 进度条起点
 * @param {string} label
 */
async function measureAll(list, withSpeed, base = 0, label = "测速") {
  const span = 1 - base;
  const hasFirstPhase = withSpeed && list.length > 20;
  let targets = list;

  if (hasFirstPhase) {
    await runPool(list, 8, async (node, i) => {
      const result = await FGNet.testNode(node.value, settings.speedTestUrl, {
        withSpeed: false,
        withCaps: true,
      });
      await FGStore.updateNode(node.value, {
        stat: { latency: result.latency },
        caps: result.caps,
      });
      setBar(base + ((i + 1) / list.length) * span * 0.45);
      setStatus(`延迟探测 + 能力标注 ${i + 1}/${list.length} · ${node.value}`);
      if (i % 3 === 0) {
        settings = await FGStore.get();
        renderNodes();
      }
    });
    settings = await FGStore.get();
    targets = sortNodes(FGStore.activeNodes(settings)).slice(0, 20);
    setBar(base + span * 0.45);
  }

  let done = 0;
  await runPool(targets, withSpeed ? 5 : 8, async (node) => {
    const result = await FGNet.testNode(node.value, settings.speedTestUrl, {
      withSpeed,
      withCaps: !hasFirstPhase,
    });
    await FGStore.updateNode(node.value, {
      stat: { latency: result.latency, speed: result.speed },
      caps: result.caps,
    });
    done += 1;
    const phaseBase = base + (hasFirstPhase ? span * 0.45 : 0);
    const phaseSpan = hasFirstPhase ? span * 0.55 : span;
    setBar(phaseBase + (done / targets.length) * phaseSpan);
    setStatus(`${label} ${done}/${targets.length} · ${node.value}`);
    if (done % 3 === 0 || done === targets.length) {
      settings = await FGStore.get();
      renderNodes();
    }
  });

  settings = await FGStore.get();
  const counts = { full: 0, download: 0, unknown: 0 };
  for (const node of list) {
    const caps =
      settings.capabilities?.[FGStore.nodeKey(node.value)] ??
      settings.nodeState?.[FGStore.nodeKey(node.value)]?.caps;
    const kind = FGStore.classifyByCaps(caps);
    if (kind === "full") counts.full += 1;
    else if (kind === "download") counts.download += 1;
    else counts.unknown += 1;
  }
  setBar(1);
  renderNodes();
  renderStats();
  return counts;
}

/** 一键体检：同步 → 去重 → 全量测速与自动标注 → 给出结论 */
async function runCheckup() {
  if (!settings) return;
  if (testing) {
    cancelTest = true;
    toast("正在停止体检…", "err");
    return;
  }
  beginTest("正在同步节点仓库…");

  try {
    setBar(0.04);
    const sync = await buildSyncPatch(settings);
    settings = await FGStore.set(sync.patch);
    setStatus(
      sync.ok
        ? `已同步 ${sync.okCount}/${sync.totalSources} 个源，正在去重…`
        : "同步失败，改用已缓存节点继续体检",
    );

    setBar(0.1);
    await dedupeNow(true);
    settings = await FGStore.get();
    refresh({ repos: true });

    const list = FGStore.activeNodes(settings);
    if (!list.length) {
      setStatus("没有可用节点，体检结束");
      toast("没有可用节点", "err");
      return;
    }
    const counts = await measureAll(list, true, 0.12, "体检中");
    const best = FGStore.preferredNode(settings);
    const text = `上次体检 ${fmtTime(Date.now())} · ${list.length} 个节点 · 可加速仓库 ${counts.full} / 仅下载 ${counts.download} / 未判定 ${counts.unknown} · 最优 ${best}`;
    $("checkupSummary").textContent = text;
    settings = await FGStore.set({ lastCheckup: Date.now(), lastCheckupMessage: text });
    setStatus(cancelTest ? "体检已中止" : `体检完成 · ${text}`);
    toast(
      cancelTest ? "体检已中止" : `体检完成 · 最优 ${best}`,
      cancelTest ? "err" : "ok",
    );
  } finally {
    endTest();
  }
}

/** 高级维护：不重新同步，只跑测速 */
async function testNodes(withSpeed) {
  if (!settings) return;
  if (testing) {
    cancelTest = true;
    toast("正在停止测速…", "err");
    return;
  }
  const list = FGStore.activeNodes(settings);
  if (!list.length) {
    toast("没有可用节点", "err");
    return;
  }
  beginTest(withSpeed ? "完整测速中…" : "延迟探测中…");
  try {
    const counts = await measureAll(
      list,
      withSpeed,
      0,
      withSpeed ? "测速" : "延迟探测 + 能力标注",
    );
    setStatus(
      `完成 · 可加速仓库 ${counts.full} / 仅下载 ${counts.download} / 未判定 ${counts.unknown}`,
    );
    toast("测速完成", "ok");
  } finally {
    endTest();
  }
}

async function testOne(value) {
  if (!settings) return;
  const result = await FGNet.testNode(value, settings.speedTestUrl, {
    withSpeed: true,
    withCaps: true,
  });
  settings = await FGStore.updateNode(value, {
    stat: { latency: result.latency, speed: result.speed },
    caps: result.caps,
  });
  renderNodes();
  renderStats();
  const kind = FGStore.classifyByCaps(result.caps);
  const label =
    kind === "full" ? "可加速仓库" : kind === "download" ? "仅下载" : "能力未判定";
  toast(`${value} · ${result.latency} · ${result.speed} · ${label}`, "ok");
}

/* ---------------------------- 白名单规则 ---------------------------- */

function renderRules() {
  const list = settings?.sensitivePaths ?? [];
  $("ruleCount").textContent = String(list.length);

  const container = $("ruleList");
  if (!container) return;

  container.innerHTML =
    list
      .map(
        (rule, index) => `
      <span class="rule-chip" data-index="${index}">
        ${rule}
        <button type="button" data-index="${index}" title="删除规则">×</button>
      </span>`,
      )
      .join("") || '<div class="fg-empty" style="padding:16px">暂无规则</div>';

  const hint = $("ruleHint");
  if (hint) {
    hint.textContent = list.length
      ? "规则即时写入本地并立即生效"
      : "未设置任何规则时，所有 GitHub 页面都可能被自动代理";
  }
}

async function updateRules(next, message) {
  settings = await FGStore.set({ sensitivePaths: next });
  renderRules();
  if (message) toast(message, "ok");
}

async function addRule() {
  const input = /** @type {HTMLInputElement} */ ($("ruleInput"));
  let rule = String(input?.value ?? "").trim();
  if (!rule) return;
  if (!rule.startsWith("/")) rule = `/${rule}`;
  rule = rule.replace(/\/+$/, "");

  const list = settings?.sensitivePaths ?? [];
  if (list.includes(rule)) {
    toast("规则已存在", "err");
    return;
  }
  await updateRules([...list, rule], `已添加规则 ${rule}`);
  if (input) input.value = "";
}

async function removeRule(index) {
  const list = [...(settings?.sensitivePaths ?? [])];
  list.splice(index, 1);
  await updateRules(list);
}

function resetRules() {
  updateRules([...DEFAULT_SENSITIVE_PATHS], "已恢复默认规则");
}

function clearRules() {
  updateRules([], "已清空规则");
}

function checkUrl() {
  const input = /** @type {HTMLInputElement} */ ($("testUrlInput"));
  const url = String(input?.value ?? "").trim();
  const result = $("testUrlResult");
  if (!result) return;
  if (!url) {
    result.innerHTML = '<span style="color:var(--fg-muted)">请输入一个地址</span>';
    return;
  }
  const blocked = matchSensitive(url, settings?.sensitivePaths ?? []);
  result.innerHTML = blocked
    ? '<span class="fg-badge fg-badge-good">受保护 · 不会被自动代理</span>'
    : '<span class="fg-badge fg-badge-mid">未命中 · 失败时会被自动代理</span>';
}

/* ------------------------------ 事件绑定 ------------------------------ */

/** 给输入框绑定「回车执行」 */
function onEnter(id, action) {
  $(id)?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") action();
  });
}

function bind() {
  $("nav")?.addEventListener("click", (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest(".nav-item");
    if (!button) return;
    for (const item of document.querySelectorAll(".nav-item")) {
      item.classList.remove("is-active");
    }
    button.classList.add("is-active");
    const tab = button.getAttribute("data-tab");
    for (const panel of document.querySelectorAll(".tab-panel")) {
      panel.classList.toggle("is-active", panel.getAttribute("data-panel") === tab);
    }
  });

  for (const field of FIELDS) {
    const el = $(field.id);
    if (!el) continue;
    el.addEventListener(field.type === "check" ? "change" : "input", () => {
      const value =
        field.type === "check"
          ? el.checked
          : field.type === "number"
            ? Number(el.value) || 0
            : el.value;
      saveField(field.key, value);
    });
  }
  $("updateSources")?.addEventListener("input", scheduleSourcesSave);

  /** id -> 处理函数，统一绑定 click */
  const clicks = {
    btnCheckup: runCheckup,
    btnMoreRepos: () => {
      showMoreRepos = !showMoreRepos;
      renderRepos();
    },
    btnSyncNow: syncNow,
    btnAddNode: addNode,
    btnTestAll: () => testNodes(true),
    btnTestLatency: () => testNodes(false),
    btnDedupe: () => dedupeNow(false),
    btnProbe: probeHostsNow,
    btnProbeCaps: probeCapsNow,
    btnSelfCheck: selfCheck,
    btnRouteTest: routeCheck,
    btnAddRule: addRule,
    btnResetRules: resetRules,
    btnClearRules: clearRules,
    btnTestUrl: checkUrl,
  };
  for (const [id, action] of Object.entries(clicks)) {
    $(id)?.addEventListener("click", action);
  }

  onEnter("customNodeInput", addNode);
  onEnter("routeTestInput", routeCheck);
  onEnter("selfCheckInput", selfCheck);
  onEnter("ruleInput", addRule);
  onEnter("testUrlInput", checkUrl);

  $("nodeSearch")?.addEventListener("input", renderNodes);
  $("nodeFilter")?.addEventListener("change", renderNodes);

  $("nodeList")?.addEventListener("click", (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest("button[data-act]");
    if (!button) return;
    const value = button.closest(".node-item")?.getAttribute("data-value") ?? "";
    switch (button.getAttribute("data-act")) {
      case "toggle":
        toggleNode(value);
        break;
      case "del":
        deleteNode(value);
        break;
      case "use":
        useNode(value);
        break;
      case "test":
        testOne(value);
        break;
      case "kind-full":
        overrideKind(value, "full");
        break;
      case "kind-download":
        overrideKind(value, "download");
        break;
      case "kind-auto":
        overrideKind(value, null);
        break;
      case "more": {
        const menu = button.parentElement?.querySelector(".node-menu");
        if (menu) menu.hidden = !menu.hidden;
        break;
      }
      default:
        break;
    }
  });

  $("repoList")?.addEventListener("change", (event) => {
    const input = /** @type {HTMLInputElement} */ (event.target);
    const id = input.getAttribute("data-repo");
    if (id) toggleRepo(id, input.checked);
  });

  $("ruleList")?.addEventListener("click", (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest(
      "button[data-index]",
    );
    if (!button) return;
    removeRule(Number(button.getAttribute("data-index")));
  });
}

async function boot() {
  settings = await FGStore.get();
  applyBrowserTheme(settings);
  renderThemeInfo();
  // 其它标签 / 弹窗改了外观设置时，来源说明与表单同步刷新
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    for (const change of Object.values(changes)) {
      const value = change?.newValue;
      if (value && typeof value === "object" && "themeSeed" in value) {
        settings = { ...(settings ?? {}), ...value };
        syncTheme();
        break;
      }
    }
  });
  bind();
  refresh({ repos: true });
  renderProbes();
  renderHealth();
}

boot();
