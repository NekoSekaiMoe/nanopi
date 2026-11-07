# Agent Note: `check:openai-client-size` 读源码，不读构建产物

Status: implemented

## Problem

`pnpm run check` 在**没构建过**的 checkout 上必然失败：

```
Error: Narrow openai client is missing:
/…/packages/ai/dist/api/openai-chat-completions-client.js.
Build the workspace packages first.
```

`check-openai-client-size.mjs` 把 esbuild 的入口指向
`packages/ai/dist/api/openai-completions.js`，插件又要求
`packages/ai/dist/api/openai-chat-completions-client.js` 存在
（`scripts/build-openai-client.mjs` 的 `existsSync` 检查 + 报错文案就是为这条路径写的）。
`dist` 是 `pnpm run build` 的产物、不在 git 里，所以这道检查隐含要求「先 build」。
`scripts/` 的其它检查（`check-entry-graphs`、`check-browser-smoke`、`check:runtime-deps`）
都直接读 `packages/*/src`，只有这一道读 `dist`，而这个要求没有任何地方写下来。

`pnpm run check` 的定位是「提交前在 checkout 上跑得动的门」，`checks.yml` 里它排在
`pnpm run build` 之后所以 CI 一直是绿的，本地新 clone 就是红的。真正的问题不是文案，
是依赖方向：一道**检查**不该依赖它要检查的那次构建。

## Decision

检查改成 bundle `packages/ai/src`：

- 入口 `packages/ai/src/api/openai-completions.ts`
- 插件模式 `mode: "src"`，把裸 `openai` 换成
  `packages/ai/src/api/openai-chat-completions-client.ts`

`createNarrowOpenAIClientPlugin` 的参数从 `{ aiDistDir }` 改成 `{ aiDir, mode }`，
`mode` 取 `"dist" | "src"`，各自拼出 `api/openai-chat-completions-client.{js,ts}`。
`mode` 存在的理由不是给调用方自由度，而是「替身必须是 import 方的兄弟模块」：构建
bundle 的是 `dist`，替身就得是编译后的 `.js`；检查没有 dist 可读，bundle 的是 `src`，
替身就得是 `.ts`。混用会让 AI 包出现第二份模块图（这正是原注释在防的事）。
未知 mode 直接抛错，不去猜扩展名。

测量结果不变：改前改后都是 `61 KiB over 11 modules`，与
[窄客户端那篇](../../implemented/simplification/2026-11-06-narrow-openai-client-for-minimal.md)
记录的 `1379 -> 61 KiB (236 -> 11)` 一致。类型擦除不改变 esbuild 的输入集合，所以
`src` 与 `dist` 度的是同一张图。

`scripts/build-coding-agent-single-file.mjs` 跟着换成 `{ aiDir, mode: "dist" }`，
单文件构建的行为不变（`aiDir` 那个变量文件里本来就有）。

## Alternatives considered

- **在检查里先跑 `pnpm run build`**：把一道 5 秒的静态检查变成几分钟的构建，还会
  因为 `dist` 里是旧产物而报出与当前源码无关的数字。检查的输入必须是它正在检查的代码。
- **没有 `dist` 就跳过检查并打印一条提示**：`pnpm run check` 从此有两种语义，
  跳过的那次不会有人回头看；而这道检查存在的全部理由是「静默回归要变成数字」。
- **让检查读 `src`，插件仍固定拼 `.js`**：esbuild 找不到 `.js`，它会去
  `packages/ai/src` 找……找不到，于是报「客户端缺失」，把真正的错误换成一句误导文案。
- **把 `mode` 换成直接传 `targetPath`**：调用方各拼一次路径，两处都要记得 `.ts`/`.js`
  的对应关系，而这个对应关系本身就是插件要守的不变量。

## Consequences

- `pnpm run check` 在没有任何 `dist` 的 checkout 上跑通，这正是 #567 报的现象。
  实测 `pnpm install --frozen-lockfile && pnpm run check` 全绿，`dist` 全程不存在。
- 构建路径的行为一字未变：`mode: "dist"` 拼出的目标与改动前逐字节相同，单文件构建
  仍然读编译产物。
- 少了一层保障：检查不再顺带验证「`tsc` 真的把
  `openai-chat-completions-client.ts` 编译出来了」。这一条本来就该由 `pnpm run build`
  负责（`tsc -p tsconfig.build.json` 会因为它编译失败而红），不属于尺寸预算的职责。
- `build-openai-client.test.mjs` 从 3 个插件用例变成 6 个：两个 tree 各自解析一次、
  两种缺失各自报错、未知 mode 抛错。`mode` 拼错的失败方式从此是显式的。
