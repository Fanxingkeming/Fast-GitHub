/**
 * 设置与节点仓库。
 * 被 service worker / options / popup / content script 共用。
 */

import { DEFAULT_NODES, NODES_SOURCE } from "./nodes.js";
import { rankNodes } from "./rank.js";
import { DEFAULT_ENABLED_REPO_IDS, NODE_REPOS } from "./repos.js";

/**
 * @typedef {Object} NodeEntry
 * @property {string} value 节点域名
 * @property {string} label 来源标记
 * @property {boolean} [builtin]
 * @property {boolean} [custom]
 * @property {boolean} [disabled]
 * @property {"full" | "download"} [kind] full=可加速仓库；download=仅下载文件
 * @property {string[]} [sources] 出现在哪些节点仓库
 */

/**
 * @typedef {Object} NodeStat
 * @property {string} [latency] 毫秒字符串或 "timeout"
 * @property {string} [speed] 形如 "8.4 Mbps"
 * @property {number} ts
 */

/**
 * @typedef {Object} Settings
 * @property {boolean} enabled
 * @property {boolean} autoUpdate
 * @property {number} updateIntervalHours
 * @property {string[]} updateSources
 * @property {number} lastUpdate
 * @property {string} lastUpdateMessage
 * @property {boolean} autoProxyOnFailure
 * @property {boolean} protectSensitive
 * @property {string[]} sensitivePaths
 * @property {string} fallbackNode
 * @property {"auto" | "manual"} strategy
 * @property {string} manualNode
 * @property {number} channelCount
 * @property {string} speedTestUrl
 * @property {NodeEntry[]} customNodes
 * @property {NodeEntry[]} remoteNodes
 * @property {string[]} disabledNodes
 * @property {Record<string, NodeStat>} stats
 * @property {Record<string, { range?: boolean; git?: boolean; reachable?: boolean; kind?: "full" | "download" | null; ts?: number }>} capabilities 测速时自动探测的能力结果
 * @property {Record<string, "full" | "download">} nodeKinds 用户手动标注的能力分类
 * @property {"system" | "light" | "dark"} theme
 * @property {boolean} followBrowserColor 主色是否实时跟随浏览器 / 系统主题色
 * @property {string} themeSeed 关闭跟随时使用的自定义主色
 */

const KEY = "fg_settings_v2";
const LEGACY_KEY = "configs";
const LEGACY_LIST_KEY = "customList";

/**
 * 旧版单源机制遗留的默认源，仅用于兼容读取；
 * 现在的同步走 NODE_REPOS 多仓库机制，默认不再附加自定义源（避免重复拉取）。
 * @type {string[]}
 */
export const DEFAULT_SOURCES = [];

/**
 * 默认的登录保护规则（可在设置页编辑）。
 * 支持 `*` 通配，匹配对象为 URL 的 pathname。
 */
export const DEFAULT_SENSITIVE_PATHS = [
  "/login",
  "/login/*",
  "/logout",
  "/session",
  "/session/*",
  "/sessions",
  "/sessions/*",
  "/signup",
  "/join",
  "/password_reset",
  "/settings",
  "/settings/*",
  "/account",
  "/account/*",
  "/notifications",
  "/notifications/*",
  "/apps",
  "/apps/*",
  "/billing",
  "/billing/*",
  "/security",
  "/security/*",
  "/sponsors/*/dashboard",
  "/orgs/*/settings",
  "/orgs/*/settings/*",
  "/orgs/*/people",
  "/orgs/*/teams",
  "/organizations/*/settings",
  "/organizations/*/settings/*",
  "/enterprises/*/settings",
  "/enterprises/*/security",
  "/enterprises/*/billing",
  "/users/*/settings",
];

