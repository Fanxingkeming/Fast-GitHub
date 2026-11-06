# GitHub 加速 · 智能节点版（gh-accelerator）

在 [Fast-GitHub](https://github.com/fhefh2015/Fast-GitHub) v1.5.10 基础上重写的现代化 MV3 扩展。汇聚多个近期活跃的 GitHub 国内加速节点仓库，支持 **一键体检（同步 / 去重 / 测速 / 能力标注 / 择优）**、**智能模式**、**实时跟随浏览器主题色**、**24 小时自动更新节点**、**重复节点自动查重合并**、**GitHub 打不开时自动代理**，以及**可编辑的登录保护白名单**。

> 纯原生 MV3，**无需构建**：`chrome://extensions/` → 开发者模式 → 加载已解压的扩展程序 → 选择本目录。

---

## 技术栈

| 项            | 选择                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| 模块规范      | **ES Modules**（service worker 与扩展页面原生 ESM；content script 用动态 `import()` 以兼容各版本 Chromium） |
| 类型          | **JSDoc + TypeScript 类型注解**（`// @ts-check` 可校验，零构建）                                            |
| 格式化 / Lint | **Biome 2.6**（一个配置文件替代 Prettier + ESLint，见 `biome.json`）                                        |
| 运行时依赖    | 无                                                                                                          |

`package.json` 仅用于声明 `type: module` 与开发脚本，扩展运行不依赖它。

```bash
npm run format   # Biome 格式化
npm run lint     # Biome 检查（format + lint + assist）
```

---

## 功能

### 1. 多仓库节点同步（每 24 小时）

精选 **8 个**近期活跃的 GitHub 国内加速节点仓库，默认启用 **3 个互补来源**（主清单 / 自带分类 / 下载专用），其余 5 个可在设置页「更多来源」里按需开启。每个仓库按自己的清单格式解析，节点自动标注**能力分类**：
- **可加速仓库（full）**：支持 `clone` / git smart HTTP，也能下载文件
- **仅下载专用（download）**：只能下载文件（raw / release / archive），不能加速仓库 clone
- 分类来源优先级：**手动标注 > 测速时自动探测 > 仓库清单默认分类**（详见第 3 节）

| 仓库                                                                                    | 清单格式        | 默认分类      | 说明                                                |
| --------------------------------------------------------------------------------------- | --------------- | ------------- | --------------------------------------------------- |
| [hubporg/ghproxy-next](https://github.com/hubporg/ghproxy-next)                         | `{label,value}` | full          | 社区公益加速节点主清单，附测速实现                  |
| [clion007/adss](https://github.com/clion007/adss)                                       | 纯文本域名      | full          | 一行一个域名的节点清单                              |
| [lopinnn56/github-fast](https://github.com/lopinnn56/github-fast)                       | `name/prefix`   | full          | 内置节点表（name / prefix 结构）                    |
| [mihsian77/MirrorHub](https://github.com/mihsian77/MirrorHub)                           | 自带分类        | full+download | 自动发现 / 测速 / 清理，自带能力分类                |
| [triwinds/ns-emu-tools](https://github.com/triwinds/ns-emu-tools)                       | download/raw    | download      | 区分下载镜像与 raw 镜像                             |
| [XIU2/UserScript](https://github.com/XIU2/UserScript)                                   | 文本提取域名    | download      | GithubEnhanced 高速下载油猴脚本内置镜像（原始出处） |
| [RC1844/FastGithub](https://github.com/RC1844/FastGithub)                               | 三元组          | full          | 快速跳转 GitHub 镜像站的油猴脚本                    |
| [KotobaWakusei/GitHubMirrorPlugin](https://github.com/KotobaWakusei/GitHubMirrorPlugin) | 文本提取域名    | full          | 自动测速选择最快镜像的插件配置                      |
- `chrome.alarms` 定时触发，默认 **24 小时**（可改，最小 1 小时）
- 每个仓库配 4 个镜像依次降级：jsdelivr → fastly.jsdelivr → gh-proxy 代理的 raw → raw 直连
- 解析器兼容 **8 种**形态：`{label,value}`、`{name,prefix}`、纯文本域名、JSON 数组（含 `value`/`domain`/`host`/`url`/`prefix`）、MirrorHub 的 `nodes.json`、ns-emu-tools 的 `github_mirrors.json`、FastGithub 的 `MirrorUrl` 三元组、以及兜底地从任意文本提取 `https://` 域名
- 仓库首页的「加速」下拉**只使用「可加速仓库」类节点**做 clone 通道；下载类节点由下载 / Release 加速按需使用
- 设置页的「**自定义节点源**」文本框可追加任意清单地址，与上方仓库合并同步；该列表是权威的——清空后同步会移除之前来自自定义源的节点

### 2. 重复节点查重合并

不同仓库经常收录同一个节点，写法还不统一。扩展会把它们归并为一条：
- 归一化规则：统一小写，去掉协议、`www.`、端口、路径与尾点
  —— `HTTPS://WWW.Gh-Proxy.com/`、`gh-proxy.com`、`www.gh-proxy.com` 视为同一个节点
- 合并后保留一条记录，用 `sources` 汇总它出现在哪些仓库（节点列表会显示来源徽章）
- 设置页实时显示「仓库原始 N 条 → 去重后 M 个（合并 K 个重复项）」；**一键体检**已包含去重，高级维护区仍可单独执行
- 手动添加自定义节点时也会先归一化，避免重复录入

### 3. 一键体检与节点测速

- **延迟**：对节点根路径发 HEAD 请求计时（6s 超时）
- **带宽**：经节点下载样本文件，不足 500ms 自动重复多轮以降低误差，换算 Mbps
- **能力自动标注**：测速在同一次调用里顺带探测 Range 断点续传与 git smart HTTP，并自动写入分类
  - 支持 git smart HTTP → **可加速仓库（full）**，可直接打开 / clone 仓库
  - 有响应但不支持 git → **仅下载专用（download）**，只能下载文件
  - 两次探测均无响应 → 节点不可达，**保留原分类不误标**
  - 优先级：手动覆盖 > 体检自动标注 > 仓库清单分类 > 默认 full；节点列表用状态圆点呈现分类，悬停可看来源，在「⋯」菜单里可手动覆盖或恢复自动判断
- **一键体检**把同步 → 去重 → 全量测速 → 能力标注 → 择优串成一次动作，结束后给出「可加速 X / 仅下载 Y / 未判定 Z」摘要；单独测速 / 单节点测速收在「高级维护」与节点行「⋯」菜单里
- **智能模式**（默认开启）：打开仓库、clone 与一键代理只使用可加速节点；仅下载节点留给文件下载
- 后台、设置页、弹窗共用 `lib/rank.js` 的同一套评分，列表顺序与实际选中的最优节点一致
- 节点 > 20 时先全量测延迟（同时完成能力探测），再对延迟最优的 20 个做完整测速
- 结果持久化，自动模式始终使用「带宽最高 → 延迟最低」的节点

### 4. GitHub 打不开时自动代理

- `webNavigation.onErrorOccurred` 捕获主框架失败（超时 / 无法解析 / 连接被拒）
- 跳转到 `https://<最优节点>/https://github.com/原地址`，图标打「代理」角标，页面顶部注入安全提示条
- 同址最多重试 2 次，忽略主动中止与断网，不会死循环

### 5. 智能路由与 jsDelivr CDN 通道

实测发现 GitHub 各域名的连通性并不一致（本机：`api.github.com` 698ms 可达，主站与 raw 间歇超时），
「一律走第三方节点」会把本可直连的流量也送进别人服务器。因此增加了按域名分流：

| 目标                             | 策略                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `raw.githubusercontent.com` 文件 | **走 jsDelivr CDN**（`cdn.jsdelivr.net/gh/{owner}/{repo}@{ref}/{path}`），商业 CDN 有 SLA，不涉及凭证中转 |
| `api.github.com`                 | 直连可用则直连（省公益节点带宽）                                                                          |
| `codeload.github.com` 打包       | 直连可用则直连（大 zip 不占用公益节点带宽）                                                               |
| github.com 页面                  | 智能模式下走节点保证渲染完整；直连优先模式下尝试直连，失败再由自动代理兜底                                |
| 登录 / 私有内容                  | 永远直连，见下一节                                                                                        |
- 每 **6 小时**自动重新探测各域名连通性，也可在设置页手动触发
- 探测带**两轮重试**：本机网络呈间歇性中断，单次采样曾把可用域名误判为不可达
- jsDelivr 覆盖不到时（私有仓库、超过 20MB）**自动降级**到加速节点重试
- 三种路由模式可切换：**智能分流**（默认）/ **直连优先** / **始终走节点**

### 6. 登录保护白名单（可编辑）

设置页「登录保护」是一个独立页面，规则完全可视化编辑：
- 规则以 chip 展示，可**逐条删除**、**自由添加**、**一键恢复默认**、**一键清空**
- 支持 `*` 通配单级路径段（如 `/settings/*`、`/orgs/*/settings`）
- 内置 **33 条**默认规则：登录、登出、2FA、账号设置、通知、计费、安全、组织与企业设置等
- 提供**规则自检**：输入任意 GitHub 地址即可验证是否会被拦截
- 私有仓库被访问时由内容脚本自动上报，加入运行时永不代理名单
- 弹窗的「一键代理 / 复制链接」对命中规则的地址直接拒绝

### 7. GitHub 页面注入

- 仓库首页 / 目录页：⚡**加速**下拉，多条「可加速仓库」通道的 clone 地址一键复制、下载 ZIP
- 文件树：单文件经加速节点下载（经 raw 通道拉取）
- Releases / Tags：每个产物旁追加「加速下载」

> 注：早期版本的「页面增强」模块（Web IDE 入口、Issue 翻译）已移除，聚焦核心加速能力。

---

## UI

Material You（Material Design 3）：
- 以紫罗兰为种子色的 **tonal 动态配色**：primary / secondary / tertiary container 分层，表面带极淡色调
- **大圆角**（卡片 20px、按钮全胶囊 pill），无粗边框，靠 tonal 明暗区分层级
- **柔和多层 elevation**（M3 level 1~3）替代硬投影；交互用 **state layer**（8% / 10% / 12% 叠加）而非位移
- 组件按 M3 规范：filled / tonal 按钮、52×32 开关、assist chip、inverse-surface snackbar、pill 形导航激活指示器
- 完整的深浅色主题；注入 GitHub 的元素使用独立的 `--fgm-*` 变量，跟随 GitHub 自身明暗模式且不污染页面主题

---

## 权限

| 权限                       | 用途                               |
| -------------------------- | ---------------------------------- |
| `storage`                  | 设置、节点表与测速结果             |
| `alarms`                   | 每 24 小时同步节点                 |
| `webNavigation`            | 感知 github.com 加载失败           |
| `scripting`                | 在代理页面注入安全提示条           |
| `https://*/*` `http://*/*` | 访问任意节点域名做测速与下载       |
| `web_accessible_resources` | content script 动态载入 `lib/*.js` |

---

## 目录结构

```
gh-accelerator/
├─ manifest.json          # MV3（background 为 ESM service worker）
├─ background.js          # 定时同步 / 域名探测 / 失败自动代理 / 4 个跨上下文消息接口
├─ content.js             # 注入 github.com 的加速按钮（动态 import 共享模块）
├─ content.css
├─ lib/
│  ├─ nodes.js            # 内置 81 个节点（由 tools/gen_nodes.py 生成）
│  ├─ repos.js            # 节点仓库源定义（8 个仓库 + 3 个默认启用 + 能力分类）
│  ├─ rank.js             # 节点评分：后台 / 设置页 / 弹窗共用
│  ├─ sync.js              # 节点同步：后台与设置页共用
│  ├─ theme.js             # 浏览器主题色：系统色探针 / tonal 调色板 / 实时监听
│  ├─ ui.js                # 提示 / 延迟格式化 / 复制兜底
│  ├─ routes.js           # 域名画像、jsDelivr 转换、路由决策
│  ├─ store.js            # 设置仓库、节点状态原子写入、择优、健康度、白名单匹配
│  ├─ net.js              # 远端同步 + 测速 + 域名探测 + 能力探测
│  └─ ui.css              # 设计系统
├─ options/               # 设置页：节点管理 / 登录保护 / 路由与诊断 / 通用设置 / 关于
├─ popup/                 # 弹窗
├─ icons/
└─ biome.json             # Biome 配置
```

---

## 验证

两层，均已通过：

```bash
node tools/smoke_test.mjs          # 逻辑层：节点合并/择优/白名单匹配/测速/同步/路由（mock chrome + fetch）
node tools/test_auto_kind.mjs      # 测速自动标注：分类纯函数 / 优先级 / 不可达保护 / 批量写入
node tools/verify_checkup.js       # 真实浏览器跑通一键体检整条流程（6 项）
node tools/test_theme.mjs          # 主题色纯函数：解析 / tonal / 对比度 / 降级（16 项）
node tools/verify_theme_ui.js      # 真实浏览器：无 Logo / 左对齐 / 深浅实时切换 / 自定义色（23 项）
NODE_PATH=<workspace>/node_modules node tools/e2e_extension.js   # 真实浏览器
```

端到端测试用 `puppeteer-core` 驱动本机 Edge 真实加载扩展，覆盖 36 项：扩展加载与 service worker 激活、设置页 81 个节点渲染、8 个节点仓库渲染与开关、白名单增删改与自检、**路由页域名真实探测与路由自检**、background(ESM) 消息响应、弹窗精简为 2 个动作、**content script 在模拟 GitHub 页面真实注入加速按钮并应用动态主题色**。另有 `verify_auto_kind_ui.js`（9 项）、`verify_theme_ui.js`（23 项）与 `verify_material_you.js` 做界面与视觉校验。

后台消息接口已收敛为 **4 个**：`syncNodes` / `proxyTab` / `probeHosts` / `markPrivate`；测速、能力标注、路由判定、设置读写与使用统计统一由页面直接调用 `lib/`，不再经 service worker 转发，避免同一能力存在两套实现。

真实网络下的探测与路由结果（本机实测）：

```
探测    api ✅ 580ms   codeload ✅ 1413ms   raw ✅ 1333ms   web ✅ 1070ms
路由    raw 文件      → jsDelivr CDN（不经第三方节点）
        codeload 打包 → 直连（1413ms 可达，省公益节点带宽）
        api.github.com → 直连（580ms 可达）
        github.com 页面 → 加速节点（智能模式，保证渲染完整）
        github.com/login → 直连（命中白名单，禁止代理）
```

---

## 反馈

扩展内提供了三个反馈入口，均指向本项目的 Issue 页：

| 位置                | 入口                                    |
| ------------------- | --------------------------------------- |
| 设置页 → 关于       | 「💬 反馈与建议」卡片，点击「前往反馈」 |
| 弹窗页脚            | 「反馈」链接                            |
| GitHub 页面加速面板 | 面板底部「💬 反馈问题 / 节点失效」      |

地址：https://github.com/Fanxingkeming/Fast-GitHub/issues

发现节点失效、功能异常或有改进建议，欢迎提 Issue。

## 安全提醒

第三方公益节点会中转你的请求。**请勿用于私有仓库、带 Token 或 Cookie 的地址，也不要在代理页面登录 GitHub 账号。** 登录请直连 `github.com/login`。

## 来源与许可

- 上游：[fhefh2015/Fast-GitHub](https://github.com/fhefh2015/Fast-GitHub)（Apache-2.0）
- 节点仓库：[hubporg/ghproxy-next](https://github.com/hubporg/ghproxy-next)（GPL-3.0）、[clion007/adss](https://github.com/clion007/adss)、[lopinnn56/github-fast](https://github.com/lopinnn56/github-fast)
- 节点均为社区公益服务，随时可能变更或下线，请自行测速后择优使用
- 本目录代码沿用仓库的 Apache-2.0；各节点仓库的协议以其自身声明为准
