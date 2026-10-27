# Agent Note: 桌面壳的 WebView 引擎选型（需求 = 双击启动 + 托盘，结论 Tauri）

Status: proposed

## Problem

Issue #332 要给 nanopi 加桌面版本，用户明确的桌面需求只有两条：

1. 双击图标启动（不敲命令、不手动开浏览器）。
2. 托盘常驻 + 全局快捷键（外加顺带的通知、文件拖入这类真·桌面能力）。

今天交付形态是单文件 `nanopi.js`（`scripts/build-coding-agent-single-file.mjs`，Node 24 前置）+ `install.js` 装到 `~/.local/bin`；前端是 `packages/webui` 的 Next.js static export，由 `nanopi webui` 的 `node:http` daemon 从 `dist/webui` serve，契约是 `/chat` SSE、`/terminal` WebSocket、以及 `randomBytes(24)` 的 Bearer token（`webui-server.ts` 的 `runWebuiMode` 生成，`bearerTokenMatches` 常数时间校验，`:upgrade` 还允许 WS 从 `?token=` 与 `sec-websocket-protocol` 捞，前端 `lib/api.ts` 存 `sessionStorage`，缺 token 时渲染 `components/auth-gate.tsx` 那张"需要从终端打开"的卡片）。

要回答两件事：壳用哪个框架；desktop 用哪个 build flavor。

需求 2 是分水岭：**只要出现托盘，`no-shell`（`.desktop` / `.app` 脚本 + `open http://…`）就出局**，问题直接变成"哪个框架给得了托盘与全局快捷键"，答案只在 Tauri / Electron / Wails 里。

## Proposal

### 引擎：Tauri

一套 Rust 壳同时给出托盘（`TrayIcon`）、全局快捷键（`global_shortcut`）、双击启动，Linux 上不自带 Chromium。

agent 继续跑在 Node（`packages/ai` / `packages/extra` 运行时从盘上加载：`jiti` 懒加载、`photon-node` wasm、扩展目录），**不 port 到 Rust**——那是重写 agent loop。壳只做窗口 + IPC + 进程管理。

第二收益是**去掉 transport 层的鉴权与端口**：`/chat`、`/terminal` 走 webview 的私有 IPC，于是 `randomBytes(24)` token、常数时间 `Bearer` 校验、WS 的 `?token=` / `sec-websocket-protocol` 捞 token、`lib/api.ts` 的 `sessionStorage`、`AuthGate` 那张卡片在桌面构建里全部不参与。Tauri 的 IPC 是默认形态，不靠"配置对了才成立"。

前提：先在 `packages/webui/src/lib` 抽一层 transport（`chat` / `terminal` / `fs.*` / `config`），默认实现是今天的 fetch + WS，行为逐字节等价；`invoke` 实现后接。这一步不装壳、只是前端重构，`pnpm run check` 就能验完，随时可回退，也是后面所有选择的公共基础。

### 窗口生命周期：关窗 = 藏到托盘，退出要杀干净

托盘应用逼出一个新契约，必须写进设计：

- **窗口关闭 ≠ 进程退出**。关窗只 `hide()`，托盘常驻，快捷键与通知继续可用；托盘菜单里的"退出"才是真退出。
- **真退出 = 一条清理链**：先停 SSE / 终端 WS，再结束 Node 侧 agent，最后退壳。今天 `runWebuiMode` 的 daemon 生命周期挂在终端进程上（Ctrl-C 就没了），壳里没有这个恩赐，每一环都得自己 `kill`/`await`，否则留僵尸进程和占着端口的孤儿。
- **单实例**：托盘 + 双击启动的组合必然遇到"用户又双击了一次图标"，第二个进程要么聚焦已有窗口、要么什么都不做，不能起第二个 daemon。

### flavor：desktop 用 `full` 的内容，但不新增 flavor

`buildconfig.json` 的 `flavors` 是"发布锚点"矩阵（`base` / `minimal` 是为单文件瘦身服务的，见 [build flavors](../../implemented/process/2026-10-11-build-flavors-buildconfig.md)），`full` 是唯一自洽能跑起来的集合（`webui`、`sidecar/*`、`oauth/*`、`module/*`、`apis: all`、`providers: presets`）。desktop 需要的就是这一套，于是一行配置继承 `full`，不新增 flavor。

