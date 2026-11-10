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

路径 pattern 同时按**锚定形式**和**相对形式**匹配，两个实现的候选集合一致。

- 锚定形式给带分隔符的 pattern 补 `**/`：`src/**/*.ts` → `**/src/**/*.ts`。
  它把 pattern 钉在 `src/` 这一层，不会顺带命中 `pkg/src/a.ts`。
- 相对形式是原样的 `src/**/*.ts`，按相对搜索根的路径匹配。minimatch 里 `**`
  匹配零或多级，因此它能命中 `src/` 直属文件与子目录。
- `compileFindGlob`（fd 缺失时的 fallback）对两个候选都跑 `minimatch`，
  任一命中即算命中。
- fd 分支（`--full-path`，匹配**绝对**路径）逐条跑这两个 pattern 并去重合并。
  只跑锚定形式时，部分 fd 版本对 `**/src/**/*.ts` 不给 `src/` 直属文件的结果；
  只跑相对形式会让 pattern 不再钉在搜索根，范围反而放宽。

fd 的下载版本因此钉在 `pinnedVersions`（10.3.0、10.4.2）上，
`resolveDownloadVersion` 取本平台资产可用的最新一个，不再跟着 latest 漂移。

## Alternatives considered

- **只跑相对形式。** walker 拿到的本来就是相对路径，去掉前缀更简单；但相对形式
  不再钉在搜索根，`src/**/*.ts` 会顺带命中 `pkg/src/a.ts`，比现状更宽。
- **只跑锚定形式。** 一份 pattern、一次 fd 调用，最省；但部分 fd 版本对它不给
  `src/` 直属文件的结果，这正是要修的假事实。
- **把 fd 的 `--full-path` 去掉，改用 `--glob` 匹配 basename。** 那样 `src/**/*.ts`
  这类 pattern 直接失效，与 fd 的 basename 语义冲突。
- **固定下载一个 fd 版本（上游的做法）。** 那解决的是 fd 10.5.1 引入的版本差异，
  与本条无关；本仓库两个实现都不依赖 fd 的版本。

## Consequences

- `src/**/*.ts` 现在会命中 `src/` 直属文件，两个实现一致。
- `src/*.ts` 语义不变，仍然不跨目录。
- 代价是带分隔符的 pattern 每个跑两次（fd 两次进程、walker 两次 minimatch），
  结果在合并时去重排序；`limit` 仍按合并后的条数截断。
- 回归测试 `packages/coding-agent/test/tools.test.ts` 覆盖两条路径：
  `find tool` → `matches files directly in src/ for a src/**/*.ts path pattern`
  走 fd，`find tool without fd` → `matches a path pattern at the top of its directory`
  走进程内走查。把 `compileFindGlob` 缩回单一锚定形式，后者会失败。
