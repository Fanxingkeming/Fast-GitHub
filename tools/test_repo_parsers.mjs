/**
 * 用真实网络数据测试 8 个节点仓库的清单解析与能力分类。
 * 用法：node tools/test_repo_parsers.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.join(__dirname, "..");

const { NODE_REPOS } = await import(
  "file:///" +
    path.join(BASE, "gh-accelerator", "lib", "repos.js").replace(/\\/g, "/").replace(/^\/+/, "")
);
const { FGNet } = await import(
  "file:///" +
    path.join(BASE, "gh-accelerator", "lib", "net.js").replace(/\\/g, "/").replace(/^\/+/, "")
);
const { FGStore } = await import(
  "file:///" +
    path.join(BASE, "gh-accelerator", "lib", "store.js").replace(/\\/g, "/").replace(/^\/+/, "")
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

console.log("=== 逐个仓库拉取并解析（真实网络） ===\n");
const allNodes = [];
for (const repo of NODE_REPOS) {
  const result = await FGNet.fetchRemoteNodes(repo.mirrors, 20000, repo.parser);
  if (!result.ok) {
    check(`${repo.id} 拉取成功`, false, result.error.slice(0, 80));
    continue;
  }
  const hosts = result.nodes.map((n) => n.value);
  const unique = new Set(hosts).size;
  const kinds = result.nodes.reduce((acc, n) => {
    const k = n.kind ?? "full";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
  check(`${repo.id} 解析出节点`, unique >= 2, `${unique} 个（${repo.parser}）`);
  check(
    `${repo.id} 有域名格式`,
    hosts.every((h) => /^[a-z0-9\u4e00-\u9fa5.-]+\.[a-z\u4e00-\u9fa5]{2,}$/i.test(h)),
    hosts.find((h) => !/^[a-z0-9\u4e00-\u9fa5.-]+\.[a-z\u4e00-\u9fa5]{2,}$/i.test(h)) ?? "",
  );
  console.log(
    `        full=${kinds.full ?? 0} download=${kinds.download ?? 0}  样例: ${hosts
      .slice(0, 3)
      .join(", ")}`,
  );
  allNodes.push(...result.nodes);
}

console.log("\n=== 汇总 ===");
const uniqueAll = [...new Set(allNodes.map((n) => n.value))];
check("8 个仓库共解析出节点", allNodes.length > 50, `${allNodes.length} 条 / 去重 ${uniqueAll.length} 个`);
check("覆盖下载专用与可加速两类", allNodes.some((n) => n.kind === "download"));

// 已知 CDN 必须被判为 download
const cdn = allNodes.find((n) => n.value.includes("jsdelivr"));
if (cdn) {
  check("jsDelivr 被判为下载专用", cdn.kind === "download", cdn.value);
}

// kindOf 判定
const settings = { ...FGStore.DEFAULTS, remoteNodes: allNodes.map((n) => ({ ...n })) };
const fullCount = uniqueAll.filter((h) => FGStore.kindOf(settings, h) === "full").length;
const dlCount = uniqueAll.filter((h) => FGStore.kindOf(settings, h) === "download").length;
console.log(`\n        kindOf 分类：full=${fullCount}  download=${dlCount}`);
check("kindOf 能区分两类", fullCount > 0 && dlCount > 0);

// channels 按能力过滤
const fullChannels = FGStore.channels(settings, 5, "full");
check("channels 可按 full 过滤", fullChannels.length > 0, fullChannels.slice(0, 3).join(", "));
check(
  "full 通道不含 CDN 类节点",
  fullChannels.every((c) => !c.includes("jsdelivr")),
  fullChannels.filter((c) => c.includes("jsdelivr")).join(",") || "无",
);

console.log("\n" + (fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ 失败 ${fail} 项`));
process.exit(fail ? 1 : 0);
