/**
 * 去重合并回归测试：验证修复后「去重写回 -> 再次同步」不再产生重复节点。
 * 同时对照旧写法，证明该 bug 修复前必现。
 *
 * 用法：node tools/test_dedupe_fix.mjs
 */
globalThis.chrome = {
  storage: {
    local: { get: async () => ({}), set: async () => {} },
    sync: { get: async () => ({}) },
  },
};

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { FGStore } = await import(
  "file:///" +
    path
      .join(__dirname, "..", "gh-accelerator", "lib", "store.js")
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
);

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

// 三个仓库都收录 gh-proxy.com（写法不一），另有各自独有节点
const ghproxyNext = [
  { value: "gh-proxy.com", label: "GH-Proxy" },
  { value: "ghfast.top", label: "GHFast" },
  { value: "ghproxy.net", label: "GHProxy" },
];
const adss = [
  { value: "https://gh-proxy.com/", label: "remote" },
  { value: "www.ghfast.top", label: "remote" },
  { value: "cdn.gh-proxy.com", label: "remote" },
];
const githubFast = [
  { value: "HTTPS://WWW.Gh-Proxy.com", label: "remote" },
  { value: "gh.dpik.top", label: "remote" },
];

console.log("[1] 多仓库同步");
let nodes = [];
nodes = FGStore.replaceRepoNodes(nodes, "ghproxy-next", ghproxyNext);
nodes = FGStore.replaceRepoNodes(nodes, "adss", adss);
nodes = FGStore.replaceRepoNodes(nodes, "github-fast", githubFast);
check("同步后共 8 条原始记录", nodes.length === 8, `${nodes.length} 条`);

console.log("\n[2] 立即去重合并（保留 sources 写回）");
const deduped = FGStore.dedupe(nodes).map((n) => ({
  value: n.value,
  label: n.label,
  sources: n.sources ?? [],
  source: (n.sources ?? [])[0] ?? "remote",
}));
check("去重后 5 条", deduped.length === 5, `${deduped.length} 条`);
const gp = deduped.find((n) => n.value === "gh-proxy.com");
check("gh-proxy.com 的 sources 含 3 个仓库", gp?.sources?.length === 3, JSON.stringify(gp?.sources));
check("gh-proxy.com 保留具体标签", gp?.label === "GH-Proxy", gp?.label);

console.log("\n[3] 关键回归：去重写回后再次同步");
const afterResync = FGStore.replaceRepoNodes(deduped, "adss", adss);
check(
  "再次同步后 gh-proxy.com 仍只有 1 条",
  afterResync.filter((n) => n.value === "gh-proxy.com").length === 1,
  `${afterResync.filter((n) => n.value === "gh-proxy.com").length} 条`,
);
check("再次同步后总条数不增长", afterResync.length === 5, `${afterResync.length} 条`);
const gpAfter = afterResync.find((n) => n.value === "gh-proxy.com");
const origins = new Set([gpAfter?.source, ...(gpAfter?.sources ?? [])]);
check(
  "再次同步后 3 个来源都在",
  origins.size === 3 && origins.has("adss") && origins.has("ghproxy-next") && origins.has("github-fast"),
  JSON.stringify([...origins]),
);

console.log("\n[4] 仓库下架节点时的保留行为");
const afterDrop = FGStore.replaceRepoNodes(deduped, "adss", [
  { value: "cdn.gh-proxy.com", label: "remote" },
]);
check(
  "adss 下架 gh-proxy.com 后，其他仓库来源仍保留它",
  afterDrop.filter((n) => n.value === "gh-proxy.com").length === 1,
  `${afterDrop.filter((n) => n.value === "gh-proxy.com").length} 条`,
);
check(
  "保留时的来源为 ghproxy-next + github-fast",
  new Set([...(afterDrop.find((n) => n.value === "gh-proxy.com")?.sources ?? [])]).size === 2,
  JSON.stringify(afterDrop.find((n) => n.value === "gh-proxy.com")?.sources),
);

console.log("\n[5] 对照：旧写法（只留单 source）必现重复");
const legacy = FGStore.dedupe(nodes).map((n) => ({
  value: n.value,
  label: n.label,
  source: (n.sources ?? [])[0],
}));
const legacyResync = FGStore.replaceRepoNodes(legacy, "adss", adss);
check(
  "旧写法再次同步后 gh-proxy.com 变 2 条",
  legacyResync.filter((n) => n.value === "gh-proxy.com").length === 2,
  `${legacyResync.filter((n) => n.value === "gh-proxy.com").length} 条`,
);

console.log("\n[6] 标签优先级与 allNodes 一致性");
const s = { ...FGStore.DEFAULTS, remoteNodes: nodes };
const all = FGStore.allNodes(s);
check("allNodes 中标签为具体名称", all.find((n) => n.value === "gh-proxy.com")?.label === "GH-Proxy");
check("allNodes 中 gh-proxy.com 只出现一次", all.filter((n) => n.value === "gh-proxy.com").length === 1);
check("allNodes 总数 = 内置 + 去重后新增", all.length === 81 + 0, `${all.length} 个`);

console.log("\n" + (fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ 失败 ${fail} 项`));
process.exit(fail ? 1 : 0);
