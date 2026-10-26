# Agent Note: 预合并检查分得清「改了」和「删了」

Status: implemented

## Problem

`scripts/check-merge-result.mjs` 的判据是「base 的文件路径在结果里必须还在，且 blob
不变」。blob 那一半把正常的修改也算成删除。

`ba2df4b4` 把判据从「数 `git diff --raw` 的 `D`」改成「逐路径比 blob」时，动机是对的：
`D` 的方向由参数顺序决定，PR #249 只加文件就被判成回退。但换成 blob 相等之后，
「base 有 `AGENTS.md`、分支补了一行」也命中 —— 路径在，blob 变了。

PR #253 上是现场样本：只动 `AGENTS.md`（+1 行）与
`packages/coding-agent/src/utils/syntax-highlight-disabled.ts`（注释改两个词），
检查输出「drops 2 file(s)」，原文案还要求 rebase 或合并 base —— 而分支的 base
就是 main 的 tip，合无可合。误报的代价不是红一次，是人照着提示做无意义的操作，
然后下次不再信这条检查。

## Decision

`removed` 与 `rewritten` 分开：路径消失（删除、改名）`exit 1`，内容改动打印一行
提醒后放行。测试 `a file the branch rewrites is a modification, not a deletion` 钉住这条。

放弃「按内容判回退」：git 不存「谁改过谁」，分支上改 `AGENTS.md` 与把 `AGENTS.md`
搬回旧 blob，在树里没有任何区别。要分需要两条历史，那是 `scripts/mirror-main.mjs`
那一侧的活（它手上有远端 tip，能拿 `git diff --raw <远端 tip> <本地树>` 判），
PR 侧只有「base 的树 vs 结果树」，判不了就是判不了。

## Alternatives considered

- **保留 blob 比对，让命中的人自己在 PR 描述里声明。** 这就是 #253 遇到的处境：
  每个正常改文件的 PR 都要写一句「这不是回退」。检查变成噪音，被跳过是迟早的事。
- **比对 base 的内容是否仍是结果的祖先（`git merge-base --is-ancestor <base> <head>`）。**
  这直接否掉了「有意删除」那条路：任何删除都会被拦，与文案里「如果说得清就往 PR
  描述里写」自相矛盾。
- **用 `git log -S` / blame 判这次改动是不是把某行改回去了。** 只能猜，脆，且慢；
  真正要拦的那类回退（整棵树被换回旧快照）已经在路径消失那条路上被抓到过（#235）。

## Consequences

- 一个「改了 base 上很多文件」的 PR 现在能过。内容回退靠 `mirror-main.mjs` 与评审兜，
  与 `2026-10-26-mirror-and-merge-never-revert-content` 里「两处都宁可停下」的分工一致：
  能证明的那处证明，证不了的那处不装作能证。
- 显式删除仍然是红，仍然要在 PR 描述里说明。