`full` 是**基座不是 SKU**：它是 npm 包唯一的发布来源，desktop 的特殊需求不能反向污染它（只能在打包层覆写）；反过来 desktop 也不要参与 `base`/`minimal` 那套单文件瘦身阶梯。真要出"精简桌面版"，走打包后裁剪 / app 配置层，不要再往 `flavors` 加一维——那张表已经是 `components × flavor`。

## Alternatives considered

### Why not Electron?

- **体积与重复 runtime。** Electron = Chromium + Node + 应用，冷压百 MB 量级。`nanopi` 的前置条件本来就是 Node 24，等于把同一个 runtime 再塞一遍，外加一个浏览器，与 README 的 radically minimalism 自相矛盾。这也是"用 sidecar 起 `nanopi webui`"那条反对项的更严重版本。
- **它确实赢一样东西**：单一 Chromium，`scripts/check-browser-smoke.mjs` 直接复用，CI 跑的就是用户看到的引擎。但那只是**推迟**版本矩阵（Electron 大版本半年一升，安全更新得跟），不是消除。
- **托盘与快捷键它也有**（`Tray` + `globalShortcut`），所以否定理由不是"做不到"，是"为了消掉渲染器风险多背一份 runtime 和一个浏览器"。
- **安全边界靠配置正确。** `contextIsolation` + `contextBridge` 能做到与 `invoke` 等价，但 `loadURL("http://127.0.0.1:5335/?token=…")` 这条"最小改动"路径在 Electron 里极其顺手，顺手就是风险：一旦这么写，唯一收益归零。

### Why not Wails?

- **托盘能做，但换不到东西**：`os/exec` + systray 生态同样能起 Node、管信号、做托盘；问题是仓库全部工具链是 TypeScript（`biome.json`、`ts-import.mjs`、`scripts/*.mjs`），为此多引一套 Go toolchain 只在壳这一层值得，收益看不到。
- **兼容面一模一样**：Linux 是 WebKitGTK、Windows 是 WebView2、macOS 是 WKWebView，与 Tauri 同一张版本矩阵，但社区、文档、issue 覆盖率都小一截——为同一个坑付更少的援手。
- **transport 侧还要多写一层**：Wails 的 Go↔JS 绑定是运行时注入的 JS 全局，Tauri 是显式 `invoke` 命令清单，做抽象时前者得再包一层 shim。
- 唯一成立的理由是团队本来写 Go——这里不成立。

### Why not 不加壳（`.desktop` / `.app` 脚本 + 打开浏览器）?

这是最便宜的方案，几十行、零新运行时，但它只解决需求 1。需求 2 一起来，托盘、全局快捷键、壳的通知一个都拿不到，`AuthGate` 与 token 也全留着。**如果将来需求退回成"只要双击启动"，这是首选**——记在这里，别下次又从头论证一遍。

## Acceptance criteria

1. `packages/webui/src/lib` 有 transport 抽象，默认实现与今天的行为逐字节等价，`pnpm run check` 与 `check:browser-smoke` 绿。
2. 桌面壳跑起来后，`webui-server.ts` 的 Bearer 校验、`?token=` / `sec-websocket-protocol` 捞 token、`lib/api.ts` 的 `sessionStorage` 与 `AuthGate` 在桌面构建里均不再参与。
3. 托盘行为可验：关窗后进程仍活着且快捷键生效；托盘"退出"后不留孤儿进程、端口被释放；重复双击图标不起第二个实例。
4. WebKitGTK 上的 smoke（终端 WS、`shiki` 高亮、通知、`dvh` / `color-mix()`）进 CI，不是手工过一遍就算。
5. `buildconfig.json` 的 `flavors` 不新增条目。

## Risks

- WebKitGTK 版本矩阵是新增兼容面：Linux 上老发行版的 webkitgtk 可能达不到 webui README 写的 Chrome 111+ / Safari 16.4+ 基线，需要实测定下限。
- 多窗口 / 多会话语义未定：现在是"浏览器开一堆标签页"，`/projects/:hash/sessions` 的多项目切换在原生壳里怎么表达（窗口菜单？侧栏？）比引擎选型更影响工作量。
- 壳的通知替换掉 `components/app-client.tsx:100` 的浏览器 `new Notification` 之后，跨平台通知的权限与点击行为要各自实测。
- 启动段的失败模式（起 Node → 等就绪 → 开窗口，超时/端口占用/agent 崩溃各是什么表现）不在 `scripts/check-browser-smoke.mjs` 覆盖范围内。
