# Agent Note: find 的路径 pattern 从搜索根开始匹配

Status: implemented

## Problem

`find` 有两个 glob 实现，共享同一条「路径 pattern 补 `**/` 前缀」的规则：

- fd 分支（`--full-path`）：`src/**/*.ts` 补成 `**/src/**/*.ts`，在绝对路径上匹配。
- 进程内走查（`compileFindGlob`，fd 缺失时的 fallback）：同一规则，在相对搜索根的路径上匹配。

补前缀是为了让 `src/**/*.ts` 在任意深度的绝对路径上也能命中
`/repo/src/a.ts`。但对 `**` 来说这多了一层语义：`**` 匹配**零或多**级目录，
所以 `**/src/**/*.ts` 里的第一个 `**/` 可以整个不匹配、也可以吃掉任意级 —— 而
第二个 `**/` 同样可以不吃掉 `src/` 这一级。

结果不是「匹配范围变大」这种可接受的偏差，而是**假事实**：

- `src/**/*.ts` 在 `src/` 有直属 `.ts` 文件时，fd 返回空
  （`No files found matching pattern`）。
- 进程内走查同样返回空，于是「fd 不在」这条降级路径给出同一个错误结论。

模型据此认定 `src/` 下没有 TypeScript 文件。用户报的是 earendil-works/pi#9262，
本仓库没有 fd 版本相关的分支，所以这条在本仓库同样是活的 bug，不是上游专属。

## Decision

路径 pattern 一律按「相对搜索根」匹配，不再补 `**/` 前缀。

- `compileFindGlob` 直接把手写的 `**/` 也当成普通 pattern 交给 minimatch。
  minimatch 里 `**` 匹配零或多级，`src/**/*.ts` 因此同时命中 `src/a.ts` 与
  `src/nested/deep.ts`。
- fd 分支保留补前缀：fd 的 `--full-path` 匹配的是**绝对**路径，去掉前缀就只有恰好
  cwd 在搜索根时才命中。`**/` 在这里是可证明安全的，因为绝对路径一定以
  `/` 开头，第一个 `**/` 吃掉的是前缀段，`src/` 那一级仍由 `src` 显式匹配。

两边因此对齐到同一条契约：`src/**/*.ts` 覆盖 `src/` 直属文件与子目录，
`src/*.ts` 只覆盖直属文件。

## Alternatives considered

- **保留 `**/` 前缀，改成 `**/` 只在 abs 路径上补。** 这就是现在 fd / walker 的分工，
  walker 侧前缀没有存在的理由：它拿到的本来就是相对路径。删掉比加分支简单。
- **把 fd 的 `--full-path` 去掉，改用 `--glob` 匹配 basename。** 那样 `src/**/*.ts`
  这类 pattern 直接失效，与 fd 的 basename 语义冲突。
- **固定下载一个 fd 版本（上游的做法）。** 那解决的是 fd 10.5.1 引入的版本差异，
  与本条无关；本仓库两个实现都不依赖 fd 的版本。

## Consequences

- `src/**/*.ts` 现在会命中 `src/` 直属文件，两个实现一致。
- `src/*.ts` 语义不变，仍然不跨目录。
- 回归测试 `packages/coding-agent/test/tools.test.ts` 的
  `find tool without fd` → `matches a path pattern at the top of its directory`
  覆盖进程内走查；把 `compileFindGlob` 的前缀加回去这条会失败。
