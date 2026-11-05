# Agent Note: webui 的 typescript 提到 7.0.2，因为 Next 16 早就在为 TS 7 做分支

Status: implemented

## Problem

`packages/webui` 的 `typescript` 停在 5.9.3，而根 `package.json` 与 `packages/extra`
已经是 7.0.2。Renovate 把它当一条 major 提在 grouped PR 里，看起来像一次没验证的组合：
webui 有自己的 `tsconfig.json`（`target: ES2022`、`moduleResolution: bundler`），类型检查
有两处入口——`pnpm run typecheck` 的裸 `tsc --noEmit`，以及 `next build` 里的前置检查。
后者是 next 自己调的编译器，版本跳一个 major 之后行为归 next 管，不由我们决定。

当时的担心是「Next 16 有没有适配 TS 7 的 npm 包」，而 TS 7 的 npm 包发布的是 Go 原生
实现（见 [tsc 已经是原生编译器](./2026-10-27-tsc-already-runs-the-native-compiler.md)）：
它的 `package.json` 里没有 `lib/typescript.js`，只有 `bin/tsc`。"Next 能不能用"取决于
next 是走 `require('typescript')` 的 API 路径（要 `lib/typescript.js`，TS 7 没有），
还是走 CLI 子进程（只要 bin 在就行）。

## Decision

`packages/webui/package.json` 的 `typescript` 锁到 **7.0.2**，与根包、`packages/extra`
同一个版本，`pnpm-lock.yaml` 里 `typescript@5.9.3` 整条消失，workspace 只剩 7.0.2 一份。

判据是 `next@16.4.3` 里已经有针对 TS 7 的分支，不是"能不能凑"。`next` 的
`dist/lib/typescript/runTypeScriptCli.js` 在解析编译器时：

```js
const apiPath = path.join(packageDir, 'lib', 'typescript.js'); // TS 7 没有这个文件
if (tscBinPath && existsSync(tscBinPath) && packageJson.type === 'module' && path.extname(tscBinPath) === '') {
  // TypeScript 7's extensionless ESM bin wrapper cannot be used as Node's
  // main entry point on Node.js 20.9. Its imported JS entry is the same CLI
  // wrapper and works across all supported Node.js versions.
  const tscJsPath = path.join(packageDir, 'lib', 'tsc.js');
  if (existsSync(tscJsPath)) tscPath = tscJsPath;
}
```

注释里点名了 TypeScript 7；`config-shared.js` 里 `experimental.useTypeScriptCli` 的默认值
是 `true`，所以 webui 走 CLI 路径，不进 `apiPath` 那条会抛 `getTypeScriptApiMissingError`
的分支。

## Measured

在 `next@16.4.3` + `typescript@7.0.2` + `@types/node@24.19.2` 下：

- `pnpm run typecheck`（裸 `tsc --noEmit`）：无输出，退出 0。
- `pnpm run build`（`next build && node scripts/export-dist.mjs`）：`✓ Compiled successfully`，
  `Running TypeScript ... Finished TypeScript in 640ms`，静态导出正常。
- 类型检查是真的在跑：塞一个 `export const broken: number = "not a number";` 进去，
  `next build` 报 `error TS2322: Type 'string' is not assignable to type 'number'` 并
  `Failed to type check.`，退出 1；删掉即恢复。
- `pnpm test`（vitest 5.0.5）：7 项通过。

## Alternatives considered

- **只升根与 `packages/extra`，webui 留 5.9.3**：能过，但同一份 workspace 里存在两个
  编译器实现（Go 原生 vs JS），`pnpm run check` 跑根 `tsc`、webui 的 `typecheck` 跑另一个，
  两边对同一段类型写法的判断可以不一致。留着的唯一理由是「等验证过」，而现在验证过了。
- **`packages/webui` 显式打开 `experimental.useTypeScriptCli`**：默认值已经是 `true`，
  写出来只是把 next 的默认值抄进我们的配置，next 改默认时反而不跟随。唯一的用途是
  反向关掉它——那会立刻撞上 `lib/typescript.js` 缺失，所以更不该写。
- **让 webui 的 `typecheck` 走 `next build` 的类型阶段**：会多一次全量静态构建，
  且 `next build` 的退出码把编译与类型混在一起，定位比裸 `tsc --noEmit` 慢。保留两条
  独立入口，它们各自都有价值。

## Consequences

- webui 与根共用同一个 `typescript` 版本，`pnpm run check` 不再存在两个编译器实现。
- `packages/webui` 的 tsconfig 里 `plugins: [{ name: "next" }]` 只对编辑器与 next 内部
  有效，裸 `tsc` 忽略它——升级前后都是这样，没有新行为。
- 代价：webui 的未来 TypeScript 升级会被 Renovate 归进同一个 npm 组，和根一起动。
  这不再是两条需要分开验证的路径，按普通 minor/patch 处理即可。
- 唯一要注意的点是 next 的 `experimental.useTypeScriptCli`：谁把它关掉，webui 的
  `next build` 会立刻报「install TypeScript 6」类的错。`next.config.ts` 现在没写这一项，
  不要加。
