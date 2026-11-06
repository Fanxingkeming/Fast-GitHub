/**
 * 节点仓库同步的唯一实现。
 * 后台（安装 / 定时 / 弹窗）与设置页（手动）都调用 buildSyncPatch，
 * 由调用方自行决定是否写入 patch，避免计数、状态文案、时间戳重复拼装。
 */

import { FGNet } from "./net.js";
import { FGStore } from "./store.js";

/**
 * 拉取当前启用的节点仓库，生成一份可直接传给 FGStore.set 的补丁。
 * @param {any} settings
 * @param {number} [timeoutMs]
 */
export async function buildSyncPatch(settings, timeoutMs = 15000) {
  const repos = FGStore.enabledRepos(settings);
  const customCount = (settings?.updateSources ?? []).filter(Boolean).length ? 1 : 0;
  const totalSources = repos.length + customCount;
  const sync = await FGNet.syncAllRepos(settings, repos, timeoutMs);

  /** @type {Record<string, number>} */
  const counts = {};
  for (const item of sync.results) counts[item.id] = item.count;

  if (!sync.okCount) {
    return {
      ok: false,
      okCount: 0,
      totalSources,
      results: sync.results,
      unique: 0,
      patch: {
        repoCounts: counts,
        lastUpdateMessage: `同步失败：${String(sync.results[0]?.error ?? "").slice(0, 140)}`,
      },
    };
  }

  const merged = FGStore.mergeStats(
    FGStore.allNodes({ ...settings, remoteNodes: sync.nodes }),
  );
  return {
    ok: true,
    okCount: sync.okCount,
    totalSources,
    results: sync.results,
    unique: merged.unique,
    patch: {
      remoteNodes: sync.nodes,
      repoCounts: counts,
      lastUpdate: Date.now(),
      lastUpdateMessage: `已同步 ${sync.okCount}/${totalSources} 个源 · 去重后 ${merged.unique} 个节点`,
    },
  };
}
