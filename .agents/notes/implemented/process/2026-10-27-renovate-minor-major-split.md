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

- `pnpm run check` 的全量链路里，`biome check` 当时仍然红：2.6.3 新增的
  `lint/complexity/useOptionalChain` 报了约 30 处既有代码，`noProto` 报了 3 处，
  加上 `biome.json` 的 schema 版本与 `recommended` → `preset` 迁移。
  这类「新规则命中老代码」的告警不能混进依赖 PR，否则改动无法和规则调整分开看。
  已在后续 PR 单独清理（见下方 [`biome 2.6.3 规则清理`](#biome-263-规则清理)）。
- 剩余 major 清单：`next`（webui）、`diff`、`highlight.js`、`hosted-git-info`、
  `vitest`、`@xterm/headless`、`protobufjs`（`pnpm-workspace.yaml` 里还钉着 override）、
  node v24、github artifact actions、`pnpm/action-setup` v6。
- 验证：`pnpm run typecheck`、`node ./test.mjs`（ai 1418 / coding-agent 2419 通过）、
  `packages/webui` 的 `typecheck` 与 `next build` 全部通过。

## biome 2.6.3 规则清理

依赖 PR 留下的那条尾巴，单独一个提交，不碰任何依赖版本。

实测基线（`biome check --max-diagnostics=200`）：34 条 lint、7 个文件的格式漂移。
修完 `biome check` 全绿，`pnpm run check` 整条链路通过。

逐条处理的判断：

- `useOptionalChain` 28 处里 26 处是标准的 `!x || x.y !== z`，`--write --unsafe`
  机械替换成 `x?.y !== z`，语义等价（`undefined` 走同一分支）。
- `constrained-sampling.ts` 的两处**必须手工还原**。`Tool.constrainedSampling` 的类型是
  `false | ConstrainedSamplingConfig`，`config?.type` 只会把 `undefined` 收窄掉，
  `false` 留在联合类型里，后面 `config.strict` / `config.variants` 就是 TS2339。
  这不是风格问题：`!config` 在这里同时否定 `false` 和 `undefined`。保留原写法并
  `biome-ignore` 加注释，说明这是 `false | T` 的收窄而不是 nullish 检查。
- `noProto` 3 处全在测试里，且断言的就是**调用方传入的 `__proto__` 必须作为自身键留下**。
  `Object.getPrototypeOf()` 会把断言变成相反的意思，所以关规则加注释，不改写法。
- `useMathMinMax` 2 处是 `index >= 0 ? index : 0`，等价于 `Math.max(index, 0)`。
- `noUnsafeOptionalChaining` 1 处是 `(x?.content as TextPart[])[0]`，`as` 断言盖住了
  `undefined`，改成 `as TextPart[] | undefined` 后再 `?.[0]`。

`biome.json` 用 `biome migrate` 迁移：schema 2.3.5 → 2.6.3，`rules.recommended: true` →
`rules.preset: "recommended"`。两项都是等价的写法替换，不改变启用的规则集。

验证：`pnpm run check` 全绿；`node ./test.mjs` 全部通过（ai 1418 / coding-agent 2419 /
agent 96 / extra 95）。
