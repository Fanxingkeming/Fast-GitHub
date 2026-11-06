#!/usr/bin/env python3
"""
为 gh-accelerator v2.8.0 创建 GitHub Release 并上传 ZIP 资产。

用法:
  GITHUB_TOKEN=xxx python tools/make_release.py
  python tools/make_release.py --token xxx --zip tools/gh-accelerator-v2.8.0.zip
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OWNER = "Fanxingkeming"
REPO = "Fast-GitHub"
REPO_API = "https://api.github.com/repositories/1429773758"
TAG = "v2.8.0"
ZIP_DEFAULT = os.path.join(BASE, "tools", "gh-accelerator-v2.8.0.zip")

BODY = """\
# Fast-GitHub 加速扩展 v2.8.0

针对 GitHub 访问慢、clone 困难而生的公益加速扩展（MV3，零构建，Chrome / Edge 通用）。

## ✨ 新特性
- **实时跟随浏览器 / 系统主题色**：读取 CSS 系统强调色作为种子，经 Material You tonal 映射生成整套浅色 / 深色配色；切换系统深浅主题或修改强调色会自动重算，无需重启扩展
- **三层主题来源**：Firefox 直接读取浏览器主题 frame 颜色；Chromium 使用系统强调色，并轮询检测变化；GitHub 注入面板额外跟随页面主题色
- **自定义主色**：「外观」里可关闭跟随并指定任意主色，按钮 / 容器 / 正文前景色自动满足 WCAG AA 对比度
- **去掉 Logo**：设置页与弹窗左上角的 GH 方块已移除，标题贴左对齐
- **保留 v2.7.0 全部能力**：一键体检、智能模式、精简弹窗、四项合一自检、即时保存、Material You 深浅双主题

## 📦 安装（任选其一）
1. **Release 包（推荐）**：下载下方的 `gh-accelerator-v2.8.0.zip`，解压后得到 `gh-accelerator-v2.8.0/` 文件夹
2. 打开 `chrome://extensions`（或 Edge 的 `edge://extensions`）
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择解压后的 `gh-accelerator-v2.8.0/` 文件夹
5. 固定扩展图标，访问任意 GitHub 页面即可看到「⚡加速」按钮与单文件下载按钮

## ⚠️ 说明
- Chrome / Edge 未提供读取浏览器主题颜色的扩展 API，主色取自系统强调色；Firefox 可读取真实浏览器主题色
- 公益节点可能不稳定，建议先到设置页点一次「开始体检」
- 上游项目：fhefh2015/Fast-GitHub（Apache-2.0）
"""


def api(url, token, method="GET", payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "gh-accelerator-releaser")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}"), resp
    except urllib.error.HTTPError as e:
        return e.code, {"message": e.read().decode("utf-8", "replace")[:400]}, None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token", default=os.environ.get("GITHUB_TOKEN", ""))
    parser.add_argument("--zip", default=ZIP_DEFAULT)
    parser.add_argument("--owner", default=OWNER)
    parser.add_argument("--repo", default=REPO)
    parser.add_argument("--tag", default=TAG)
    parser.add_argument(
        "--dry-run", action="store_true", help="只预览标签 / ZIP / Release 说明，不调用 GitHub API"
    )
    args = parser.parse_args()

    if args.dry_run:
        size = os.path.getsize(args.zip) if os.path.isfile(args.zip) else "文件缺失"
        print(f"[dry-run] tag={args.tag}  zip={args.zip}  size={size}")
        print(f"[dry-run] name=Fast-GitHub Accel {args.tag}  target=main")
        print("[dry-run] Release body:")
        print(BODY)
        return 0

    if not args.token:
        print("缺少 token：--token 或环境变量 GITHUB_TOKEN")
        return 1
    if not os.path.isfile(args.zip):
        print("ZIP 不存在:", args.zip)
        return 1

    # 1) 创建 Release（标签不存在则基于 main 创建）
    status, data, _ = api(
        f"{REPO_API}/releases",
        args.token,
        "POST",
        {
            "tag_name": args.tag,
            "target_commitish": "main",
            "name": f"Fast-GitHub Accel {args.tag}",
            "body": BODY,
            "draft": False,
            "prerelease": False,
        },
    )
    if status not in (200, 201):
        print(f"创建 Release 失败: HTTP {status} {data.get('message')}")
        if "already_exists" in str(data):
            print("（标签/Release 可能已存在，可先删除再试，或改用 --tag 指定新标签）")
        return 1

    upload_url = data.get("upload_url", "").split("{")[0]
    print(f"Release 已创建: {data.get('html_url')}")

    # 2) 上传 ZIP 资产
    fname = os.path.basename(args.zip)
    with open(args.zip, "rb") as f:
        raw = f.read()
    req = urllib.request.Request(
        f"{upload_url}?name={fname}&label={fname}",
        data=raw,
        method="POST",
    )
    req.add_header("Authorization", "Bearer " + args.token)
    req.add_header("Content-Type", "application/zip")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "gh-accelerator-releaser")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            adata = json.loads(resp.read().decode("utf-8"))
            print(f"资产已上传: {adata.get('browser_download_url')}")
    except urllib.error.HTTPError as e:
        print("资产上传失败:", e.code, e.read().decode("utf-8", "replace")[:400])
        return 1

    print("\n✅ Release 完成:", data.get("html_url"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
