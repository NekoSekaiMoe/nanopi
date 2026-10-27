# Agent Note: 桌面壳的 WebView 引擎选型（Tauri 优先，Wails 与 Electron 均不选）

Status: proposed

## Problem

Issue #332 要给 nanopi 加桌面版本。当前交付形态是单文件 `nanopi.js`（`scripts/build-coding-agent-single-file.mjs`，Node 24）+ `install.js` 装到 `~/.local/bin`；前端是 `packages/webui` 的 Next.js static export，由 `nanopi webui` 的 `node:http` daemon 从 `dist/webui` serve，契约是 `/chat` SSE、`/terminal` WebSocket、以及 `randomBytes(24)` 的 Bearer token（`webui-server.ts:654` 生成，`:161` 常数时间校验，`:686` 还允许 WS 从 `?token=` 与 `sec-websocket-protocol` 捞，前端 `lib/api.ts` 存 `sessionStorage`）。

要回答两件事：壳用哪个框架；desktop 用哪个 build flavor。

## Proposal

### 引擎：Tauri 优先

唯一值得为壳付代价的收益是**去掉 transport 层的鉴权与端口**：`/chat`、`/terminal` 走 `invoke`（webview 私有 IPC），token、`?token=` 链接、CORS、`AuthGate` 卡片、`sessionStorage` 那一整块随之消失。Tauri 的 IPC 是默认形态，不需要靠配置正确才成立。

agent 继续跑在 Node（`packages/ai` / `packages/extra` 运行时从盘上加载：`jiti` 懒加载、`photon-node` wasm、扩展目录），不要 port 到 Rust。壳只做窗口 + IPC + 进程管理。

第一步与壳无关：在 `packages/webui/src/lib` 抽一层 transport（`chat` / `terminal` / `fs.*` / `config`），默认实现是 fetch + WS，`invoke` 实现后接。做完这步，Tauri / Electron / 纯浏览器三种宿主是同一份前端，选型可以用数据说话。

### flavor：desktop 用 `full` 的内容，但不新增 flavor

`buildconfig.json` 的 `flavors` 是「发布锚点」矩阵（`base` / `minimal` 是为单文件瘦身服务的），`full` 是唯一自洽能跑起来的集合（`webui`、`sidecar/*`、`oauth/*`、`module/*`、`apis: all`、`providers: presets`）。desktop 需要的就是这一套，于是一行配置继承 `full`，不新增 flavor。真要分叉（精简桌面版）走打包后裁剪 / app 配置层，不要再往 `flavors` 加一维。

## Alternatives considered

### Why not Wails?

- **省不掉 transport。** Wails 的 Go↔JS 绑定同样是私有通道，理论上也能替代 HTTP/WS；但它的前端侧是运行时注入的 JS 全局，Tauri 是显式的 `invoke` 命令清单——做 transport 抽象时前者要多写一层 shim，收益不多一分。
- **不省 WebView 兼容面。** Wails 在 Linux 也是 WebKitGTK，Windows 是 WebView2，macOS 是 WKWebView，与 Tauri 同一张版本矩阵，但社区体量、文档和 issue 覆盖率都小一截。为同一个坑付更少的援手。
- **技术栈是最贵的那部分。** 壳里要的东西——拉起 Node 进程、管信号与僵尸、读 stdout——在 Tauri 里是 `std::process`，在 Wails 里是 `os/exec`，两者都行；但仓库的全部工具链是 TypeScript（`biome.json`、`ts-import.mjs`、`scripts/*.mjs`），再引入 Go toolchain 只在壳这一层值得，收益看不到。
- 唯一可能成立的理由是团队本来写 Go——这里不成立。

### Why not Electron?

- **体积与重复 runtime。** Electron = Chromium + Node + 应用，冷压百 MB 量级。而 `nanopi` 的前置条件本来就是 Node 24，等于把同一个 runtime 再塞一遍，外加一个浏览器。这是「用 sidecar 起 `nanopi webui`」那条反对项的更严重版本。
- **安全边界靠配置正确。** `contextIsolation` + `contextBridge` 能做到和 `invoke` 等价的效果，但 `loadURL("http://127.0.0.1:5335/?token=…")` 这条「最小改动」路径在 Electron 里极其顺手，顺手就是风险：一旦这么写，唯一收益归零。
- **它确实赢一样东西**：单一 Chromium，`scripts/check-browser-smoke.mjs` 直接复用，CI 跑的就是用户看到的引擎。但这只是**推迟**版本矩阵（Electron 大版本半年一升，安全更新得跟），不是消除；而 WebKitGTK 不是「没法测」，是「难测」（`apt install libwebkit2gtk` 能进 CI）。

### Why not 不加壳（`.desktop` / `.app` 脚本 + 打开浏览器）?

这是最便宜的方案，几十行、零新运行时，但它解决不了 Issue 里要的东西：Token 与端口还在，`AuthGate` 还在，托盘 / 快捷键 / 通知 / 文件拖入这些真·桌面能力一个都没有。只有「用户少敲一条命令」这一个需求时它才对。

## Acceptance criteria

1. `packages/webui/src/lib` 有 transport 抽象，默认实现与今天的行为逐字节等价，`pnpm run check` 与 `check:browser-smoke` 绿。
2. 桌面壳跑起来后，`webui-server.ts` 的 Bearer 校验、`?token=` / `sec-websocket-protocol` 捞 token、`lib/api.ts` 的 `sessionStorage` 与 `AuthGate` 在桌面构建里均不再参与。
3. WebKitGTK 上的 smoke（终端 WS、`shiki` 高亮、通知、`dvh` / `color-mix()`）进 CI，不是手工过一遍就算。
4. `buildconfig.json` 的 `flavors` 不新增条目。

## Risks

- WebKitGTK 版本矩阵是新增兼容面：Linux 上老发行版的 webkitgtk 可能达不到 webui README 写的 Chrome 111+ / Safari 16.4+ 基线，需要实测定下限。
- 多窗口 / 多会话语义未定：现在是「浏览器开一堆标签页」，`/projects/:hash/sessions` 的多项目切换在原生壳里怎么表达（窗口菜单？侧栏？）比引擎选型更影响工作量。
- 桌面壳的启动流程（起 Node 进程 → 等就绪 → 开窗口）会引入新的失败模式与信号清理责任，`scripts/check-browser-smoke.mjs` 覆盖不到这层。