/** @type {Settings} */
const DEFAULTS = {
  enabled: true,
  autoUpdate: true,
  updateIntervalHours: 24,
  updateSources: DEFAULT_SOURCES,
  lastUpdate: 0,
  lastUpdateMessage: "",
  autoProxyOnFailure: true,
  protectSensitive: true,
  sensitivePaths: DEFAULT_SENSITIVE_PATHS,
  fallbackNode: "gh-proxy.com",
  strategy: "auto",
  manualNode: "",
  channelCount: 3,
  speedTestUrl:
    "https://raw.githubusercontent.com/hubporg/ghproxy-next/main/package-lock.json",
  customNodes: [],
  remoteNodes: [],
  repoEnabled: NODE_REPOS.reduce(
    (acc, repo) => {
      acc[repo.id] = DEFAULT_ENABLED_REPO_IDS.includes(repo.id);
      return acc;
    },
    /** @type {Record<string, boolean>} */ ({}),
  ),
  repoCounts: {},
  disabledNodes: [],
  stats: {},
  routeMode: "auto",
  useJsDelivr: true,
  probes: {},
  capabilities: {},
  usage: {},
  /** 节点能力分类：full = 可加速仓库（支持 clone）；download = 仅下载文件 */
  nodeKinds: {},
  /**
   * 以域名为键的合并状态视图（stat / caps / usage / 手动分类）。
   * 四个旧键保留以兼容既有配置与读取方，所有新写入由 writeNodePatches 同时维护两者。
   */
  nodeState: {},
  /** 智能模式：打开仓库 / 一键代理时只使用可加速仓库的节点 */
  smartKind: true,
  lastCheckup: 0,
  lastCheckupMessage: "",
  theme: "system",
  /** 实时跟随浏览器 / 系统强调色；关闭后使用 themeSeed */
  followBrowserColor: true,
  themeSeed: "#6750a4",
};

/** @template T @param {T} obj @returns {T} */
const clone = (obj) => JSON.parse(JSON.stringify(obj));

/**
 * 域名归一化：统一大小写、去掉协议 / www / 端口 / 路径，
 * 使 `HTTPS://WWW.Gh-Proxy.com/` 与 `gh-proxy.com` 视为同一个节点。
 * @param {string} value
 * @returns {string}
 */
