# Agent Note: 运行时依赖的四个 major 里，三个是「没人读到」，一个是「上游锁住了」

Status: implemented

## Problem

[依赖升级按可验证分批](./2026-10-27-renovate-minor-major-split.md) 列的「要改代码」
那一批，issue 描述按版本号猜破坏面：`diff` v9 要核对两个 import 点、
`hosted-git-info` v10、`@xterm/headless` v6、`protobufjs` v8 要连带改 override、
`vitest` 与 `next` 各自要跟。

实际核对下来，这批的性质和描述差得远：

- `vitest` 仓库里已经是 **5.0.5**，`next` 已经是 **16.4.3**，两个都是当时的 npm
  `latest`。issue 写的「5.0.5 → v5 之后的下一档」不存在这个版本。
- `protobufjs` v8 装不上。`pnpm-workspace.yaml` 与 `packages/coding-agent/package.json`
  的 `overrides: protobufjs: 7.6.6` 不是给直接依赖用的——`packages/coding-agent` 的
  `dependencies` 里那行 `protobufjs: 7.6.6` 根本没有源码引用它，它只是把一条
  override 写在 `package.json` 里。锁住的真正原因是 `@google/genai@2.31.0`
  （当前最新）自己声明 `protobufjs: ^7.5.4`。

## Decision

落 `diff` 9.0.0、`hosted-git-info` 10.1.1、`@xterm/headless` 6.0.0；
`protobufjs` 停在 7.6.6，把 `packages/coding-agent` 里那条挂在 `dependencies`
上的假依赖删掉、`overrides`（两处）保留。

三个升级的实际改动量：

- `diff` 9.0.0：`export { … }` 具名导出不变，`FILE_HEADERS_ONLY`、`diffLines`、
  `createTwoFilesPatch`、`applyPatch`、`diffWords` 全部还在。实测
  `createTwoFilesPatch(..., { headerOptions: FILE_HEADERS_ONLY })` 的输出与 v8 逐字节
  相同（`--- a` / `+++ b` / `@@` 三行头，无 `Index:` 行、无 tab 尾巴），
  `diffLines` / `diffWords` 的 change 对象形状也没变。v9 的 breaking changes
  （`parsePatch` 支持 C 风格引号文件名与 git 扩展头、`oldFileName` 变
  `string | undefined`）全在 patch 解析路径上，本仓库只生成不解析。零代码改动。
- `hosted-git-info` 10.1.1：`module.exports = GitHost`，`fromUrl` 仍是静态方法。
  与 9.0.3 逐文件比对，`lib/index.js` / `lib/hosts.js` / `lib/from-url.js` 完全一致，
  只有 `parse-url.js` 把 `require('url').URL` 换成全局 `URL`。用
  `src/utils/git.ts` 的 `parseGitUrl` 跑了 10 个输入（`github:` 简写、`git@host:path`、
  scp-style 带 `@ref`、`#ref`、`git+https://`、`ssh://`、`git://`、bitbucket、裸 https）
  在 9.0.3 与 10.1.1 下各跑一遍，输出逐字节一致。零代码改动。
- `@xterm/headless` 6.0.0：类型文件 59 行 diff 全是新增，`Terminal`
  `write`/`resize`/`buffer.active`/`translateToString` 未变。`packages/tui` 的 1117 条
  测试全过。

`protobufjs` 的判断依据：`protobufjs` 只被 `@google/genai` 依赖，而
`@google/genai` 的 `./tokenizer` 入口第一行就是 `import $protobuf from
'protobufjs/minimal.js'`。`packages/ai` 只从根入口 `@google/genai` 取
`GoogleGenAI` / `FinishReason` 这些符号，仓库里没有一处 import 那个 tokenizer 子路径，
所以运行时并不解码 protobuf。即使如此，把 override 拿掉让 `@google/genai` 装出
protobufjs 8 也说不通：那是 `^7.5.4` 之外的版本，上游未验证的组合，而我们没有能覆盖
这条路径的测试——之前 override 到 `7.6.6` 就是为了 GHSA-j3f2-48v5-ccww，
再往前推到 v8 等于用一个未知组合换一个已经修好的 CVE。

## Alternatives considered

- **去掉 `overrides` 让 pnpm 自动解析**：在 `minimumReleaseAge: 2` 与
  `allowBuilds` 都在位的配置下试过，lockfile 会指向 `protobufjs@8.8.1`，因为
  override 一撤，`^7.5.4` 之外的版本就没人拦了。这与「跟着上游的兼容范围」相反。
- **升 `@google/genai` 到支持 protobufjs 8 的版本**：npm 上 `@google/genai` 的
  dist-tag `latest` 就是 2.31.0，没有更高版本。
- **`protobufjs` 留在 `packages/coding-agent` 的 `dependencies` 里当保险**：
  它没有任何运行时 import，`scripts/check-runtime-deps.mjs` 也不认它（该脚本只查
  「import 了但没声明」，不查「声明了但没 import」），留着只是让每次读
  `package.json` 的人以为有个 protobuf 运行时代码。删掉后 `pnpm why protobufjs`
  仍然由 `@google/genai` 的 override 解析到 7.6.6。

## Consequences

- `overrides` 留在原地，并绑定在 `@google/genai` 上——下次 `@google/genai` 把
  `^7.5.4` 提到 v8 时，这条 override 应当一起撤掉。
- `pnpm run check` 除 tsc 外全绿；tsc 只剩 `sidecars.ts` 的 `ReadableStream` 方差错误，
  干净 `main` 上同样报（已 stash 本次改动复验过）。
- `node ./test.mjs`：ai 1418、coding-agent 2419、agent 96、extra 95 全过，
  `packages/tui` 1117 过；`packages/webui` 的 `typecheck` 与 `next build` 通过。
- 剩余 major 清单收缩为 `protobufjs` v8（等 `@google/genai` 放行）。
  node v24 已在 [node 24 floor](./2026-10-27-node-24-floor.md) 里落地。
