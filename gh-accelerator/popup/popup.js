/**
 * 弹窗：查看当前节点、切换节点、一键代理当前页。
 * 测速 / 同步 / 能力标注统一收在设置页「一键体检」，此处只保留高频动作。
 */

import { rankNodes } from "../lib/rank.js";
import { FGStore } from "../lib/store.js";
import { applyBrowserTheme } from "../lib/theme.js";
import { fmtLatency, toast } from "../lib/ui.js";

/** @type {import("../lib/store.js").Settings | null} */
let settings = null;
/** @type {chrome.tabs.Tab | null} */
let currentTab = null;

const $ = (/** @type {string} */ id) => document.getElementById(id);

function render() {
  if (!settings) return;
  applyBrowserTheme(settings);
  const enabled = $("enabled");
  if (enabled) enabled.checked = Boolean(settings.enabled);

  const best = FGStore.preferredNode(settings);
  const stat = FGStore.statOf(settings, best);

  const nodeValue = $("nodeValue");
  if (nodeValue) {
    nodeValue.textContent = best || "—";
    nodeValue.title = best ?? "";
  }
  $("strategyTag").textContent = settings.strategy === "manual" ? "手动" : "自动";
  $("nodeLatency").textContent = fmtLatency(stat?.latency)?.text ?? "未测速";
  $("nodeSpeed").textContent = stat?.speed && stat.speed !== "-" ? stat.speed : "未测速";
  $("syncInfo").textContent = settings.lastCheckup
    ? `最近体检：${new Date(settings.lastCheckup).toLocaleString()}`
    : "尚未体检 · 到设置页一键体检";
  $("currentUrl").textContent = currentTab?.url || "无可用页面";
}

async function nextNode() {
  if (!settings) return;
  const list = rankNodes(FGStore.activeNodes(settings), settings);
  if (!list.length) return;

  const current = FGStore.preferredNode(settings);
  const index = list.findIndex((n) => n.value === current);
  const next = list[(index + 1) % list.length];
  settings = await FGStore.set({ strategy: "manual", manualNode: next.value });
  render();
  toast(`已切换到 ${next.value}`, "ok");
}

async function proxyCurrent() {
  if (!currentTab?.url) {
    toast("没有可代理的页面", "err");
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "proxyTab" });
  if (!res?.ok) {
    toast(res?.error || "代理失败", "err");
    return;
  }
  window.close();
}

function bind() {
  $("enabled")?.addEventListener("change", async (event) => {
    const checked = /** @type {HTMLInputElement} */ (event.target).checked;
    settings = await FGStore.set({ enabled: checked });
    toast(checked ? "已启用" : "已停用", "ok");
  });
  $("btnNext")?.addEventListener("click", nextNode);
  $("btnProxy")?.addEventListener("click", proxyCurrent);
  $("btnOptions")?.addEventListener("click", () => chrome.runtime.openOptionsPage());
}

async function boot() {
  settings = await FGStore.get();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab ?? null;
  bind();
  render();
}

boot();
