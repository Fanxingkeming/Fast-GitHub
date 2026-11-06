/**
 * 测速自动标注能力分类 —— 回归测试
 *
 * 覆盖：
 *   1) classifyByCaps / shouldProbeCaps 纯函数的确定性规则
 *   2) probeCapabilities 的 reachable 信号（区分「仅下载」与「节点不可达」）
 *   3) testNode(withCaps) 在同一次测速里返回能力结果，且默认调用结构不变
 *   4) saveCapabilities 批量写入、归一化、不污染手动标注
 *   5) kindOf / kindSource 优先级：手动 > 自动 > 清单 > 默认
 *   6) channels("full") 会排除自动标注为仅下载的节点
 *
 * 用法：node tools/test_auto_kind.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/* ---------------------------- mock chrome ---------------------------- */

const memory = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys)) {
          const out = {};
          for (const k of keys) out[k] = memory.get(k);
          return out;
        }
        if (keys && typeof keys === "object") {
          const out = {};
          for (const k of Object.keys(keys)) out[k] = memory.get(k);
          return out;
        }
        return { [keys]: memory.get(keys) };
      },
      async set(obj) {
        for (const [k, v] of Object.entries(obj)) {
          memory.set(k, JSON.parse(JSON.stringify(v)));
        }
      },
    },
    sync: { async get() { return {}; } },
  },
};

/* ------------------------------ mock fetch ------------------------------ */

const GIT_HOSTS = new Set(["git-ok.example"]);
const RANGE_HOSTS = new Set(["git-ok.example"]);
const DEAD_HOSTS = new Set(["dead.example"]);

/** @param {number} status @param {string} body @param {Record<string,string>} headers */
function makeRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
    async text() { return body; },
    async arrayBuffer() { return new ArrayBuffer(body.length || 1024); },
  };
}

globalThis.fetch = async (url, init) => {
  const target = String(url ?? "");
  let host = "";
  try { host = new URL(target).hostname; } catch { /* 忽略非法 URL */ }
  if (DEAD_HOSTS.has(host)) throw new Error("network down");
  if (init?.method === "HEAD") return makeRes(200, "");
  if (target.includes(".git/info/refs")) {
    return GIT_HOSTS.has(host)
      ? makeRes(200, "001e# service=git-upload-pack\nrefs/heads/main\n")
      : makeRes(404, "not a git endpoint");
  }
  if (target.includes("/README.md")) {
    return RANGE_HOSTS.has(host)
      ? makeRes(206, "hello", { "content-range": "bytes 0-127/1000" })
      : makeRes(200, "hello");
  }
  return makeRes(200, "x".repeat(1024));
};

/* ------------------------------ 加载模块 ------------------------------ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const asFileUrl = (...parts) =>
  "file:///" + path.join(__dirname, "..", ...parts).replace(/\\/g, "/").replace(/^\/+/, "");

const { FGStore } = await import(asFileUrl("gh-accelerator", "lib", "store.js"));
const { FGNet } = await import(asFileUrl("gh-accelerator", "lib", "net.js"));

let pass = 0;
let fail = 0;
const check = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? "  -> " + detail : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
};

/* --------------------- [1] classifyByCaps 纯函数 --------------------- */

console.log("\n[1] 能力信号 -> 分类（纯函数）");
const C = FGStore.classifyByCaps;
check("git 支持 => 可加速仓库", C({ range: false, git: true, reachable: true }) === "full");
check("git 优先于 reachable=false", C({ range: false, git: true, reachable: false }) === "full");
check("有响应但不支持 git => 仅下载", C({ range: false, git: false, reachable: true }) === "download");
check("两次探测都无响应 => 不标注", C({ range: false, git: false, reachable: false }) === null);
check("旧数据无 reachable、range=true => 仅下载", C({ range: true, git: false }) === "download");
check("旧数据无 reachable、range=false => 不标注", C({ range: false, git: false }) === null);
check("null / undefined => 不标注", C(null) === null && C(undefined) === null);
check("空对象 => 不标注", C({}) === null);
check("同输入恒定同输出（无副作用）", C({ git: true }) === C({ git: true }));

/* --------------------- [2] shouldProbeCaps --------------------- */

console.log("\n[2] 只有可达节点才做能力探测");
const P = FGNet.shouldProbeCaps;
check("正常延迟 => 探测", P("123") === true && P("0") === true);
check("timeout => 不探测", P("timeout") === false);
check("null / undefined / 空串 => 不探测", P(null) === false && P(undefined) === false && P("") === false);

/* --------------------- [3] probeCapabilities --------------------- */

console.log("\n[3] 能力探测信号");
const capsGit = await FGNet.probeCapabilities("git-ok.example", 1000);
const capsDl = await FGNet.probeCapabilities("dl-only.example", 1000);
const capsDead = await FGNet.probeCapabilities("dead.example", 1000);
check(
  "git 节点：range + git + reachable",
  capsGit.range === true && capsGit.git === true && capsGit.reachable === true,
  JSON.stringify(capsGit),
);
check(
  "仅下载节点：有响应但不支持 git",
  capsDl.git === false && capsDl.reachable === true,
  JSON.stringify(capsDl),
);
check(
  "不可达节点：reachable=false",
  capsDead.git === false && capsDead.reachable === false,
  JSON.stringify(capsDead),
);
check("不可达节点不会被误标为仅下载", C(capsDead) === null);
check("仅下载节点被标为 download", C(capsDl) === "download");

