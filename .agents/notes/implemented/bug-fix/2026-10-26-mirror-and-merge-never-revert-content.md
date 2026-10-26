# Agent Note: 回退既不在镜像里发生，也不在预合并结果里通过

Status: implemented

## Problem

`b3ffe400`（`Merge CNB main 6a3e6670`）把 main 整棵树换回了 `6a3e6670` 的快照，
而 `c897cdf2`（#235）在它之后。合并结果因此把 #235 的四处改动整块抹掉：聊天行文案、
`CHANGELOG` 条目、`run-record-row.test.ts`、设计笔记。父链没断，`c897cdf2` 仍是
`b3ffe400` 的祖先，`git log` 看不出任何回退 —— 只有下一个动到同一片代码的人才会发现，
于是又开一个 PR（#241）把它放回去。

种子是 `scripts/mirror-main.mjs` 的合成提交：两侧历史分叉时它推
`git commit-tree <本地树> -p <远端 tip>`。这是为了绕开 GitHub push protection
（见 [main 镜像按内容判定](../bug-fix/2026-10-19-mirror-main-by-content-not-ancestry.md)），
但它只搬内容，不搬历史：远端那些「本地没合过」的提交会被直接落下，日志里连痕迹都没有。
它的唯一防护是「树相同就 no-op」，而树相同恰恰是回退发生的前提 —— 本地树停在旧快照、
远端已经往前走时，两者当然不同，脚本照推。

## Decision

两处都改成「宁可停下，不可覆盖」，都不引入 force，也都不改合并策略。

**镜像（`scripts/mirror-main.mjs`）**：非快进路径在 `commit-tree` 之前多一道证明 ——
用 `git diff --raw <远端 tip> <本地树>` 列出远端有、本地树没有的文件（D 状态）。
一条都没有才继续；有就打印清单并 `exit 1`，提示先 `git merge` 远端 main。
判定按 blob 比，所以「本地有同名文件但内容不同」同样算回退。
镜像因此可能变红，这是有意的：红一次好过悄悄丢一次改动。

**预合并结果（`scripts/check-merge-result.mjs`）**：检查「本次改动合进 base 之后，
base 上原有的文件是否还在」。同样用 `git diff --raw`，只报 `D`；改名报 `R`，不算。

接了两处：

- `.cnb.yml` 的 `main: pull_request.target`，状态名 `check-merge-result`。
  **事件必须选 `pull_request.target`**：`pull_request` 拿的是预合并后的提交，
  按定义已经把 base 的树合进来了，回退永远查不出来。代价是它拿不到 PR 的代码，
  脚本里按 `CNB_PULL_REQUEST_SLUG` / `CNB_PULL_REQUEST_BRANCH` 自己合一次。
- `.github/workflows/ci.yml` 的 `Check merge result` 步骤，`fetch-depth: 0`，
  `--base refs/remotes/origin/${{ github.base_ref }}`。步骤并进 `build-check-test`，
  脚本只读 git 对象、不需要依赖，不用为它单独起一个 runner。workflow 同时响应
  `push` 与 `pull_request`（直推 main 也要过 build/check/test，#258），这一步只在
  `github.base_ref` 非空时跑 —— push 上没有可比的 base。

## Alternatives considered

- **把 CNB 的合并策略固定成 fast_forward。** `cnb pulls merge-pull --merge-style`
  支持它，但这是人点合并按钮时的选项，平台没有仓库级默认值的公开配置（`.cnb/settings.yml`
  只管 UI 定制与 NPC）。而且它解决不了 `b3ffe400` 这种「预合并结果本身就是旧树」的情形 ——
  那次回退在提交生成时就发生了，与谁点的合并无关。
- **在 `pull_request` 事件上顺手检查。** 拿到的是预合并提交，base 的树已经被合进来，
  丢没丢东西看不出来。`pull_request.mergeable` 同理。（这里的 `pull_request` 指
  CNB 的同名事件；GitHub Actions 的 `pull_request` 检出的就是合并后的提交，可以用，
  见下一条。）
- **在 GitHub 的 `push` 事件上跑 merge-result。** 检查的语义是「合进 base 会丢什么」，
  push 事件没有可比的 base，`github.base_ref` 为空，脚本只能退化成对空 ref 报错。
  直推 main 的回退由 `sync-to-cnb.yml` 反向镜像 + CNB 侧的 `mirror-main.mjs` 拦；
  push 事件上只跑 build/check/test，那一步按 `github.base_ref` 分流跳过。
- **镜像改为拒绝一切非快进推送。** 两侧历史按设计永久分叉（合成提交），非快进是常态，
  拒绝等于关掉镜像。
- **镜像自动 `git merge FETCH_HEAD` 后再推。** 冲突要人判断，自动合并会把冲突标记
  写进 main；而且合并提交会把待推区间重新通告给 push protection，正是当初要绕开的东西。
- **直接和父链比「哪些提交还没过来」。** 分叉后两侧都没有共同祖先意义上的可比较区间，
  `rev-list FETCH_HEAD ^HEAD` 恒非空，等于每次都拦。

## Consequences

- 镜子推不动时留给人一条明确动作：`git merge` 对端 main。脚本不替人做这个决定。
- 显式删除文件（确实要删）会被 `check-merge-result` 拦。这是已知的误报，处理办法是在
  PR 描述里说明，而不是给检查开豁免 —— 一旦有豁免，回退也会走这条路。
- `pull_request.target` 的流水线在 CNB 上要真正阻止合并，还需要 main 是保护分支并勾选
  「需要通过状态检查」。仓库当前只有 5 个成员、合并都由人点，这条检查的作用是留痕加报警。
