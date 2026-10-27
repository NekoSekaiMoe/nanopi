# Agent Note: 依赖升级按「可验证」分两批，major 不跟 minor 一起上

Status: implemented

## Problem

renovate.json 把所有包收进一个 `all-dependencies` 组，`automergeType: "branch"`，
CI 绿灯就直推 main（见 [renovate 单组配置](./2026-10-27-mirror-credential-store-path.md)
同一批改动里的 `45c3118b2`）。issue #302 是 Renovate 打出来的依赖清单：

- 22 条 minor/patch，多数是直接的版本号替换；
- 14 条 major（`@anthropic-ai/sdk` → v1、`lucide-react` → v1、`next`、`diff` v9、
  `highlight.js` v11、`hosted-git-info` v10、`marked` v18、`typebox`、`@xterm/headless` v6、
  node v24、`vitest` v5、`typescript` v7、`protobufjs` v8、github artifact actions）。

一个组等于「一批全上或全不上」。batch 里任何一条 major 需要改代码，整批就卡住，
minor 里那些本该当天进 main 的补丁也跟着停。而 `pnpm run check` 在这批 minor
上本来就有两处真实的破坏点（下面 Decision 里写），说明「版本号替换」也只是
看上去机械。

## Decision

一批只做能在本地全绿验证的升级：22 条 minor/patch，外加**零代码改动**的 major。
需要改代码、或改起来会动到打包产物的 major 单独留到后续 issue。

这次一起上的 major：`@anthropic-ai/sdk` 0.137.0、`lucide-react` 0.577.0、
`typebox` 1.4.3、`marked` 18.1.2（coding-agent 的 devDependency）。

升级带出的两处必要改动：

- `@google/genai` 2.31.0 新增了 `FinishReason.CONTINUATION`，而
  `packages/ai/src/api/google-shared.ts` 的 `mapStopReason` 用 `never` 做穷尽检查，
  少一个 case 就是类型错误。归到 `error`：开了 `automaticContinuation` 时 SDK
  自己续写，没开时它就是一个没说完的回合，不是正常停止。
- vitest 5 删掉了 `describe.sequential`。`packages/ai` 的四个 OAuth 测试文件
  改成 `describe("…", { concurrent: false }, () => …)`，默认行为不变。

`pnpm` 锁到 12.15.0 之后，`.github/workflows/{ci,build-binaries,issue-analysis}.yml`
里硬编码的 `npm install -g pnpm@12.3.1` 跟着改成 12.15.0——它们不走 `package.json`，
不改就是 lockfile 与本机工具链对不上。

## Alternatives considered

- **照 Renovate 的建议全上**：`highlight.js` 11 与 `marked` 18 先落在
  `packages/coding-agent/src/core/export-html/vendor/*.min.js` 这三个 vendor 产物上，
  它们是手工提交、没有生成步骤，跟着一起升就得在同一个 PR 里换三个 min 文件并重跑
  CJK 分词测试；`diff` v9 的导出形态也要逐个核对两个 import 点。把这些和 22 条
  补丁塞进一个 PR，出问题时的二分成本远大于分两批。
- **先只升 patch，minor 也等**：patch 与 minor 在本仓库的破坏力没有区别
  （`@google/genai` 的枚举扩展就是 minor），按版本号分段不如按「本地能不能全绿」分段。
- **把 major 写进 `renovate.json` 的 `ignoreDeps`**：会永久关掉升级线索。留在
  issue 清单里，下一次 Renovate 运行还会重新提。

## Consequences

- `pnpm run check` 的全量链路里，`biome check` 仍然红：2.6.3 新增的
  `lint/complexity/useOptionalChain` 报了约 30 处既有代码，`noProto` 报了 3 处，
  加上 `biome.json` 的 schema 版本与 `recommended` → `preset` 迁移。
  这类「新规则命中老代码」的告警不能混进依赖 PR，否则改动无法和规则调整分开看。
  留给单独一条清理。
- 剩余 major 清单：`next`（webui）、`diff`、`highlight.js`、`hosted-git-info`、
  `vitest`、`@xterm/headless`、`protobufjs`（`pnpm-workspace.yaml` 里还钉着 override）、
  node v24、github artifact actions、`pnpm/action-setup` v6。
- 验证：`pnpm run typecheck`、`node ./test.mjs`（ai 1418 / coding-agent 2419 通过）、
  `packages/webui` 的 `typecheck` 与 `next build` 全部通过。