export function nodeKey(value) {
  let host = String(value ?? "")
    .trim()
    .toLowerCase();
  host = host.replace(/^[a-z]+:\/\//i, "");
  host = host.replace(/^www\./, "");
  host = host.split(/[/?#]/)[0];
  host = host.replace(/:\d+$/, "");
  host = host.replace(/^\.+|\.+$/g, "");
  return host;
}

/**
 * @param {Partial<NodeEntry>} node
 * @returns {NodeEntry}
 */
function normalize(node) {
  return {
    value: nodeKey(node?.value),
    label: node?.label ?? "custom",
    builtin: Boolean(node?.builtin),
    custom: Boolean(node?.custom),
    kind: node?.kind,
  };
}

/**
 * 泛化标签：内置节点库统一用这两个词，信息量低于仓库给出的具体名称。
 * 合并时优先保留具体名称。
 */
const GENERIC_LABELS = new Set([
  "contribute",
  "search",
  "remote",
  "custom",
  "builtin",
  "node",
]);

/**
 * @param {string} next
 * @param {string} current
 * @returns {boolean}
 */
function isBetterLabel(next, current) {
  if (!next) return false;
  return !GENERIC_LABELS.has(next) && GENERIC_LABELS.has(current);
}

/**
 * 去重并合并：同 key 的节点合并为一个，来源（sources）取并集
 * @param {Partial<NodeEntry>[]} list
 * @returns {NodeEntry[]}
 */
function dedupe(list) {
  /** @type {Map<string, any>} */
  const map = new Map();

  for (const item of list ?? []) {
    const entry = normalize(item);
    if (!entry.value) continue;

    const sources = new Set([...(item?.sources ?? [])]);
    if (item?.source) sources.add(item.source);

    const prev = map.get(entry.value);
    if (prev) {
      prev.merged += 1;
      for (const source of sources) prev.sources.add(source);
      prev.builtin = prev.builtin || entry.builtin;
      prev.custom = prev.custom || entry.custom;
      // 标签优先取具体名称（内置的 contribute/search 让位给仓库标签）
      if (isBetterLabel(entry.label, prev.label)) prev.label = entry.label;
      // 能力分类：已确定的结论不被泛化值覆盖
      if (entry.kind && (!prev.kind || prev.kind === "full")) prev.kind = entry.kind;
      continue;
    }

    map.set(entry.value, {
      ...entry,
      merged: 0,
      sources,
    });
  }

  return [...map.values()].map((entry) => {
    const { sources, ...rest } = entry;
    return { ...rest, sources: [...sources] };
  });
}

/**
 * 去重统计：用于 UI 展示"合并了多少重复项"
 * @param {Partial<NodeEntry>[]} list
 */
export function mergeStats(list) {
  const items = list ?? [];
  /** @type {Set<string>} */
  const keys = new Set();
  let invalid = 0;
  for (const item of items) {
    const key = nodeKey(item?.value);
    if (!key) invalid += 1;
    else keys.add(key);
  }
  const unique = keys.size;
  return {
    total: items.length,
    unique,
    merged: Math.max(0, items.length - invalid - unique),
    invalid,
  };
}

/**
 * 用某个仓库的最新节点替换列表中同来源的旧数据。
 *
 * 节点可能已被去重合并（sources 含多个仓库）。此时：
 * - 先把该节点从旧列表移除，并把「除本仓库外的其他来源」记录下来；
 * - 若本仓库的新清单仍收录它，把其他来源一并写回新条目（sources 不丢）；
 * - 若本仓库已下架它但其他仓库仍收录，则按剩余来源保留，避免节点被误删。
 * @param {{ source?: string; sources?: string[]; value: string; label?: string }[]} list
 * @param {string} repoId
 * @param {{ value: string; label?: string }[]} nodes
 */
export function replaceRepoNodes(list, repoId, nodes) {
  /** @type {Map<string, { sources: string[]; label?: string }>} */
  const carry = new Map();
  /** @type {any[]} */
  const others = [];

  for (const item of list ?? []) {
    const sources = item?.sources ?? [];
    if (item?.source === repoId) continue; // 单来源节点：整体替换
    if (sources.includes(repoId)) {
      const rest = sources.filter((s) => s !== repoId);
      if (rest.length) carry.set(item.value, { sources: rest, label: item.label });
      continue;
    }
    others.push(item);
  }

  /** @type {Set<string>} */
  const freshKeys = new Set();
  const fresh = (nodes ?? []).map((item) => {
    const value = nodeKey(item?.value);
    freshKeys.add(value);
    const extra = carry.get(value);
    return {
      value,
      label: item?.label ?? "remote",
      source: repoId,
      ...(extra ? { sources: [...extra.sources] } : {}),
    };
  });

  // 本仓库下架、但其他仓库仍收录的节点：按剩余来源保留
  for (const [value, info] of carry) {
    if (freshKeys.has(value)) continue;
    others.push({
      value,
      label: info.label ?? "remote",
      sources: info.sources,
      source: info.sources[0],
    });
  }

  return [...others, ...fresh];
}

/** 启用的节点仓库（默认只启用互补的 3 个；旧配置里显式 true 的仍保持启用） */
export function enabledRepos(settings) {
  const enabled = settings?.repoEnabled ?? {};
  return NODE_REPOS.filter((repo) => enabled[repo.id] === true);
}

/**
 * 内置 + 远端 + 自定义 合并后的完整节点表
 * @param {Settings} [settings]
 * @returns {NodeEntry[]}
 */
export function allNodes(settings) {
  const s = settings ?? DEFAULTS;
  const builtin = DEFAULT_NODES.map((n) => ({ ...n, builtin: true, source: "builtin" }));
  const remote = (s.remoteNodes ?? []).map((n) => ({ ...n, builtin: true }));
  const custom = (s.customNodes ?? []).map((n) => ({
    ...n,
    custom: true,
    label: "custom",
  }));
  const disabled = new Set(s.disabledNodes ?? []);
  return dedupe([...builtin, ...remote, ...custom]).map((n) => ({
    ...n,
    disabled: disabled.has(n.value),
  }));
}

/**
 * @param {Settings} [settings]
 * @returns {NodeEntry[]}
 */
export function activeNodes(settings) {
  return allNodes(settings).filter((n) => !n.disabled);
}

/**
 * @param {Settings} settings
 * @param {string} value
 * @returns {NodeStat | null}
 */
export function statOf(settings, value) {
  return settings?.stats?.[value] ?? settings?.nodeState?.[nodeKey(value)]?.stat ?? null;
}

/**
 * @typedef {Object} UsageStat
 * @property {number} total
 * @property {number} ok
 * @property {number} fail
 * @property {number} avgMs
 * @property {boolean} [lastOk]
 * @property {number} [ts]
 */

/**
 * 节点健康度（基于真实使用记录）
 * @param {Settings} settings
 * @param {string} value
 */
/** 读取某节点的使用统计，兼容合并视图 */
function usageOf(settings, value) {
  return settings?.usage?.[value] ?? settings?.nodeState?.[nodeKey(value)]?.usage ?? null;
}

export function healthOf(settings, value) {
  const usage = usageOf(settings, value);
  if (!usage?.total) {
    return { score: null, label: "暂无数据", failRate: 0, uses: 0, avgMs: 0 };
  }
  const failRate = usage.fail / usage.total;
  const score = Math.round((1 - failRate) * 100);
  const label = score >= 90 ? "良好" : score >= 60 ? "一般" : "偏差";
  return { score, label, failRate, uses: usage.total, avgMs: usage.avgMs ?? 0 };
}

/**
 * 节点状态的唯一写入口：一次读取、一次写回，并使用串行队列避免并发覆盖。
 * 四个旧键与 nodeState 在同一次事务里同步更新，调用方无需自行排队。
 * @param {Record<string, { stat?: any; caps?: any; kind?: "full" | "download" | null; usageEvent?: { ok: boolean; ms: number } }>} entries
 * @returns {Promise<Settings>}
 */
let writeQueue = Promise.resolve();
export function writeNodePatches(entries) {
  const run = async () => {
    const settings = await get();
    const stats = { ...(settings.stats ?? {}) };
    const capabilities = { ...(settings.capabilities ?? {}) };
    const usage = { ...(settings.usage ?? {}) };
    const nodeKinds = { ...(settings.nodeKinds ?? {}) };
    const nodeState = { ...(settings.nodeState ?? {}) };
    const ts = Date.now();

    for (const [raw, patch] of Object.entries(entries ?? {})) {
      const key = nodeKey(raw);
      if (!key) continue;
      const state = { ...(nodeState[key] ?? {}), ts };

      if (patch.stat) {
        const stat = {
          ...(stats[key] ?? {}),
          ...patch.stat,
          ts,
        };
        stats[key] = stat;
        state.stat = stat;
      }
      if (patch.caps) {
        const caps = { ...patch.caps, kind: classifyByCaps(patch.caps), ts };
        capabilities[key] = caps;
        state.caps = caps;
      }
      if (patch.kind === "full" || patch.kind === "download") {
        nodeKinds[key] = patch.kind;
        state.kind = patch.kind;
        state.kindSource = "manual";
      } else if (patch.kind === null) {
        delete nodeKinds[key];
        delete state.kind;
        delete state.kindSource;
      }
      if (patch.usageEvent) {
        const prev = usage[key] ?? { total: 0, ok: 0, fail: 0, avgMs: 0 };
        const total = prev.total + 1;
        const next = {
          total,
          ok: prev.ok + (patch.usageEvent.ok ? 1 : 0),
          fail: prev.fail + (patch.usageEvent.ok ? 0 : 1),
          avgMs: Math.round(
            ((prev.avgMs ?? 0) * prev.total + (patch.usageEvent.ms ?? 0)) / total,
          ),
          lastOk: Boolean(patch.usageEvent.ok),
          ts,
        };
        usage[key] = next;
        state.usage = next;
      }
      nodeState[key] = state;
    }

    return await set({ stats, capabilities, usage, nodeKinds, nodeState });
  };

  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
}

/**
 * 单节点状态写入（测速 / 能力探测 / 使用记录 / 手动分类统一走这里）。
 * @param {string} value
 * @param {{ stat?: any; caps?: any; kind?: "full" | "download" | null; usageEvent?: { ok: boolean; ms: number } }} patch
 */
export function updateNode(value, patch) {
  return writeNodePatches({ [value]: patch });
}

/**
 * 记录一次真实下载结果，用于健康度评分
 * @param {string} value
 * @param {boolean} ok
 * @param {number} [ms]
 */
export function recordUsage(value, ok, ms) {
  return updateNode(value, { usageEvent: { ok: Boolean(ok), ms: Number(ms) || 0 } });
}

/**
 * 按评分排序的可用节点（带宽高 → 延迟低 → 失败率低的优先）。
 * bestNode 取首个，channels 取前 N 个，页面列表也复用同一套排序。
 * @param {Settings} s
 */
function rankedNodes(s) {
  return rankNodes(activeNodes(s), s);
}

/**
 * 当前最优节点
 * @param {Settings} [settings]
 * @returns {string}
 */
export function bestNode(settings, kind) {
  const s = settings ?? DEFAULTS;
  if (s.strategy === "manual" && s.manualNode) return s.manualNode;

  let list = rankedNodes(s);
  // 智能模式：打开仓库 / 一键代理只允许使用「可加速仓库」的节点
  if (kind) {
    const filtered = list.filter((n) => kindOf(s, n.value) === kind);
    if (filtered.length) list = filtered;
  }
  if (!list.length) return s.fallbackNode || "gh-proxy.com";

  // 全新安装（无任何测速数据）时优先用兜底节点
  const hasStats = list.some((n) => n.stat);
  if (!hasStats && list.some((n) => n.value === s.fallbackNode)) {
    return s.fallbackNode;
  }
  return list[0].value;
}

/** 页面代理 / 展示用的首选节点：智能模式开启时自动过滤掉仅下载节点 */
export function preferredNode(settings) {
  const s = settings ?? DEFAULTS;
  return bestNode(s, s.smartKind === true ? "full" : undefined);
}

/**
 * 由能力探测信号派生节点分类（纯函数，无副作用、不读存储）。
 * - 支持 git smart HTTP → `full`（可加速仓库 / 可直接打开仓库）
 * - 探测有响应但不支持 git → `download`（仅下载文件）
 * - 两次探测都没有响应 → `null`（节点不可达，保留原分类，不误标）
 *
 * 兼容旧数据：没有 `reachable` 字段时用 `range` 作为「探测有响应」的依据。
 * @param {{ range?: boolean; git?: boolean; reachable?: boolean } | null | undefined} caps
 * @returns {"full" | "download" | null}
 */
export function classifyByCaps(caps) {
  if (!caps || typeof caps !== "object") return null;
  if (caps.git === true) return "full";
  const reachable =
    typeof caps.reachable === "boolean" ? caps.reachable : caps.range === true;
  if (caps.git === false && reachable) return "download";
  return null;
}

/**
 * 节点能力分类。
 * - `full`：可加速仓库（支持 clone / git smart HTTP）
 * - `download`：仅下载文件（raw / release / archive），不能加速仓库
 *
 * 判定优先级：用户手动标注 > 测速时自动探测 > 节点自带分类（来自仓库清单）> 默认 full
 * @param {Settings} [settings]
 * @param {string} value
 * @returns {"full" | "download"}
 */
export function kindOf(settings, value) {
  const s = settings ?? DEFAULTS;
  const key = nodeKey(value);
  const state = s.nodeState?.[key];
  const manual =
    s.nodeKinds?.[key] ?? (state?.kindSource === "manual" ? state?.kind : undefined);
  if (manual === "full" || manual === "download") return manual;
  // 测速时自动探测的结果优先于仓库清单分类（清单可能过时）
  const auto = classifyByCaps(s.capabilities?.[key] ?? state?.caps);
  if (auto) return auto;
  // 节点自带分类（仓库清单给出，合并时 download 优先）
  const node = allNodes(s).find((n) => n.value === key);
  if (node?.kind === "download") return "download";
  return "full";
}

/**
 * 分类来源，用于设置页区分「测速自动标注」与「手动标注」。
 * @param {Settings} [settings]
 * @param {string} value
 * @returns {"manual" | "auto" | "repo" | "default"}
 */
export function kindSource(settings, value) {
  const s = settings ?? DEFAULTS;
  const key = nodeKey(value);
  const state = s.nodeState?.[key];
  const manual =
    s.nodeKinds?.[key] ?? (state?.kindSource === "manual" ? state?.kind : undefined);
  if (manual === "full" || manual === "download") return "manual";
  if (classifyByCaps(s.capabilities?.[key] ?? state?.caps)) return "auto";
  const node = allNodes(s).find((n) => n.value === key);
  if (node?.kind === "download") return "repo";
  return "default";
}

/**
 * 设置节点能力分类（手动标注）
 * @param {string} value
 * @param {"full" | "download"} kind
 */
export function setNodeKind(value, kind) {
  const next = kind === "full" || kind === "download" ? kind : null;
  return updateNode(value, { kind: next });
}

/**
 * 首页展示的通道列表。
 * @param {Settings} [settings]
 * @param {number} [count]
 * @param {"full" | "download"} [kind] 只返回该能力的节点；不传则不限
 * @returns {string[]}
 */
export function channels(settings, count, kind) {
  const s = settings ?? DEFAULTS;
  const n = Math.max(1, Math.min(count ?? s.channelCount ?? 3, 10));
  let list = rankedNodes(s);
  if (kind) list = list.filter((item) => kindOf(s, item.value) === kind);
  if (!list.length) {
    // 没有符合能力的节点时退化为不限能力，避免无通道可用
    list = rankedNodes(s);
  }
  if (!list.length) return [s.fallbackNode || "gh-proxy.com"];
  return list.slice(0, n).map((item) => item.value);
}

/**
 * 构造代理地址 `https://<node>/<原始URL>`
 * @param {string} node
 * @param {string} target
 */
export function buildProxyUrl(node, target) {
  const base = String(node ?? "").replace(/\/+$/, "");
  return /^https?:\/\//i.test(base) ? `${base}/${target}` : `https://${base}/${target}`;
}

/**
 * glob（支持 `*`）转正则
 * @param {string} pattern
 */
export function globToRegExp(pattern) {
  const escaped = String(pattern ?? "")
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * 地址是否命中保护规则
 * @param {string} url
 * @param {string[]} patterns
 */
export function matchSensitive(url, patterns) {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return (patterns ?? []).some((p) => {
    if (!p?.trim()) return false;
    try {
      return globToRegExp(p).test(pathname);
    } catch {
      return false;
    }
  });
}

/** @returns {Promise<Settings | null>} */
export async function raw() {
  const result = await chrome.storage.local.get(KEY);
  return /** @type {Settings | null} */ (result[KEY] ?? null);
}

/** 读取设置；首次运行时迁移旧版配置 */
export async function get() {
  const stored = await raw();
  /** @type {Settings} */
  const settings = { ...clone(DEFAULTS), ...(stored ?? {}) };

  if (!stored) {
    const legacy = await chrome.storage.sync.get([LEGACY_KEY, LEGACY_LIST_KEY]);
    const old = /** @type {any} */ (legacy[LEGACY_KEY]);
    const oldList = /** @type {string[]} */ (legacy[LEGACY_LIST_KEY] ?? []);

    /** @type {Partial<NodeEntry>[]} */
    let migrated = oldList
      .map((v) => ({ value: String(v).replace(/github_proxy/g, "") }))
      .filter((n) => n.value);

    if (old?.speedList) {
      migrated = dedupe([
        ...migrated,
        ...String(old.speedList)
          .split("\n")
          .map((v) => ({ value: v.trim() }))
          .filter((n) => n.value),
      ]);
    }
    if (migrated.length) settings.customNodes = /** @type {NodeEntry[]} */ (migrated);

    await chrome.storage.local.set({ [KEY]: settings });
  }
  return settings;
}

/**
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
export async function set(patch) {
  const current = await get();
  const next = { ...current, ...(patch ?? {}) };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/**
 * @param {string} value
 * @param {string} [latency]
 * @param {string} [speed]
 */
export function saveStat(value, latency, speed) {
  /** @type {Record<string, string>} */
  const stat = {};
  // 未提供的字段保持上一次结果（测延迟与测带宽分两阶段写入）
  if (latency !== null && latency !== undefined) stat.latency = String(latency);
  if (speed !== null && speed !== undefined) stat.speed = String(speed);
  return updateNode(value, { stat });
}

/**
 * 批量写入「测速时自动探测」的能力结果，供 kindOf / kindSource 使用。
 * 只写 capabilities，不碰 nodeKinds（手动标注），因此用户可以随时手动覆盖自动结果。
 * @param {Record<string, { range?: boolean; git?: boolean; reachable?: boolean } | null>} entries
 * @returns {Promise<Settings>}
 */
export function saveCapabilities(entries) {
  /** @type {Record<string, { caps: any }>} */
  const batch = {};
  for (const [value, caps] of Object.entries(entries ?? {})) {
    if (!caps) continue;
    batch[value] = { caps };
  }
  return writeNodePatches(batch);
}

export const FGStore = {
  KEY,
  DEFAULTS,
  NODES_SOURCE,
  DEFAULT_SOURCES,
  DEFAULT_SENSITIVE_PATHS,
  NODE_REPOS,
  get,
  nodeKey,
  mergeStats,
  replaceRepoNodes,
  enabledRepos,
  set,
  raw,
  allNodes,
  activeNodes,
  statOf,
  bestNode,
  preferredNode,
  channels,
  buildProxyUrl,
  matchSensitive,
  globToRegExp,
  saveStat,
  saveCapabilities,
  writeNodePatches,
  updateNode,
  dedupe,
  normalize,
  healthOf,
  recordUsage,
  classifyByCaps,
  kindOf,
  kindSource,
  setNodeKind,
};
