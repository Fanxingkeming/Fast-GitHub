/**
 * 节点评分与排序的唯一实现。
 * 后台、设置页、弹窗共用；纯函数，不读写存储，便于单测。
 */

/**
 * 分值越小越优；真实使用失败率高的节点会被降权。
 * @param {{ latency?: string; speed?: string } | null} stat
 * @param {{ total?: number; fail?: number } | null} [usage]
 * @returns {number}
 */
export function scoreOf(stat, usage) {
  if (usage?.total && usage.total >= 3 && usage.fail / usage.total > 0.5) {
    return Number.MAX_SAFE_INTEGER - 3;
  }
  if (!stat) return Number.MAX_SAFE_INTEGER;
  const speed = Number.parseFloat(String(stat.speed ?? ""));
  if (!Number.isNaN(speed) && speed > 0) return 1000 - speed;
  const latency = Number.parseFloat(String(stat.latency ?? ""));
  if (!Number.isNaN(latency)) return 100000 + latency;
  return Number.MAX_SAFE_INTEGER - 1;
}

/**
 * 按评分升序排列节点。兼容新旧两种状态存储：
 * 优先读 stats / usage，回退到合并后的 nodeState。
 * @param {{ value: string; [key: string]: any }[]} nodes
 * @param {any} settings
 * @returns {{ value: string; stat: any; usage: any; [key: string]: any }[]}
 */
export function rankNodes(nodes, settings) {
  const stats = settings?.stats ?? {};
  const usage = settings?.usage ?? {};
  const state = settings?.nodeState ?? {};
  return [...(nodes ?? [])]
    .map((node) => ({
      ...node,
      stat: stats[node.value] ?? state[node.value]?.stat ?? null,
      usage: usage[node.value] ?? state[node.value]?.usage ?? null,
    }))
    .sort((a, b) => scoreOf(a.stat, a.usage) - scoreOf(b.stat, b.usage));
}