/* --------------------- [4] testNode(withCaps) --------------------- */

console.log("\n[4] 测速同次调用完成能力探测");
const plain = await FGNet.testNode("git-ok.example", "https://example.com/f.bin", { withSpeed: false });
const withCaps = await FGNet.testNode("git-ok.example", "https://example.com/f.bin", {
  withSpeed: false,
  withCaps: true,
});
const deadTest = await FGNet.testNode("dead.example", "https://example.com/f.bin", {
  withSpeed: false,
  withCaps: true,
});
check("默认调用返回结构不含 caps（向后兼容）", !("caps" in plain), JSON.stringify(plain));
check("withCaps 返回能力结果", withCaps.caps?.git === true, JSON.stringify(withCaps.caps));
check("withCaps 结果可直接派生 full", C(withCaps.caps) === "full");
check("超时节点 latency=timeout 且 caps=null", deadTest.latency === "timeout" && deadTest.caps === null);

/* --------------------- [5] saveCapabilities --------------------- */

console.log("\n[5] 自动标注写入存储");
await FGStore.set({
  nodeKinds: { "manual.example": "download" },
  capabilities: { "old.example": { range: false, git: false, reachable: false } },
});
await FGStore.saveCapabilities({
  "git-ok.example": capsGit,
  "dl-only.example": capsDl,
  "HTTPS://WWW.Normalized.example/": capsDl,
  "manual.example": capsGit, // 自动结果不应改动 nodeKinds
  "skip.example": null,
});
const stored = await FGStore.get();
check("写入 4 个有效结果（跳过 null）", Object.keys(stored.capabilities).length === 5,
  Object.keys(stored.capabilities).join(","));
check("派生 kind 一并落盘", stored.capabilities["git-ok.example"].kind === "full"
  && stored.capabilities["dl-only.example"].kind === "download");
check(
  "不可达结果不产生任何分类标签",
  stored.capabilities["old.example"].kind === undefined &&
    C(stored.capabilities["old.example"]) === null,
  JSON.stringify(stored.capabilities["old.example"]),
);
check("域名归一化写入", Boolean(stored.capabilities["normalized.example"]),
  Object.keys(stored.capabilities).join(","));
check("带 ts 时间戳", typeof stored.capabilities["git-ok.example"].ts === "number");
check("保留原有 capabilities 条目", Boolean(stored.capabilities["old.example"]));
check("不污染手动标注字段", stored.nodeKinds["manual.example"] === "download"
  && Object.keys(stored.nodeKinds).length === 1);

/* --------------------- [6] kindOf / kindSource 优先级 --------------------- */

console.log("\n[6] 分类来源优先级");
const base = await FGStore.set({
  customNodes: [
    { value: "repo-dl.example", label: "c", kind: "download" },
    { value: "repo-full.example", label: "c", kind: "full" },
  ],
  nodeKinds: {},
  capabilities: {},
});
check("清单自带 kind 能被 allNodes 读到",
  FGStore.allNodes(base).some((n) => n.value === "repo-dl.example" && n.kind === "download"));

const autoFull = { ...base, capabilities: { "repo-dl.example": { git: true, reachable: true } } };
const autoDl = { ...base, capabilities: { "repo-full.example": { git: false, reachable: true } } };
const autoDead = { ...base, capabilities: { "repo-dl.example": { git: false, reachable: false } } };
const manual = {
  ...autoFull,
  nodeKinds: { "repo-dl.example": "download" },
};

check("清单标记 download 的节点默认仅下载", FGStore.kindOf(base, "repo-dl.example") === "download");
check("无分类节点默认可加速仓库", FGStore.kindOf(base, "repo-full.example") === "full");
check("自动探测 full 覆盖清单 download", FGStore.kindOf(autoFull, "repo-dl.example") === "full");
check("自动探测 download 覆盖清单 full", FGStore.kindOf(autoDl, "repo-full.example") === "download");
check("不可达探测不改变清单分类", FGStore.kindOf(autoDead, "repo-dl.example") === "download");
check("手动标注优先于自动探测", FGStore.kindOf(manual, "repo-dl.example") === "download");
check("kindSource: manual", FGStore.kindSource(manual, "repo-dl.example") === "manual");
check("kindSource: auto", FGStore.kindSource(autoFull, "repo-dl.example") === "auto");
check("kindSource: repo", FGStore.kindSource(base, "repo-dl.example") === "repo");
check("kindSource: default", FGStore.kindSource(base, "repo-full.example") === "default");
check("kindSource: 不可达不产生 auto 来源", FGStore.kindSource(autoDead, "repo-dl.example") === "repo");

/* --------------------- [7] channels 过滤 --------------------- */

console.log("\n[7] 通道按自动标注结果过滤");
const dlNode = "repo-dl.example";
const scored = {
  ...autoDl,
  // 给这个节点最优测速分数：若过滤失效，它必然排进前 10（避免假阴性）
  stats: { [dlNode]: { latency: "1", speed: "999 Mbps", ts: Date.now() } },
  channelCount: 10,
};
const fullChannels = FGStore.channels(scored, 10, "full");
const dlChannels = FGStore.channels(scored, 10, "download");
check("自动标为仅下载的节点不进入可加速通道", !fullChannels.includes(dlNode),
  `full=${fullChannels.length} 条`);
check("自动标为仅下载的节点出现在下载通道", dlChannels.includes(dlNode),
  `download=${dlChannels.length} 条`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
