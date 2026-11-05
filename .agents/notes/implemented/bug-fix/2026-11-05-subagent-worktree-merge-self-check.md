# Agent Note: 隔离子代理的分支合回主树前先过自检

Status: implemented

## Problem

`pi-subagent-mini` 的 `isolated: true` 给子代理开一棵 git worktree、一条
`subagent/<jobId>` 分支，删树和合并都由工具负责，模型不碰路径。但 job 状态是
`completed` 时，`removeWorktree` 的动作是：

```
git worktree remove --force <tree>
git worktree prune
git merge --no-edit subagent/<jobId>
```

合并是整段 accept。三种后果都真实存在：

- 子代理在树里留下未提交改动。改动不在分支上，`merge` 带不走，紧接着的
  `worktree remove --force` 把它一起删掉，父子两边都没有痕迹。
- 子代理提交了没过 `pnpm run check` 的半成品，分支照样落进主树，主树在类型检查
  或构建上是坏的。
- 父 agent 想知道这次合了哪些文件。拿不到：合并黑箱，没有清单。

同时 `removeWorktree` 的注释写着「a failed or abandoned job drops the branch
instead, so a half-finished tree never lands in the main checkout」——失败路径成立，
完成路径全盘 accept，注释承诺的防线只覆盖一半。

## Decision

合并之前先过三道闸，实现在 `packages/coding-agent/src/extras/pi-subagent-mini/src/worktree.ts`
的 `mergeWorktree`：

- `git status --porcelain` 在主 checkout 上必须为空。否则 `merge` 会把父 agent 未提交
  的改动混进子代理的提交里，冲突时还没人知道自己踩了两份改动。
- `pnpm run check` 必须在主 checkout 上通过。目录里没有 `package.json` 时是 `skipped`
  而不是 `failed`：非 JS 仓库没有这道闸可跑，硬造一个会让 `isolated` 在仓库外不可用。
- 改动文件清单（`git diff --name-status HEAD <branch>`）进报告，父 agent 读到的是
  「合了什么」，而不是「合了」。

任一条不满足就**不合并**：保留 worktree 和分支，`worktree.kept = true`，原因写进
`worktree.report`，由 `withWorktreeReport` 附到子代理报告的末尾：

```
worktree not merged (subagent/sa-1 at /tmp/.repo-subagent-sa-1):
the repository's check command failed on this tree:
...
```

分支自身没有提交时直接丢弃，报告写 `no commits of its own; nothing to merge`——
`merge` 在那个场景只会打一行 "Already up to date"，分支还得另删。

删分支挪到删树之后，且统一用 `-D`：git 拒绝删除仍被某棵 worktree checkout 的分支，
而"没有提交可合"的分支也不是 HEAD 的祖先，`-d` 在那里会拒。

## Alternatives considered

**合并前在子代理树里跑 check，而不是主 checkout。** 最强理由是子代理的树就是它
自己改的那份，检查离改动最近。否决：子代理的树从 `HEAD` 开始，主 checkout 可能
已经前进（别的会话、别的合并），在旧树上过检不代表落进新 HEAD 后过检。闸要装在
落点那一侧。

**校验失败就丢弃分支，只把原因报告给父 agent。** 最强理由是"不合并"已经达到了
安全目标，留着分支只是垃圾回收的负担。否决：这正是当前缺陷的镜像——父 agent 拿到
一句「没过检」却拿不到代码，只能重新派活。保留树和分支让父 agent 可以进去看、
修、或者自己决定 `git branch -D`；代价是磁盘上多一棵树，而它出现在报告里，跑不掉。

**把自检做成 `isolated` 的选项（`verifyIsolation: true`）。** 否决：默认关等于默认
留着缺陷，默认开等于多一个没人会关的开关。自检不是偏好，是这条路径上唯一一道闸。

**自检失败就把 job 状态改成 `failed` 而不是 `completed`。** 否决：子代理确实完成了
它自己的任务，产出只是没落地。把"没合"混进"失败"会让 `dependsOn` 把下游判成
`blocked`，而下游其实可以基于这份未落地的产出继续判断。报告里说清楚就够。

## Consequences

- 子代理的未提交改动不再被静默删除：树留着，路径写在报告里。
- 父 agent 每次都能读到「合了哪几个文件、闸过了没过」，`action: "wait"` 与
  `action: "status"` 都带上这段，`details.worktree` 里也有同样的 `report`。
- 一次成功的合并现在会跑一次 `pnpm run check`，在 nanopi 仓库里是几十秒。隔离
  子代理本来就比共享工作区贵，这笔开销买的是"主树不会因为子代理的提交变坏"。
- 主 checkout 脏的时候，隔离子代理的产出会停在分支上不落主树。这是有意为之：
  多会话同时改不同文件时，`merge` 一旦把别人的未提交改动卷进去，ABORT 之后
  谁的工作都不完整。
- 非 git 目录、非 JS 仓库的行为分别是「保留树并说明」和「跳过闸」，不会被拒绝
  到无法使用。

## Testing

`packages/coding-agent/test/suite/regressions/subagent-session-and-worktree.test.ts`
新增 `subagent worktree merge self-check` 一组：干净树 + 过检的分支合入并给出
`A<TAB>file` 清单、主 checkout 有未提交改动时拒绝并保树、check 失败时拒绝并保树、
无 `package.json` 时按 `skipped` 合入。`kill` 路径保持不合并、不留分支的原行为，
也有用例钉住。
