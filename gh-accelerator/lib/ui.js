/**
 * 扩展页面（设置页 / 弹窗）共用的界面小工具。
 * 只在有 DOM 的页面脚本中引用，后台 service worker 不加载本模块。
 */

/**
 * 轻提示。各页面均提供 #toastWrap 容器。
 * @param {string} message
 * @param {"ok" | "err" | ""} [kind]
 */
export function toast(message, kind) {
  const wrap = document.getElementById("toastWrap");
  if (!wrap) return;
  const el = document.createElement("div");
  el.className = `fg-toast${kind ? ` is-${kind}` : ""}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "all .2s";
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

/** 主题（明暗 + 动态配色）已统一由 lib/theme.js 提供，此处不再重复实现。 */

/**
 * 延迟格式化：统一返回文案与配色，调用方按需取用。
 * @param {string | null | undefined} value
 * @returns {{ text: string; cls: string } | null}
 */
export function fmtLatency(value) {
  if (!value || value === "-" || value === "未测速") return null;
  if (value === "timeout") return { text: "超时", cls: "fg-badge-bad" };
  const n = Number.parseInt(String(value), 10);
  if (Number.isNaN(n)) return null;
  const text = n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`;
  const cls = n < 400 ? "fg-badge-good" : n < 1000 ? "fg-badge-mid" : "fg-badge-bad";
  return { text, cls };
}

/**
 * 复制文本，带 execCommand 降级（部分上下文没有 clipboard 权限）。
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
